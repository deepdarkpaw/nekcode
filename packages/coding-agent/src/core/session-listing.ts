import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "fs";
import { readdir, stat } from "fs/promises";
import { basename, join } from "path";
import { sessionLockPath } from "./durable/lock.ts";
import { readFreshSidecar, sidecarFromBuilder, writeSessionSidecar } from "./durable/session-sidecar.ts";
import { projectSnapshot, readSessionSnapshot, readSnapshotHeader } from "./durable/session-snapshot.ts";
import { DurableSessionStore, databaseModifiedMs } from "./durable/session-store.ts";
import {
	ALL_SESSION_LIST_PUBLISH_INTERVAL,
	buildSessionInfo,
	CURRENT_SESSION_LIST_PUBLISH_INTERVAL,
	getSessionHeaderCwd,
	MAX_CONCURRENT_SESSION_DISCOVERY_LOADS,
	MAX_CONCURRENT_SESSION_INFO_LOADS,
	mapWithConcurrency,
	readSessionHeaderForDiscovery,
	type SessionFileCandidate,
	type SessionHeader,
	type SessionInfo,
	SessionInfoBuilder,
	type SessionListProgress,
	sessionCwdMatches,
	sortSessionInfos,
} from "./session-entries.ts";

/**
 * Session discovery over durable sessions (`<name>.sqlite`) and JSONL sessions not imported yet (`<name>.jsonl`
 * without a `<name>.sqlite`). A durable session is described by its sidecar, so listing does not open databases
 * unless a sidecar is missing or stale.
 */
const DATABASE_SUFFIX = ".sqlite";
const JSONL_SUFFIX = ".jsonl";

/** The database a JSONL session is imported into. */
export function importedDatabasePath(jsonlPath: string): string {
	return jsonlPath.endsWith(JSONL_SUFFIX)
		? `${jsonlPath.slice(0, -JSONL_SUFFIX.length)}${DATABASE_SUFFIX}`
		: `${jsonlPath}${DATABASE_SUFFIX}`;
}

/** Session files among the names of one directory, as paths. */
export function sessionFilePaths(directory: string, names: readonly string[]): string[] {
	const present = new Set(names);
	const paths: string[] = [];
	for (const name of names) {
		if (name.endsWith(DATABASE_SUFFIX)) paths.push(join(directory, name));
		else if (name.endsWith(JSONL_SUFFIX) && !present.has(basename(importedDatabasePath(name)))) {
			paths.push(join(directory, name));
		}
	}
	return paths;
}

const SQLITE_MAGIC = "SQLite format 3\0";

/** Whether `path` is an SQLite database, by its file header; a session database keeps working when renamed. */
export function isDatabaseFile(path: string): boolean {
	let fd: number;
	try {
		fd = openSync(path, "r");
	} catch {
		return false;
	}
	try {
		const buffer = Buffer.alloc(SQLITE_MAGIC.length);
		const read = readSync(fd, buffer, 0, buffer.length, 0);
		return read === buffer.length && buffer.toString("latin1") === SQLITE_MAGIC;
	} finally {
		closeSync(fd);
	}
}

function isDatabasePath(path: string): boolean {
	return path.endsWith(DATABASE_SUFFIX) || isDatabaseFile(path);
}

/** Modification time used to order session files. */
async function sessionFileModifiedMs(path: string): Promise<number> {
	return isDatabasePath(path) ? databaseModifiedMs(path) : (await stat(path)).mtimeMs;
}

/** Session info of a durable session: its fresh sidecar, or a rebuild from the database that refreshes the sidecar. */
export function durableSessionInfo(path: string): SessionInfo | null {
	const modified = databaseModifiedMs(path);
	const cached = readFreshSidecar(path, modified);
	if (cached !== undefined) return cached;
	try {
		const projected = projectSnapshot(readSessionSnapshot(path));
		const builder = new SessionInfoBuilder();
		for (const entry of projected.fileEntries) builder.add(entry);
		const info = builder.build(path, new Date(modified));
		// Only the writer refreshes a sidecar while it may still write; otherwise an older rebuild could replace it.
		const unchanged = databaseModifiedMs(path) === modified;
		if (info !== null && unchanged && !DurableSessionStore.isPinned(path) && !existsSync(sessionLockPath(path))) {
			const sidecar = sidecarFromBuilder(builder);
			if (sidecar !== undefined) writeSessionSidecar(path, sidecar);
		}
		return info;
	} catch {
		return null;
	}
}

async function anySessionInfo(path: string, signal: AbortSignal | undefined): Promise<SessionInfo | null> {
	if (isDatabasePath(path)) {
		signal?.throwIfAborted();
		return durableSessionInfo(path);
	}
	return buildSessionInfo(path, signal);
}

/** Header of a session file for discovery; `null` when it is not a session. */
export function readAnySessionHeader(path: string): SessionHeader | null {
	if (!isDatabasePath(path)) return readSessionHeaderForDiscovery(path);
	const cached = readFreshSidecar(path, databaseModifiedMs(path));
	if (cached !== undefined) {
		return { type: "session", id: cached.id, cwd: cached.cwd, timestamp: cached.created.toISOString() };
	}
	try {
		return readSnapshotHeader(path);
	} catch {
		return null;
	}
}

function infosWithConcurrency(
	files: SessionFileCandidate[],
	onLoaded: (info: SessionInfo | null, index: number) => void,
	signal?: AbortSignal,
): Promise<(SessionInfo | null)[]> {
	return mapWithConcurrency(
		files,
		MAX_CONCURRENT_SESSION_INFO_LOADS,
		async (file, index) => {
			const info = await anySessionInfo(file.path, signal);
			onLoaded(info, index);
			return info;
		},
		signal,
	);
}

