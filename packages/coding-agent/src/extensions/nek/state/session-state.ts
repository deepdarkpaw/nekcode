import type { SessionEntry } from "../../../core/session-manager.ts";
import type { NekSessionState, Todo, TodoListData } from "../types.ts";
import { TODO_STATUSES } from "./todos.ts";

/** Tool name of the Cursor TodoWrite tool (snake_case, plan.md D3). */
export const TODO_WRITE_TOOL_NAME = "todo_write";

/** Custom entry type that sets the todo list outside todo_write (e.g. when a plan is implemented). */
export const NEK_TODOS_ENTRY_TYPE = "nek.todos";

/** Initial state of a branch without nek entries. */
export function createSessionState(): NekSessionState {
	return { mode: "agent", todos: [] };
}

/**
 * Rebuild branch-scoped state by replaying entries in order. The last todo_write result
 * (`details.todos`) or `nek.todos` entry (`data.todos`) wins; failed tool results are ignored.
 */
export function replayBranch(entries: readonly SessionEntry[]): NekSessionState {
	const state = createSessionState();
	for (const entry of entries) {
		const todos = todosFromEntry(entry);
		if (todos) state.todos = todos;
	}
	return state;
}

function todosFromEntry(entry: SessionEntry): Todo[] | undefined {
	if (entry.type === "custom" && entry.customType === NEK_TODOS_ENTRY_TYPE) return readTodoList(entry.data);
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role !== "toolResult" || message.toolName !== TODO_WRITE_TOOL_NAME || message.isError) return undefined;
	return readTodoList(message.details);
}

function readTodoList(value: unknown): Todo[] | undefined {
	if (!isTodoListData(value)) return undefined;
	return value.todos.map((todo) => ({ id: todo.id, content: todo.content, status: todo.status }));
}

function isTodoListData(value: unknown): value is TodoListData {
	if (typeof value !== "object" || value === null || !("todos" in value)) return false;
	return Array.isArray(value.todos) && value.todos.every(isTodo);
}

function isTodo(value: unknown): value is Todo {
	if (typeof value !== "object" || value === null) return false;
	const todo = value as Record<string, unknown>;
	return (
		typeof todo.id === "string" &&
		typeof todo.content === "string" &&
		TODO_STATUSES.some((status) => status === todo.status)
	);
}
