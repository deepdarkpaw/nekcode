import { win32 } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { openNodeSqliteStorage, type SyncSqliteConnection } from "@earendil-works/pi-durable/storage/sqlite/node";

/** How the session code opens SQLite databases. */
export type SqliteDriver = {
	open(path: string, options: { readonly readOnly?: boolean; readonly busyTimeoutMs: number }): SyncSqliteConnection;
};

/** Time SQLite waits for a competing file lock. */
const BUSY_TIMEOUT_MS = 5000;

const nodeDriver: SqliteDriver = {
	open: (path, options) =>
		new DatabaseSync(path, { readOnly: options.readOnly ?? false, timeout: options.busyTimeoutMs }),
};

let driver: SqliteDriver = nodeDriver;

/**
 * Replace the SQLite driver, before any session opens. The Bun frontend uses `bun:sqlite`: Bun's `node:sqlite` keeps a
 * closed database's file open until its prepared statements are garbage collected, so the file cannot be moved or
 * deleted on Windows.
 */
export function setSqliteDriver(next: SqliteDriver): void {
	driver = next;
}

/** Windows extended-length path prefix (`\\?\`). */
const EXTENDED_PREFIX = "\\\\?\\";

/**
 * The path SQLite opens. On Windows SQLite cannot open a path longer than MAX_PATH (260 characters, its `-journal`
 * and `-wal` files included) unless it has the extended-length prefix, and session paths embed the working directory.
 */
export function sqliteFilePath(path: string): string {
	if (process.platform !== "win32" || path.startsWith(EXTENDED_PREFIX)) return path;
	const absolute = win32.resolve(path);
	return absolute.startsWith("\\\\") ? `${EXTENDED_PREFIX}UNC\\${absolute.slice(2)}` : `${EXTENDED_PREFIX}${absolute}`;
}

/** Open a session database with the current driver. */
export function openSqlite(path: string, options: { readonly readOnly?: boolean } = {}): SyncSqliteConnection {
	return driver.open(sqliteFilePath(path), { ...options, busyTimeoutMs: BUSY_TIMEOUT_MS });
}

/** Open a session database as durable storage for a Harness, with the current driver. */
export function openSqliteStorage(path: string): Promise<SqliteStorage> {
	return openNodeSqliteStorage(sqliteFilePath(path), {
		busyTimeoutMs: BUSY_TIMEOUT_MS,
		connect: (file, busyTimeoutMs) => driver.open(file, { busyTimeoutMs }),
	});
}
