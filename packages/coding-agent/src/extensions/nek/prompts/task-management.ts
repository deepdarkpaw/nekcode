/**
 * `<task_management>` section body: Cursor's opening sentence (reference/cursor/cursor-opus5-agent-system-prompt.txt
 * line 253) with the thresholds of Claude Code's TodoWrite prompt. The section tag is added by the system prompt
 * builder. Ending the turn means closing out the list, not forcing every todo to completion.
 */
export const TASK_MANAGEMENT = `You have access to the todo_write tool to help you manage and plan tasks. Use it for work with several distinct steps (roughly three or more) or when the user gives a list of tasks; skip it for single-step or trivial tasks and for questions.

Before ending your turn, mark finished todos completed and cancel the ones that are no longer needed.`;

/**
 * Hidden reminder sent once per run when it would end with open todos (plan.md section 5.6).
 * Cursor has no published equivalent, so the text comes from plan.md.
 */
export function openTodosReminder(openTodoList: string): string {
	return `You still have open todos: ${openTodoList}. Continue working on them, or mark them cancelled if no longer needed, before ending your turn.`;
}
