import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../../core/extensions/types.ts";
import { STOP_SUBAGENT_DESCRIPTION } from "../prompts/subagent.ts";
import type { SubagentRegistry } from "../services/subagent-registry.ts";
import type { StopSubagentToolData } from "../types.ts";
import { stopSubagentRenderers } from "../ui/subagent-view.ts";
import { snapshotSubagent } from "./subagent.ts";

/** Tool name of the Claude Code TaskStop counterpart for subagents (snake_case, plan.md D3). */
export const STOP_SUBAGENT_TOOL_NAME = "stop_subagent";

/** Schema from Claude Code TaskStop, with task_id renamed to subagent_id like await. */
const stopSubagentSchema = Type.Object({
	subagent_id: Type.String({ description: "The ID of the subagent to stop" }),
});

/** Validated stop_subagent arguments. */
export type StopSubagentToolInput = Static<typeof stopSubagentSchema>;

/** Access to the registry owned by the extension. */
export interface StopSubagentToolOptions {
	getRegistry(): SubagentRegistry;
}

/**
 * Stop a running subagent, as `/subagents` → Cancel does: the child's run is aborted, the record stays, marked
 * aborted and observed, so no completion notice follows. An unknown ID is an error; a finished one is reported as is.
 */
export function createStopSubagentToolDefinition(
	options: StopSubagentToolOptions,
): ToolDefinition<typeof stopSubagentSchema, StopSubagentToolData> {
	return {
		name: STOP_SUBAGENT_TOOL_NAME,
		label: "Stop Subagent",
		promptSnippet: "Stop a running subagent",
		description: STOP_SUBAGENT_DESCRIPTION,
		parameters: stopSubagentSchema,
		// Stopping again after a crash stops nothing new: the subagent is stopped or no longer retained.
		replay: "safe",
		async execute(_toolCallId, { subagent_id }: StopSubagentToolInput) {
			const registry = options.getRegistry();
			const record = registry.get(subagent_id);
			if (!record) throw new Error(`Unknown subagent ${subagent_id}.`);
			const stopped = record.status === "running";
			if (stopped) await registry.abort(subagent_id);
			const text = stopped
				? `Stopped subagent ${record.id} (${record.description}); status: ${record.status}.`
				: `Subagent ${record.id} (${record.description}) is not running; status: ${record.status}.`;
			return {
				content: [{ type: "text", text }],
				details: { subagent: snapshotSubagent(record), stopped },
			};
		},
		...stopSubagentRenderers(options.getRegistry),
	};
}
