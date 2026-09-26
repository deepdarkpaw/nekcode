import { type Component, Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { ExtensionContext } from "../../../core/extensions/types.ts";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { getSelectListTheme, type Theme } from "../../../modes/interactive/theme/theme.ts";
import {
	clearContextDescription,
	IMPLEMENT_CLEAR_CONTEXT,
	IMPLEMENT_NO,
	IMPLEMENT_NO_DESCRIPTION,
	IMPLEMENT_TITLE,
	IMPLEMENT_YES,
	IMPLEMENT_YES_DESCRIPTION,
} from "../prompts/implement.ts";

/** Choices of the "Implement this plan?" panel. */
export type PlanApprovalChoice = "implement" | "fresh" | "stay";

/** One panel row. */
export interface PlanApprovalOption {
	choice: PlanApprovalChoice;
	label: string;
	description: string;
}

/** The three Codex panel rows; the fresh-session row shows the context usage when it is known. */
export function planApprovalOptions(percentUsed: number | undefined): PlanApprovalOption[] {
	return [
		{ choice: "implement", label: IMPLEMENT_YES, description: IMPLEMENT_YES_DESCRIPTION },
		{ choice: "fresh", label: IMPLEMENT_CLEAR_CONTEXT, description: clearContextDescription(percentUsed) },
		{ choice: "stay", label: IMPLEMENT_NO, description: IMPLEMENT_NO_DESCRIPTION },
	];
}

/**
 * Show the "Implement this plan?" panel and resolve with the choice, or undefined when dismissed. The TUI shows a
 * list with descriptions; other dialog UIs (RPC) use a plain select over the labels.
 */
export async function showPlanApproval(ctx: ExtensionContext): Promise<PlanApprovalChoice | undefined> {
	const options = planApprovalOptions(ctx.getContextUsage()?.percent ?? undefined);
	if (ctx.mode === "tui") {
		return ctx.ui.custom<PlanApprovalChoice | undefined>((_tui, theme, _keybindings, done) =>
			createApprovalView(options, theme, done),
		);
	}
	const label = await ctx.ui.select(
		IMPLEMENT_TITLE,
		options.map((option) => option.label),
	);
	return options.find((option) => option.label === label)?.choice;
}

function createApprovalView(
	options: readonly PlanApprovalOption[],
	theme: Theme,
	done: (choice: PlanApprovalChoice | undefined) => void,
): Component {
	const items: SelectItem[] = options.map((option) => ({
		value: option.choice,
		label: option.label,
		description: option.description,
	}));
	const list = new SelectList(items, items.length, getSelectListTheme());
	list.onSelect = (item) => done(options.find((option) => option.choice === item.value)?.choice);
	list.onCancel = () => done(undefined);
	const view = new Container();
	view.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	view.addChild(new Text(theme.fg("accent", theme.bold(IMPLEMENT_TITLE)), 1, 0));
	view.addChild(list);
	view.addChild(
		new Text(`${keyHint("tui.select.confirm", "select")}  ${keyHint("tui.select.cancel", "dismiss")}`, 1, 0),
	);
	view.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	return {
		render: (width) => view.render(width),
		invalidate: () => view.invalidate(),
		handleInput: (data) => list.handleInput(data),
	};
}
