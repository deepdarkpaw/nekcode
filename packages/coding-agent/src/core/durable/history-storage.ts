import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import type { EntryRecord } from "@earendil-works/pi-durable";
import type { SyncSqliteConnection } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { SessionEntry, SessionHeader } from "../session-entries.ts";
import { type HistoryBytes, HistoryJson, historyFileBytes, type JsonSpan, setHistoryPath } from "./history-json.ts";
import { SnapshotProjection } from "./session-snapshot.ts";
import { openSqlite } from "./sqlite.ts";

const MAX_RECORDS = 100000;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;
const ENTRY_FIELDS = [
	"type",
	"id",
	"parentId",
	"timestamp",
	"provider",
	"modelId",
	"thinkingLevel",
	"name",
	"customType",
	"display",
	"targetId",
	"fromId",
	"firstKeptEntryId",
	"firstKeptEntryIndex",
	"tokensBefore",
];
const MESSAGE_FIELDS = [
	"role",
	"timestamp",
	"provider",
	"model",
	"toolName",
	"toolCallId",
	"customType",
	"display",
	"stopReason",
];
const USAGE_FIELDS = ["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost.total"];
const CHILD_FIELDS = [
	"id",
	"type",
	"description",
	"background",
	"status",
	"sessionFile",
	"startedAt",
	"endedAt",
	"model",
];
const MESSAGE_ROOTS = ["message", "data.entry.message", "model.0", "data.message"];
const ENTRY_ROOTS = ["", "data.entry"];
const fields = (root: string, names: string[]) => names.map((field) => [root, field].filter(Boolean).join("."));
const META_PATHS = [
	...ENTRY_ROOTS.flatMap((root) => fields(root, [...ENTRY_FIELDS, "content", "content.0.text", "summary"])),
	...MESSAGE_ROOTS.flatMap((root) => [
		...fields(root, MESSAGE_FIELDS),
		`${root}.content`,
		`${root}.content.0.text`,
		...fields(`${root}.usage`, USAGE_FIELDS),
	]),
	...ENTRY_ROOTS.flatMap((root) => fields([root, "usage"].filter(Boolean).join("."), USAGE_FIELDS)),
	...fields("data.header", ["type", "version", "id", "timestamp", "cwd", "parentSession"]),
	"version",
	"cwd",
	"parentSession",
	"kind",
	"conversationId",
	"head",
];
const META_SET = new Set(META_PATHS);
const childPath =
	/^(?:(?:data\.entry|message|data\.entry\.message|model\.0|data\.message)\.)?details\.(?:subagent|(?:subagents|running)\.\d+)\.(\w+)$/u;
function wanted(path: (string | number)[]): boolean {
	const key = path.join(".");
	if (META_SET.has(key)) return true;
	const match = childPath.exec(key);
	if (!match || !CHILD_FIELDS.includes(match[1])) return false;
	if (path.some((part) => typeof part === "number" && part >= 128))
		throw new Error("INDEX_LIMIT: More than 128 child facts in one entry");
	return true;
}
function collect(target: Record<string, unknown>, span: JsonSpan): void {
	if (span.value === undefined || !wanted(span.path)) return;
	const key = span.path.join(".");
	const preview = /(?:^|\.)(?:content|text|summary|description)$/u.test(key);
	if (typeof span.value === "string" && !preview && span.end - span.start > 2048)
		throw new Error("INDEX_LIMIT: History identity/metadata scalar exceeds 2048 bytes");
	setHistoryPath(target, span.path, typeof span.value === "string" && preview ? span.value.slice(0, 256) : span.value);
}
function sqlPath(path: string): string {
	if (!path) return "$";
	return `$${path
		.split(".")
		.map((part) => (/^\d+$/u.test(part) ? `[${part}]` : `.${part}`))
		.join("")}`;
}
const SQL_META_MATCH = `fullkey IN (${META_PATHS.map((path) => `'${sqlPath(path)}'`).join(",")}) OR (key IN (${CHILD_FIELDS.map((field) => `'${field}'`).join(",")}) AND (${[
	...MESSAGE_ROOTS,
	...ENTRY_ROOTS,
]
	.flatMap((root) => [
		`path='${sqlPath(root)}.details.subagent'`,
		`path LIKE '${sqlPath(root)}.details.subagents[%]'`,
		`path LIKE '${sqlPath(root)}.details.running[%]'`,
	])
	.join(" OR ")}))`;
