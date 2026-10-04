/**
 * Pure reducer from RPC records to view state.
 *
 * Blocks are immutable: a changed block is a new object, so the view only re-renders blocks whose
 * identity changed. Incoming records are untrusted JSON and are narrowed field by field.
 */

import type { RpcEventRecord, UiRequest } from "../rpc/protocol.ts";
import type {
	AssistantBlock,
	AssistantPart,
	Block,
	DialogRequest,
	FooterStats,
	SubagentView,
	TodoItem,
	TodoStatus,
	ToolBlock,
	ToolResultView,
	ViewState,
} from "./types.ts";

/** Blocks kept in memory; older ones are dropped and counted in `droppedBlocks`. */
export const MAX_STATE_BLOCKS = 1500;
/** Toasts shown at once; older ones are dropped. */
const MAX_TOASTS = 4;

export type Action =
	| { type: "rpc_event"; event: RpcEventRecord; now: number }
	| { type: "ui_request"; request: UiRequest; now: number }
	| { type: "dialog_closed"; id: string }
	| { type: "session_state"; state: unknown }
	| { type: "session_stats"; stats: unknown }
	| { type: "history"; messages: unknown; now: number }
	| { type: "notice"; level: "info" | "warning" | "error"; text: string }
	| { type: "toast"; level: "info" | "warning" | "error"; text: string; now: number }
	| { type: "toast_expired"; id: string }
	| { type: "toggle_expanded"; id: string }
	| { type: "toggle_expand_all" }
	| { type: "backend_ready" }
	| { type: "backend_exit"; code: number | null; error?: string };

export interface ReducerState extends ViewState {
	/** Block id of the assistant message being streamed. */
	streamingAssistantId?: string;
	droppedBlocks: number;
}

export function createInitialState(cwd: string): ReducerState {
	return {
		cwd,
		blocks: [],
		seq: 0,
		running: false,
		compacting: false,
		queue: { steering: [], followUp: [] },
		statuses: {},
		mode: "agent",
		todos: [],
		subagents: {},
		footer: { inputTokens: 0, outputTokens: 0, cost: 0 },
		dialogs: [],
		toasts: [],
		widgets: {},
		expanded: {},
		expandAll: false,
		backend: { status: "starting" },
		droppedBlocks: 0,
	};
}

// ============================================================================
// Narrowing helpers
// ============================================================================

type Json = Record<string, unknown>;

