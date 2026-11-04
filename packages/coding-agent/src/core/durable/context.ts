import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
	CompactionEntry,
	type ContextView,
	type EntryId,
	type EntryRecord,
	leadWithSystemBy,
	orderToolResultsBy,
} from "@earendil-works/pi-durable";
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

/**
 * Rebuild pi messages for a durable context, entry by entry, through `cutoff` when given.
 *
 * - A `nek.message` entry whose model contribution is unedited stands for its stored pi message.
 * - A `pi.compaction` head marker stands for a `compactionSummary` message with its recorded `tokensBefore`.
 * - Any other contribution, or an edited one, stands for itself: a model message is a valid pi message.
 *
 * Durable then moves each tool result directly after its assistant, synthesizes missing ones, and moves a system
 * message that only user messages precede to the front; the same ordering is applied here, so `llm` equals the model
 * context durable derived from the same view.
 */
export function agentContext(view: ContextView, records: readonly CompactionRecord[], cutoff?: EntryId): AgentContext {
	const items: ContextItem[] = [];
	view.entries.forEach((entry, index) => {
		if (cutoff !== undefined && entry.id > cutoff) return;
		items.push(...entryItems(entry, view.contributions[index] ?? [], records));
	});
	const messageOf = (item: ContextItem) => item.llm;
	const ordered = leadWithSystemBy(
		orderToolResultsBy(items, messageOf, (llm) => ({ agent: llm, llm })),
		messageOf,
	);
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
