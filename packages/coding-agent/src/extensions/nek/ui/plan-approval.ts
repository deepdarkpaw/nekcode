import { type Component, type SelectItem, SelectList, Text, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "../../../core/extensions/types.ts";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
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
import { planHeading } from "./renderers.ts";

/** Choices of the "Implement this plan?" panel. */
export type PlanApprovalChoice = "implement" | "fresh" | "stay" | "exit";

/** One panel row. */
export interface PlanApprovalOption {
	choice: PlanApprovalChoice;
	label: string;
	description: string;
}

/** The persisted snapshot being reviewed; its body is shown in the transcript, not in this panel. */
export type PlanApprovalSnapshot = PlanData;

/** Pointer from the compact panel to the plan preview appended to the transcript just before it. */
export const PLAN_APPROVAL_TRANSCRIPT_HINT = "Full plan is above in the transcript";

/** Four review actions; the fresh-session row shows context usage when it is known. */
export function planApprovalOptions(percentUsed: number | undefined): PlanApprovalOption[] {
	return [
		{ choice: "implement", label: IMPLEMENT_YES, description: IMPLEMENT_YES_DESCRIPTION },
		{ choice: "fresh", label: IMPLEMENT_CLEAR_CONTEXT, description: clearContextDescription(percentUsed) },
		{ choice: "stay", label: IMPLEMENT_NO, description: IMPLEMENT_NO_DESCRIPTION },
		{ choice: "exit", label: IMPLEMENT_EXIT, description: IMPLEMENT_EXIT_DESCRIPTION },
	];
}

/** Ask for one of the four actions inline, or through a non-TUI select. Dismissal changes nothing. */
export async function showPlanApproval(
	ctx: ExtensionContext,
	snapshot: PlanApprovalSnapshot,
): Promise<PlanApprovalChoice | undefined> {
	const options = planApprovalOptions(ctx.getContextUsage()?.percent ?? undefined);
	if (ctx.mode === "tui") {
		return ctx.ui.custom<PlanApprovalChoice | undefined>((tui, theme, _keybindings, done) =>
			createApprovalView(options, theme, tui, done, snapshot),
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

/**
 * Compact panel in the editor slot: heading, actions, the selected action's description, and key hints. The plan body
 * lives in the transcript, where fullscreen paging and native scrollback both work.
 */
function createApprovalView(
	options: readonly PlanApprovalOption[],
	theme: Theme,
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
	return {
		render(width) {
			if (width <= 0) return [];
			const border = theme.fg("borderAccent", "─".repeat(width));
			const selected = options.find((option) => option.choice === list.getSelectedItem()?.value);
			const hints = `${keyHint("tui.select.up", "")}${keyHint("tui.select.down", "choose")}  ${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "dismiss")}`;
			return [
				border,
				...new Text(planHeading(snapshot.plan.name, snapshot.plan.revision, theme), 1, 0).render(width),
				...new Text(theme.style(IMPLEMENT_TITLE, { fg: "borderAccent", bold: true }), 1, 0).render(width),
				...list.render(width),
				...new Text(theme.fg("muted", selected?.description ?? ""), 1, 0).render(width),
				...new Text(theme.fg("dim", PLAN_APPROVAL_TRANSCRIPT_HINT), 1, 0).render(width),
				...new Text(hints, 1, 0).render(width),
				border,
			].map((line) => truncateToWidth(line, width, ""));
		},
		invalidate() {
			list.invalidate();
		},
		handleInput(data) {
			list.handleInput(data);
			tui.requestRender();
		},
	};
}
