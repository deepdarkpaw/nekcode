import type { JsonValue } from "@earendil-works/chord";
import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	ImageContent,
	SystemMessage,
	TextContent,
	ToolCall,
	ToolResultMessage,
	UserMessage,
} from "@earendil-works/pi-ai";
import {
	type AgentEvent,
	CompactionEntry,
	type CompactionReason,
	type EntryRecord,
	type InboxState,
	type MessageChange,
	type SnapshotEvent,
	type SubmissionRecord,
	type TaskId,
	type TaskOutcome,
} from "@earendil-works/pi-durable";
import type { AgentSessionEvent } from "../agent-session.ts";
import type { CompactionResult } from "../compaction/index.ts";
import type { AgentActivityOutcome } from "../extensions/types.ts";
import { type CompactionRecord, compactionSummaryText, findCompactionRecord, storedAgentMessage } from "./entries.ts";

/** Pi session events the adapter produces. */
export type DurableSessionEvent = AgentSessionEvent;

/** Reads and callbacks the adapter needs from its engine. */
export interface EventAdapterHost {
	emit(event: DurableSessionEvent): Promise<void>;
	readInbox(): Promise<Readonly<InboxState> | undefined>;
	readCompactionRecords(): Promise<readonly CompactionRecord[]>;
	readTaskOutcome(taskId: TaskId): Promise<TaskOutcome<unknown> | undefined>;
	/** Committed entries of the conversation with an ID above `id`, oldest first. */
	entriesAfter(id: number): Promise<EntryRecord[]>;
	/** The retry policy's `maxRetries`, for `auto_retry_start.maxAttempts`. */
	maxRetries(): number;
	now(): number;
	report(error: unknown): void;
}

type Block = AssistantMessage["content"][number];
type DurableMessageEnd = Extract<AgentEvent, { type: "message_end" }>;
type DurableToolEnd = Extract<AgentEvent, { type: "tool_execution_end" }>;

/** Roles of entries placed as input, whose events pi emits after `turn_start`. */
const INPUT_ROLES: ReadonlySet<string> = new Set(["user", "custom", "system"]);

/**
 * Translates one conversation's durable agent events into pi session events, in the order pi's agent loop emits them.
 *
 * - `run_start`/`run_end` become `agent_start`/`agent_end`. A run that ends and is succeeded by a new run in the same
 *   commit (queued follow-ups) stays one pi run, as in pi's loop, which drains follow-ups before `agent_end`.
 * - Durable lists the user messages a boundary places before the turn change of the same commit; pi emits them after
 *   `turn_start`. They are moved there.
 * - Committed partials become pi `message_update` events whose `assistantMessageEvent` is rebuilt from durable's
 *   message changes; block ends are synthesized when the next block starts or the message ends.
 * - A `snapshot` (durable's delivery overflow) replays the entries this adapter has not seen, then reconciles the
 *   open turn and run, so listeners never miss `message_end`, `tool_execution_end`, or `turn_end`.
 */
export class DurableEventAdapter {
	readonly #host: EventAdapterHost;
	#lastEntryId = 0;
	#runActive = false;
	#turnActive = false;
	#runMessages: AgentMessage[] = [];
	#turnAssistant: AssistantMessage | undefined;
	#turnToolResults: ToolResultMessage[] = [];
	#partial: AssistantMessage | undefined;
	#openBlock: number | undefined;
	readonly #toolArgs = new Map<string, Record<string, unknown>>();
	/** System messages written while idle, emitted when the next turn starts. */
	#pendingSystem: SystemMessage[] = [];
	/** Calls of the current turn whose end was emitted. */
	readonly #endedTools = new Set<string>();
	#retryAttempt = 0;
	#outcome: AgentActivityOutcome = "completed";
	/** Compaction summaries seen since their compaction started, by head; the result of `compaction_end`. */
	readonly #summaries: EntryRecord[] = [];

	constructor(host: EventAdapterHost) {
		this.#host = host;
	}

	/** Newest entry whose events were emitted. */
	get lastEntryId(): number {
		return this.#lastEntryId;
	}

	/** Whether a run started and has not ended in the events emitted so far. */
	get running(): boolean {
		return this.#runActive;
	}

	/** Adopt the attachment snapshot without emitting: what it shows already happened. */
	attach(snapshot: SnapshotEvent): void {
		for (const entry of snapshot.entries) this.#lastEntryId = Math.max(this.#lastEntryId, entry.id);
		this.#runActive = snapshot.run !== undefined;
		this.#turnActive = snapshot.run !== undefined;
		const partial = snapshot.generation?.message;
		this.#partial = partial === undefined ? undefined : structuredClone(partial);
		this.#openBlock = partial === undefined || partial.content.length === 0 ? undefined : partial.content.length - 1;
		for (const slot of snapshot.tools) {
			if (slot.status === "running") this.#toolArgs.set(slot.callId, {});
		}
	}

