import { Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { ExtensionContext, MessageRenderer } from "../../../core/extensions/types.ts";
import { rawKeyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme } from "../../../modes/interactive/theme/theme.ts";
import type { NekSessionState, PlanData } from "../types.ts";
import { formatPlanDocument } from "./renderers.ts";

/** A saved revision can be reopened without executing or asking the model to regenerate it. */
export const PLAN_PREVIEW_TYPE = "nek.plan_preview";

/** Render the immutable preview as a document, not a collapsed generic tool result. */
export const renderPlanPreview: MessageRenderer<PlanData> = (message, options, theme) => {
	const view = new Container();
	const plan = message.details?.plan;
	if (plan) {
		view.addChild(
			new Text(
				theme.fg("muted", `${plan.name}  |  revision ${plan.revision}  |  ${plan.path}`),
				options.outputPad,
				0,
			),
		);
	}
	const markdown = message.details
		? formatPlanDocument(message.details)
		: typeof message.content === "string"
			? message.content
			: "";
	view.addChild(new Markdown(markdown, options.outputPad, 1, getMarkdownTheme()));
	return view;
};

/** A compact lifecycle row stays separate from the editor's persistent PLAN badge. */
export function syncPlanUi(ctx: ExtensionContext, state: NekSessionState, shortcut: string): void {
	if (!ctx.hasUI) return;
	const planning = state.mode === "plan";
	const interrupted = state.execution?.status === "interrupted";
	if (!planning && !interrupted) {
		ctx.ui.setWidget("nek.plan", undefined);
		return;
	}
	ctx.ui.setWidget("nek.plan", () => ({
		invalidate: () => {},
		render: (width) => {
			const theme = ctx.ui.theme;
			const status = planning
				? state.planStatus === "ready"
					? "Ready for review"
					: state.plan
						? "Revising plan"
						: "Drafting plan"
				: "Plan execution interrupted";
			const name = state.plan ? `  ${state.plan.name} / r${state.plan.revision}` : "";
			const action = planning ? `  ${rawKeyHint(shortcut, "switch mode")}  ${theme.fg("muted", "/agent exit")}` : "";
			return new Text(
				theme.fg(planning ? "accent" : "warning", status) + theme.fg("muted", name) + action,
				1,
				0,
			).render(width);
		},
	}));
}
