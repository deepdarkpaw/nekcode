import type { Mode } from "../types.ts";

/**
 * Plan mode runtime reminder, condensed from reference/cursor/cursor-plan-mode-runtime-reminder.md lines 13-64 (the
 * third `<system_reminder>` block): the opening paragraph is verbatim, the twelve rules are merged into five, and
 * `<mermaid_syntax>` keeps only the rules the renderer needs. `CreatePlan` and `AskQuestion` become `create_plan` and
 * `ask_question`.
 */
export const PLAN_MODE_REMINDER = `Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received (for example, to make edits). Instead, you should:

1. Answer the user's query comprehensively by researching with read-only tools. To speed up broad research, run parallel explore subagents on different parts of the codebase or different angles.

2. If information you cannot find in the code or instructions is missing, instructions are ambiguous, the scope is too broad, or several valid implementations would change the plan significantly, you MUST ask the user with the ask_question tool before planning. Ask 1-2 critical questions at a time, immediately at the start; do a small pre-read first only if ≤5 files (~20s) will likely answer them. Ask only about decisions that change the plan, never about routine procedure such as committing or backups.

3. When you're done researching, present your plan by calling the create_plan tool, which will prompt the user to confirm the plan. To revise an existing plan, read the plan file, use edit for incremental changes, then call update_plan. Do NOT make any other changes until the user has confirmed the plan.

4. Keep the plan concise, specific, actionable, and proportional to the request; don't over-engineer simple tasks. Cite specific file paths as markdown links with the full path (for example, \`[backend/src/foo.ts](backend/src/foo.ts)\`) and include essential code snippets. Do NOT use emojis.

5. Use mermaid diagrams when they make architecture, data flows, or complex relationships clearer.

<mermaid_syntax>
- Node IDs without spaces (\`userService\`, \`user_service\`); never \`end\`, \`subgraph\`, \`graph\`, or \`flowchart\` as IDs.
- Quote labels with special characters: \`A["Process (main)"]\`, \`A -->|"O(1) lookup"| B\`.
- Subgraphs need an ID and a bracketed label: \`subgraph auth [Authentication Flow]\`.
- No angle brackets or HTML entities in labels, no colors or styling (\`style\`, \`classDef\`, \`:::\`), no \`click\`.
</mermaid_syntax>`;

/**
 * Cursor `<plan_mode_guardrails>` block, verbatim from reference/cursor/cursor-evidence-2026-08-02-README.md
 * lines 62-66. `SwitchMode` is renamed to `switch_mode`.
 */
export const PLAN_MODE_GUARDRAILS = `<plan_mode_guardrails>
- In plan mode, only edit markdown files.
- If the user is refining the plan, stay in plan mode and keep edits in markdown.
- If the user explicitly asks you to build, implement, or write the code now, switch to agent mode before making non-markdown edits by calling \`switch_mode\` with \`target_mode_id=agent\`.
</plan_mode_guardrails>`;

/** Cursor plan enter notice, verbatim from reference/cursor/cursor-plan-mode-runtime-reminder.md line 2. */
export const ENTER_PLAN_MODE =
	"You are now in Plan mode. You have EXITED your previous mode. Continue with the task in the new mode.";

/** Cursor agent enter notice, verbatim from reference/cursor/cursor-agent-runtime-reminder.md line 2. */
export const ENTER_AGENT_MODE =
	"You are now in Agent mode. You have EXITED your previous mode. Continue with the task in the new mode.";

/** Cursor still-in-plan notice, verbatim from reference/cursor/cursor-plan-mode-runtime-reminder.md line 69. */
export const STILL_IN_PLAN_MODE = "You are still in **Plan Mode**";

/** Display name of a mode, e.g. `Plan`. */
export function modeLabel(mode: Mode): string {
	return mode === "plan" ? "Plan" : "Agent";
}

/** switch_mode result after an approved switch: the enter notice, plus the plan reminder and guardrails for plan. */
export function switchModeResult(mode: Mode): string {
	if (mode === "agent") return ENTER_AGENT_MODE;
	return [ENTER_PLAN_MODE, PLAN_MODE_REMINDER, PLAN_MODE_GUARDRAILS].join("\n\n");
}

/** Wrap one reminder body in Cursor's `<system_reminder>` tags. */
export function systemReminder(body: string): string {
	return `<system_reminder>\n${body}\n</system_reminder>`;
}

/**
 * Hidden reminder for one user submission, in Cursor's block order: the enter notice right after a mode change
 * (otherwise nothing in agent mode), then in plan mode the plan reminder, the guardrails, and the still-in-plan notice
 * when the mode did not just change. Returns undefined when there is nothing to say.
 */
export function modeReminder(mode: Mode, entered: boolean): string | undefined {
	const blocks: string[] = [];
	if (entered) blocks.push(systemReminder(mode === "plan" ? ENTER_PLAN_MODE : ENTER_AGENT_MODE));
	if (mode === "plan") {
		blocks.push(systemReminder(PLAN_MODE_REMINDER), PLAN_MODE_GUARDRAILS);
		if (!entered) blocks.push(systemReminder(STILL_IN_PLAN_MODE));
	}
	return blocks.length > 0 ? blocks.join("\n\n") : undefined;
}
