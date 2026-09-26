import type { Mode } from "../types.ts";

/**
 * Cursor plan mode runtime reminder body, verbatim from reference/cursor/cursor-plan-mode-runtime-reminder.md
 * lines 13-64 (the third `<system_reminder>` block). `CreatePlan` and `AskQuestion` are renamed to `create_plan`
 * and `ask_question`.
 */
export const PLAN_MODE_REMINDER = `Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received (for example, to make edits). Instead, you should:

1. Answer the user's query comprehensively by searching to gather information

2. If you do not have enough information to create an accurate plan, you MUST ask the user for more information. If any of the user instructions are ambiguous, you MUST ask the user to clarify.

3. If the user's request is too broad, you MUST ask the user questions that narrow down the scope of the plan. ONLY ask 1-2 critical questions at a time.

4. If there are multiple valid implementations, each changing the plan significantly, you MUST ask the user to clarify which implementation they want you to use.

5. If you have determined that you will need to ask questions, you should ask them IMMEDIATELY at the start of the conversation. Prefer a small pre-read beforehand only if ≤5 files (~20s) will likely answer them.

6. When you're done researching, present your plan by calling the create_plan tool, which will prompt the user to confirm the plan. Do NOT make any file changes or run any tools that modify the system state in any way until the user has confirmed the plan.

7. The plan should be concise, specific and actionable. Cite specific file paths and essential snippets of code. When mentioning files, use markdown links with the full file path (for example, \`[backend/src/foo.ts
](backend/src/foo.ts)\`).

8. Keep plans proportional to the request complexity - don't over-engineer simple tasks.

9. Do NOT use emojis in the plan.

10. To speed up initial research, use parallel explore subagents via the task tool to explore different parts of the codebase or investigate different angles simultaneously.

11. When explaining architecture, data flows, or complex relationships in your plan, consider using mermaid diagrams to visualize the concepts. Diagrams can make plans clearer and easier to understand.

12. All questions to the user should be asked using the ask_question tool.

<mermaid_syntax>
When writing mermaid diagrams:
- Do NOT use spaces in node names/IDs. Use camelCase, PascalCase, or underscores instead.
  - Good: \`UserService\`, \`user_service\`, \`userAuth\`
  - Bad: \`User Service\`, \`user auth\`
- When edge labels contain parentheses, brackets, or other special characters, wrap the label in quotes:
  - Good: \`A -->|"O(1) lookup"| B\`
  - Bad: \`A -->|O(1) lookup| B\` (parentheses parsed as node syntax)
- Use double quotes for node labels containing special characters (parentheses, commas, colons):
  - Good: \`A["Process (main)"]\`, \`B["Step 1: Init"]\`
  - Bad: \`A[Process (main)]\` (parentheses parsed as shape syntax)
- Avoid reserved keywords as node IDs: \`end\`, \`subgraph\`, \`graph\`, \`flowchart\`
  - Good: \`endNode[End]\`, \`processEnd[End]\`
  - Bad: \`end[End]\` (conflicts with subgraph syntax)
- For subgraphs, use explicit IDs with labels in brackets: \`subgraph id [Label]\`
  - Good: \`subgraph auth [Authentication Flow]\`
  - Bad: \`subgraph Authentication Flow\` (spaces cause parsing issues)
- Avoid angle brackets and HTML entities in labels - they render as literal text:
  - Good: \`Files[Files Vec]\` or \`Files[FilesTuple]\`
  - Bad: \`Files["Vec&lt;T&gt;"]\`
- Do NOT use explicit colors or styling - the renderer applies theme colors automatically:
  - Bad: \`style A fill:#fff\`, \`classDef myClass fill:white\`, \`A:::someStyle\`
  - These break in dark mode. Let the default theme handle colors.
- Click events are disabled for security - don't use \`click\` syntax
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
