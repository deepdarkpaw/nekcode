import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { CompactionEntry, type EntryRecord, type JsonObject } from "@earendil-works/pi-durable";
import { createBranchSummaryMessage, createCustomMessage } from "../messages.ts";
import {
	type ContextEditEntry,
	type FileEntry,
	projectContextEntry,
	type SessionEntry,
	type SessionHeader,
	sessionEntryToContextMessages,
} from "../session-entries.ts";
import {
	type CompactionRecord,
	type ConvertToLlm,
	compactionSummaryText,
	findCompactionRecord,
	NEK_MESSAGE_KIND,
} from "./entries.ts";

/**
 * How a pi session lives in durable storage.
 *
 * Every pi `SessionEntry` is exactly one durable entry, and `data.entry` keeps the pi entry itself (its id, parentId,
 * timestamp, and fields), so the pi tree reads back unchanged. Entries that reach the model also carry `model`, the
 * messages durable sends, so durable derives the same model context pi builds from the same path:
 *
 * | pi entry | durable kind | model |
 * |---|---|---|
 * | `message` with role user, assistant, toolResult, system | `pi.user`, `pi.assistant`, `pi.tool-result`, `pi.system` | the message (kept only there) |
 * | `message` with a coding-agent role, `custom_message`, `branch_summary` | `nek.message` | `convertToLlm` of its context messages |
 * | `compaction` | `pi.compaction`, `head` = the first kept entry or itself | system message and summary; kept system messages omitted by `edits` |
 * | `context_edit` | `nek.context_edit` | none; `edits` omit or replace the target |
 * | state entries (`model_change`, `label`, `session_info`, ...) | `nek.<type>` | none |
 *
 * The session header is the first entry of the root conversation, kind `nek.session`.
 *
 * Entries written by durable itself (the engine's answers, tool results, system prompt changes, and compactions)
 * carry no `data.entry`; {@link projectRecord} derives their pi entry from the durable record.
 */
export const SESSION_HEADER_KIND = "nek.session";

/** Durable kind of a message entry whose message durable owns. */
const MESSAGE_KINDS: Readonly<Record<string, string>> = {
	user: "pi.user",
	assistant: "pi.assistant",
	toolResult: "pi.tool-result",
	system: "pi.system",
};

/** Durable entry with references to pi entry IDs, resolved to durable IDs when the store writes it. */
export type EntryPlan = {
	/** The pi entry or header this plan writes; the store's summary reads it. */
	readonly source: FileEntry;
	readonly kind: string;
	readonly data: JsonObject;
	readonly model?: readonly Message[];
	/** pi ID of the first kept entry, or `"self"`. */
	readonly head?: string;
	readonly edits?: readonly PlannedEdit[];
};

export type PlannedEdit =
	| { readonly target: string; readonly action: "omit" }
	| { readonly target: string; readonly action: "replace"; readonly messages: readonly Message[] };

/** What planning needs from the session tree. */
export interface PlanningTree {
	getEntry(id: string): SessionEntry | undefined;
	/** Entries from the root to `id`, inclusive. */
	getBranch(id: string): SessionEntry[];
}

