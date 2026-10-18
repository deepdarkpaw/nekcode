/**
 * todo_write uses Cursor's short description and complexity-based trigger (reference/cursor/cursor-tools-2026.json
 * line 753 and cursor-opus5-agent-system-prompt.txt line 253), followed by concise list-management rules.
 */
export const TODO_WRITE = `Use this tool to create and manage a structured task list for your current coding session. The user sees it as your progress.

- Use it only for complex tasks that need progress tracking.
- Skip simple work, quick fixes, questions, and explanations, even when they involve several routine steps.
- merge=true updates items by id and keeps the others; merge=false replaces the whole list.
- Keep at most one item in_progress. Mark an item completed as soon as it is done, and cancelled when it is no longer needed.
- Write items as specific actions (for example "Add retry to fetchUser"), not vague goals.`;

/**
 * switch_mode description, condensed from Cursor SwitchMode (reference/cursor/cursor-tools-2026.json line 656): nek has
 * only agent and plan, so the when/when-not lists are merged and the per-mode examples dropped. Unlike Cursor it does
 * not ask for proactive switching: task size alone is no reason, because every proposal blocks on the user.
 */
export const SWITCH_MODE = `Propose switching the interaction mode. The call stops your work until the user approves or declines, so propose a switch only when the current mode clearly does not fit (see <autonomy>).

Modes
- agent: the default implementation mode with full tool access.
- plan: read-only collaboration (only markdown files can be edited) to research, clarify, and present a plan with create_plan before any code changes.

Propose plan when the user asks for a plan, when the request leaves open decisions that only the user can make and that would substantially change the implementation (for example which architecture, library, or data model to use), or when repeated attempts are not converging. Size alone is not a reason: a large or multi-file task with a clear goal and an evident approach stays in agent mode.
Propose agent when the plan or diagnosis is settled and the user wants it implemented.

Do not switch for clear tasks, in the middle of good progress, to ask one or two questions (use ask_question), for routine procedure such as committing or backups, or again after the user declined a switch for the same task.

Give a one-sentence reason in explanation; the user sees it in the approval prompt.`;

/**
 * Cursor CreatePlan description, verbatim from reference/cursor/cursor-tools-2026.json line 204.
 * `CreatePlan` and `AskQuestion` are renamed to `create_plan` and `ask_question`.
 */
export const CREATE_PLAN = `Use this tool to create or revise a concise plan for accomplishing the user's request. This tool should be called at the end of the planning phase to finalize and store the plan.

The plan you create should be properly formatted in markdown, using appropriate sections and headers. The plan should be very concise and actionable, providing the minimum amount of detail for the user to understand and action the plan. It may be helpful to identify the most important couple files you will change, and existing code you will leverage. Cite specific file paths and essential snippets of code. IMPORTANT: Do NOT use markdown tables in plan content (they cannot be rendered for the user); use bullet lists instead. The first line MUST BE A TITLE for the plan formatted as a level 1 markdown heading.

TASK ORGANIZATION:

Use 'todos' for organizing implementation tasks:
- Each todo should be a clear, specific, and actionable task
- Each todo needs a unique ID (e.g., "setup-auth") and descriptive content
- If the plan is simple, provide just a few high-level todos or none at all

UPDATING THE PLAN:
- The plan file URI and stable plan_id will be returned in the tool result.
- To revise the active plan for the same task, first read its plan file, then use edit for incremental changes (including overview and todos in the file's frontmatter), and call update_plan to submit it for review.
- To rewrite an existing saved plan as a complete document, call create_plan with its plan_id; the rewrite keeps its path and name and creates a new revision.
- To create a separate new plan, omit plan_id and provide its name when useful. Omitted plan_id always creates a new file; it never revises the active plan.

Additional guidelines:
- Avoid asking clarifying questions in the plan itself. Ask them before calling this tool. Present these to the user using the ask_question tool.
- Todos help break down complex plans into manageable, trackable tasks
- Focus on high-level meaningful decisions rather than low-level implementation details
- A good plan is glanceable, not a wall of text.`;

/** Description of the incremental plan submission tool. */
export const UPDATE_PLAN = `Use this tool to submit the current plan file for review after making incremental edits.

- This is the submission entry point for revising an existing plan. First read the selected plan file, then use edit to change the file before calling update_plan.
- Omit plan_id to update the active plan, or provide a saved plan_id to select another plan explicitly.
- Edit the markdown body or the overview and todos in the same file's frontmatter; do not rewrite the plan through this tool.
- The plan body must be non-empty. Submit only the changes made since the current reviewed snapshot.
- The tool reads the edited file, records a new revision when its document changed, and ends the turn for user review.`;

/**
 * Cursor AskQuestion description (reference/cursor/cursor-tools-2026.json line 7) with nek additions: the blocking cost
 * and what not to ask, a pointer to <autonomy>, and the last line limited to real choices so optional follow-ups stay in
 * the reply text.
 */
export const ASK_QUESTION = `Collect structured multiple-choice answers from the user. Use this tool only when you are blocked on a decision that is genuinely the user's to make: one you cannot resolve from the request, the project instructions, the code, or a sensible default. The call stops your work until the user answers, so never use it for routine procedure (committing, backups, running tests), for permission to continue in-scope work, or to offer optional follow-ups (see <autonomy>).

Usage notes:
- Ask 1-2 critical questions at a time
- Each question should have at least 2 options for the user to choose from
- Users will always be able to select "Other" to provide custom text input
- Use allow_multiple: true to allow multiple answers to be selected for a question
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label
- Do not ask whether a plan is ready; create_plan and update_plan request the user's approval

When you do need the user's choice, prefer this tool over listing the options in your reply text.`;
