import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../../../core/extensions/types.ts";
import { AWAIT_DESCRIPTION, formatTaskResult } from "../prompts/subagent.ts";
import type { TaskRegistry } from "../services/task-registry.ts";
import type { AwaitToolData, TaskRecord } from "../types.ts";
import { awaitRenderers } from "../ui/task-view.ts";
import { snapshotTask } from "./task.ts";

/** Tool name of the Cursor AwaitShell counterpart (snake_case, plan.md D3). */
export const AWAIT_TOOL_NAME = "await";

/** Schema from Cursor AwaitShell (reference/cursor/cursor-grok46-system-prompt-with-tools.txt), subagent fields only. */
const awaitSchema = Type.Object({
	task_id: Type.Optional(
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
	getRegistry(): TaskRegistry;
}

/** One line per task that is still running: `id running (Ns)`. */
function runningLines(records: readonly TaskRecord[], now: number): string[] {
	return records
		.filter((record) => record.status === "running")
		.map((record) => `${record.id} running (${Math.round((now - record.startedAt) / 1000)}s)`);
}

/** Result text: every finished task's result, then the running ones, then the timeout note. */
function awaitText(done: readonly TaskRecord[], running: readonly string[], timedOut: boolean): string {
	const parts = done.map(formatTaskResult);
	if (running.length > 0) parts.push(`Still running:\n${running.join("\n")}`);
	if (timedOut) parts.push("timed_out: true. No subagent finished before block_until_ms elapsed.");
	return parts.join("\n\n");
}

/**
 * Cursor AwaitShell for subagents as `await` (plan.md section 7.7): wait for one task or the first background task to
 * finish, with the timeout clamped to `[1000, awaitMaxMs]`; `<= 0` is a non-blocking check. Returned results are
 * observed and no longer produce a completion notice.
 */
export function createAwaitToolDefinition(
	options: AwaitToolOptions,
): ToolDefinition<typeof awaitSchema, AwaitToolData> {
	return {
		name: AWAIT_TOOL_NAME,
		label: "await",
		description: AWAIT_DESCRIPTION,
		parameters: awaitSchema,
		async execute(_toolCallId, { task_id, block_until_ms }: AwaitToolInput, signal) {
			const registry = options.getRegistry();
			const scope = task_id ? [task_id] : undefined;
			const pending = registry
				.list()
				.some((record) => record.background && (record.status === "running" || !record.observed));
			if (!task_id && !pending) {
				return {
					content: [{ type: "text", text: "No running subagents." }],
					details: { tasks: [], timedOut: false },
				};
			}
			const { done, timedOut } = await registry.await(scope, block_until_ms, signal);
			const pool = task_id ? registry.list().filter((record) => record.id === task_id) : registry.list();
			const running = runningLines(pool, Date.now());
			const text = awaitText(done, running, timedOut) || "No subagent has finished yet.";
			return { content: [{ type: "text", text }], details: { tasks: done.map(snapshotTask), timedOut } };
		},
		...awaitRenderers,
	};
}
