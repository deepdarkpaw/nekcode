import {
	type Component,
	Markdown,
	type SelectItem,
	SelectList,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { ExtensionContext } from "../../../core/extensions/types.ts";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../../modes/interactive/theme/theme.ts";
import {
	clearContextDescription,
	IMPLEMENT_CLEAR_CONTEXT,
	IMPLEMENT_EXIT,
	IMPLEMENT_EXIT_DESCRIPTION,
	IMPLEMENT_NO,
	IMPLEMENT_NO_DESCRIPTION,
	IMPLEMENT_TITLE,
	IMPLEMENT_YES,
	IMPLEMENT_YES_DESCRIPTION,
} from "../prompts/implement.ts";
import type { PlanData } from "../types.ts";
import { formatPlanDocument } from "./renderers.ts";

/** Choices of the "Implement this plan?" panel. */
export type PlanApprovalChoice = "implement" | "fresh" | "stay" | "exit";

/** One panel row. */
export interface PlanApprovalOption {
	choice: PlanApprovalChoice;
	label: string;
	description: string;
}

/** The persisted body and metadata being reviewed; no plan file is read by this UI. */
export type PlanApprovalSnapshot = PlanData;

/** Four review actions; the fresh-session row shows context usage when it is known. */
export function planApprovalOptions(percentUsed: number | undefined): PlanApprovalOption[] {
	return [
		{ choice: "implement", label: IMPLEMENT_YES, description: IMPLEMENT_YES_DESCRIPTION },
		{ choice: "fresh", label: IMPLEMENT_CLEAR_CONTEXT, description: clearContextDescription(percentUsed) },
		{ choice: "stay", label: IMPLEMENT_NO, description: IMPLEMENT_NO_DESCRIPTION },
		{ choice: "exit", label: IMPLEMENT_EXIT, description: IMPLEMENT_EXIT_DESCRIPTION },
	];
}

/** Review a plan inline, or use the same four actions through a non-TUI select. Dismissal changes nothing. */
export async function showPlanApproval(
	ctx: ExtensionContext,
	snapshot: PlanApprovalSnapshot,
): Promise<PlanApprovalChoice | undefined> {
	const options = planApprovalOptions(ctx.getContextUsage()?.percent ?? undefined);
	if (ctx.mode === "tui") {
		return ctx.ui.custom<PlanApprovalChoice | undefined>((tui, theme, keybindings, done) =>
			createApprovalView(options, theme, keybindings, tui, done, snapshot),
		);
	}
	const label = await ctx.ui.select(
		IMPLEMENT_TITLE,
		options.map((option) => option.label),
	);
	return options.find((option) => option.label === label)?.choice;
}

const COMPACT_LABELS: Record<PlanApprovalChoice, string> = {
	implement: "Implement",
	fresh: "Fresh context",
	stay: "Keep planning",
	exit: "Exit Plan mode",
};

function createApprovalView(
	options: readonly PlanApprovalOption[],
	theme: Theme,
	keybindings: KeybindingsManager,
	tui: TUI,
	done: (choice: PlanApprovalChoice | undefined) => void,
	snapshot: PlanApprovalSnapshot,
): Component {
	const items: SelectItem[] = options.map((option) => ({
		value: option.choice,
		label: COMPACT_LABELS[option.choice],
	}));
	const list = new SelectList(items, items.length, {
		selectedPrefix: (text) => theme.fg("borderAccent", text),
		selectedText: (text) => theme.style(text, { fg: "borderAccent", bold: true, inverse: true }),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("muted", text),
		noMatch: (text) => theme.fg("muted", text),
	});
	list.onSelect = (item) => done(options.find((option) => option.choice === item.value)?.choice);
	list.onCancel = () => done(undefined);
	const markdown = new Markdown(formatPlanDocument(snapshot), 1, 0, getMarkdownTheme());
	let offset = 0;
	let pageHeight = 1;
	let bodyLength = 0;
	return {
		render(width) {
			if (width <= 0) return [];
			const border = theme.fg("borderAccent", "─".repeat(width));
			const selected = options.find((option) => option.choice === list.getSelectedItem()?.value);
			const actionLines = [
				...new Text(theme.style(IMPLEMENT_TITLE, { fg: "borderAccent", bold: true }), 1, 0).render(width),
				...list.render(width),
				...new Text(theme.fg("muted", selected?.description ?? ""), 1, 0).render(width),
				...new Text(
					`${keyHint("tui.select.up", "")}${keyHint("tui.select.down", "choose")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "dismiss")}`,
					1,
					0,
				).render(width),
			];
			const revision = `  Revision ${snapshot.plan.revision}`;
			const heading = new Text(
				theme.style(" PLAN ", { fg: "borderAccent", bold: true, inverse: true }) +
					` ${theme.style(snapshot.plan.name, { fg: "text", bold: true })}` +
					theme.fg("muted", revision),
				1,
				0,
			).render(width);
			const body = markdown.render(width);
			bodyLength = body.length;
			// Leave room for transcript context above the inline review, and keep the actions outside the body viewport.
			pageHeight = Math.max(
				1,
				Math.min(Math.floor(tui.terminal.rows / 2), tui.terminal.rows - actionLines.length - heading.length - 8),
			);
			offset = Math.max(0, Math.min(offset, body.length - pageHeight));
			const bodyLines = body.slice(offset, offset + pageHeight);
			const scrollHint = new Text(
				theme.fg("muted", `${offset + 1}-${Math.min(body.length, offset + pageHeight)} / ${body.length}`) +
					`  ${keyHint("tui.select.pageUp", "")}${keyHint("tui.select.pageDown", "review")}`,
				1,
				0,
			).render(width);
			return [border, ...heading, ...bodyLines, ...scrollHint, border, ...actionLines, border].map((line) =>
				truncateToWidth(line, width, ""),
			);
		},
		invalidate() {
			markdown.invalidate();
			list.invalidate();
		},
		handleInput(data) {
			if (keybindings.matches(data, "tui.select.pageUp")) {
				offset = Math.max(0, offset - pageHeight);
			} else if (keybindings.matches(data, "tui.select.pageDown")) {
				offset = Math.min(Math.max(0, bodyLength - pageHeight), offset + pageHeight);
			} else {
				list.handleInput(data);
			}
			tui.requestRender();
		},
	};
}
