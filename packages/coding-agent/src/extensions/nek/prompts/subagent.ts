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

/**
 * SUBAGENT_DESCRIPTION: Cursor subagent description, from reference/cursor/cursor-tools-2026.json line 679 (2026). Tool names
 * are mapped to pi (Read/Glob/Grep/Shell -> read/find/grep/bash); cloud links, `resume="self"`, and the fixed type and model lists
 * are removed. The type list and the model section are generated per session (plan.md sections 7.3 and 7.5).
 */
export const SUBAGENT_DESCRIPTION = `Launch a new agent to autonomously handle a clearly bounded task that is suitable for delegation.

The subagent tool starts a dedicated subagent. Each subagent_type has specific capabilities and available tools. When using subagent, select the agent type through subagent_type.

Default behavior

Handle the user's request directly by default, preferring direct tools such as read, find, grep, bash, and MCP. A task being broad, multi-step, requiring codebase exploration, having an uncertain answer, or theoretically parallelizable is not by itself a reason to use subagent.

Use subagent only when at least one of the following applies:
- The user explicitly asks to start an agent, subagent, or worker, or explicitly asks for parallel delegation.
- There is a substantial, clearly bounded workflow that can be completed independently and delegating it would materially help the current task.
- The task genuinely requires capabilities provided by a specialized subagent_type.

If the current agent can complete the work with one or a few direct tool calls, do not use subagent. Do not hand the entire user request to a subagent and simply return its result; the current agent remains responsible for understanding the user's intent, integrating results, and producing the final response.

Concurrency rules

- Launch one to three subagents by default, matching the number of independent workflows that genuinely need delegation.
- Launch multiple subagents at the same time only when the user explicitly requests parallel agents or when there are two or three independent, substantial workflows.
- When the user does not specify a number, launch at most three subagents in a single response. If the user explicitly requests more, you may launch the requested number.
- Do not artificially split one investigation, one execution chain, or work that one agent can complete sequentially merely to create parallelism.
- When multiple subagents should start together, issue multiple subagent calls in the same message.

Examples

- The user asks, "Where is the ClientError class defined?": use grep or find directly; do not use subagent.
- The user asks to read a known file: use read directly; do not use subagent.
- The user asks to search two or three specified files: use read, grep, or find directly; do not use subagent.
- The user asks to run a query through a database API: call the relevant MCP directly; do not use subagent.
- The user broadly asks about the repository structure: investigate with direct tools first; broad scope alone does not require delegation.
- The user explicitly asks to "start two agents to investigate the client and server separately": start two clearly bounded tasks in parallel.

Usage requirements

- description must be a short, specific title that users can easily recognize.
- prompt must clearly state the work the subagent should complete, its scope, constraints, and the information it should return.
- Subagents cannot see the user's original message or the parent's previous steps, so prompt must include the context required to complete the task without copying unrelated context.
- A subagent's response is working material for the parent. Verify it as appropriate for the task's risk instead of accepting it unconditionally.
- Descriptions of subagent types explain their capabilities but do not override the rule that the current agent handles work directly by default. Do not call a type proactively merely because its description says it can be used proactively.
- If the user explicitly requests parallel subagents, follow the number requested by the user.

Resume and interruption

- Use resume with an existing agent ID to continue that agent while preserving its context.
- If the target agent is still running, a resume request fails unless interrupt=true.
- Set interrupt=true only when the user explicitly asks to interrupt or change a running agent.
- Without resume, each subagent call starts a new agent, so prompt must be self-contained.

Display rules

If you mention an agent or subagent in a user-facing response, link it as \`[Name](id)\`. Do not use generic labels such as \`[agent]\`, \`[worker]\`, or \`[subagent]\`.`;

const SUBAGENT_DESCRIPTION_TAIL = `Background agents

Background agents automatically send a completion notification after the current response ends.`;

/** Cursor model section header and rules (same source), with the model list supplied by the session. */
function subagentModelSection(models: readonly string[]): string {
	if (models.length === 0) {
		return "Subagent model\n\nUse inherit unless the user explicitly requests another model (provider/model).";
	}
	const list = ["inherit", ...models].map((model) => `- ${model}`).join("\n");
	return `Subagent model

Choose from the following list only when the user explicitly requests a subagent model:
${list}

When the user does not explicitly specify a model, use inherit. If the requested model is not in the list, do not substitute or guess. Skip that subagent call and tell the user that the model is unavailable and which models are available.`;
}

/**
 * Full subagent tool description: SUBAGENT_DESCRIPTION, the agent type list (`describeAgentTypes()` output), the model section
 * for the scoped models (`provider/id`; empty when the session has no model scope), and the background note.
 */
export function subagentDescription(agentTypes: string, models: readonly string[]): string {
	return [SUBAGENT_DESCRIPTION, agentTypes, subagentModelSection(models), SUBAGENT_DESCRIPTION_TAIL].join("\n\n");
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
