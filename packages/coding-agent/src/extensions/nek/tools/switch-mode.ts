import { StringEnum } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../../../core/extensions/types.ts";
import { modeLabel, switchModeResult } from "../prompts/plan-mode.ts";
import { SWITCH_MODE } from "../prompts/tool-descriptions.ts";
import { MODES, SWITCH_MODE_TOOL_NAME } from "../state/session-state.ts";
import type { Mode } from "../types.ts";
import { switchModeRenderers } from "../ui/renderers.ts";

const switchModeSchema = Type.Object({
	explanation: Type.Optional(
		Type.String({
			description:
				"Optional explanation for why the mode switch is requested. This helps the user understand why you're switching modes.",
		}),
	),
	target_mode_id: StringEnum(MODES, { description: "The mode to switch to. Allowed values: 'plan', 'agent'." }),
});

/** Validated switch_mode arguments. */
export type SwitchModeToolInput = Static<typeof switchModeSchema>;

/** Access to the mode owned by the extension. */
export interface SwitchModeToolOptions {
	getMode(): Mode;
	/** Apply an approved switch. The tool result carries the enter notice, so no reminder is queued. */
	setMode(mode: Mode, ctx: ExtensionContext): void;
}

function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: undefined };
}

/**
 * Cursor SwitchMode as `switch_mode` (description and schema from reference/cursor/cursor-tools-2026.json, agent and
 * plan only). Every switch needs the user's confirmation; without dialog UI the call fails and the mode is unchanged.
 */
export function createSwitchModeToolDefinition(
	options: SwitchModeToolOptions,
): ToolDefinition<typeof switchModeSchema, undefined> {
	return {
		name: SWITCH_MODE_TOOL_NAME,
		label: "switch_mode",
		description: SWITCH_MODE,
		parameters: switchModeSchema,
		executionMode: "sequential",
		async execute(_toolCallId, { explanation, target_mode_id }: SwitchModeToolInput, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			const current = options.getMode();
			if (target_mode_id === current) return textResult(`Already in ${modeLabel(current)} mode.`);
			if (!ctx.hasUI) throw new Error("Mode switch requires user approval, which is unavailable in this run mode.");
			const approved = await ctx.ui.confirm(`Switch to ${modeLabel(target_mode_id)} mode?`, explanation ?? "", {
				signal,
			});
			signal?.throwIfAborted();
			if (options.getMode() !== current)
				throw new Error("The mode changed while this approval was pending. Request a new approval.");
			if (!approved) return textResult(`User declined the mode switch. Stay in ${modeLabel(current)} mode.`);
			options.setMode(target_mode_id, ctx);
			return textResult(switchModeResult(target_mode_id));
		},
		...switchModeRenderers,
	};
}