/** json_tree parses a record once; JS receives only a capped scalar map, never historical body values. */
const SQL_META = `(SELECT json_group_object(fullkey, json_array(type, CASE WHEN type='text' THEN substr(atom,1,2050) ELSE atom END)) FROM (SELECT fullkey,type,atom FROM json_tree(e.record) WHERE type NOT IN ('object','array') AND (${SQL_META_MATCH}) LIMIT 2049))`;
function sqliteSample(raw: string): Record<string, unknown> {
	const scalars = Object.entries(JSON.parse(raw) as Record<string, [string, unknown]>);
	if (scalars.length > 2048 || Buffer.byteLength(raw) > 512 * 1024)
		throw new Error("INDEX_LIMIT: Too many metadata members in one entry");
	const sample: Record<string, unknown> = {};
	for (const [key, [type, value]] of scalars) {
		const path = key
			.slice(2)
			.replace(/\[(\d+)\]/gu, ".$1")
			.split(".")
			.map((part) => (/^\d+$/u.test(part) ? Number(part) : part));
		if (!wanted(path)) continue;
		collect(sample, {
			path,
			start: 0,
			end: typeof value === "string" ? Buffer.byteLength(value) : 0,
			value: type === "true" ? true : type === "false" ? false : value,
		});
	}
	return sample;
}

export interface HistoryStoredEntry {
	entry: SessionEntry;
	/** Physical immutable row ID or JSONL byte start. */
	storageId: number;
	length: number;
	fingerprint: string;
}
export interface HistoryStorage {
	path: string;
	header: SessionHeader;
	entries: HistoryStoredEntry[];
	watermark: { entryId: number; conversationId: number; nextSeq: number };
	bytes(entry: HistoryStoredEntry): HistoryBytes;
	/** Root pointer of the original stored pi entry, when available. */
	format: "sqlite" | "jsonl";
	/** Verify a legacy file was not replaced/mutated between index and body reads. SQLite holds a read transaction. */
	verify(): void;
	close(): void;
}
function indexBudget(entries: HistoryStoredEntry[], bytes: number): void {
	if (entries.length > MAX_RECORDS || bytes > MAX_INDEX_BYTES)
		throw new Error("INDEX_LIMIT: History metadata index exceeds 100000 records or 64MiB");
}

