import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { CompactionEntry, type ContextView, type EntryId, type EntryRecord } from "@earendil-works/pi-durable";
import { type CompactionRecord, compactionDetails, compactionSummaryText, storedAgentMessage } from "./entries.ts";

/**
 * One item of the pi view of model context: the pi message an extension sees and, when it reaches the model, the
 * durable model message it became. A message pi keeps in context but `convertToLlm` drops (a `!!` bash execution)
 * has no `llm` part.
 */
type ContextItem = { readonly agent: AgentMessage; readonly llm: Message | undefined };

/** Pi's view of one durable model context. */
export type AgentContext = {
	/** What pi's `context` handlers receive. */
	readonly messages: AgentMessage[];
	/** The model messages `messages` stand for, in the same order as durable's model context. */
	readonly llm: Message[];
};

/** Text durable puts in a tool result it synthesizes for a call whose result is missing (durable `context.ts`). */
const MISSING_RESULT_TEXT = "Tool result unavailable: history ends before this call completed.";

/**
 * Rebuild pi messages for a durable context, entry by entry, through `cutoff` when given.
 *
 * - A `nek.message` entry whose model contribution is unedited stands for its stored pi message.
 * - A `pi.compaction` head marker stands for a `compactionSummary` message with its recorded `tokensBefore`.
 * - Any other contribution, or an edited one, stands for itself: a model message is a valid pi message.
 *
 * Durable then moves each tool result directly after its assistant and synthesizes missing ones; the same ordering
 * is applied here, so `llm` equals the model context durable derived from the same view.
 */
export function agentContext(view: ContextView, records: readonly CompactionRecord[], cutoff?: EntryId): AgentContext {
	const items: ContextItem[] = [];
	view.entries.forEach((entry, index) => {
		if (cutoff !== undefined && entry.id > cutoff) return;
		items.push(...entryItems(entry, view.contributions[index] ?? [], records));
	});
	const ordered = orderToolResults(items);
	return {
		messages: ordered.map((item) => item.agent),
		llm: ordered.flatMap((item) => (item.llm === undefined ? [] : [item.llm])),
	};
}

function entryItems(
	entry: EntryRecord,
	contribution: readonly Message[],
	records: readonly CompactionRecord[],
): ContextItem[] {
	const unedited =
		contribution.length === (entry.model?.length ?? 0) &&
		contribution.every((message, index) => message === entry.model?.[index]);
	const stored = storedAgentMessage(entry);
	if (stored !== undefined && unedited) {
		// A message pi keeps in its context while `convertToLlm` drops it, such as an excluded bash execution.
		if (contribution.length === 0)
			return entry.model === undefined && isContextOnly(stored) ? [{ agent: stored, llm: undefined }] : [];
		return [{ agent: stored, llm: contribution[0] }, ...contribution.slice(1).map((llm) => ({ agent: llm, llm }))];
	}
	// A context edit replaced a custom message's content; pi keeps the custom message with the new content.
	if (stored?.role === "custom" && contribution.length === 1 && contribution[0]!.role === "user") {
		return [{ agent: { ...stored, content: contribution[0]!.content }, llm: contribution[0] }];
	}
	if (CompactionEntry.is(entry) && unedited) {
		const summary = compactionSummaryText(entry);
		const index = contribution.findIndex((message) => message.role === "user");
		if (summary !== undefined && index >= 0) {
			// An imported compaction also contributes its system message, before the summary.
			const tokensBefore = compactionDetails(records, entry)?.tokensBefore ?? 0;
			return contribution.map((message, position) =>
				position === index
					? {
							agent: { role: "compactionSummary", summary, tokensBefore, timestamp: message.timestamp },
							llm: message,
						}
					: { agent: message, llm: message },
			);
		}
	}
	return contribution.map((message) => ({ agent: message, llm: message }));
}

/** Pi lists these messages in context although they never reach the model. */
function isContextOnly(message: AgentMessage): boolean {
	return message.role === "bashExecution" && message.excludeFromContext === true;
}

/** Durable's `orderToolResults()` applied to items keyed by their model message. */
function orderToolResults(items: readonly ContextItem[]): ContextItem[] {
	const ordered: ContextItem[] = [];
	for (let index = 0; index < items.length; index++) {
		const item = items[index]!;
		const message = item.llm;
		if (message?.role === "toolResult") continue;
		ordered.push(item);
		if (message?.role !== "assistant") continue;
		const calls = message.content.filter((content): content is ToolCall => content.type === "toolCall");
		if (calls.length === 0) continue;
		const results = new Map<string, ContextItem>();
		for (let next = index + 1; next < items.length && items[next]!.llm?.role !== "assistant"; next++) {
			const candidate = items[next]!;
			if (candidate.llm?.role === "toolResult" && !results.has(candidate.llm.toolCallId)) {
				results.set(candidate.llm.toolCallId, candidate);
			}
		}
		for (const call of calls) {
			const result = results.get(call.id);
			if (result !== undefined) ordered.push(result);
			else {
				const missing = missingResult(call, message.timestamp);
				ordered.push({ agent: missing, llm: missing });
			}
		}
	}
	return ordered;
}

function missingResult(call: ToolCall, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: MISSING_RESULT_TEXT }],
		isError: true,
		details: { reason: "missing_result" },
		timestamp,
	};
}

/**
 * Whether `actual` is the model context `expected` describes: same length, and per position the same role,
 * timestamp, and, for tool results, the same call. Durable derives both from the same immutable entries.
 */
export function sameModelContext(expected: readonly Message[], actual: readonly Message[]): boolean {
	return (
		expected.length === actual.length &&
		expected.every((message, index) => {
			const other = actual[index]!;
			if (message.role !== other.role || message.timestamp !== other.timestamp) return false;
			return (
				message.role !== "toolResult" || (other.role === "toolResult" && message.toolCallId === other.toolCallId)
			);
		})
	);
}
