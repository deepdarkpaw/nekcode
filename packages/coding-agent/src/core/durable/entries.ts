import { createHash } from "node:crypto";
import type { JsonValue } from "@earendil-works/chord";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import {
	CompactionEntry,
	defineDoc,
	type EntryDraft,
	type EntryRecord,
	type JsonObject,
} from "@earendil-works/pi-durable";
import { COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX } from "../messages.ts";
import { toStrictJsonObject } from "./json.ts";

/**
 * Entry kind of a pi message with a coding-agent role (`custom`, `bashExecution`, `branchSummary`). `data.message`
 * keeps the original `AgentMessage` so extensions and UIs see pi's message; `model` holds its `convertToLlm` result,
 * which is what durable sends. A display-only message is written without `model` and never reaches the model.
 */
export const NEK_MESSAGE_KIND = "nek.message";

/** `data` of a {@link NEK_MESSAGE_KIND} entry. */
export type NekMessageData = { readonly message: JsonObject };

/** Converts pi messages to model messages; pi's `convertToLlm` or a host variant of it. */
export type ConvertToLlm = (messages: AgentMessage[]) => Message[];

/** Entry draft for a pi message with a coding-agent role. `display: "only"` keeps it out of model context. */
export function agentMessageEntry(
	message: AgentMessage,
	convert: ConvertToLlm,
	options: { readonly displayOnly?: boolean } = {},
): EntryDraft {
	const model = options.displayOnly === true ? [] : convert([message]);
	const data: NekMessageData = { message: toStrictJsonObject(message) };
	return { kind: NEK_MESSAGE_KIND, data, ...(model.length === 0 ? {} : { model }) };
}

/** The original pi message of a {@link NEK_MESSAGE_KIND} entry. */
export function storedAgentMessage(entry: EntryRecord): AgentMessage | undefined {
	if (entry.kind !== NEK_MESSAGE_KIND) return undefined;
	const data = entry.data;
	if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
	const message = data.message;
	if (message === null || typeof message !== "object" || Array.isArray(message) || typeof message.role !== "string") {
		return undefined;
	}
	return message as unknown as AgentMessage;
}

/** Pi's compaction details for one durable summary, which the `pi.compaction` entry itself cannot carry. */
export type CompactionRecord = {
	/** The summary entry's `head`: the first entry kept verbatim. */
	readonly firstKept: number;
	/** Hash of the summary text, which identifies the summary among summaries with the same `firstKept`. */
	readonly summaryHash: string;
	readonly tokensBefore: number;
	/** Pi's `CompactionEntry.details`: `{ readFiles, modifiedFiles }` for pi summaries, extension data otherwise. */
	readonly details: JsonValue;
	/** Whether a `session_before_compact` handler supplied the summary. */
	readonly fromHook: boolean;
};

/** Bound on retained records; older summaries fall out of context long before this many newer ones exist. */
export const MAX_COMPACTION_RECORDS = 64;

/**
 * Side records of the conversation's compactions. `fork: "current"` lets a fork inherit the records of the summaries
 * it inherits.
 */
export const CompactionDetailsDoc = defineDoc<{ records: CompactionRecord[] }>({
	kind: "nek.compaction-details",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ records: [] }),
});

export function hashSummary(summary: string): string {
	return createHash("sha256").update(summary).digest("hex").slice(0, 32);
}

/** The summary text of a `pi.compaction` entry, without durable's wrapper. */
export function compactionSummaryText(entry: EntryRecord): string | undefined {
	if (!CompactionEntry.is(entry)) return undefined;
	const message = entry.model?.[0];
	if (message?.role !== "user") return undefined;
	const text =
		typeof message.content === "string"
			? message.content
			: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
	if (!text.startsWith(COMPACTION_SUMMARY_PREFIX) || !text.endsWith(COMPACTION_SUMMARY_SUFFIX)) return text;
	return text.slice(COMPACTION_SUMMARY_PREFIX.length, text.length - COMPACTION_SUMMARY_SUFFIX.length);
}

/** The side record of a `pi.compaction` entry, matched by its head and summary text. */
export function findCompactionRecord(
	records: readonly CompactionRecord[],
	entry: EntryRecord,
): CompactionRecord | undefined {
	const summary = compactionSummaryText(entry);
	if (summary === undefined || entry.head === undefined) return undefined;
	const hash = hashSummary(summary);
	for (let index = records.length - 1; index >= 0; index--) {
		const record = records[index]!;
		if (record.firstKept === entry.head && record.summaryHash === hash) return record;
	}
	return undefined;
}
