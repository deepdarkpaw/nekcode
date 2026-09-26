/**
 * Shared data model for the nek built-in extension (todos, plan mode, subagents).
 * Plain structs only; behavior lives in free functions under state/ and services/.
 */

/** Interaction mode of a root session. */
export type Mode = "agent" | "plan";

/** Status of a single todo item (Cursor TodoWrite). */
export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

/** One todo item (Cursor TodoWrite). */
export interface Todo {
	id: string;
	content: string;
	status: TodoStatus;
}

/** Persisted todo list: todo_write result details and `nek.todos` entry data. */
export interface TodoListData {
	todos: Todo[];
}

/** The current plan of a session, written by create_plan. */
export interface PlanRecord {
	name: string;
	/** Absolute path of the plan markdown file. */
	path: string;
	overview: string;
	todos: Array<{ id: string; content: string }>;
}

/** Branch-scoped session state; rebuilt from branch entries, never stored elsewhere. */
export interface NekSessionState {
	mode: Mode;
	todos: Todo[];
	plan?: PlanRecord;
}

/** Terminal and non-terminal states of a subagent run. */
export type TaskStatus = "running" | "completed" | "errored" | "aborted";

/** Registry record of one subagent. */
export interface TaskRecord {
	/** Equals the child session id. */
	id: string;
	description: string;
	type: string;
	background: boolean;
	status: TaskStatus;
	sessionFile?: string;
	startedAt: number;
	endedAt?: number;
	finalText?: string;
	error?: string;
	/** Result already delivered to the parent (await or foreground return); suppresses the completion notice. */
	observed: boolean;
}

/** Subagent type: built-in (Cursor) or discovered from agent markdown files. */
export interface AgentType {
	name: string;
	description: string;
	source: "builtin" | "user" | "project";
	readonly: boolean;
	background: boolean;
	model?: string;
	instructions?: string;
	/** Tool allowlist of the child session. */
	tools: string[];
}

/** create_plan result details; replayBranch() restores the current plan from them. */
export interface PlanData {
	plan: PlanRecord;
}

/** One answer option of an ask_question question (Cursor AskQuestion). */
export interface QuestionOption {
	id: string;
	label: string;
}

/** One ask_question question (Cursor AskQuestion). */
export interface Question {
	id: string;
	prompt: string;
	options: QuestionOption[];
	allow_multiple?: boolean;
}

/** The user's answer to one question: chosen options and/or free text typed under "Other". */
export interface QuestionAnswer {
	questionId: string;
	optionIds: string[];
	labels: string[];
	other?: string;
}

/** ask_question result details. */
export interface AskQuestionData {
	answers: QuestionAnswer[];
}

/** Data of a `nek.mode` custom entry. */
export interface ModeEntryData {
	mode: Mode;
}