/** Sessions of one directory, with the progress reporting of JSONL listing. */
export async function listSessionFilesFromDir(
	dir: string,
	onProgress?: SessionListProgress,
	signal?: AbortSignal,
): Promise<SessionInfo[]> {
	signal?.throwIfAborted();
	if (!existsSync(dir)) return [];

	try {
		const names = (await readdir(dir)).sort((a, b) => b.localeCompare(a));
		const files = sessionFilePaths(dir, names).map((path) => ({ path }));
		const total = files.length;
		const partialSessions: SessionInfo[] = [];
		let loaded = 0;
		const results = await infosWithConcurrency(
			files,
			(info) => {
				loaded++;
				if (info) partialSessions.push(info);
				const publishPartial =
					loaded === 1 || loaded % CURRENT_SESSION_LIST_PUBLISH_INTERVAL === 0 || loaded === files.length;
				onProgress?.(loaded, total, publishPartial ? sortSessionInfos([...partialSessions]) : undefined);
			},
			signal,
		);
		// Database sessions load synchronously, so an abort from a progress callback is seen only here.
		signal?.throwIfAborted();
		return results.filter((info): info is SessionInfo => info !== null);
	} catch {
		signal?.throwIfAborted();
		return [];
	}
}

/** Sessions across every project directory under `sessionsDir`, newest file first. */
export async function listAllSessionFiles(
	sessionsDir: string,
	progress: SessionListProgress | undefined,
	abortSignal: AbortSignal | undefined,
): Promise<SessionInfo[]> {
	try {
		if (!existsSync(sessionsDir)) return [];
		const entries = await readdir(sessionsDir, { withFileTypes: true });
		const dirs = entries
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
			.map((entry) => join(sessionsDir, entry.name));

		const dirFiles = await mapWithConcurrency(
			dirs,
			MAX_CONCURRENT_SESSION_DISCOVERY_LOADS,
			async (dir) => {
				try {
					return sessionFilePaths(dir, await readdir(dir));
				} catch {
					return [];
				}
			},
			abortSignal,
		);
		const allFiles = dirFiles.flat();
		const candidates = await mapWithConcurrency(
			allFiles,
			MAX_CONCURRENT_SESSION_DISCOVERY_LOADS,
			async (path): Promise<SessionFileCandidate & { modifiedMs?: number }> => {
				try {
					return { path, modifiedMs: await sessionFileModifiedMs(path) };
				} catch {
					return { path };
				}
			},
			abortSignal,
		);
		candidates.sort(
			(a, b) =>
				(b.modifiedMs ?? Number.NEGATIVE_INFINITY) - (a.modifiedMs ?? Number.NEGATIVE_INFINITY) ||
				basename(b.path).localeCompare(basename(a.path)),
		);

		const totalFiles = candidates.length;
		let loaded = 0;
		let firstCandidateLoaded = false;
		const partialSessions: SessionInfo[] = [];
		const results = await infosWithConcurrency(
			candidates,
			(info, index) => {
				loaded++;
				if (index === 0) firstCandidateLoaded = true;
				if (info) partialSessions.push(info);
				const publishPartial =
					firstCandidateLoaded &&
					(index === 0 || loaded % ALL_SESSION_LIST_PUBLISH_INTERVAL === 0 || loaded === totalFiles);
				progress?.(loaded, totalFiles, publishPartial ? sortSessionInfos([...partialSessions]) : undefined);
			},
			abortSignal,
		);
		abortSignal?.throwIfAborted();
		return sortSessionInfos(results.filter((info): info is SessionInfo => info !== null));
	} catch {
		abortSignal?.throwIfAborted();
		return [];
	}
}

function sessionFilesByModified(dir: string): string[] {
	const paths = sessionFilePaths(dir, readdirSync(dir));
	return paths
		.map((path) => ({ path, modified: isDatabasePath(path) ? databaseModifiedMs(path) : statMtime(path) }))
		.sort((a, b) => b.modified - a.modified)
		.map((candidate) => candidate.path);
}

function statMtime(path: string): number {
	try {
		return statSync(path).mtimeMs;
	} catch {
		return 0;
	}
}

/** Most recently modified session of a directory, optionally limited to sessions started in `cwd`. */
export function findMostRecentSessionFile(sessionDir: string, resolvedCwd?: string): string | null {
	try {
		for (const path of sessionFilesByModified(sessionDir)) {
			const header = readAnySessionHeader(path);
			if (header && (!resolvedCwd || sessionCwdMatches(getSessionHeaderCwd(header), resolvedCwd))) return path;
		}
		return null;
	} catch {
		// Directory access and stat races make recent-session discovery unavailable.
		return null;
	}
}

/** Session file with an exact session ID, optionally limited to sessions started in `cwd`. */
export function findSessionFileById(dir: string, id: string, resolvedCwd?: string): string | undefined {
	try {
		for (const path of sessionFilePaths(dir, readdirSync(dir))) {
			const header = readAnySessionHeader(path);
			if (header?.id !== id) continue;
			if (resolvedCwd !== undefined && !sessionCwdMatches(getSessionHeaderCwd(header), resolvedCwd)) continue;
			return path;
		}
	} catch {
		// Exact session discovery is best-effort, matching list().
	}
	return undefined;
}
