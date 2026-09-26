/**
 * Cursor `<task_management>` section body, verbatim from
 * reference/cursor/cursor-opus5-agent-system-prompt.txt lines 252-256 (body lines 253-255; the section tag is added
 * by the system prompt builder).
 */
export const TASK_MANAGEMENT = `You have access to the todo_write tool to help you manage and plan tasks. Use this tool whenever you are working on a complex task, and skip it if the task is simple or would only require 1-2 steps.

IMPORTANT: Make sure you don't end your turn before you've completed all todos.`;

/**
 * Hidden reminder sent once per run when it would end with open todos (plan.md section 5.6).
 * Cursor has no published equivalent, so the text comes from plan.md.
 */
export function openTodosReminder(openTodoList: string): string {
	return `You still have open todos: ${openTodoList}. Continue working on them, or mark them cancelled if no longer needed, before ending your turn.`;
}
