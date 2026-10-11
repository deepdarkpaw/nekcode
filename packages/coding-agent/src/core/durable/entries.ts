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
import { type SessionEntry, sessionEntryToContextMessages } from "../session-entries.ts";
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

/** The pi entry a session entry stored with its durable entry (`data.entry`), if any. */
export function storedSessionEntry(entry: EntryRecord): SessionEntry | undefined {
	const data = entry.data;
	if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
	const stored = data.entry;
	if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return undefined;
	return typeof stored.type === "string" && typeof stored.id === "string"
		? (stored as unknown as SessionEntry)
		: undefined;
}

/**
 * The original pi message of a {@link NEK_MESSAGE_KIND} entry: `data.message` when the engine wrote it, else the
 * context message of the stored session entry (custom messages, branch summaries, bash executions).
 */
export function storedAgentMessage(entry: EntryRecord): AgentMessage | undefined {
	if (entry.kind !== NEK_MESSAGE_KIND) return undefined;
	const data = entry.data;
	if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
	const sessionEntry = storedSessionEntry(entry);
	if (sessionEntry !== undefined) return sessionEntryToContextMessages(sessionEntry)[0];
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

/**
 * Whether a run the host started has not finished settling (`agent_before_settle`, then `agent_settled` or a
 * continuation). Set when the host starts a run and cleared in the commit that writes the settlement's entries, so a
 * session reopened after a crash during settlement settles that run again.
 */
export const SettlementDoc = defineDoc<{ pending: boolean }>({
	kind: "nek.settlement",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ pending: false }),
});

export function hashSummary(summary: string): string {
	return createHash("sha256").update(summary).digest("hex").slice(0, 32);
}

/** The summary text of a `pi.compaction` entry, without durable's wrapper. */
export function compactionSummaryText(entry: EntryRecord): string | undefined {
	if (!CompactionEntry.is(entry)) return undefined;
	const stored = storedSessionEntry(entry);
	if (stored?.type === "compaction") return stored.summary;
	// An imported compaction contributes its system message before the summary.
	const message = entry.model?.find((each) => each.role === "user");
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

/** Pi's `tokensBefore`, `details`, and `fromHook` of a `pi.compaction` entry: stored with it, or in the side record. */
export function compactionDetails(
	records: readonly CompactionRecord[],
	entry: EntryRecord,
): { readonly tokensBefore: number; readonly details?: unknown; readonly fromHook?: boolean } | undefined {
	const stored = storedSessionEntry(entry);
	if (stored?.type === "compaction") {
		return { tokensBefore: stored.tokensBefore, details: stored.details, fromHook: stored.fromHook };
	}
	return findCompactionRecord(records, entry);
}
