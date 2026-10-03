import {
	type Component,
	Editor,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "../../../core/extensions/types.ts";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { getEditorTheme, type Theme } from "../../../modes/interactive/theme/theme.ts";
import type { Question, QuestionAnswer } from "../types.ts";

/** Label of the free-text row that every question offers (Cursor: users can always select "Other"). */
export const OTHER_LABEL = "Other...";
const SUBMIT_LABEL = "Submit";

type Row = { kind: "option"; id: string; label: string } | { kind: "other" } | { kind: "submit" };

interface DialogState {
	cursor: number;
	checked: Set<string>;
	/** Last submitted free-text value, retained separately from the active draft. */
	other?: string;
	otherDraft: string;
	editing: boolean;
}

/** Answer built from chosen option ids (in option order) and optional free text. */
export function buildAnswer(question: Question, optionIds: readonly string[], other?: string): QuestionAnswer {
	const chosen = question.options.filter((option) => optionIds.includes(option.id));
	const answer: QuestionAnswer = {
		questionId: question.id,
		optionIds: chosen.map((option) => option.id),
		labels: chosen.map((option) => option.label),
	};
	if (other) answer.other = other;
	return answer;
}

/**
 * Ask one question and resolve with the answer, or undefined when the user dismisses it. The TUI shows the options
 * plus "Other..." (free text); in multi-select questions Enter toggles an option and the Submit row confirms. Other
 * dialog UIs (RPC) fall back to select for single choice and one confirm per option for multiple choice.
 */
export async function askQuestion(
	ctx: ExtensionContext,
	question: Question,
	title: string | undefined,
	signal?: AbortSignal,
): Promise<QuestionAnswer | undefined> {
	if (signal?.aborted) return undefined;
	if (ctx.mode === "tui") {
		return ctx.ui.custom<QuestionAnswer | undefined>((tui, theme, keybindings, done) => {
			let closed = false;
			const finish = (answer: QuestionAnswer | undefined) => {
				if (closed) return;
				closed = true;
				signal?.removeEventListener("abort", abort);
				done(answer);
			};
			const abort = () => finish(undefined);
			signal?.addEventListener("abort", abort, { once: true });
			if (signal?.aborted) abort();
			const view = createQuestionView(question, title, { tui, theme, keybindings }, finish);
			return { ...view, dispose: () => signal?.removeEventListener("abort", abort) };
		});
	}
	if (question.allow_multiple) return askMultipleByConfirm(ctx, question, signal);
	const labels = question.options.map((option) => option.label);
	const choice = await ctx.ui.select(question.prompt, [...labels, OTHER_LABEL], { signal });
	if (choice === undefined || signal?.aborted) return undefined;
	if (choice !== OTHER_LABEL) return buildAnswer(question, [question.options[labels.indexOf(choice)].id]);
	const text = (await ctx.ui.input(question.prompt, undefined, { signal }))?.trim();
	return text && !signal?.aborted ? buildAnswer(question, [], text) : undefined;
}

async function askMultipleByConfirm(
	ctx: ExtensionContext,
	question: Question,
	signal?: AbortSignal,
): Promise<QuestionAnswer | undefined> {
	const chosen: string[] = [];
	for (const option of question.options) {
		if (signal?.aborted) return undefined;
		if (await ctx.ui.confirm(question.prompt, option.label, { signal })) chosen.push(option.id);
	}
	return signal?.aborted ? undefined : buildAnswer(question, chosen);
}

function dialogRows(question: Question): Row[] {
	const rows: Row[] = question.options.map((option) => ({ kind: "option", id: option.id, label: option.label }));
	rows.push({ kind: "other" });
	if (question.allow_multiple) rows.push({ kind: "submit" });
	return rows;
}

interface ViewEnv {
	tui: TUI;
	theme: Theme;
	keybindings: KeybindingsManager;
}

function createQuestionView(
	question: Question,
	title: string | undefined,
	env: ViewEnv,
	done: (answer: QuestionAnswer | undefined) => void,
): Component {
	const { tui, theme, keybindings } = env;
	const rows = dialogRows(question);
	const state: DialogState = { cursor: 0, checked: new Set(), otherDraft: "", editing: false };
	const input = new Editor(tui, getEditorTheme(), { borders: false });
	input.onChange = (value) => {
		state.otherDraft = value;
	};
	input.onSubmit = (value) => {
		const text = value.trim();
		if (text && !question.allow_multiple) return done(buildAnswer(question, [], text));
		state.other = text || undefined;
		state.otherDraft = value;
		stopEditing(state, input);
	};
	const activate = (row: Row) => {
		if (row.kind === "other") return startEditing(state, input);
		if (row.kind === "option" && !question.allow_multiple) return done(buildAnswer(question, [row.id]));
		if (row.kind === "option") return toggle(state.checked, row.id);
		const other = (state.otherDraft || state.other)?.trim();
		if (state.checked.size > 0 || other) done(buildAnswer(question, [...state.checked], other));
	};
	return {
		render: (width) => renderQuestion(question, title, rows, state, input, theme, width),
		invalidate: () => input.invalidate(),
		handleInput: (data) => {
			if (state.editing) {
				if (keybindings.matches(data, "tui.select.cancel")) stopEditing(state, input);
				else input.handleInput(data);
			} else if (keybindings.matches(data, "tui.select.up")) state.cursor = Math.max(0, state.cursor - 1);
			else if (keybindings.matches(data, "tui.select.down"))
				state.cursor = Math.min(rows.length - 1, state.cursor + 1);
			else if (keybindings.matches(data, "tui.select.confirm")) activate(rows[state.cursor]);
			else if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
			tui.requestRender();
		},
	};
}

function startEditing(state: DialogState, input: Editor): void {
	state.editing = true;
	const value = state.otherDraft || state.other || "";
	if (input.getText() !== value) input.setText(value);
	input.focused = true;
}

function stopEditing(state: DialogState, input: Editor): void {
	state.editing = false;
	input.focused = false;
}

function toggle(checked: Set<string>, id: string): void {
	if (!checked.delete(id)) checked.add(id);
}

/** Plain label of a row, without the selection/cursor prefix. */
function rowLabel(row: Row, state: DialogState): string {
	if (row.kind === "submit") return SUBMIT_LABEL;
	if (row.kind === "option") return row.label;
	const draft = (state.otherDraft || state.other || "").replace(/\s+/g, " ").trim();
	return draft ? `${OTHER_LABEL} ${draft}` : OTHER_LABEL;
}

/**
 * Prefix shown before a row label: `> ` when selected else `  `, plus `[x] `/`[ ] ` for multi-select rows.
 * The prefix is never wrapped; the label wraps into the remaining width so continuation lines align under it.
 */
function rowPrefix(row: Row, state: DialogState, multiple: boolean, selected: boolean): string {
	let prefix = selected ? "> " : "  ";
	if (multiple && row.kind !== "submit") {
		const checked =
			row.kind === "option" ? state.checked.has(row.id) : Boolean((state.otherDraft || state.other)?.trim());
		prefix += `${checked ? "[x]" : "[ ]"} `;
	}
	return prefix;
}

/** Push one styled option row, wrapping its label into `width - prefixWidth` columns. */
function pushRow(
	lines: string[],
	row: Row,
	state: DialogState,
	multiple: boolean,
	selected: boolean,
	theme: Theme,
	width: number,
): void {
	const prefix = truncateToWidth(rowPrefix(row, state, multiple, selected), Math.max(0, width - 1), "");
	const labelWidth = Math.max(1, width - visibleWidth(prefix));
	const indent = " ".repeat(visibleWidth(prefix));
	const color = selected ? "accent" : "text";
	for (const [index, line] of wrapTextWithAnsi(rowLabel(row, state), labelWidth).entries()) {
		lines.push(`${index === 0 ? prefix : indent}${theme.fg(color, line)}`);
	}
}

/** Push the active Other editor into its row, keeping wrapped continuations under the label. */
function pushEditorRow(
	lines: string[],
	row: Row,
	state: DialogState,
	multiple: boolean,
	selected: boolean,
	editor: Editor,
	theme: Theme,
	width: number,
): void {
	const prefix = truncateToWidth(rowPrefix(row, state, multiple, selected), width, "");
	const editorWidth = Math.max(1, width - visibleWidth(prefix));
	const indent = " ".repeat(visibleWidth(prefix));
	for (const [index, line] of editor.render(editorWidth).entries()) {
		lines.push(`${index === 0 ? prefix : indent}${theme.fg("accent", line)}`);
	}
}

function renderQuestion(
	question: Question,
	title: string | undefined,
	rows: readonly Row[],
	state: DialogState,
	input: Editor,
	theme: Theme,
	width: number,
): string[] {
	const inner = Math.max(1, width - 2);
	const lines = [theme.fg("accent", "─".repeat(Math.max(1, width)))];
	if (title) lines.push(` ${truncateToWidth(theme.fg("accent", theme.bold(title)), inner, "")}`);
	for (const line of wrapTextWithAnsi(question.prompt, inner)) {
		lines.push(` ${truncateToWidth(theme.fg("text", line), inner, "")}`);
	}
	lines.push("");
	const multiple = question.allow_multiple === true;
	for (const [index, row] of rows.entries()) {
		const selected = index === state.cursor;
		if (state.editing && row.kind === "other") {
			pushEditorRow(lines, row, state, multiple, selected, input, theme, inner);
		} else {
			pushRow(lines, row, state, multiple, selected, theme, inner);
		}
	}
	const hint = state.editing ? keyHint("tui.input.submit", "submit") : keyHint("tui.select.confirm", "select");
	const hintLine = ` ${hint}  ${keyHint("tui.select.cancel", state.editing ? "back" : "dismiss")}`;
	lines.push("", truncateToWidth(hintLine, width, ""));
	lines.push(theme.fg("accent", "─".repeat(Math.max(1, width))));
	return lines;
}
