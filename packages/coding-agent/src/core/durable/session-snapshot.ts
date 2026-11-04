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
	return readSnapshotDelta(path, EMPTY_SNAPSHOT_WATER);
}

/** Two indexed range reads in one SQLite snapshot; document-only commits return no historical rows. */
export function readSnapshotDelta(path: string, water: SnapshotWater): SessionSnapshot {
	const db = openDatabase(path);
	try {
		db.exec("BEGIN");
		const conversations = (
			db
				.prepare("SELECT record FROM conversations WHERE id > ? ORDER BY id")
				.all(water.conversationId) as RecordRow[]
		).map((row) => JSON.parse(row.record) as ConversationRecord);
		const entries = (
			db.prepare("SELECT record FROM entries WHERE id > ? ORDER BY id").all(water.entryId) as RecordRow[]
		).map((row) => JSON.parse(row.record) as EntryRecord);
		const { next_seq: nextSeq } = db.prepare("SELECT next_seq FROM durable_metadata WHERE singleton = 1").get() as {
			next_seq: number;
		};
		db.exec("COMMIT");
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

	/** Independent write placement; transaction staging must never mutate the committed projection. */
	copy(): Placement {
		const copy = new Placement();
		for (const [id, value] of this.durableIds) copy.durableIds.set(id, value);
		for (const [id, value] of this.home) copy.home.set(id, value);
		for (const [id, value] of this.tails) copy.tails.set(id, value);
		copy.headerWritten = this.headerWritten;
		return copy;
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
	const projection = new SnapshotProjection();
	const { entries } = projection.fold(snapshot);
	const header = projection.header;
	return {
		header,
		fileEntries: header === undefined ? entries : [header, ...entries],
		placement: projection.placement,
	};
}

/** Committed immutable-row high water, independent of document/progress commit sequences. */
export type SnapshotWater = { readonly conversationId: number; readonly entryId: number };
export const EMPTY_SNAPSHOT_WATER: SnapshotWater = { conversationId: 0, entryId: 0 };
export type ProjectedDelta = { readonly header?: SessionHeader; readonly entries: SessionEntry[] };

/** One fold for initialization and append-only refresh; retained state is indexes, not historical snapshots. */
export class SnapshotProjection {
	readonly placement = new Placement();
	#parents = new Map<ConversationId, ConversationRecord["parent"]>();
	#hiddenVisibleAt = new Map<EntryId, string | null>();
	#piIdOf = new Map<EntryId, string>();
	#header: SessionHeader | undefined;
	#lastTimestamp = new Date(0).toISOString();
	#water: SnapshotWater = EMPTY_SNAPSHOT_WATER;

	get header(): SessionHeader | undefined {
		return this.#header;
	}
	get water(): SnapshotWater {
		return this.#water;
	}

	fold(snapshot: Pick<SessionSnapshot, "conversations" | "entries">): ProjectedDelta {
		let conversationId = this.#water.conversationId;
		for (const record of snapshot.conversations) {
			if (this.#parents.has(record.id)) continue;
			this.#parents.set(record.id, record.parent);
			this.placement.tails.set(record.id, null);
			conversationId = Math.max(conversationId, record.id);
		}
		const entries: SessionEntry[] = [];
		const seen = new Set<EntryId>();
		let entryId = this.#water.entryId;
		let header: SessionHeader | undefined;
		for (const record of snapshot.entries) {
			if (record.id <= this.#water.entryId || seen.has(record.id)) continue;
			if (record.id <= entryId) throw new Error(`Out-of-order durable entry ${record.id}`);
			seen.add(record.id);
			entryId = record.id;
			const parentId = this.#newestBefore(record.conversationId);
			const projected = projectRecord(record, () => ({
				id: derivedEntryId(record.id),
				parentId,
				fallbackTimestamp: this.#lastTimestamp,
				idOf: (id) => this.#piIdOf.get(id as EntryId),
				compactionRecords: [],
			}));
			if (projected.type !== "entry") {
				if (projected.type === "header" && record.conversationId === ROOT_CONVERSATION_ID) {
					if (this.#header === undefined) header = this.#header = projected.header;
					this.placement.headerWritten = true;
				}
				this.#hiddenVisibleAt.set(record.id, parentId);
				continue;
			}
			const entry =
				hasStoredEntry(record) && projected.entry.parentId !== parentId
					? { ...projected.entry, parentId }
					: projected.entry;
			this.#piIdOf.set(record.id, entry.id);
			this.placement.record(entry.id, record.id, record.conversationId);
			entries.push(entry);
			if (typeof entry.timestamp === "string") this.#lastTimestamp = entry.timestamp;
		}
		this.#water = { conversationId, entryId };
		return { header, entries };
	}

	#newestBefore(conversationId: ConversationId): string | null {
		if (!this.#parents.has(conversationId)) throw new Error(`Unknown durable conversation ${conversationId}`);
		const tail = this.placement.tails.get(conversationId);
		if (tail !== undefined && tail !== null) return tail;
		const parent = this.#parents.get(conversationId);
		if (parent === undefined) return null;
		const visible = this.#piIdOf.get(parent.at) ?? this.#hiddenVisibleAt.get(parent.at);
		if (visible === undefined)
			throw new Error(`Missing durable fork point ${parent.at} for conversation ${conversationId}`);
		return visible;
	}
}
