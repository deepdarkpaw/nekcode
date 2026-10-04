import type { SessionEntry } from "../../../core/session-manager.ts";
import { planId } from "../services/plan-store.ts";
import type {
	Mode,
	ModeEntryData,
	NekSessionState,
	PlanData,
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
	return { mode: "agent", todos: [], plans: [] };
}

/** Return the selected plan snapshot, if the selection still identifies a saved plan. */
export function activePlan(state: NekSessionState): PlanData | undefined {
	return state.activePlan ? state.plans.find((snapshot) => snapshot.plan.path === state.activePlan) : undefined;
}

/** Find a saved plan by its stable filename id. */
export function findPlan(state: NekSessionState, id: string): PlanData | undefined {
	return state.plans.find((snapshot) => planId(snapshot.plan) === id);
}

/** Whether two references identify the exact same reviewed plan revision. */
export function samePlanRevision(left: PlanReference | undefined, right: PlanReference | undefined): boolean {
	return left !== undefined && right !== undefined && left.path === right.path && left.revision === right.revision;
}

/** Ordinary todos are always active; planning todos are active only in Plan mode. */
export function todosAreActive(state: NekSessionState): boolean {
	return state.todoOwner !== "planning" || state.mode === "plan";
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
			if (list.owner) state.todoOwner = list.owner;
			else delete state.todoOwner;
		}
		const artifact = planFromEntry(entry);
		if (artifact) applyPlanArtifact(state, artifact);
		const lifecycle = lifecycleFromEntry(entry);
		if (lifecycle) applyLifecycle(state, lifecycle);
	}
	return state;
}

function applyPlanArtifact(state: NekSessionState, artifact: PlanData): void {
	const snapshot = clonePlanData(artifact);
	const index = state.plans.findIndex((item) => item.plan.path === snapshot.plan.path);
	state.plans =
		index < 0
			? [...state.plans, snapshot]
			: state.plans.map((item, itemIndex) => (itemIndex === index ? snapshot : item));
	state.activePlan = snapshot.plan.path;
	state.planStatus = "ready";
}

function applyLifecycle(state: NekSessionState, lifecycle: PlanLifecycleData): void {
	if (lifecycle.active !== undefined) state.activePlan = lifecycle.active;
	const selected = activePlan(state);
	if (!selected) {
		delete state.activePlan;
		delete state.planStatus;
		return;
	}
	state.planStatus = lifecycle.status;
}

function clonePlanData(snapshot: PlanData): PlanData {
	return {
		plan: { ...snapshot.plan, todos: snapshot.plan.todos.map((todo) => ({ ...todo })) },
		markdown: snapshot.markdown,
	};
}

function modeFromEntry(entry: SessionEntry): Mode | undefined {
	if (entry.type !== "custom" || entry.customType !== NEK_MODE_ENTRY_TYPE) return undefined;
	const data = entry.data as Partial<ModeEntryData> | undefined;
	return MODES.find((mode) => mode === data?.mode);
}

/** Owners other than `planning` (plan references written by older versions) are dropped: those todos are ordinary. */
function todoListFromEntry(entry: SessionEntry): TodoListData | undefined {
	const data =
		entry.type === "custom" && entry.customType === NEK_TODOS_ENTRY_TYPE
			? entry.data
			: successfulToolDetails(entry, TODO_WRITE_TOOL_NAME);
	if (typeof data !== "object" || data === null || !("todos" in data)) return undefined;
	const todos: unknown = data.todos;
	if (!Array.isArray(todos) || !todos.every(isTodo)) return undefined;
	const planning = "owner" in data && data.owner === "planning";
	return { todos, ...(planning ? { owner: "planning" as const } : {}) };
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
	const record = data as Record<string, unknown>;
	if (record.status !== "draft" && record.status !== "ready") return undefined;
	if (record.active !== undefined && typeof record.active !== "string") return undefined;
	return { status: record.status, ...(typeof record.active === "string" ? { active: record.active } : {}) };
}

function successfulToolDetails(entry: SessionEntry, toolName: string): unknown {
	if (entry.type !== "message") return undefined;
	const message = entry.message;
	if (message.role !== "toolResult" || message.toolName !== toolName || message.isError) return undefined;
	return message.details;
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