function obj(value: unknown): Json | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function num(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function arr(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** Text of a message content value: a string or an array of text blocks. */
export function contentText(content: unknown): string {
	if (typeof content === "string") return content;
	return arr(content)
		.map((block) => {
			const b = obj(block);
			return b?.type === "text" ? (str(b.text) ?? "") : "";
		})
		.filter((text) => text.length > 0)
		.join("\n");
}

function imageCount(content: unknown): number {
	return arr(content).filter((block) => obj(block)?.type === "image").length;
}

// ============================================================================
// Block helpers
// ============================================================================

function nextId(state: ReducerState, prefix: string): [string, number] {
	const seq = state.seq + 1;
	return [`${prefix}${seq}`, seq];
}

function appendBlock(state: ReducerState, block: Block, seq: number): ReducerState {
	const blocks = [...state.blocks, block];
	const overflow = blocks.length - MAX_STATE_BLOCKS;
	if (overflow <= 0) return { ...state, blocks, seq };
	return { ...state, blocks: blocks.slice(overflow), seq, droppedBlocks: state.droppedBlocks + overflow };
}

function replaceBlockAt(state: ReducerState, index: number, block: Block): ReducerState {
	const blocks = state.blocks.slice();
	blocks[index] = block;
	return { ...state, blocks };
}

function findBlockIndex(state: ReducerState, id: string): number {
	for (let i = state.blocks.length - 1; i >= 0; i--) {
		if (state.blocks[i].id === id) return i;
	}
	return -1;
}

function addNotice(
	state: ReducerState,
	level: "info" | "warning" | "error",
	text: string,
	label?: string,
): ReducerState {
	const [id, seq] = nextId(state, "n");
	return appendBlock(state, { kind: "notice", id, level, text, ...(label ? { label } : {}) }, seq);
}

// ============================================================================
// Derived panels: todos and subagents
// ============================================================================

const TODO_STATUSES: ReadonlySet<string> = new Set(["pending", "in_progress", "completed", "cancelled"]);

/** Todos from `todo_write` details (`{ todos, owner? }`), or undefined when the shape does not match. */
export function parseTodos(details: unknown): TodoItem[] | undefined {
	const todos = obj(details)?.todos;
	if (!Array.isArray(todos)) return undefined;
	const items: TodoItem[] = [];
	for (const entry of todos) {
		const todo = obj(entry);
		const id = str(todo?.id);
		const content = str(todo?.content);
		const status = str(todo?.status);
		if (id === undefined || content === undefined || !status || !TODO_STATUSES.has(status)) continue;
		items.push({ id, content, status: status as TodoStatus });
	}
	return items;
}

/**
 * Subagent record from tool details. Supports the current shape (`usage`, `lastActivityAt`) and
 * tolerates records that only carry a `tokens` total.
 */
export function parseSubagent(value: unknown): SubagentView | undefined {
	const record = obj(value);
	const id = str(record?.id);
	if (!record || !id) return undefined;
	const usage = obj(record.usage);
	const input = num(usage?.input);
	const output = num(usage?.output);
	return {
		id,
		description: str(record.description) ?? "",
		type: str(record.type) ?? "subagent",
		status: str(record.status) ?? "running",
		model: str(record.model),
		startedAt: num(record.startedAt),
		endedAt: num(record.endedAt),
		activity: str(record.activity),
		lastActivityAt: num(record.lastActivityAt),
		usage: input !== undefined || output !== undefined ? { input: input ?? 0, output: output ?? 0 } : undefined,
		totalTokens: num(record.tokens),
	};
}

function subagentsFromDetails(details: unknown): SubagentView[] {
	const d = obj(details);
	if (!d) return [];
	const single = parseSubagent(d.subagent);
	const lists = [...arr(d.subagents), ...arr(d.running)].map(parseSubagent);
	return [single, ...lists].filter((entry): entry is SubagentView => entry !== undefined);
}

function applyToolDerivations(state: ReducerState, toolName: string, details: unknown): ReducerState {
	let next = state;
	if (toolName === "todo_write") {
		const todos = parseTodos(details);
		if (todos) next = { ...next, todos };
	}
	const subagents = subagentsFromDetails(details);
	if (subagents.length > 0) {
		const merged = { ...next.subagents };
		for (const subagent of subagents) merged[subagent.id] = subagent;
		next = { ...next, subagents: merged };
	}
	return next;
}

// ============================================================================
// Messages
// ============================================================================

function partsFromContent(content: unknown): AssistantPart[] {
	const parts: AssistantPart[] = [];
	for (const [index, block] of arr(content).entries()) {
		const b = obj(block);
		if (b?.type === "text") parts.push({ type: "text", index, text: str(b.text) ?? "" });
		if (b?.type === "thinking") parts.push({ type: "thinking", index, text: str(b.thinking) ?? "" });
	}
	return parts;
}

function toolCallsFromContent(content: unknown): Array<{ id: string; name: string; args: unknown }> {
	const calls: Array<{ id: string; name: string; args: unknown }> = [];
	for (const block of arr(content)) {
		const b = obj(block);
		const id = str(b?.id);
		const name = str(b?.name);
		if (b?.type === "toolCall" && id && name) calls.push({ id, name, args: b.arguments });
	}
	return calls;
}

function resultView(result: unknown): ToolResultView | undefined {
	const r = obj(result);
	if (!r) return undefined;
	return { text: contentText(r.content), details: r.details };
}

/** Insert a tool block, or update its name and arguments when it already exists. */
function upsertToolCall(state: ReducerState, id: string, name: string, args: unknown): ReducerState {
	const index = findBlockIndex(state, id);
	if (index === -1) {
		const block: ToolBlock = { kind: "tool", id, name, args, status: "pending" };
		return appendBlock(state, block, state.seq);
	}
	const existing = state.blocks[index];
	if (existing.kind !== "tool") return state;
	return replaceBlockAt(state, index, { ...existing, name, args: args ?? existing.args });
}

function updateFooterUsage(footer: FooterStats, usage: unknown): FooterStats {
	const u = obj(usage);
	if (!u) return footer;
	const input = num(u.input) ?? 0;
	const output = num(u.output) ?? 0;
	const cacheRead = num(u.cacheRead) ?? 0;
	const cacheWrite = num(u.cacheWrite) ?? 0;
	const contextTokens = num(u.totalTokens) ?? input + output + cacheRead + cacheWrite;
	const cost = num(obj(u.cost)?.total) ?? 0;
	return {
		...footer,
		inputTokens: footer.inputTokens + input,
		outputTokens: footer.outputTokens + output,
		cost: footer.cost + cost,
		contextTokens,
		contextPercent:
			footer.contextWindow && contextTokens > 0
				? (contextTokens / footer.contextWindow) * 100
				: footer.contextPercent,
	};
}

function finalizeAssistant(state: ReducerState, message: Json, countUsage: boolean): ReducerState {
	let next = state;
	const parts = partsFromContent(message.content);
	const stopReason = str(message.stopReason);
	const errorMessage = str(message.errorMessage);
	const error =
		stopReason === "error" || stopReason === "aborted"
			? (errorMessage ?? (stopReason === "aborted" ? "Aborted" : "Error"))
			: undefined;
	const id = next.streamingAssistantId;
	const index = id ? findBlockIndex(next, id) : -1;
	const block: AssistantBlock = {
		kind: "assistant",
		id: index === -1 ? `m${next.seq + 1}` : (id as string),
		parts,
		streaming: false,
		...(error ? { error } : {}),
		...(str(message.model) ? { model: str(message.model) } : {}),
	};
	if (index === -1) {
		if (parts.length > 0 || error) next = appendBlock(next, block, next.seq + 1);
	} else {
		next = replaceBlockAt(next, index, block);
	}
	next = { ...next, streamingAssistantId: undefined };
	for (const call of toolCallsFromContent(message.content)) next = upsertToolCall(next, call.id, call.name, call.args);
	if (countUsage) next = { ...next, footer: updateFooterUsage(next.footer, message.usage) };
	return next;
}

/** Add a non-assistant message (user, custom, bash, summaries) as a block. */
function addMessageBlock(state: ReducerState, message: Json): ReducerState {
	switch (message.role) {
		case "user": {
			const [id, seq] = nextId(state, "u");
			return appendBlock(
				state,
				{ kind: "user", id, text: contentText(message.content), images: imageCount(message.content) },
				seq,
			);
		}
		case "custom": {
			let next = state;
			const subagent = parseSubagent(obj(message.details)?.subagent);
			if (subagent) next = { ...next, subagents: { ...next.subagents, [subagent.id]: subagent } };
			if (message.display === false) return next;
			const text = contentText(message.content);
			return text ? addNotice(next, "info", text, str(message.customType)) : next;
		}
		case "bashExecution": {
			const [id, seq] = nextId(state, "b");
			const exitCode = num(message.exitCode);
			const block: ToolBlock = {
				kind: "tool",
				id,
				name: "bash",
				args: { command: str(message.command) ?? "" },
				status: exitCode === undefined || exitCode === 0 ? "done" : "error",
				result: { text: str(message.output) ?? "", details: undefined },
			};
			return appendBlock(state, block, seq);
		}
		case "compactionSummary":
			return addNotice(state, "info", "Context compacted", "compaction");
		case "branchSummary":
			return addNotice(state, "info", str(message.summary) ?? "Branch summary", "branch");
		default:
			return state;
	}
}

// ============================================================================
// Streaming updates
// ============================================================================

function updateStreamingPart(
	state: ReducerState,
	type: "text" | "thinking",
	index: number,
	update: (text: string) => string,
): ReducerState {
	let next = state;
	let id = next.streamingAssistantId;
	if (!id || findBlockIndex(next, id) === -1) {
		const [newId, seq] = nextId(next, "m");
		next = appendBlock(next, { kind: "assistant", id: newId, parts: [], streaming: true }, seq);
		next = { ...next, streamingAssistantId: newId };
		id = newId;
	}
	const blockIndex = findBlockIndex(next, id);
	const block = next.blocks[blockIndex];
	if (block.kind !== "assistant") return next;
	const parts = block.parts.slice();
	const partIndex = parts.findIndex((part) => part.index === index);
	if (partIndex === -1) {
		parts.push({ type, index, text: update("") });
		parts.sort((a, b) => a.index - b.index);
	} else {
		parts[partIndex] = { ...parts[partIndex], text: update(parts[partIndex].text) };
	}
	return replaceBlockAt(next, blockIndex, { ...block, parts });
}

function applyAssistantEvent(state: ReducerState, event: Json): ReducerState {
	const index = num(event.contentIndex) ?? 0;
	switch (event.type) {
		case "text_start":
			return updateStreamingPart(state, "text", index, (text) => text);
		case "thinking_start":
			return updateStreamingPart(state, "thinking", index, (text) => text);
		case "text_delta":
			return updateStreamingPart(state, "text", index, (text) => text + (str(event.delta) ?? ""));
		case "thinking_delta":
			return updateStreamingPart(state, "thinking", index, (text) => text + (str(event.delta) ?? ""));
		case "text_end":
			return updateStreamingPart(state, "text", index, (text) => str(event.content) ?? text);
		case "thinking_end":
			return updateStreamingPart(state, "thinking", index, (text) => str(event.content) ?? text);
		case "toolcall_start": {
			const id = str(event.id);
			const name = str(event.toolName);
			return id && name ? upsertToolCall(state, id, name, undefined) : state;
		}
		case "toolcall_end": {
			const call = obj(event.toolCall);
			const id = str(call?.id);
			const name = str(call?.name);
			return id && name ? upsertToolCall(state, id, name, call?.arguments) : state;
		}
		default:
			return state;
	}
}

// ============================================================================
// Tool execution
// ============================================================================

function applyToolExecution(state: ReducerState, event: Json, now: number): ReducerState {
	const id = str(event.toolCallId);
	const name = str(event.toolName);
	if (!id || !name) return state;
	let next = state;
	let index = findBlockIndex(next, id);
	if (index === -1) {
		next = upsertToolCall(next, id, name, event.args);
		index = findBlockIndex(next, id);
	}
	const block = next.blocks[index];
	if (block?.kind !== "tool") return next;
	switch (event.type) {
		case "tool_execution_start":
			return replaceBlockAt(next, index, {
				...block,
				args: event.args ?? block.args,
				status: "running",
				startedAt: now,
			});
		case "tool_execution_update": {
			const result = resultView(event.partialResult);
			next = replaceBlockAt(next, index, { ...block, status: "running", ...(result ? { result } : {}) });
			return applyToolDerivations(next, name, obj(event.partialResult)?.details);
		}
		case "tool_execution_end": {
			const result = resultView(event.result);
			const status = event.isError === true ? "error" : "done";
			next = replaceBlockAt(next, index, { ...block, status, endedAt: now, ...(result ? { result } : {}) });
			return applyToolDerivations(next, name, obj(event.result)?.details);
		}
		default:
			return next;
	}
}

// ============================================================================
// Events
// ============================================================================

function applyEvent(state: ReducerState, event: RpcEventRecord, now: number): ReducerState {
	switch (event.type) {
		case "agent_start":
			return { ...state, running: true };
		case "agent_settled": {
			let next: ReducerState = { ...state, running: false };
			const id = next.streamingAssistantId;
			const index = id ? findBlockIndex(next, id) : -1;
			const block = index === -1 ? undefined : next.blocks[index];
			if (block?.kind === "assistant") next = replaceBlockAt(next, index, { ...block, streaming: false });
			return { ...next, streamingAssistantId: undefined };
		}
		case "message_start": {
			const message = obj(event.message);
			if (message?.role !== "assistant") return state;
			const [id, seq] = nextId(state, "m");
			const next = appendBlock(state, { kind: "assistant", id, parts: [], streaming: true }, seq);
			return { ...next, streamingAssistantId: id };
		}
		case "message_update": {
			const update = obj(event.assistantMessageEvent);
			return update ? applyAssistantEvent(state, update) : state;
		}
		case "message_end": {
			const message = obj(event.message);
			if (!message) return state;
			if (message.role === "assistant") return finalizeAssistant(state, message, true);
			if (message.role === "toolResult") return state;
			return addMessageBlock(state, message);
		}
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end":
			return applyToolExecution(state, event, now);
		case "queue_update":
			return {
				...state,
				queue: {
					steering: arr(event.steering).filter((s): s is string => typeof s === "string"),
					followUp: arr(event.followUp).filter((s): s is string => typeof s === "string"),
				},
			};
		case "thinking_level_changed":
			return {
				...state,
				footer: { ...state.footer, thinkingLevel: str(event.level) ?? state.footer.thinkingLevel },
			};
		case "session_info_changed":
			return { ...state, sessionName: str(event.name) };
		case "entry_appended": {
			const entry = obj(event.entry);
			const mode = str(obj(entry?.data)?.mode);
			if (entry?.customType === "nek.mode" && (mode === "plan" || mode === "agent")) return { ...state, mode };
			return state;
		}
		case "compaction_start":
			return addNotice({ ...state, compacting: true }, "info", "Compacting context…", "compaction");
		case "compaction_end": {
			const next = { ...state, compacting: false };
			if (event.aborted === true) return addNotice(next, "warning", "Compaction aborted", "compaction");
			const errorMessage = str(event.errorMessage);
			if (errorMessage) return addNotice(next, "error", `Compaction failed: ${errorMessage}`, "compaction");
			const result = obj(event.result);
			const before = num(result?.tokensBefore);
			const after = num(result?.estimatedTokensAfter);
			const summary =
				before !== undefined && after !== undefined ? `Compacted ${before} → ${after} tokens` : "Compacted";
			return addNotice(next, "info", summary, "compaction");
		}
		case "auto_retry_start": {
			const attempt = num(event.attempt) ?? 1;
			const max = num(event.maxAttempts);
			const delay = num(event.delayMs);
			const reason = str(event.errorMessage) ?? "";
			const text = `Retrying (${attempt}${max ? `/${max}` : ""})${delay ? ` in ${Math.round(delay / 1000)}s` : ""}${reason ? `: ${reason}` : ""}`;
			return addNotice(state, "warning", text, "retry");
		}
		case "auto_retry_end":
			return event.success === false
				? addNotice(state, "error", `Retry failed: ${str(event.finalError) ?? "unknown error"}`, "retry")
				: state;
		case "extension_error":
			return addNotice(
				state,
				"error",
				`${str(event.extensionPath) ?? "extension"}: ${str(event.error) ?? "error"}`,
				"extension",
			);
		case "rpc_uncorrelated_response":
			return event.success === false
				? addNotice(state, "error", str(event.error) ?? "Protocol error", "rpc")
				: state;
		default:
			return state;
	}
}

function applyUiRequest(state: ReducerState, request: UiRequest, now: number): ReducerState {
	switch (request.method) {
		case "select":
		case "confirm":
		case "input":
		case "editor":
			return { ...state, dialogs: [...state.dialogs, request as DialogRequest] };
		case "notify": {
			const toast = { id: request.id, level: request.notifyType ?? "info", text: request.message, createdAt: now };
			return { ...state, toasts: [...state.toasts, toast].slice(-MAX_TOASTS) };
		}
		case "setStatus": {
			const statuses = { ...state.statuses };
			if (request.statusText === undefined || request.statusText === null) delete statuses[request.statusKey];
			else statuses[request.statusKey] = request.statusText;
			const mode =
				request.statusKey === "nek.mode" ? (request.statusText === "plan" ? "plan" : "agent") : state.mode;
			return { ...state, statuses, mode };
		}
		case "setWidget": {
			const widgets = { ...state.widgets };
			if (!request.widgetLines) delete widgets[request.widgetKey];
			else
				widgets[request.widgetKey] = {
					lines: request.widgetLines,
					placement: request.widgetPlacement ?? "aboveEditor",
				};
			return { ...state, widgets };
		}
		case "setTitle":
			return { ...state, title: request.title };
		case "set_editor_text":
			return { ...state, editorText: { text: request.text, seq: (state.editorText?.seq ?? 0) + 1 } };
		default:
			return state;
	}
}

function applySessionState(state: ReducerState, value: unknown): ReducerState {
	const s = obj(value);
	if (!s) return state;
	const model = obj(s.model);
	const contextWindow = num(model?.contextWindow) ?? state.footer.contextWindow;
	return {
		...state,
		running: typeof s.isStreaming === "boolean" ? s.isStreaming : state.running,
		compacting: typeof s.isCompacting === "boolean" ? s.isCompacting : state.compacting,
		sessionName: str(s.sessionName) ?? state.sessionName,
		footer: {
			...state.footer,
			model: str(model?.id) ?? state.footer.model,
			provider: str(model?.provider) ?? state.footer.provider,
			contextWindow,
			thinkingLevel: str(s.thinkingLevel) ?? state.footer.thinkingLevel,
		},
	};
}

function applySessionStats(state: ReducerState, value: unknown): ReducerState {
	const s = obj(value);
	if (!s) return state;
	const tokens = obj(s.tokens);
	const context = obj(s.contextUsage);
	return {
		...state,
		footer: {
			...state.footer,
			inputTokens: num(tokens?.input) ?? state.footer.inputTokens,
			outputTokens: num(tokens?.output) ?? state.footer.outputTokens,
			cost: num(s.cost) ?? state.footer.cost,
			contextTokens: num(context?.tokens) ?? state.footer.contextTokens,
			contextPercent: num(context?.percent) ?? state.footer.contextPercent,
			contextWindow: num(context?.contextWindow) ?? state.footer.contextWindow,
		},
	};
}

/** Rebuild the transcript from `get_messages` (resumed sessions). Usage comes from `get_session_stats`. */
function applyHistory(state: ReducerState, messages: unknown, now: number): ReducerState {
	let next: ReducerState = { ...state, blocks: [], streamingAssistantId: undefined };
	for (const entry of arr(messages)) {
		const message = obj(entry);
		if (!message) continue;
		if (message.role === "assistant") {
			next = finalizeAssistant(next, message, false);
		} else if (message.role === "toolResult") {
			const id = str(message.toolCallId);
			const name = str(message.toolName) ?? "tool";
			if (!id) continue;
			next = applyToolExecution(
				next,
				{
					type: "tool_execution_end",
					toolCallId: id,
					toolName: name,
					result: message,
					isError: message.isError === true,
				},
				num(message.timestamp) ?? now,
			);
		} else {
			next = addMessageBlock(next, message);
		}
	}
	return next;
}

export function reduce(state: ReducerState, action: Action): ReducerState {
	switch (action.type) {
		case "rpc_event":
			return applyEvent(state, action.event, action.now);
		case "ui_request":
			return applyUiRequest(state, action.request, action.now);
		case "dialog_closed":
			return { ...state, dialogs: state.dialogs.filter((dialog) => dialog.id !== action.id) };
		case "session_state":
			return applySessionState(state, action.state);
		case "session_stats":
			return applySessionStats(state, action.stats);
		case "history":
			return applyHistory(state, action.messages, action.now);
		case "notice":
			return addNotice(state, action.level, action.text);
		case "toast": {
			const [id, seq] = nextId(state, "t");
			const toast = { id, level: action.level, text: action.text, createdAt: action.now };
			return { ...state, seq, toasts: [...state.toasts, toast].slice(-MAX_TOASTS) };
		}
		case "toast_expired":
			return { ...state, toasts: state.toasts.filter((toast) => toast.id !== action.id) };
		case "toggle_expanded":
			return { ...state, expanded: { ...state.expanded, [action.id]: !state.expanded[action.id] } };
		case "toggle_expand_all":
			return { ...state, expandAll: !state.expandAll };
		case "backend_ready":
			return { ...state, backend: { status: "ready" } };
		case "backend_exit":
			return {
				...state,
				running: false,
				backend: { status: "exited", exitCode: action.code, ...(action.error ? { error: action.error } : {}) },
			};
	}
}

/** Running subagents, oldest first. */
export function runningSubagents(state: ViewState): SubagentView[] {
	return Object.values(state.subagents)
		.filter((subagent) => subagent.status === "running")
		.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
}

/** Whether a tool row or thinking block is expanded. */
export function isExpanded(state: ViewState, id: string): boolean {
	return state.expandAll ? !state.expanded[id] : state.expanded[id] === true;
}
