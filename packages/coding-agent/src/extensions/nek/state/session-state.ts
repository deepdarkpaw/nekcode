import type { SessionEntry } from "../../../core/session-manager.ts";
import type { Mode, ModeEntryData, NekSessionState, PlanRecord, Todo, TodoListData } from "../types.ts";
import { TODO_STATUSES } from "./todos.ts";

/** Tool name of the Cursor TodoWrite tool (snake_case, plan.md D3). */
export const TODO_WRITE_TOOL_NAME = "todo_write";

/** Tool name of the Cursor CreatePlan tool (snake_case, plan.md D3). */
export const CREATE_PLAN_TOOL_NAME = "create_plan";

/** Tool name of the Cursor SwitchMode tool (snake_case, plan.md D3). */
export const SWITCH_MODE_TOOL_NAME = "switch_mode";

/** Tool name of the Cursor AskQuestion tool (snake_case, plan.md D3). */
export const ASK_QUESTION_TOOL_NAME = "ask_question";

/** Custom entry type that sets the todo list outside todo_write (e.g. when a plan is implemented). */
export const NEK_TODOS_ENTRY_TYPE = "nek.todos";

/** Custom entry type that records a mode change (`data: { mode }`). */
export const NEK_MODE_ENTRY_TYPE = "nek.mode";

/** Modes in switch_mode schema order. */
export const MODES = ["plan", "agent"] as const satisfies readonly Mode[];

/** Initial state of a branch without nek entries. */
export function createSessionState(): NekSessionState {
	return { mode: "agent", todos: [] };
}

/**
 * Rebuild branch-scoped state by replaying entries in order. The last `nek.mode` entry sets the mode; the last
 * todo_write result (`details.todos`) or `nek.todos` entry (`data.todos`) sets the todos; the last create_plan result
 * (`details.plan`) sets the plan. Failed tool results are ignored.
 */
export function replayBranch(entries: readonly SessionEntry[]): NekSessionState {
	const state = createSessionState();
	for (const entry of entries) {
		const mode = modeFromEntry(entry);
		if (mode) state.mode = mode;
		const todos = todosFromEntry(entry);
		if (todos) state.todos = todos;
		const plan = planFromEntry(entry);
		if (plan) state.plan = plan;
	}
	return state;
}

function modeFromEntry(entry: SessionEntry): Mode | undefined {
	if (entry.type !== "custom" || entry.customType !== NEK_MODE_ENTRY_TYPE) return undefined;
	const data = entry.data as Partial<ModeEntryData> | undefined;
	return MODES.find((mode) => mode === data?.mode);
}

function todosFromEntry(entry: SessionEntry): Todo[] | undefined {
	if (entry.type === "custom" && entry.customType === NEK_TODOS_ENTRY_TYPE) return readTodoList(entry.data);
	return readTodoList(successfulToolDetails(entry, TODO_WRITE_TOOL_NAME));
}

function planFromEntry(entry: SessionEntry): PlanRecord | undefined {
	const details = successfulToolDetails(entry, CREATE_PLAN_TOOL_NAME);
	if (typeof details !== "object" || details === null || !("plan" in details)) return undefined;
	return isPlanRecord(details.plan) ? clonePlan(details.plan) : undefined;
}

function successfulToolDetails(entry: SessionEntry, toolName: string): unknown {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role !== "toolResult" || message.toolName !== toolName || message.isError) return undefined;
	return message.details;
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

function isPlanRecord(value: unknown): value is PlanRecord {
	if (typeof value !== "object" || value === null) return false;
	const plan = value as Record<string, unknown>;
	if (typeof plan.name !== "string" || typeof plan.path !== "string" || typeof plan.overview !== "string") {
		return false;
	}
	return Array.isArray(plan.todos) && plan.todos.every(isPlanTodo);
}

function isPlanTodo(value: unknown): value is PlanRecord["todos"][number] {
	if (typeof value !== "object" || value === null) return false;
	const todo = value as Record<string, unknown>;
	return typeof todo.id === "string" && typeof todo.content === "string";
}

function clonePlan(plan: PlanRecord): PlanRecord {
	const todos = plan.todos.map((todo) => ({ id: todo.id, content: todo.content }));
	return { name: plan.name, path: plan.path, overview: plan.overview, todos };
}
