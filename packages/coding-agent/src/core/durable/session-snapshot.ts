import {
	type ConversationId,
	type ConversationRecord,
	type EntryId,
	type EntryRecord,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import type { SyncSqliteConnection } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { FileEntry, SessionEntry, SessionHeader } from "../session-entries.ts";
import { derivedEntryId, hasStoredEntry, projectRecord, SESSION_HEADER_KIND } from "./session-format.ts";
import { openSqlite } from "./sqlite.ts";

/**
 * Synchronous read of a durable session database.
 *
 * `SessionManager` opens sessions synchronously, while durable's Session API is asynchronous. Committed entries and
 * conversations are immutable rows of durable's SQLite schema (`conversations.record` and `entries.record` hold the
 * JSON records), so they are read here directly through `node:sqlite`. Documents are not read: their revisions are
 * deltas that only the Session materializes. Only schema version 1 is understood; a newer schema fails the read.
 */
const SUPPORTED_SCHEMA_VERSION = 1;

/** Committed conversations and entries of one session database, entries in ID order. */
export type SessionSnapshot = {
	readonly conversations: readonly ConversationRecord[];
	readonly entries: readonly EntryRecord[];
	/** Commit sequence of the next write; changes whenever anything commits. */
	readonly nextSeq: number;
};

type RecordRow = { readonly record: string };

function openDatabase(path: string): SyncSqliteConnection {
	const db = openSqlite(path, { readOnly: true });
	try {
		const row = db.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get() as
			| { version: number }
			| undefined;
		if (row?.version !== SUPPORTED_SCHEMA_VERSION) {
			throw new Error(`Unsupported durable session schema version ${String(row?.version)} in ${path}`);
		}
		return db;
	} catch (error) {
		db.close();
		throw error;
	}
}

export function readSessionSnapshot(path: string): SessionSnapshot {
	const db = openDatabase(path);
	try {
		const conversations = (db.prepare("SELECT record FROM conversations ORDER BY id").all() as RecordRow[]).map(
			(row) => JSON.parse(row.record) as ConversationRecord,
		);
		const entries = (db.prepare("SELECT record FROM entries ORDER BY id").all() as RecordRow[]).map(
			(row) => JSON.parse(row.record) as EntryRecord,
		);
		const { next_seq: nextSeq } = db.prepare("SELECT next_seq FROM durable_metadata WHERE singleton = 1").get() as {
			next_seq: number;
		};
		return { conversations, entries, nextSeq };
	} finally {
		db.close();
	}
}

/** The session header of a database, read without loading its entries. */
export function readSnapshotHeader(path: string): SessionHeader | null {
	const db = openDatabase(path);
	try {
		const row = db
			.prepare("SELECT record FROM entries WHERE conversation_id = ? ORDER BY id LIMIT 1")
			.get(ROOT_CONVERSATION_ID) as RecordRow | undefined;
		if (row === undefined) return null;
		const record = JSON.parse(row.record) as EntryRecord;
		if (record.kind !== SESSION_HEADER_KIND) return null;
		const projected = projectRecord(record, () => {
			throw new Error("A session header has a stored identity");
		});
		return projected.type === "header" ? projected.header : null;
	} finally {
		db.close();
	}
}

/**
 * Where each pi entry lives in durable storage, and the newest pi entry of each conversation. Appending a pi entry
 * continues the conversation whose newest entry is its parent, forks the conversation that holds its parent, or starts
 * a new conversation for a root entry.
 */
export class Placement {
	readonly durableIds = new Map<string, EntryId>();
	readonly home = new Map<string, ConversationId>();
	/** pi ID of each conversation's newest entry; `null` while it holds no pi entry (the root holds the header). */
	readonly tails = new Map<ConversationId, string | null>();
	headerWritten = false;

	record(piId: string, entryId: EntryId, conversationId: ConversationId): void {
		this.durableIds.set(piId, entryId);
		this.home.set(piId, conversationId);
		this.tails.set(conversationId, piId);
	}

	/** The conversation whose newest pi entry is `piId`. */
	conversationEndingAt(piId: string): ConversationId | undefined {
		for (const [conversationId, tail] of this.tails) if (tail === piId) return conversationId;
		return undefined;
	}
}

/** A session read back from durable storage. */
export type ProjectedSession = {
	readonly header: SessionHeader | undefined;
	/** Header first, then pi entries in append order. */
	readonly fileEntries: FileEntry[];
	readonly placement: Placement;
};

/**
 * Project a snapshot into pi entries. Entries durable wrote without a stored pi entry get a derived identity. Every
 * entry's parent is the newest pi entry before it in its conversation's history, which for a fork's first entry is the
 * newest pi entry at or before the fork point.
 */
export function projectSnapshot(snapshot: SessionSnapshot): ProjectedSession {
	const parents = new Map(snapshot.conversations.map((record) => [record.id, record.parent]));
	const placement = new Placement();
	for (const record of snapshot.conversations) placement.tails.set(record.id, null);
	/** Newest pi entry visible at each durable entry, within the entry's conversation history. */
	const visibleAt = new Map<EntryId, string | null>();
	const piIdOf = new Map<EntryId, string>();
	let header: SessionHeader | undefined;
	const fileEntries: FileEntry[] = [];
	let lastTimestamp = new Date(0).toISOString();

	const newestBefore = (conversationId: ConversationId): string | null => {
		const tail = placement.tails.get(conversationId);
		if (tail !== undefined && tail !== null) return tail;
		const parent = parents.get(conversationId);
		return parent === undefined ? null : (visibleAt.get(parent.at) ?? null);
	};

	for (const record of snapshot.entries) {
		const parentId = newestBefore(record.conversationId);
		const projected = projectRecord(record, () => ({
			id: derivedEntryId(record.id),
			parentId,
			fallbackTimestamp: lastTimestamp,
			idOf: (entryId) => piIdOf.get(entryId as EntryId),
			compactionRecords: [],
		}));
		if (projected.type === "header") {
			if (record.conversationId === ROOT_CONVERSATION_ID) {
				header ??= projected.header;
				placement.headerWritten = true;
			}
			visibleAt.set(record.id, parentId);
			continue;
		}
		if (projected.type === "hidden") {
			visibleAt.set(record.id, parentId);
			continue;
		}
		// Within a conversation the pi path is its entry order: an entry's parent is the newest pi entry before it, even
		// when its stored parentId names an older one (written while the engine appended entries the writer had not
		// read yet). Imported and branched entries already agree with that order.
		const entry: SessionEntry =
			hasStoredEntry(record) && projected.entry.parentId !== parentId
				? { ...projected.entry, parentId }
				: projected.entry;
		piIdOf.set(record.id, entry.id);
		visibleAt.set(record.id, entry.id);
		placement.record(entry.id, record.id, record.conversationId);
		fileEntries.push(entry);
		if (!hasStoredEntry(record)) lastTimestamp = entry.timestamp;
		else if (typeof entry.timestamp === "string") lastTimestamp = entry.timestamp;
	}
	return { header, fileEntries: header === undefined ? fileEntries : [header, ...fileEntries], placement };
}
