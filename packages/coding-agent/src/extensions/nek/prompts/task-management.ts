/**
 * `<task_management>` uses Cursor's complexity-based trigger (reference/cursor/cursor-opus5-agent-system-prompt.txt
 * line 253), not a step-count threshold. Ending the turn means closing out the list, not forcing every todo to completion.
 */
export const TASK_MANAGEMENT = `You have access to the todo_write tool to help you manage and plan tasks. Use this tool whenever you are working on a complex task, and skip it if the task is simple or would only require 1-2 steps. Skip simple work even if it involves several routine steps.

Before ending your turn, mark finished todos completed and cancel the ones that are no longer needed.`;

/**
 * Hidden reminder sent once per run when it would end with open todos (plan.md section 5.6).
 * Cursor has no published equivalent, so the text comes from plan.md.
 */
export function openTodosReminder(openTodoList: string): string {
	return `You still have open todos: ${openTodoList}. Continue working on them, or mark them cancelled if no longer needed, before ending your turn.`;
}