function json<T>(value: T): JsonObject {
	return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function jsonMessages(messages: readonly Message[]): Message[] {
	return JSON.parse(JSON.stringify(messages)) as Message[];
}

export function planHeader(header: SessionHeader): EntryPlan {
	return { source: header, kind: SESSION_HEADER_KIND, data: { header: json(header) } };
}

/** The durable entry for one pi entry, given the tree it was appended to. */
export function planEntry(entry: SessionEntry, tree: PlanningTree, convert: ConvertToLlm): EntryPlan {
	if (entry.type === "message") {
		const kind = MESSAGE_KINDS[entry.message.role];
		const message = entry.message as { content?: unknown };
		if (kind !== undefined && message.content != null) {
			const { message: owned, ...rest } = entry;
			return { source: entry, kind, data: { entry: json(rest) }, model: jsonMessages([owned as Message]) };
		}
		return modelEntry(entry, NEK_MESSAGE_KIND, convert);
	}
	if (entry.type === "custom_message" || entry.type === "branch_summary") {
		return modelEntry(entry, NEK_MESSAGE_KIND, convert);
	}
	if (entry.type === "compaction") return planCompaction(entry, tree, convert);
	if (entry.type === "context_edit") return planContextEdit(entry, tree, convert);
	return { source: entry, kind: `nek.${entry.type}`, data: { entry: json(entry) } };
}

function modelEntry(entry: SessionEntry, kind: string, convert: ConvertToLlm): EntryPlan {
	const model = convert(sessionEntryToContextMessages(entry));
	return {
		source: entry,
		kind,
		data: { entry: json(entry) },
		...(model.length === 0 ? {} : { model: jsonMessages(model) }),
	};
}

/**
 * A compaction keeps the path from `firstKeptEntryId` to itself, minus system messages, after its own system message
 * and summary. Durable keeps the entries from `head` on and drops older head markers; `edits` omit the kept system
 * messages. A first kept entry that is not on the path keeps nothing, as in pi.
 */
function planCompaction(
	entry: Extract<SessionEntry, { type: "compaction" }>,
	tree: PlanningTree,
	convert: ConvertToLlm,
): EntryPlan {
	const path = entry.parentId === null ? [] : tree.getBranch(entry.parentId);
	const firstKept = path.findIndex((each) => each.id === entry.firstKeptEntryId);
	const kept = firstKept < 0 ? [] : path.slice(firstKept);
	const edits: PlannedEdit[] = kept
		.filter((each) => each.type === "message" && each.message.role === "system")
		.map((each) => ({ target: each.id, action: "omit" }));
	const model = convert(sessionEntryToContextMessages(entry));
	return {
		source: entry,
		kind: CompactionEntry.kind,
		data: { reason: "manual", entry: json(entry) },
		model: jsonMessages(model),
		head: firstKept < 0 ? "self" : entry.firstKeptEntryId,
		...(edits.length === 0 ? {} : { edits }),
	};
}

/** A context edit omits its target or replaces the target's model messages with the edited ones. */
function planContextEdit(entry: ContextEditEntry, tree: PlanningTree, convert: ConvertToLlm): EntryPlan {
	const target = tree.getEntry(entry.targetId);
	const base: EntryPlan = { source: entry, kind: `nek.${entry.type}`, data: { entry: json(entry) } };
	if (target === undefined) return base;
	const edit: PlannedEdit =
		entry.replacement === null
			? { target: entry.targetId, action: "omit" }
			: {
					target: entry.targetId,
					action: "replace",
					messages: jsonMessages(convert(projectContextEntry(target, entry))),
				};
	return { ...base, edits: [edit] };
}

/** The pi side of one durable record: the session header, a pi entry, or nothing for durable bookkeeping. */
export type ProjectedRecord =
	| { readonly type: "header"; readonly header: SessionHeader }
	| { readonly type: "entry"; readonly entry: SessionEntry }
	| { readonly type: "hidden" };

/** Identity a record without a stored pi entry takes in the pi tree. */
export type DerivedIdentity = {
	readonly id: string;
	readonly parentId: string | null;
	/** Timestamp to use when the record's own messages carry none. */
	readonly fallbackTimestamp: string;
	/** pi ID of a durable entry, for compaction heads. */
	readonly idOf: (entryId: number) => string | undefined;
	readonly compactionRecords: readonly CompactionRecord[];
};

/** pi ID of a durable entry written without a stored pi entry. */
export function derivedEntryId(entryId: number): string {
	return `n${entryId}`;
}

function storedEntry(record: EntryRecord): JsonObject | undefined {
	const data = record.data;
	if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
	const entry = data.entry;
	if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
	return typeof entry.type === "string" && typeof entry.id === "string" ? entry : undefined;
}

/** Whether a record carries its pi entry, so its identity does not need deriving. */
export function hasStoredEntry(record: EntryRecord): boolean {
	return record.kind === SESSION_HEADER_KIND || storedEntry(record) !== undefined;
}

/** Project one durable record into the pi session. */
export function projectRecord(record: EntryRecord, derive: () => DerivedIdentity): ProjectedRecord {
	if (record.kind === SESSION_HEADER_KIND) {
		const data = record.data as { header?: SessionHeader } | undefined;
		return data?.header === undefined ? { type: "hidden" } : { type: "header", header: data.header };
	}
	const stored = storedEntry(record);
	if (stored !== undefined) {
		if (stored.type === "message" && stored.message === undefined) {
			const message = record.model?.[0];
			if (message === undefined) return { type: "hidden" };
			return { type: "entry", entry: { ...stored, message } as unknown as SessionEntry };
		}
		return { type: "entry", entry: stored as unknown as SessionEntry };
	}
	const entry = deriveEntry(record, derive());
	return entry === undefined ? { type: "hidden" } : { type: "entry", entry };
}

function isoTimestamp(messages: readonly Message[] | undefined, fallback: string): string {
	const timestamp = messages?.find(
		(message) => typeof message.timestamp === "number" && message.timestamp > 0,
	)?.timestamp;
	return timestamp === undefined ? fallback : new Date(timestamp).toISOString();
}

/** The pi entry of a record durable wrote: a message, a compaction, or a stored pi message. */
function deriveEntry(record: EntryRecord, identity: DerivedIdentity): SessionEntry | undefined {
	const base = {
		id: identity.id,
		parentId: identity.parentId,
		timestamp: isoTimestamp(record.model, identity.fallbackTimestamp),
	};
	if (record.kind === "nek.custom") {
		const data = record.data;
		if (data === null || typeof data !== "object" || Array.isArray(data) || typeof data.customType !== "string")
			return undefined;
		return {
			...base,
			type: "custom",
			customType: data.customType,
			...(data.data === undefined ? {} : { data: data.data }),
		};
	}
	if (record.kind === "nek.context_edit") {
		const data = record.data;
		if (
			data === null ||
			typeof data !== "object" ||
			Array.isArray(data) ||
			typeof data.targetId !== "string" ||
			(data.replacement !== null &&
				(data.replacement === undefined || typeof data.replacement !== "object" || Array.isArray(data.replacement)))
		)
			return undefined;
		return {
			...base,
			type: "context_edit",
			targetId: data.targetId,
			replacement: data.replacement as ContextEditEntry["replacement"],
		};
	}
	if (record.kind === NEK_MESSAGE_KIND) {
		const data = record.data as { message?: AgentMessage } | undefined;
		const message = data?.message;
		if (message === undefined) return undefined;
		if (message.role === "custom") {
			return {
				...base,
				type: "custom_message",
				customType: message.customType,
				content: message.content,
				display: message.display,
				...(message.details === undefined ? {} : { details: message.details }),
			};
		}
		if (message.role === "branchSummary") {
			return { ...base, type: "branch_summary", fromId: message.fromId ?? "root", summary: message.summary };
		}
		if (message.role === "bashExecution") return { ...base, type: "message", message };
		return undefined;
	}
	if (CompactionEntry.is(record)) {
		const summary = compactionSummaryText(record) ?? "";
		const compaction = findCompactionRecord(identity.compactionRecords, record);
		const system = record.model?.find((message) => message.role === "system");
		const firstKept = record.head === undefined || record.head === record.id ? base.id : identity.idOf(record.head);
		return {
			...base,
			type: "compaction",
			summary,
			firstKeptEntryId: firstKept ?? base.id,
			tokensBefore: compaction?.tokensBefore ?? 0,
			...(compaction === undefined ? {} : { details: compaction.details, fromHook: compaction.fromHook }),
			...(system?.role === "system" ? { systemMessage: system } : {}),
		};
	}
	const message = record.model?.[0];
	if (message === undefined || record.model?.length !== 1) return undefined;
	if (MESSAGE_KINDS[message.role] !== record.kind) return undefined;
	return { ...base, type: "message", message };
}

/** Stored pi message of a `nek.message` entry written by the planner or the engine. */
export function storedSessionMessages(record: EntryRecord): AgentMessage[] | undefined {
	const stored = storedEntry(record);
	if (stored === undefined) return undefined;
	return sessionEntryToContextMessages(stored as unknown as SessionEntry);
}

export { createBranchSummaryMessage, createCustomMessage };
