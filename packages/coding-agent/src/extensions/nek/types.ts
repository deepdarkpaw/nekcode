import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

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

/** Persisted todo list; `planning` todos belong to Plan mode and are inactive in Agent mode. */
export interface TodoListData {
	todos: Todo[];
	owner?: "planning";
}

/** Identity of the exact plan revision being reviewed or implemented. */
export interface PlanReference {
	path: string;
	revision: number;
}

/** Plan readiness, independent of the agent's interaction mode. */
export type PlanStatus = "draft" | "ready";

/** Full lifecycle snapshot persisted separately from the plan artifact. */
export interface PlanLifecycleData {
	status: PlanStatus;
	/** Path of the selected plan. */
	active?: string;
}

/** The current plan of a session, written by create_plan. */
export interface PlanRecord extends PlanReference {
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
	todoOwner?: "planning";
	plans: PlanData[];
	/** Path of the plan selected for review or implementation. */
	activePlan?: string;
	planStatus?: PlanStatus;
}

/** Terminal and non-terminal states of a subagent run. */
export type SubagentStatus = "running" | "completed" | "errored" | "aborted";

/** Registry record of one subagent. */
export interface SubagentRecord {
	/** Equals the child session id. */
	id: string;
	description: string;
	type: string;
	background: boolean;
	status: SubagentStatus;
	sessionFile?: string;
	startedAt: number;
	endedAt?: number;
	finalText?: string;
	error?: string;
	/** Result already delivered to the parent (await or foreground return); suppresses the completion notice. */
	observed: boolean;
	/** Most recent tool call or streamed assistant text, at most 80 characters. */
	activity?: string;
	/** Epoch ms of the last change to `activity`. */
	lastActivityAt?: number;
	/** Actual model used by the child, in `provider/id` form. */
	model?: string;
	/**
	 * Tokens used by the child session so far, summed over its assistant messages. `input` includes cache reads and
	 * writes. Records stored by older versions lack this field.
	 */
	usage?: SubagentUsage;
}

/** Input and output token totals of one subagent. */
export interface SubagentUsage {
	input: number;
	output: number;
}

/** Subagent result details: a snapshot of the record when the call returned. */
export interface SubagentToolData {
	subagent: SubagentRecord;
}

/** Await result details: finished records returned by this call, and whether the wait timed out. */
export interface AwaitToolData {
	subagents: SubagentRecord[];
	running?: SubagentRecord[];
	timedOut: boolean;
	interrupted?: boolean;
}

/** Details of a `nek.subagent_notice` message: the finished record the notice reports. */
export interface SubagentNoticeData {
	subagent: SubagentRecord;
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
	/** Tools removed from the allowlist. */
	disallowedTools: string[];
	/** Thinking level override; omitted means inherit from the parent. */
	thinking?: ThinkingLevel;
	/** Optional child context window cap used by automatic compaction. */
	contextWindow?: number;
}

/** create_plan result details; replayBranch() restores the current plan from them. */
export interface PlanData {
	plan: PlanRecord;
	/** Immutable Markdown snapshot of this revision, also used when replaying older branches. */
	markdown: string;
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
