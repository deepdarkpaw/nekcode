import { type Component, Input, type TUI, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "../../../core/extensions/types.ts";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { Question, QuestionAnswer } from "../types.ts";

/** Label of the free-text row that every question offers (Cursor: users can always select "Other"). */
export const OTHER_LABEL = "Other...";
const SUBMIT_LABEL = "Submit";

type Row = { kind: "option"; id: string; label: string } | { kind: "other" } | { kind: "submit" };

interface DialogState {
	cursor: number;
	checked: Set<string>;
	other?: string;
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
	const state: DialogState = { cursor: 0, checked: new Set(), editing: false };
	const input = new Input();
	input.onEscape = () => stopEditing(state, input);
	input.onSubmit = (value) => {
		const text = value.trim();
		if (text && !question.allow_multiple) return done(buildAnswer(question, [], text));
		state.other = text || undefined;
		stopEditing(state, input);
	};
	const activate = (row: Row) => {
		if (row.kind === "other") return startEditing(state, input);
		if (row.kind === "option" && !question.allow_multiple) return done(buildAnswer(question, [row.id]));
		if (row.kind === "option") return toggle(state.checked, row.id);
		if (state.checked.size > 0 || state.other) done(buildAnswer(question, [...state.checked], state.other));
	};
	return {
		render: (width) => renderQuestion(question, title, rows, state, input, theme, width),
		invalidate: () => input.invalidate(),
		handleInput: (data) => {
			if (state.editing) input.handleInput(data);
			else if (keybindings.matches(data, "tui.select.up")) state.cursor = Math.max(0, state.cursor - 1);
			else if (keybindings.matches(data, "tui.select.down"))
				state.cursor = Math.min(rows.length - 1, state.cursor + 1);
			else if (keybindings.matches(data, "tui.select.confirm")) activate(rows[state.cursor]);
			else if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
			tui.requestRender();
		},
	};
}

function startEditing(state: DialogState, input: Input): void {
	state.editing = true;
	input.setValue(state.other ?? "");
	input.focused = true;
}

function stopEditing(state: DialogState, input: Input): void {
	state.editing = false;
	input.focused = false;
}

function toggle(checked: Set<string>, id: string): void {
	if (!checked.delete(id)) checked.add(id);
}

function rowLabel(row: Row, state: DialogState, multiple: boolean): string {
	if (row.kind === "submit") return SUBMIT_LABEL;
	const label = row.kind === "option" ? row.label : state.other ? `${OTHER_LABEL} ${state.other}` : OTHER_LABEL;
	if (!multiple) return label;
	const checked = row.kind === "option" ? state.checked.has(row.id) : state.other !== undefined;
	return `${checked ? "[x]" : "[ ]"} ${label}`;
}

function renderQuestion(
	question: Question,
	title: string | undefined,
	rows: readonly Row[],
	state: DialogState,
	input: Input,
	theme: Theme,
	width: number,
): string[] {
	const inner = Math.max(1, width - 2);
	const lines = [theme.fg("accent", "─".repeat(Math.max(1, width)))];
	if (title) lines.push(` ${theme.fg("accent", theme.bold(title))}`);
	for (const line of wrapTextWithAnsi(question.prompt, inner)) lines.push(` ${theme.fg("text", line)}`);
	lines.push("");
	rows.forEach((row, index) => {
		const selected = index === state.cursor;
		const label = rowLabel(row, state, question.allow_multiple === true);
		lines.push(`${selected ? theme.fg("accent", "> ") : "  "}${theme.fg(selected ? "accent" : "text", label)}`);
	});
	if (state.editing) lines.push("", ...input.render(inner).map((line) => ` ${line}`));
	const hint = state.editing ? keyHint("tui.input.submit", "submit") : keyHint("tui.select.confirm", "select");
	lines.push("", ` ${hint}  ${keyHint("tui.select.cancel", state.editing ? "back" : "dismiss")}`);
	lines.push(theme.fg("accent", "─".repeat(Math.max(1, width))));
	return lines;
}