	/** Translate one batch, the events of one commit. */
	async handle(batch: readonly AgentEvent[]): Promise<void> {
		const continued =
			batch.some((event) => event.type === "run_end") && batch.some((event) => event.type === "run_start");
		const startsTurn = batch.some((event) => event.type === "turn_start" || event.type === "run_start");
		const deferred: DurableMessageEnd[] = [];
		for (const [index, event] of batch.entries()) {
			switch (event.type) {
				case "snapshot":
					await this.#catchUp(event);
					break;
				case "run_start":
					if (!continued) await this.#startRun();
					break;
				case "run_end":
					if (!continued) await this.#endRun();
					break;
				case "turn_start":
					await this.#startTurn();
					for (const end of deferred.splice(0)) await this.#messageEnd(end.entry);
					break;
				case "turn_end":
					await this.#endTurn();
					break;
				case "message_start": {
					// Durable starts a non-streamed entry right before its end, with the entry's own message; the end emits it.
					const next = batch[index + 1];
					const entryStart = next?.type === "message_end" && next.entry.model?.[0] === event.message;
					if (!entryStart && event.message.role === "assistant") await this.#startPartial(event.message);
					break;
				}
				case "message_update":
					await this.#update(event.changes, event.usage);
					break;
				case "message_end":
					if (startsTurn && INPUT_ROLES.has(this.#roleOf(event.entry))) deferred.push(event);
					else await this.#messageEnd(event.entry);
					break;
				case "tool_execution_start":
					await this.#startTool(event.toolCallId, event.toolName, event.args);
					break;
				case "tool_execution_update":
					await this.#updateTool(event.toolCallId, event.toolName, event.details);
					break;
				case "tool_execution_end":
					await this.#endTool(event);
					break;
				case "inbox_update":
					await this.#queueUpdate();
					break;
				case "submission":
					this.#noteSubmission(event.record);
					break;
				case "auto_retry_start":
					await this.#retryStart(event.attempt, event.at, event.errorMessage);
					break;
				case "compaction_start":
					await this.#host.emit({ type: "compaction_start", reason: event.reason });
					break;
				case "compaction_end":
					await this.#compactionEnd(event.taskId, event.reason);
					break;
				case "entry_appended":
					this.#lastEntryId = Math.max(this.#lastEntryId, event.entry.id);
					break;
				case "task_failed":
					this.#host.report(new Error(`Durable task ${event.kind} ${event.taskId} failed: ${event.message}`));
					break;
				default:
					break;
			}
		}
		// Input placed without a turn change in this commit, such as a write placed into an idle conversation.
		for (const end of deferred) await this.#messageEnd(end.entry);
	}

	#roleOf(entry: EntryRecord): string {
		return storedAgentMessage(entry)?.role ?? entry.model?.[0]?.role ?? "";
	}

	async #startRun(): Promise<void> {
		this.#runActive = true;
		this.#runMessages = [];
		this.#outcome = "completed";
		await this.#host.emit({ type: "agent_start" });
	}

