import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { ExtensionContext, MessageRenderer } from "../../../core/extensions/types.ts";
import { rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme } from "../../../modes/interactive/theme/theme.ts";
import { activePlan } from "../state/session-state.ts";
import type { NekSessionState, PlanData } from "../types.ts";
import { formatPlanDocument, planHeading } from "./renderers.ts";

/**
 * Display-only transcript copy of a saved revision, appended when a review opens and by `/plans`. It never reaches the
 * model: plan-wiring drops it in the `context` handler, because the plan is already in context via the plan tool call
 * or the approved-plan message.
 */
export const PLAN_PREVIEW_TYPE = "nek.plan_preview";

/** Render the immutable preview as a document, not a collapsed generic tool result. */
export const renderPlanPreview: MessageRenderer<PlanData> = (message, options, theme) => {
	const view = new Container();
	const plan = message.details?.plan;
	if (plan) {
		view.addChild(new Text(planHeading(plan.name, plan.revision, theme), options.outputPad, 0));
		view.addChild(new Text(theme.fg("dim", plan.path), options.outputPad, 0));
	}
	const markdown = message.details
		? formatPlanDocument(message.details)
		: typeof message.content === "string"
			? message.content
			: "";
	view.addChild(new Markdown(markdown, options.outputPad, 1, getMarkdownTheme()));
	return view;
};

/** A compact lifecycle row, shown only in Plan mode, stays separate from the editor's persistent PLAN badge. */
export function syncPlanUi(ctx: ExtensionContext, state: NekSessionState, shortcut: string): void {
	if (!ctx.hasUI) return;
	if (state.mode !== "plan") {
		ctx.ui.setWidget("nek.plan", undefined);
		return;
	}
	const selected = activePlan(state);
	ctx.ui.setWidget("nek.plan", () => ({
		invalidate: () => {},
		dispose: () => {},
		render: (width) => {
			const theme = ctx.ui.theme;
			const status =
				state.planStatus === "ready" ? "Ready for review" : selected ? "Revising plan" : "Drafting plan";
			const name = selected ? `  ${selected.plan.name} / r${selected.plan.revision}` : "";
			const action = `  ${rawKeyHint(shortcut, "switch mode")}  ${theme.fg("muted", "/agent exit")}`;
			return new Text(theme.fg("accent", status) + theme.fg("muted", name) + action, 1, 0).render(width);
		},
	}));
}
