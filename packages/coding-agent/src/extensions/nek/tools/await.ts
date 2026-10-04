import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../../core/extensions/types.ts";
import { AWAIT_DESCRIPTION, formatSubagentResult } from "../prompts/subagent.ts";
import type { SubagentRegistry } from "../services/subagent-registry.ts";
import type { AwaitToolData, SubagentRecord } from "../types.ts";
import { awaitRenderers } from "../ui/subagent-view.ts";
import { snapshotSubagent } from "./subagent.ts";

/** Tool name of the Cursor AwaitShell counterpart (snake_case, plan.md D3). */
export const AWAIT_TOOL_NAME = "await";

/** Schema from Cursor AwaitShell (reference/cursor/cursor-grok46-system-prompt-with-tools.txt), subagent fields only. */
const awaitSchema = Type.Object({
	subagent_id: Type.Optional(
		Type.String({
			description:
				"Optional subagent id to poll. Omit to wait for whichever running background subagent finishes first.",
		}),
	),
	block_until_ms: Type.Optional(
		Type.Number({
			maximum: 7140000,
			description:
				"Max sleep time to block before returning (in milliseconds). Defaults to 30000ms. Set to 0 for non-blocking status check. Must not exceed 7140000 (119 minutes).",
		}),
	),
});

/** Validated await arguments. */
export type AwaitToolInput = Static<typeof awaitSchema>;

/** Access to the registry owned by the extension. */
export interface AwaitToolOptions {
	getRegistry(): SubagentRegistry;
}

/** One line per subagent that is still running: `id running (Ns)`. */
function runningLines(records: readonly SubagentRecord[], now: number): string[] {
	return records
		.filter((record) => record.status === "running")
		.map(
			(record) => `${record.description} (${record.id}) running (${Math.round((now - record.startedAt) / 1000)}s)`,
		);
}

/** Result text: every finished subagent's result, then the running ones, then the timeout note. */
function awaitText(done: readonly SubagentRecord[], running: readonly string[], timedOut: boolean): string {
	const parts = done.map(formatSubagentResult);
	if (running.length > 0) parts.push(`Still running:\n${running.join("\n")}`);
	if (timedOut) parts.push("timed_out: true. No subagent finished before block_until_ms elapsed.");
	return parts.join("\n\n");
}

/**
 * Cursor AwaitShell for subagents as `await` (plan.md section 7.7): wait for one subagent or the first background subagent to
 * finish, with the timeout clamped to `[1000, awaitMaxMs]`; `<= 0` is a non-blocking check. Returned results are
 * observed and no longer produce a completion notice.
 */
export function createAwaitToolDefinition(
	options: AwaitToolOptions,
): ToolDefinition<typeof awaitSchema, AwaitToolData> {
	return {
		name: AWAIT_TOOL_NAME,
		label: "Waiting",
		description: AWAIT_DESCRIPTION,
		parameters: awaitSchema,
		async execute(_toolCallId, { subagent_id, block_until_ms }: AwaitToolInput, signal) {
			const registry = options.getRegistry();
			const scope = subagent_id ? [subagent_id] : undefined;
			const pending = registry
				.list()
				.some((record) => record.background && (record.status === "running" || !record.observed));
			if (!subagent_id && !pending) {
				return {
					content: [{ type: "text", text: "No running subagents." }],
					details: { subagents: [], running: [], timedOut: false, interrupted: false },
				};
			}
			const { done, timedOut, interrupted } = await registry.await(scope, block_until_ms, signal);
			const pool = subagent_id ? registry.list().filter((record) => record.id === subagent_id) : registry.list();
			const runningRecords = pool.filter((record) => record.status === "running");
			const running = runningLines(runningRecords, Date.now());
			const text = interrupted
				? `${awaitText(done, running, false)}${running.length > 0 ? "\n\n" : ""}Wait ended because the user sent a new message. Subagents keep running; await again after responding if still needed.`
				: awaitText(done, running, timedOut) || "No subagent has finished yet.";
			return {
				content: [{ type: "text", text }],
				details: {
					subagents: done.map(snapshotSubagent),
					running: runningRecords.map(snapshotSubagent),
					timedOut,
					interrupted,
				},
			};
		},
		...awaitRenderers(options.getRegistry),
	};
}
