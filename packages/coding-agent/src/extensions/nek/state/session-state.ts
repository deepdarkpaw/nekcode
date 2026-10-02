import type { SessionEntry } from "../../../core/session-manager.ts";
import type {
	Mode,
	ModeEntryData,
	NekSessionState,
	PlanData,
	PlanExecution,
	PlanLifecycleData,
	PlanRecord,
	PlanReference,
	Todo,
	TodoListData,
} from "../types.ts";
import { TODO_STATUSES } from "./todos.ts";

/** Tool names of the built-in planning and task tools. */
export const TODO_WRITE_TOOL_NAME = "todo_write";
export const CREATE_PLAN_TOOL_NAME = "create_plan";
export const UPDATE_PLAN_TOOL_NAME = "update_plan";
export const SWITCH_MODE_TOOL_NAME = "switch_mode";
export const ASK_QUESTION_TOOL_NAME = "ask_question";

/** Branch entries for todo ownership, interaction mode, and plan lifecycle. */
export const NEK_TODOS_ENTRY_TYPE = "nek.todos";
export const NEK_MODE_ENTRY_TYPE = "nek.mode";
export const NEK_PLAN_ENTRY_TYPE = "nek.plan";
export const NEK_PLAN_SNAPSHOT_ENTRY_TYPE = "nek.plan_snapshot";

/** Modes in switch_mode schema order. */
export const MODES = ["plan", "agent"] as const satisfies readonly Mode[];

/** Initial state of a branch without nek entries. */
export function createSessionState(): NekSessionState {
	return { mode: "agent", todos: [] };
}

/** Whether two references identify the exact same reviewed plan revision. */
export function samePlanRevision(left: PlanReference | undefined, right: PlanReference | undefined): boolean {
	return left !== undefined && right !== undefined && left.path === right.path && left.revision === right.revision;
}

/** Ordinary todos remain active; plan-owned todos require an active authorization for their revision. */
export function todosAreActive(state: NekSessionState): boolean {
	if (!state.todoOwner) return true;
	if (state.todoOwner === "planning") return state.mode === "plan";
	return state.execution?.status === "active" && samePlanRevision(state.todoOwner, state.execution);
}

/** Replay artifacts, lifecycle, modes, and todo ownership in branch order. Failed results do not change state. */
export function replayBranch(entries: readonly SessionEntry[]): NekSessionState {
	const state = createSessionState();
	for (const entry of entries) {
		const mode = modeFromEntry(entry);
		if (mode) state.mode = mode;
		const list = todoListFromEntry(entry);
		if (list) {
			state.todos = list.todos.map((todo) => ({ ...todo }));
			if (list.owner) state.todoOwner = list.owner === "planning" ? "planning" : { ...list.owner };
			else delete state.todoOwner;
		}
		const artifact = planFromEntry(entry);
		if (artifact) {
			state.plan = { ...artifact.plan, todos: artifact.plan.todos.map((todo) => ({ ...todo })) };
			state.planMarkdown = artifact.markdown;
			state.planStatus = "ready";
			delete state.execution;
		}
		const lifecycle = lifecycleFromEntry(entry);
		if (lifecycle) {
			state.planStatus = lifecycle.status;
			if (lifecycle.execution) state.execution = { ...lifecycle.execution };
			else delete state.execution;
		}
	}
	return state;
}

function modeFromEntry(entry: SessionEntry): Mode | undefined {
	if (entry.type !== "custom" || entry.customType !== NEK_MODE_ENTRY_TYPE) return undefined;
	const data = entry.data as Partial<ModeEntryData> | undefined;
	return MODES.find((mode) => mode === data?.mode);
}

function todoListFromEntry(entry: SessionEntry): TodoListData | undefined {
	const data =
		entry.type === "custom" && entry.customType === NEK_TODOS_ENTRY_TYPE
			? entry.data
			: successfulToolDetails(entry, TODO_WRITE_TOOL_NAME);
	if (!isTodoListData(data)) return undefined;
	return data;
}

function planFromEntry(entry: SessionEntry): PlanData | undefined {
	const details =
		entry.type === "custom" && entry.customType === NEK_PLAN_SNAPSHOT_ENTRY_TYPE
			? entry.data
			: (successfulToolDetails(entry, CREATE_PLAN_TOOL_NAME) ?? successfulToolDetails(entry, UPDATE_PLAN_TOOL_NAME));
	if (typeof details !== "object" || details === null || !("plan" in details) || !("markdown" in details))
		return undefined;
	if (!isPlanRecord(details.plan) || typeof details.markdown !== "string") return undefined;
	return { plan: details.plan, markdown: details.markdown };
}

function lifecycleFromEntry(entry: SessionEntry): PlanLifecycleData | undefined {
	if (entry.type !== "custom" || entry.customType !== NEK_PLAN_ENTRY_TYPE) return undefined;
	const data = entry.data;
	if (typeof data !== "object" || data === null || !("status" in data)) return undefined;
	if (data.status !== "draft" && data.status !== "ready") return undefined;
	const execution = "execution" in data ? data.execution : undefined;
	if (execution !== undefined && !isPlanExecution(execution)) return undefined;
	return { status: data.status, ...(execution ? { execution } : {}) };
}

function successfulToolDetails(entry: SessionEntry, toolName: string): unknown {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role !== "toolResult" || message.toolName !== toolName || message.isError) return undefined;
	return message.details;
}

function isTodoListData(value: unknown): value is TodoListData {
	if (typeof value !== "object" || value === null || !("todos" in value)) return false;
	if ("owner" in value && value.owner !== undefined && value.owner !== "planning" && !isPlanReference(value.owner))
		return false;
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

function isPlanReference(value: unknown): value is PlanReference {
	if (typeof value !== "object" || value === null || !("path" in value) || !("revision" in value)) return false;
	return (
		typeof value.path === "string" &&
		typeof value.revision === "number" &&
		Number.isSafeInteger(value.revision) &&
		value.revision > 0
	);
}

function isPlanExecution(value: unknown): value is PlanExecution {
	if (!isPlanReference(value) || !("status" in value)) return false;
	return value.status === "active" || value.status === "interrupted" || value.status === "completed";
}

function isPlanRecord(value: unknown): value is PlanRecord {
	if (!isPlanReference(value) || !("name" in value) || !("overview" in value) || !("todos" in value)) return false;
	if (typeof value.name !== "string" || typeof value.overview !== "string") return false;
	return Array.isArray(value.todos) && value.todos.every(isPlanTodo);
}

function isPlanTodo(value: unknown): value is PlanRecord["todos"][number] {
	if (typeof value !== "object" || value === null) return false;
	const todo = value as Record<string, unknown>;
	return typeof todo.id === "string" && typeof todo.content === "string";
}