/** Read-only request-local index: no migration, repair, model context, lock or durable Session instance. */
export function openHistoryStorage(input: string): HistoryStorage {
	const path = realpathSync(input);
	return path.endsWith(".sqlite") ? sqliteHistory(path) : jsonlHistory(path);
}
function sqliteHistory(path: string): HistoryStorage {
	const db = openSqlite(path, { readOnly: true });
	try {
		db.exec("BEGIN");
		const schema = db.prepare("SELECT version FROM durable_schema WHERE singleton=1").get() as { version: number };
		if (schema?.version !== 1) throw new Error("Unsupported history database schema");
		const projection = new SnapshotProjection();
		let conversationId = 0;
		let conversationCount = 0;
		const conversationQuery = db.prepare(
			"SELECT id,json_extract(record,'$.parent.conversationId') AS parentId,json_extract(record,'$.parent.at') AS at FROM conversations WHERE id>? ORDER BY id LIMIT 128",
		);
		for (;;) {
			const rows = conversationQuery.all(conversationId) as {
				id: number;
				parentId: number | null;
				at: number | null;
			}[];
			if (!rows.length) break;
			conversationCount += rows.length;
			if (conversationCount > MAX_RECORDS) throw new Error("INDEX_LIMIT: Too many conversations");
			const conversations = rows.map((row) => {
				conversationId = row.id;
				return {
					id: row.id,
					...(row.parentId === null ? {} : { parent: { conversationId: row.parentId, at: row.at } }),
				};
			});
			projection.fold({
				conversations: conversations as unknown as Parameters<SnapshotProjection["fold"]>[0]["conversations"],
				entries: [],
			});
		}
		const statement = db.prepare(
			`SELECT e.id, e.commit_seq, length(CAST(e.record AS BLOB)) AS bytes, ${SQL_META} AS meta FROM entries e WHERE e.id > ? ORDER BY e.id LIMIT 32`,
		);
		const entries: HistoryStoredEntry[] = [];
		let high = 0;
		let count = 0;
		let indexBytes = 0;
		for (;;) {
			const rows = statement.all(high) as Record<string, unknown>[];
			if (!rows.length) break;
			for (const row of rows) {
				if (++count > MAX_RECORDS) throw new Error("INDEX_LIMIT: Too many history records");
				high = Number(row.id);
				const record = sqliteSample(String(row.meta));
				record.id = high;
				const folded = projection.fold({ conversations: [], entries: [record as unknown as EntryRecord] });
				for (const entry of folded.entries) {
					const fingerprint = createHash("sha256")
						.update(JSON.stringify([high, row.commit_seq, row.bytes, entry]))
						.digest("hex");
					entries.push({ entry, storageId: high, length: Number(row.bytes), fingerprint });
					indexBytes += Buffer.byteLength(JSON.stringify(entry)) + 256;
					indexBudget(entries, indexBytes);
				}
			}
		}
		const header = projection.header;
		if (!header) throw new Error("Missing session header");
		const meta = db.prepare("SELECT next_seq FROM durable_metadata WHERE singleton=1").get() as { next_seq: number };
		return {
			path,
			header,
			entries,
			format: "sqlite",
			watermark: { entryId: high, conversationId: projection.water.conversationId, nextSeq: meta.next_seq },
			bytes: (entry) => sqliteBytes(db, entry),
			verify() {},
			close: () => {
				db.exec("ROLLBACK");
				db.close();
			},
		};
	} catch (error) {
		db.close();
		throw error;
	}
}
function sqliteBytes(db: SyncSqliteConnection, entry: HistoryStoredEntry): HistoryBytes {
	const stmt = db.prepare("SELECT substr(CAST(record AS BLOB), ?, ?) AS data FROM entries WHERE id=?");
	return {
		length: entry.length,
		read: (offset, length) => {
			const row = stmt.get(offset + 1, Math.min(length, entry.length - offset), entry.storageId) as {
				data: Uint8Array;
			};
			return Buffer.from(row.data);
		},
		close() {},
	};
}
function jsonlHistory(path: string): HistoryStorage {
	const stat = statSync(path);
	const source = historyFileBytes(path, stat.size);
	try {
		const parser = new HistoryJson(source);
		const entries: HistoryStoredEntry[] = [];
		let header: SessionHeader | undefined;
		let indexBytes = 0;
		let count = 0;
		while (parser.position < source.length) {
			parser.space();
			if (parser.position === source.length) break;
			if (++count > MAX_RECORDS) throw new Error("INDEX_LIMIT: Too many history records");
			const start = parser.position;
			const sample: Record<string, unknown> = {};
			parser.walk((span) => collect(sample, span));
			const length = parser.position - start;
			if (sample.type === "session") {
				if (header || entries.length) throw new Error("Invalid session header order");
				header = sample as unknown as SessionHeader;
				if (![1, 2, 3].includes(header.version ?? 1)) throw new Error("Unsupported JSONL session version");
			} else {
				if (!header || typeof sample.type !== "string") throw new Error("Invalid JSONL history identity");
				if ((header.version ?? 1) === 1) {
					sample.id = `j${start.toString(16)}`;
					sample.parentId = entries.at(-1)?.entry.id ?? null;
					if (typeof sample.firstKeptEntryIndex === "number") {
						const target = entries[sample.firstKeptEntryIndex - 1];
						if (!target) throw new Error("Invalid legacy compaction target");
						sample.firstKeptEntryId = target.entry.id;
					}
				}
				if (typeof sample.id !== "string") throw new Error("Invalid JSONL history identity");
				const entry = legacyHistoryProjection(sample, sample as unknown as SessionEntry) as unknown as SessionEntry;
				const fingerprint = createHash("sha256");
				for (let offset = start; offset < start + length; offset += 65536)
					fingerprint.update(source.read(offset, Math.min(65536, start + length - offset)));
				entries.push({ entry, storageId: start, length, fingerprint: fingerprint.digest("hex") });
				indexBytes += Buffer.byteLength(JSON.stringify(sample)) + 256;
				indexBudget(entries, indexBytes);
			}
			if (parser.byte() !== -1 && ![10, 13, 32, 9].includes(parser.byte()))
				throw new Error("Invalid JSONL record separator");
		}
		if (!header) throw new Error("Missing JSONL session header");
		const after = statSync(path);
		if (after.size < stat.size || after.mtimeMs !== stat.mtimeMs)
			throw new Error("History storage changed during index read; retry");
		return {
			path,
			header,
			entries,
			format: "jsonl",
			watermark: { entryId: stat.size, conversationId: 0, nextSeq: 0 },
			bytes: (entry) => ({
				length: entry.length,
				read: (offset, length) => source.read(entry.storageId + offset, Math.min(length, entry.length - offset)),
				close() {},
			}),
			verify() {
				const current = statSync(path);
				if (current.ino !== stat.ino || current.size !== stat.size || current.mtimeMs !== stat.mtimeMs)
					throw new Error("History storage changed during body read; retry");
			},
			close: () => source.close(),
		};
	} catch (error) {
		source.close();
		throw error;
	}
}

/** Virtual legacy migrations only: stable byte-derived v1 IDs, never a repair or random-id rewrite. */
export function legacyHistoryProjection(
	value: Record<string, unknown>,
	identity: Pick<SessionEntry, "id" | "parentId"> & { firstKeptEntryId?: string },
): Record<string, unknown> {
	const projected: Record<string, unknown> = { ...value, id: identity.id, parentId: identity.parentId };
	const message = projected.message as Record<string, unknown> | undefined;
	if (projected.type === "message" && message?.role === "hookMessage")
		projected.message = { ...message, role: "custom" };
	if ("firstKeptEntryIndex" in projected) {
		delete projected.firstKeptEntryIndex;
		projected.firstKeptEntryId = identity.firstKeptEntryId;
	}
	return projected;
}
