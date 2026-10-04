/** View state of the OpenTUI frontend, built from RPC records by `reduce()`. */

import type { UiRequest } from "../rpc/protocol.ts";

export type TodoStatus = "pending" | "in_progress" | "completed" | "cancelled";

export interface TodoItem {
	id: string;
	content: string;
	status: TodoStatus;
}

export interface SubagentView {
	id: string;
	description: string;
	type: string;
	status: string;
	model?: string;
	startedAt?: number;
	endedAt?: number;
	activity?: string;
	lastActivityAt?: number;
	usage?: { input: number; output: number };
	/** Total tokens from records that predate `usage`. */
	totalTokens?: number;
}

export interface UserBlock {
	kind: "user";
	id: string;
	text: string;
	/** Images attached to the message; the frontend shows a count only. */
	images: number;
}

export interface AssistantPart {
	type: "text" | "thinking";
	/** Provider content index of the block. */
	index: number;
	text: string;
}

export interface AssistantBlock {
	kind: "assistant";
	id: string;
	/** Text and thinking parts in content-index order. */
	parts: AssistantPart[];
	streaming: boolean;
	error?: string;
	model?: string;
}

export type ToolStatus = "pending" | "running" | "done" | "error";

export interface ToolResultView {
	text: string;
	details: unknown;
}

export interface ToolBlock {
	kind: "tool";
	id: string;
	name: string;
	args: unknown;
	status: ToolStatus;
	result?: ToolResultView;
	startedAt?: number;
	endedAt?: number;
}

export interface NoticeBlock {
	kind: "notice";
	id: string;
	level: "info" | "warning" | "error";
	text: string;
	/** Short label such as a custom message type. */
	label?: string;
}

export type Block = UserBlock | AssistantBlock | ToolBlock | NoticeBlock;

export interface Toast {
	id: string;
	level: "info" | "warning" | "error";
	text: string;
	createdAt: number;
}

export interface Widget {
	lines: string[];
	placement: "aboveEditor" | "belowEditor";
}

export interface FooterStats {
	model?: string;
	provider?: string;
	contextWindow?: number;
	thinkingLevel?: string;
	inputTokens: number;
	outputTokens: number;
	/** Context tokens of the last assistant response. */
	contextTokens?: number;
	contextPercent?: number;
	cost: number;
}

export type DialogRequest = Extract<UiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

export interface ViewState {
	cwd: string;
	sessionName?: string;
	/** Immutable; a changed block is a new object, so the view re-renders blocks whose identity changed. */
	blocks: Block[];
	/** Monotonic counter for block ids. */
	seq: number;
	/** An agent run is active (between `agent_start` and `agent_settled`). */
	running: boolean;
	compacting: boolean;
	queue: { steering: string[]; followUp: string[] };
	statuses: Record<string, string>;
	mode: "agent" | "plan";
	todos: TodoItem[];
	subagents: Record<string, SubagentView>;
	footer: FooterStats;
	dialogs: DialogRequest[];
	toasts: Toast[];
	widgets: Record<string, Widget>;
	title?: string;
	/** Text an extension asked to place in the editor; `seq` changes on every request. */
	editorText?: { text: string; seq: number };
	/** Tool rows and thinking blocks are collapsed unless their id is here or `expandAll` is set. */
	expanded: Record<string, boolean>;
	expandAll: boolean;
	backend: { status: "starting" | "ready" | "exited"; exitCode?: number | null; error?: string };
}
