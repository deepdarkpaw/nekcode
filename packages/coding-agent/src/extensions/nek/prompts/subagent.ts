import type { SubagentRecord } from "../types.ts";

/**
 * Cursor subagent runtime reminder from reference/cursor/cursor-subagent-runtime-reminder.md lines 1-3,
 * with the tool name mapped to subagent (the `<system_reminder>` body).
 */
export const SUBAGENT_REMINDER = `You are currently working inside a subagent. Your parent agent has delegated a clearly bounded assignment to you. Complete that assignment directly with the tools available in this session. The subagent tool is unavailable inside subagents, so delegation cannot be nested.`;

/** System prompt section tag that carries the delegated agent type instructions. */
export const SUBAGENT_INSTRUCTIONS_SECTION = "subagent_instructions";

/**
 * Instructions of the built-in explore type, derived from the explore entry of the Cursor subagent description
 * (reference/cursor/cursor-tools-2026.json line 679): read-only, and the answer states its depth.
 */
export const EXPLORE_INSTRUCTIONS = `Explore the codebase to answer the question in the task prompt. You cannot edit files: report findings, file paths, and code structure instead of changing anything. State the desired depth in your answer: quick, medium, or very thorough.`;

/** System prompt section that lists the subagent types and the model overrides (see `subagentsSection()`). */
export const SUBAGENTS_SECTION = "subagents";

/**
 * SUBAGENT_DESCRIPTION: condensed from the Cursor Task description (reference/cursor/cursor-tools-2026.json line 679).
 * The type and model lists live in the `subagents` system prompt section, so this description is static. Spawning
 * authorization follows Codex spawn_agent (codex-rs/core/src/tools/handlers/multi_agents_spec.rs): only types marked
 * autonomous may be started without an explicit user request.
 */
export const SUBAGENT_DESCRIPTION = `Launch a subagent: a separate agent with its own context window that completes one clearly bounded task and returns its final answer to you. The available types and model overrides are listed in the <subagents> section of the system prompt.

When to delegate
- By default, do the work yourself with your own tools. A task being broad, multi-step, exploratory, or uncertain is not by itself a reason to delegate.
- Types marked [autonomous] may be started on your own initiative when a task clearly needs broad codebase exploration that would take many searches or flood your context with raw output.
- Every other type, including custom types, needs an explicit user request: the user asks for a subagent, delegation, or parallel work, or names the agent. Requests for depth, thoroughness, investigation, or research do not count as permission.
- Never delegate what one or a few direct tool calls can do, and never hand the whole request to a subagent and relay its answer. You remain responsible for understanding the request, integrating results, and the final response.

How to call
- prompt must be self-contained: the subagent cannot see this conversation. State the goal, the relevant context (file paths, findings, constraints), whether it may edit files, and what it should return.
- description is a short, specific title the user sees.
- Omit model unless the user explicitly asks for a model (see <subagents>).
- Treat the result as working material and verify it in proportion to the risk before relying on it.
- When two or three independent tasks qualify, start them in the same response. Do not split one investigation just to run it in parallel.
- run_in_background returns immediately; you are notified when the subagent finishes, so do not poll.
- resume continues an existing subagent with its context; set interrupt only when the user asks to redirect a running one. Without resume, every call starts a fresh subagent.
- When mentioning a subagent to the user, link it as [Name](id).`;

/** Model override rules for the scoped models (`provider/id`); without a model scope only the rule is stated. */
function subagentModelSection(models: readonly string[]): string {
	const rule =
		"Types with a preset model always use it; omit model (a different value is rejected). Only types without a preset accept model overrides; omitted model or inherit uses your model. Set model only when the user explicitly asks for a specific model. Ignored with resume.";
	if (models.length === 0) return `Model overrides\n\n${rule}`;
	const list = ["inherit", ...models].map((model) => `- ${model}`).join("\n");
	return `Model overrides\n\n${rule} Allowed values:\n${list}\n\nIf the requested model is not listed, do not substitute or guess: skip the call and tell the user which models are available.`;
}

/** Body of the `subagents` system prompt section: the agent type list (`describeAgentTypes()` output) and model overrides. */
export function subagentsSection(agentTypes: string, models: readonly string[]): string {
	return [agentTypes, subagentModelSection(models)].join("\n\n");
}

/**
 * AWAIT_DESCRIPTION: Cursor AwaitShell description (reference/cursor/cursor-grok46-system-prompt-with-tools.txt line
 * 142) with shell jobs replaced by background subagents and the shell-only sleep usage removed.
 */
export const AWAIT_DESCRIPTION = `Check or poll a background subagent. Omit subagent_id to wait for whichever running background subagent finishes first. At the end of your turn, you will be notified about any unawaited subagents that completed. If you think a subagent completed (e.g. because it was cancelled), observe it with await to skip the notification, because stale notifications can confuse the user.

Prefer NOT to poll reflexively with await.`;

/** Codex ERROR_NEXT_ACTION counterpart from plan.md section 7.7. */
export const SUBAGENT_ERROR_NEXT_ACTION = "Decide whether to retry, resume with more context, or proceed without it.";

/** Result text of one finished subagent for subagent and await: header line, then the final text or the error. */
export function formatSubagentResult(record: SubagentRecord): string {
	const header = `Subagent ${record.id} (${record.description}) ${record.status}.`;
	if (record.status === "errored") {
		return `${header}\n\nError: ${record.error ?? "unknown error"}\n\n${SUBAGENT_ERROR_NEXT_ACTION}`;
	}
	return record.finalText ? `${header}\n\n${record.finalText}` : header;
}

/** Background start result of the subagent tool (plan.md section 7.7). */
export function backgroundSubagentStartText(record: SubagentRecord): string {
	return `Started subagent ${record.id} ("${record.description}") in the background. You will be notified when it completes; do not poll.`;
}

/**
 * COMPLETION_NOTICE: Codex `format_inter_agent_completion_message` layout (codex-rs/core/src/session_prefix.rs and
 * context/inter_agent_completion_message.rs) wrapped in Cursor's `<system_notification>` tag.
 */
export function completionNotice(record: SubagentRecord): string {
	const body = `Message Type: FINAL_ANSWER
Subagent name: ${record.description}
Sender: ${record.id}
Payload:
${noticePayload(record)}`;
	return `<system_notification>
${body}
</system_notification>`;
}

function noticePayload(record: SubagentRecord): string {
	if (record.status === "errored")
		return `Agent errored: ${record.error ?? "unknown error"}

${SUBAGENT_ERROR_NEXT_ACTION}`;
	if (record.status === "aborted") return "Agent was aborted.";
	return record.finalText ?? "";
}
