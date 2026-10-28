/**
 * Session catalog commands: list, delete, rename, read a snapshot, and import.
 *
 * None of these open the session as a live session. Reading and renaming use the same read/write paths as the
 * interactive picker, and both refuse to touch a session whose lock a live process holds.
 */

import { existsSync, rmSync, statSync } from "node:fs";
import { isSessionLocked, readSessionLockOwner, sessionLockPath } from "../../../core/durable/lock.ts";
import { sidecarPath } from "../../../core/durable/session-sidecar.ts";
import { projectSnapshot, readSessionSnapshot } from "../../../core/durable/session-snapshot.ts";
import {
	buildSessionContext,
	type FileEntry,
	loadEntriesFromFile,
	type SessionEntry,
	type SessionInfo,
	SessionInfoBuilder,
} from "../../../core/session-entries.ts";
import { importedDatabasePath, isDatabaseFile } from "../../../core/session-listing.ts";
import { SessionManager } from "../../../core/session-manager.ts";
import { resolvePath } from "../../../utils/paths.ts";
import type { GuiContext } from "./context.ts";
import type { RpcSessionSnapshot, RpcSessionSummary } from "./protocol.ts";

const DEFAULT_SESSION_LIMIT = 500;
const FIRST_MESSAGE_LIMIT = 200;

/** `firstMessage` as the GUI shows it: one line, at most 200 characters. */
function truncateFirstMessage(text: string): string {
	const singleLine = text.replace(/\s+/gu, " ").trim();
	return singleLine.length <= FIRST_MESSAGE_LIMIT ? singleLine : `${singleLine.slice(0, FIRST_MESSAGE_LIMIT)}`;
}

/** SessionInfo as the GUI consumes it. */
export function toSessionSummary(info: SessionInfo): RpcSessionSummary {
	const path = resolvePath(info.path);
	const summary: RpcSessionSummary = {
		path,
		id: info.id,
		cwd: info.cwd,
		createdAt: info.created.toISOString(),
		modifiedAt: info.modified.toISOString(),
		messageCount: info.messageCount,
		firstMessage: truncateFirstMessage(info.firstMessage),
		locked: isSessionLocked(path),
	};
	return {
		...summary,
		...(info.name === undefined ? {} : { name: info.name }),
		...(info.parentSessionPath === undefined ? {} : { parentSessionPath: info.parentSessionPath }),
	};
}

/** Sessions for one cwd, or all sessions of the storage root, newest first and capped. */
export async function listSessions(
	ctx: GuiContext,
	command: { cwd?: string; all?: boolean; limit?: number },
): Promise<RpcSessionSummary[]> {
	const cwd = command.cwd === undefined ? ctx.cwd : resolvePath(command.cwd);
	const infos = command.all
		? await SessionManager.listAll(ctx.configuredSessionDir)
		: await SessionManager.list(cwd, ctx.configuredSessionDir);
	const limit = command.limit === undefined ? DEFAULT_SESSION_LIMIT : Math.max(1, Math.floor(command.limit));
	return infos
		.slice()
		.sort((left, right) => right.modified.getTime() - left.modified.getTime())
		.slice(0, limit)
		.map(toSessionSummary);
}

/**
 * Every file a session owns: the database or JSONL file, its sidecar, SQLite journal files, the JSONL file an
 * imported session came from, and a stale lock the caller already ruled out.
 */
function sessionFiles(path: string): string[] {
	const files = new Set<string>([path]);
	if (path.endsWith(".jsonl")) files.add(importedDatabasePath(path));
	const database = [...files].find((file) => file.endsWith(".sqlite"));
	if (database !== undefined) {
		files.add(sidecarPath(database));
		files.add(`${database}-wal`);
		files.add(`${database}-shm`);
		files.add(database.replace(/\.sqlite$/u, ".jsonl"));
		files.add(sessionLockPath(database));
	}
	return [...files];
}

/** Delete a session and every file it owns; the current session and locked sessions are refused. */
export function deleteSession(ctx: GuiContext, sessionPath: string): void {
	const path = resolvePath(sessionPath);
	const currentFile = ctx.session?.sessionFile;
	if (currentFile !== undefined && resolvePath(currentFile) === path) {
		throw new Error(`Cannot delete the current session: ${path}`);
	}
	if (isSessionLocked(path)) throw new Error(`Session is locked by a live process: ${path}`);
	const existing = sessionFiles(path).filter((file) => existsSync(file));
	if (existing.length === 0) throw new Error(`Session not found: ${path}`);
	for (const file of existing) rmSync(file, { force: true });
}

/** Rename a session by appending a `session_info` entry, as `/resume` does. */
export async function renameSession(sessionPath: string, name: string): Promise<void> {
	const path = resolvePath(sessionPath);
	const trimmed = name.trim();
	if (!trimmed) throw new Error("Session name cannot be empty");
	if (!existsSync(path)) throw new Error(`Session not found: ${path}`);
	if (isSessionLocked(path)) throw new Error(`Session is locked by a live process: ${path}`);
	const manager = SessionManager.open(path);
	manager.appendSessionInfo(trimmed);
	await manager.flush();
}

/** Entries of a session file, without opening it as a session: the header plus every pi entry. */
function readEntries(path: string): FileEntry[] {
	if (isDatabaseFile(path)) return projectSnapshot(readSessionSnapshot(path)).fileEntries;
	return loadEntriesFromFile(path, { repair: false });
}

/**
 * A read-only snapshot: entries, leaf, and the messages on the leaf branch. Never takes the session lock.
 *
 * `lockedBy` names the live process that does hold the lock, so a client can tell which nek process is using the
 * session. It is omitted when the lock is absent, stale, or was written before locks described their holder.
 */
export function readSessionSnapshotFor(sessionPath: string): RpcSessionSnapshot {
	const path = resolvePath(sessionPath);
	if (!existsSync(path)) throw new Error(`Session not found: ${path}`);
	const fileEntries = readEntries(path);
	const builder = new SessionInfoBuilder();
	for (const entry of fileEntries) builder.add(entry);
	const info = builder.build(path, statSync(path).mtime);
	if (info === null) throw new Error(`Session file is not a valid nek session: ${path}`);
	const entries = fileEntries.filter((entry): entry is SessionEntry => entry.type !== "session");
	const leafId = entries.length === 0 ? null : entries[entries.length - 1].id;
	const { messages } = buildSessionContext(entries, leafId);
	const owner = readSessionLockOwner(path);
	return {
		session: toSessionSummary(info),
		entries,
		leafId,
		messages,
		...(owner === undefined ? {} : { lockedBy: { ...owner, startedAt: new Date(owner.startedAt).toISOString() } }),
	};
}

/** Import a JSONL or database session into a new session of `cwd` and return the new session path. */
export function importSession(ctx: GuiContext, inputPath: string, cwd: string): string {
	const source = resolvePath(inputPath);
	if (!existsSync(source)) throw new Error(`Session file not found: ${source}`);
	if (isSessionLocked(source)) throw new Error(`Session is locked by a live process: ${source}`);
	let manager: SessionManager;
	try {
		manager = SessionManager.forkFrom(source, resolvePath(cwd), ctx.configuredSessionDir);
	} catch (error: unknown) {
		throw new Error(`Failed to import session ${source}: ${error instanceof Error ? error.message : String(error)}`);
	}
	const sessionFile = manager.getSessionFile();
	if (sessionFile === undefined) throw new Error(`Failed to import session ${source}: no session file was created`);
	return sessionFile;
}
