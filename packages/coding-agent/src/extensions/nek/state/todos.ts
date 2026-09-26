import type { Todo, TodoStatus } from "../types.ts";

/** Todo statuses in Cursor TodoWrite schema order. */
export const TODO_STATUSES = [
	"pending",
	"in_progress",
	"completed",
	"cancelled",
] as const satisfies readonly TodoStatus[];

/**
 * Apply one todo_write call. `merge=false` replaces the list; `merge=true` overrides items by id,
 * keeps the existing order, and appends new ids at the end in call order.
 */
export function mergeTodos(current: readonly Todo[], incoming: readonly Todo[], merge: boolean): Todo[] {
	if (!merge) return incoming.map((todo) => ({ ...todo }));
	const updates = new Map(incoming.map((todo) => [todo.id, todo]));
	const merged = current.map((todo) => ({ ...todo, ...updates.get(todo.id) }));
	const known = new Set(current.map((todo) => todo.id));
	for (const todo of incoming) {
		if (known.has(todo.id)) continue;
		known.add(todo.id);
		merged.push({ ...todo, ...updates.get(todo.id) });
	}
	return merged;
}

/** Items that still need work: pending or in_progress. */
export function openTodos(todos: readonly Todo[]): Todo[] {
	return todos.filter((todo) => todo.status === "pending" || todo.status === "in_progress");
}

/** Completed count over total, e.g. `2/5`. */
export function todoProgress(todos: readonly Todo[]): string {
	const completed = todos.filter((todo) => todo.status === "completed").length;
	return `${completed}/${todos.length}`;
}

/** Short tool result text for the model, e.g. `Todos updated: 2/5 completed. In progress: add-schema`. */
export function summarizeTodos(todos: readonly Todo[]): string {
	const summary = `Todos updated: ${todoProgress(todos)} completed.`;
	const inProgress = todos.filter((todo) => todo.status === "in_progress").map((todo) => todo.id);
	return inProgress.length > 0 ? `${summary} In progress: ${inProgress.join(", ")}` : summary;
}

/** One-line listing for reminders, e.g. `add-schema [in_progress] Add the schema; docs [pending] Write docs`. */
export function describeTodos(todos: readonly Todo[]): string {
	return todos.map((todo) => `${todo.id} [${todo.status}] ${todo.content}`).join("; ");
}
