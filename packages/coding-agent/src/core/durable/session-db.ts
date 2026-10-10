import { DatabaseSync } from "node:sqlite";
import {
	type ContextEdit,
	type ConversationId,
	type ConversationRecord,
	type EntryId,
	type EntryRecord,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { SQLITE_MIGRATIONS } from "@earendil-works/pi-durable/storage/sqlite";
import type { SessionEntry } from "../session-entries.ts";
import type { EntryPlan } from "./session-format.ts";
import type { Placement } from "./session-snapshot.ts";

/**
 * Synchronous writes to a durable session database, for `SessionManager` appends while no Harness has the database
 * open in this process.
 *
 * `SessionManager` appends synchronously and callers rely on that (a renamed session is listed with its new name at
 * once; a process may exit right after appending). Durable's Session API is asynchronous, so these writes use durable's
 * SQLite schema (version 1) directly, exactly as `SqliteStorage.commit()` writes table rows: one transaction claims
 * IDs in `record_ids`, inserts `conversations` and `entries` rows with the commit's `next_seq`, and advances
 * `durable_metadata`. Only conversations and entries are written; durable creates conversation documents on first use.
 *
 * A Harness caches the next ID while open, so a database must not be written here while a Harness in this process
 * has it open; `DurableSessionStore` routes writes through the Harness then. Another process is excluded by the
 * session lock and by SQLite's write lock (`BEGIN IMMEDIATE`).
 */
const SUPPORTED_SCHEMA_VERSION = 1;
const BUSY_TIMEOUT_MS = 5000;

type MetadataRow = { readonly next_id: string; readonly next_seq: number };

function connect(path: string): DatabaseSync {
	const db = new DatabaseSync(path);
	db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
	return db;
}

/** Create the durable schema in a new, empty database file. */
export function createSessionDatabase(path: string): void {
	const db = connect(path);
	try {
		db.exec("BEGIN IMMEDIATE");
		try {
			db.exec(`CREATE TABLE IF NOT EXISTS durable_schema (
				singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
				version INTEGER NOT NULL CHECK (version >= 0)
			) STRICT`);
			db.prepare("INSERT OR IGNORE INTO durable_schema (singleton, version) VALUES (1, 0)").run();
			for (const migration of SQLITE_MIGRATIONS) {
				for (const statement of migration.statements) db.exec(statement);
				db.prepare("UPDATE durable_schema SET version = ? WHERE singleton = 1").run(migration.version);
			}
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	} finally {
		db.close();
	}
}

/**
 * Write `plans` in one transaction, placing each pi entry in its conversation (see `conversationFor`). Returns the
 * database's next commit sequence afterwards. Throws without writing when the database changed since `expectedSeq`.
 */
export function writePlansSync(
	path: string,
	placement: Placement,
	plans: readonly EntryPlan[],
	expectedSeq: number | undefined,
): number {
	const db = connect(path);
	try {
		db.exec("BEGIN IMMEDIATE");
		try {
			const version = (
				db.prepare("SELECT version FROM durable_schema WHERE singleton = 1").get() as
					| { version: number }
					| undefined
			)?.version;
			if (version !== SUPPORTED_SCHEMA_VERSION) {
				throw new Error(`Unsupported durable session schema version ${String(version)} in ${path}`);
			}
			const metadata = db
				.prepare("SELECT next_id, next_seq FROM durable_metadata WHERE singleton = 1")
				.get() as MetadataRow;
			if (expectedSeq !== undefined && metadata.next_seq !== expectedSeq) {
				throw new StaleSessionPlacement(path);
			}
			const writer = new RowWriter(db, Number(metadata.next_id), metadata.next_seq);
			writer.ensureRoot();
			for (const plan of plans) writer.write(plan, placement);
			db.prepare("UPDATE durable_metadata SET next_id = ?, next_seq = ? WHERE singleton = 1").run(
				String(writer.nextId),
				metadata.next_seq + 1,
			);
			db.exec("COMMIT");
			return metadata.next_seq + 1;
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	} finally {
		db.close();
	}
}

/** The database changed since placement was read; the caller rereads it and retries. */
export class StaleSessionPlacement extends Error {
	constructor(path: string) {
		super(`Session ${path} changed since it was read`);
		this.name = "StaleSessionPlacement";
	}
}

class RowWriter {
	readonly #db: DatabaseSync;
	readonly #seq: number;
	nextId: number;

	constructor(db: DatabaseSync, nextId: number, seq: number) {
		this.#db = db;
		this.nextId = nextId;
		this.#seq = seq;
	}

	ensureRoot(): void {
		const exists = this.#db.prepare("SELECT 1 AS present FROM conversations WHERE id = ?").get(ROOT_CONVERSATION_ID);
		if (exists === undefined) this.#insertConversation({ id: ROOT_CONVERSATION_ID });
	}

	write(plan: EntryPlan, placement: Placement): void {
		if (plan.source.type === "session") {
			if (placement.headerWritten) return;
			this.#insertEntry(ROOT_CONVERSATION_ID, plan, placement);
			placement.headerWritten = true;
			return;
		}
		const entry = plan.source as SessionEntry;
		const conversationId = this.#conversationFor(placement, entry);
		const record = this.#insertEntry(conversationId, plan, placement);
		placement.record(entry.id, record.id, conversationId);
	}

	/**
	 * The conversation an entry joins: the one its parent ends, a fork of the one holding its parent, the root while it
	 * holds no pi entry yet, or a new conversation for another root or an orphan.
	 */
	#conversationFor(placement: Placement, entry: SessionEntry): ConversationId {
		const parentId = entry.parentId === entry.id ? null : entry.parentId;
		if (parentId !== null) {
			const continued = placement.conversationEndingAt(parentId);
			if (continued !== undefined) return continued;
			const at = placement.durableIds.get(parentId);
			const home = placement.home.get(parentId);
			if (at !== undefined && home !== undefined) {
				const fork = this.#insertConversation({ id: this.#mint(), parent: { conversationId: home, at } });
				placement.tails.set(fork.id, null);
				return fork.id;
			}
		} else if (placement.tails.get(ROOT_CONVERSATION_ID) === null) {
			return ROOT_CONVERSATION_ID;
		}
		const created = this.#insertConversation({ id: this.#mint() });
		placement.tails.set(created.id, null);
		return created.id;
	}

	#mint<I extends number>(): I {
		if (!Number.isSafeInteger(this.nextId)) throw new Error("ID space is exhausted");
		return this.nextId++ as I;
	}

	#claim(id: number, type: "conversation" | "entry"): void {
		this.#db.prepare("INSERT INTO record_ids (id, record_type) VALUES (?, ?)").run(id, type);
	}

	#insertConversation(fields: {
		id: number;
		parent?: { conversationId: ConversationId; at: EntryId };
	}): ConversationRecord {
		const record = fields as unknown as ConversationRecord;
		this.#claim(record.id, "conversation");
		this.#db
			.prepare(
				"INSERT INTO conversations (id, owner_conversation_id, owner_task_id, record) VALUES (?, NULL, NULL, ?)",
			)
			.run(record.id, JSON.stringify(record));
		return record;
	}

	#insertEntry(conversationId: ConversationId, plan: EntryPlan, placement: Placement): EntryRecord {
		const id = this.#mint<EntryId>();
		const head =
			plan.head === undefined ? undefined : plan.head === "self" ? id : (placement.durableIds.get(plan.head) ?? id);
		const edits: ContextEdit[] = [];
		for (const edit of plan.edits ?? []) {
			const target = placement.durableIds.get(edit.target);
			if (target === undefined) continue;
			edits.push(
				edit.action === "omit"
					? { target, action: "omit" }
					: { target, action: "replace", messages: edit.messages },
			);
		}
		const record: EntryRecord = {
			kind: plan.kind,
			data: plan.data,
			...(plan.model === undefined ? {} : { model: plan.model }),
			...(edits.length === 0 ? {} : { edits }),
			id,
			conversationId,
			...(head === undefined ? {} : { head }),
		};
		this.#claim(id, "entry");
		this.#db
			.prepare("INSERT INTO entries (id, conversation_id, head, commit_seq, record) VALUES (?, ?, ?, ?, ?)")
			.run(id, conversationId, head ?? null, this.#seq, JSON.stringify(record));
		return record;
	}
}