	async #endRun(): Promise<void> {
		if (this.#turnActive) await this.#endTurn();
		if (!this.#runActive) return;
		this.#runActive = false;
		if (this.#retryAttempt > 0) {
			const finalError = this.#turnAssistant?.errorMessage;
			await this.#host.emit({
				type: "auto_retry_end",
				success: false,
				attempt: this.#retryAttempt,
				...(finalError === undefined ? {} : { finalError }),
			});
			this.#retryAttempt = 0;
		}
		const messages = this.#runMessages;
		this.#runMessages = [];
		await this.#host.emit({ type: "agent_end", messages, willRetry: false });
		await this.#host.emit({ type: "agent_settled", outcome: this.#outcome });
	}

	async #startTurn(): Promise<void> {
		if (this.#turnActive) await this.#endTurn();
		this.#turnActive = true;
		this.#turnAssistant = undefined;
		this.#turnToolResults = [];
		this.#endedTools.clear();
		await this.#host.emit({ type: "turn_start" });
		for (const message of this.#pendingSystem.splice(0)) await this.#emitMessage(message);
	}

	async #endTurn(): Promise<void> {
		if (!this.#turnActive) return;
		this.#turnActive = false;
		const message = this.#turnAssistant ?? failedTurnMessage();
		await this.#host.emit({ type: "turn_end", message, toolResults: this.#turnToolResults });
		this.#turnToolResults = [];
	}

	/** First committed partial: pi's `message_start` with empty content, then the content so far as updates. */
	async #startPartial(message: AssistantMessage): Promise<void> {
		const first = structuredClone(message);
		this.#partial = { ...first, content: [] };
		this.#openBlock = undefined;
		await this.#host.emit({ type: "message_start", message: structuredClone(this.#partial) });
		const changes: MessageChange[] = first.content.map((block, contentIndex) => ({
			type: "block",
			contentIndex,
			block,
		}));
		await this.#update(changes, first.usage);
	}

	async #update(changes: readonly MessageChange[], usage: AssistantMessage["usage"]): Promise<void> {
		const partial = this.#partial;
		if (partial === undefined) return;
		partial.usage = structuredClone(usage);
		for (const change of changes) {
			if (change.type === "message") {
				await this.#closeBlock();
				this.#partial = structuredClone(change.message);
				this.#openBlock = undefined;
				await this.#emitUpdate({ type: "start", partial: structuredClone(change.message) });
				continue;
			}
			const index = change.contentIndex;
			if (this.#openBlock !== undefined && index > this.#openBlock) await this.#closeBlock();
			const opening = partial.content[index] === undefined;
			if (!("block" in change)) {
				applyDelta(partial, change);
				if (change.type === "toolcall_delta") {
					await this.#emitUpdate({
						type: "toolcall_delta",
						contentIndex: index,
						delta: change.delta,
						partial: snapshot(partial),
					});
				} else {
					await this.#emitUpdate({
						type: change.type,
						contentIndex: index,
						delta: change.delta,
						partial: snapshot(partial),
					});
				}
				continue;
			}
			const block = structuredClone(change.block);
			const previous = partial.content[index];
			partial.content[index] = opening ? emptyBlock(block) : block;
			if (opening) {
				this.#openBlock = index;
				await this.#emitUpdate({ type: startType(block), contentIndex: index, partial: snapshot(partial) });
				partial.content[index] = block;
			}
			const delta = blockDelta(opening ? emptyBlock(block) : previous, block);
			if (delta !== undefined) {
				await this.#emitUpdate({ ...delta, contentIndex: index, partial: snapshot(partial) });
			}
		}
	}

	/** Synthesize pi's `*_end` event for the open block. */
	async #closeBlock(): Promise<void> {
		const partial = this.#partial;
		const index = this.#openBlock;
		this.#openBlock = undefined;
		if (partial === undefined || index === undefined) return;
		const block = partial.content[index];
		if (block === undefined) return;
		if (block.type === "text") {
			await this.#emitUpdate({
				type: "text_end",
				contentIndex: index,
				content: block.text,
				partial: snapshot(partial),
			});
		} else if (block.type === "thinking") {
			await this.#emitUpdate({
				type: "thinking_end",
				contentIndex: index,
				content: block.thinking,
				partial: snapshot(partial),
			});
		} else {
			await this.#emitUpdate({
				type: "toolcall_end",
				contentIndex: index,
				toolCall: structuredClone(block),
				partial: snapshot(partial),
			});
		}
	}

	async #emitUpdate(assistantMessageEvent: AssistantMessageEvent): Promise<void> {
		const partial = this.#partial;
		if (partial === undefined) return;
		await this.#host.emit({ type: "message_update", message: snapshot(partial), assistantMessageEvent });
	}

	async #messageEnd(entry: EntryRecord): Promise<void> {
		this.#lastEntryId = Math.max(this.#lastEntryId, entry.id);
		if (CompactionEntry.is(entry)) {
			this.#summaries.push(entry);
			return;
		}
		const stored = storedAgentMessage(entry);
		const model = entry.model?.[0];
		if (stored !== undefined) {
			// Pi emits message events only for custom messages; bash executions and branch summaries are entries.
			if (stored.role !== "custom") return;
			await this.#emitMessage(stored);
			return;
		}
		if (model === undefined) return;
		// The engine writes a run's prompt change before its input; pi emits it inside the run, after `turn_start`.
		if (model.role === "system" && !this.#runActive) {
			this.#pendingSystem.push(model);
			return;
		}
		if (model.role === "assistant") {
			await this.#assistantEnd(model);
			return;
		}
		if (model.role === "toolResult") {
			this.#turnToolResults.push(model);
			if (!this.#toolArgs.has(model.toolCallId) && !this.#endedTools.has(model.toolCallId)) {
				await this.#endTool({
					type: "tool_execution_end",
					toolCallId: model.toolCallId,
					toolName: model.toolName,
					entry,
				});
			}
		}
		await this.#emitMessage(model);
	}

	async #emitMessage(message: AgentMessage): Promise<void> {
		if (this.#runActive) this.#runMessages.push(message);
		await this.#host.emit({ type: "message_start", message });
		await this.#host.emit({ type: "message_end", message });
	}

	async #assistantEnd(message: AssistantMessage): Promise<void> {
		// An answer that finished within one partial interval was never committed as a partial; replay its blocks so
		// listeners still see pi's start, delta, and end events.
		if (this.#partial === undefined) await this.#startPartial(message);
		await this.#closeBlock();
		this.#partial = undefined;
		this.#turnAssistant = message;
		if (this.#runActive) this.#runMessages.push(message);
		await this.#host.emit({ type: "message_end", message });
		if (message.stopReason === "aborted") this.#outcome = "aborted";
		else if (message.stopReason === "error") this.#outcome = "error";
		else {
			this.#outcome = "completed";
			if (this.#retryAttempt > 0) {
				await this.#host.emit({ type: "auto_retry_end", success: true, attempt: this.#retryAttempt });
				this.#retryAttempt = 0;
			}
		}
	}

	async #startTool(toolCallId: string, toolName: string, args: Record<string, unknown>): Promise<void> {
		this.#toolArgs.set(toolCallId, args);
		await this.#host.emit({ type: "tool_execution_start", toolCallId, toolName, args });
	}

	async #updateTool(toolCallId: string, toolName: string, details: JsonValue | undefined): Promise<void> {
		if (details === null || typeof details !== "object" || Array.isArray(details) || !("partial" in details)) return;
		const args = this.#toolArgs.get(toolCallId) ?? {};
		await this.#host.emit({
			type: "tool_execution_update",
			toolCallId,
			toolName,
			args,
			partialResult: details.partial,
		});
	}

	async #endTool(event: DurableToolEnd): Promise<void> {
		// A call durable answered without running it (a tool its request did not offer) starts here, as in pi.
		if (!this.#toolArgs.has(event.toolCallId)) await this.#startTool(event.toolCallId, event.toolName, {});
		this.#toolArgs.delete(event.toolCallId);
		this.#endedTools.add(event.toolCallId);
		const message = event.entry?.model?.[0];
		const result: AgentToolResult<unknown> =
			message?.role === "toolResult"
				? { content: message.content as (TextContent | ImageContent)[], details: message.details }
				: { content: [], details: {} };
		const isError = message?.role === "toolResult" ? message.isError : true;
		await this.#host.emit({
			type: "tool_execution_end",
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			result,
			isError,
		});
	}

	async #queueUpdate(): Promise<void> {
		const inbox = await this.#host.readInbox();
		const steering: string[] = [];
		const followUp: string[] = [];
		for (const item of inbox?.items ?? []) {
			if (item.mode === "write") continue;
			const text = inputText(item.content as UserMessage["content"]);
			(item.mode === "steer" ? steering : followUp).push(text);
		}
		await this.#host.emit({ type: "queue_update", steering, followUp });
	}

	#noteSubmission(record: SubmissionRecord): void {
		if (record.type !== "input" || record.status !== "unanswered") return;
		this.#outcome = record.reason === "aborted" ? "aborted" : "error";
	}

	async #retryStart(attempt: number, at: number, errorMessage: string): Promise<void> {
		this.#retryAttempt = attempt;
		await this.#host.emit({
			type: "auto_retry_start",
			attempt,
			maxAttempts: this.#host.maxRetries(),
			delayMs: Math.max(0, at - this.#host.now()),
			errorMessage,
		});
	}

	async #compactionEnd(taskId: TaskId, reason: CompactionReason): Promise<void> {
		const outcome = await this.#host.readTaskOutcome(taskId);
		const summary = this.#summaries.pop();
		this.#summaries.length = 0;
		let result: CompactionResult | undefined;
		if (summary !== undefined && outcome?.status === "completed") {
			const record = findCompactionRecord(await this.#host.readCompactionRecords(), summary);
			result = {
				summary: compactionSummaryText(summary) ?? "",
				firstKeptEntryId: String(summary.head),
				tokensBefore: record?.tokensBefore ?? 0,
				...(record === undefined ? {} : { details: record.details }),
			};
		}
		const errorMessage =
			outcome?.status === "failed" || outcome?.status === "faulted" ? outcome.error.message : undefined;
		await this.#host.emit({
			type: "compaction_end",
			reason,
			result,
			aborted: outcome?.status === "aborted",
			willRetry: reason === "overflow" && result !== undefined,
			...(errorMessage === undefined ? {} : { errorMessage }),
		});
	}

	/**
	 * After an overflow snapshot: replay every entry not seen yet, then reconcile tools, the partial, the turn, and the
	 * run with what the snapshot shows.
	 */
	async #catchUp(snapshot: SnapshotEvent): Promise<void> {
		const missed = await this.#host.entriesAfter(this.#lastEntryId);
		// A run the adapter missed starts before its entries, as in pi; one that also ended closes below.
		const runOutput = missed.some((entry) => {
			const role = entry.model?.[0]?.role;
			return role === "assistant" || role === "toolResult";
		});
		if (!this.#runActive && (snapshot.run !== undefined || runOutput)) {
			await this.#startRun();
			await this.#startTurn();
		}
		for (const entry of missed) {
			const message = entry.model?.[0];
			if (message?.role === "toolResult" && this.#toolArgs.has(message.toolCallId)) {
				await this.#endTool({
					type: "tool_execution_end",
					toolCallId: message.toolCallId,
					toolName: message.toolName,
					entry,
				});
			}
			await this.#messageEnd(entry);
		}
		for (const slot of snapshot.tools) {
			if (slot.status === "running" && !this.#toolArgs.has(slot.callId))
				await this.#startTool(slot.callId, slot.name, {});
		}
		const partial = snapshot.generation?.message;
		if (partial !== undefined) {
			if (this.#partial === undefined) await this.#startPartial(partial);
			else await this.#update([{ type: "message", message: partial }], partial.usage);
		}
		if (snapshot.run === undefined && this.#runActive) await this.#endRun();
		await this.#queueUpdate();
	}
}

function snapshot(message: AssistantMessage): AssistantMessage {
	return structuredClone(message);
}

function startType(block: Block): "text_start" | "thinking_start" | "toolcall_start" {
	return block.type === "text" ? "text_start" : block.type === "thinking" ? "thinking_start" : "toolcall_start";
}

function emptyBlock(block: Block): Block {
	if (block.type === "text") return { ...block, text: "" };
	if (block.type === "thinking") return { ...block, thinking: "" };
	return { ...block, arguments: {} };
}

/** The delta event that turns `previous` into `next`, for a block sent whole. */
function blockDelta(
	previous: Block | undefined,
	next: Block,
): { type: "text_delta" | "thinking_delta"; delta: string } | { type: "toolcall_delta"; delta: string } | undefined {
	if (next.type === "text") {
		const before = previous?.type === "text" ? previous.text : "";
		const delta = next.text.startsWith(before) ? next.text.slice(before.length) : next.text;
		return delta === "" ? undefined : { type: "text_delta", delta };
	}
	if (next.type === "thinking") {
		const before = previous?.type === "thinking" ? previous.thinking : "";
		const delta = next.thinking.startsWith(before) ? next.thinking.slice(before.length) : next.thinking;
		return delta === "" ? undefined : { type: "thinking_delta", delta };
	}
	const args = JSON.stringify(next.arguments);
	return args === "{}" ? undefined : { type: "toolcall_delta", delta: args };
}

function applyDelta(
	partial: AssistantMessage,
	change: Extract<MessageChange, { type: "text_delta" | "thinking_delta" | "toolcall_delta" }>,
): void {
	const block = partial.content[change.contentIndex];
	if (block === undefined) return;
	if (change.type === "text_delta" && block.type === "text") block.text += change.delta;
	else if (change.type === "thinking_delta" && block.type === "thinking") block.thinking += change.delta;
	else if (change.type === "toolcall_delta" && block.type === "toolCall")
		appendAtPath(block, change.path, change.delta);
}

/** Append `delta` to the string at `path` inside a tool call's arguments. */
function appendAtPath(call: ToolCall, path: readonly (string | number)[], delta: string): void {
	if (path.length === 0) return;
	let target: unknown = call.arguments;
	for (const segment of path.slice(0, -1)) {
		if (target === null || typeof target !== "object") return;
		target = (target as Record<string | number, unknown>)[segment];
	}
	if (target === null || typeof target !== "object") return;
	const container = target as Record<string | number, unknown>;
	const key = path[path.length - 1]!;
	const current = container[key];
	container[key] = (typeof current === "string" ? current : "") + delta;
}

function inputText(content: UserMessage["content"]): string {
	if (typeof content === "string") return content;
	return content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/** Stand-in answer for `turn_end` when a turn produced none (no model, a faulted generation). */
function failedTurnMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "",
		provider: "",
		model: "",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: "The turn ended without a response",
		timestamp: Date.now(),
	};
}
