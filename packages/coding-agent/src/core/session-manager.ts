import { existsSync, mkdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { APP_NAME, getSessionsDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { type EntryPlan, planEntry, planHeader } from "./durable/session-format.ts";
import { projectSnapshot, readSessionSnapshot, readSnapshotHeader } from "./durable/session-snapshot.ts";
import { DurableSessionStore } from "./durable/session-store.ts";
import { convertToLlm } from "./messages.ts";
import {
	assertValidSessionId,
	CURRENT_SESSION_VERSION,
	createSessionId,
	type FileEntry,
	getDefaultSessionDir,
	getDefaultSessionDirPath,
	getSessionHeaderCwd,
	loadEntriesFromFile,
	migrateToCurrentVersion,
	type NewSessionOptions,
	readSessionHeader,
	type SessionEntry,
	type SessionHeader,
	SessionHeaderScanLimitError,
	type SessionInfo,
	type SessionListProgress,
	sessionCwdMatches,
	sortSessionInfos,
} from "./session-entries.ts";
import {
	findMostRecentSessionFile,
	findSessionFileById,
	importedDatabasePath,
	isDatabaseFile,
	listAllSessionFiles,
	listSessionFilesFromDir,
} from "./session-listing.ts";
import { SessionTree } from "./session-tree.ts";

export {
	assertValidSessionId,
	type BranchSummaryEntry,
	buildContextEntries,
	buildSessionContext,
	buildSessionProjection,
	type CompactionEntry,
	type ContextEditableContent,
	type ContextEditEntry,
	CURRENT_SESSION_VERSION,
	type CustomEntry,
	type CustomMessageEntry,
	type FileEntry,
	findMostRecentSession,
	getDefaultSessionDir,
	getLatestCompactionEntry,
	type LabelEntry,
	loadEntriesFromFile,
	type ModelChangeEntry,
	migrateSessionEntries,
	type NewSessionOptions,
	type ProjectedSessionEntry,
	parseSessionEntries,
	type SessionContext,
	type SessionEntry,
	type SessionEntryBase,
	type SessionHeader,
	type SessionInfo,
	type SessionInfoEntry,
	type SessionListProgress,
	type SessionMessageEntry,
	type SessionProjection,
	type SessionTreeNode,
	sessionEntryToContextMessages,
	type ThinkingLevelChangeEntry,
	type UsageEntry,
} from "./session-entries.ts";

export type ReadonlySessionManager = Pick<
	SessionManager,
	| "getCwd"
	| "getSessionDir"
	| "getSessionId"
	| "getSessionFile"
	| "getLeafId"
	| "getLeafEntry"
	| "getEntry"
	| "getLabel"
	| "getBranch"
	| "buildContextEntries"
	| "buildSessionProjection"
	| "getHeader"
	| "getEntries"
	| "getTree"
	| "getSessionName"
>;

/** Where a requested session path lives: an existing database, a JSONL session to import, or a new database. */
type SessionLocation =
	| { readonly kind: "database"; readonly path: string }
	| { readonly kind: "jsonl"; readonly jsonlPath: string; readonly path: string }
	| { readonly kind: "new"; readonly path: string };

function locateSession(requested: string): SessionLocation {
	if (existsSync(requested) && statSync(requested).size > 0 && isDatabaseFile(requested)) {
		return { kind: "database", path: requested };
	}
	const imported = requested.endsWith(".sqlite") ? requested : importedDatabasePath(requested);
	if (imported !== requested && existsSync(imported) && statSync(imported).size > 0) {
		return { kind: "database", path: imported };
	}
	if (existsSync(requested) && !requested.endsWith(".sqlite")) {
		return { kind: "jsonl", jsonlPath: requested, path: imported };
	}
	return { kind: "new", path: imported };
}

/** Header of a session file for its cwd: the database header, or the JSONL header within the bounded scan. */
function readLocatedHeader(location: SessionLocation): { header: SessionHeader | null; entries?: FileEntry[] } {
	if (location.kind === "database") return { header: readSnapshotHeader(location.path) };
	if (location.kind === "new") return { header: null };
	try {
		return { header: readSessionHeader(location.jsonlPath) };
	} catch (error) {
		if (!(error instanceof SessionHeaderScanLimitError)) throw error;
		// The bounded scan is only a discovery optimization. A full load remains
		// authoritative for legacy files with very large headers or prefixes.
		const entries = loadEntriesFromFile(location.jsonlPath, { repair: false });
		const first = entries[0];
		return { header: first?.type === "session" ? first : null, entries };
	}
}

/**
 * Manages conversation sessions as append-only trees stored in durable session databases.
 *
 * Each session entry has an id and parentId forming a tree structure. The "leaf"
 * pointer tracks the current position. Appending creates a child of the current leaf.
 * Branching moves the leaf to an earlier entry, allowing new branches without
 * modifying history.
 *
 * Use buildSessionContext() to get the resolved message list for the LLM, which
 * handles compaction summaries and follows the path from root to current leaf.
 *
 * Storage: a session is `<timestamp>_<id>.sqlite`, a pi-durable database whose conversations hold the tree's branches
 * (see `durable/session-format.ts`). Appends are synchronous in memory and written behind by the session's
 * `DurableSessionStore`; `flush()` waits for them. Opening a JSONL session imports it into a database next to it and
 * leaves the `.jsonl` file unchanged; `getSessionFile()` then names the database.
 */
export class SessionManager extends SessionTree {
	/** In-memory sessions get durable storage only when an engine asks for it. */
	#memoryStore: DurableSessionStore | undefined;

	private constructor(
		cwd: string,
		sessionDir: string,
		sessionFile: string | undefined,
		persist: boolean,
		newSessionOptions?: NewSessionOptions,
		preloadedFileEntries?: FileEntry[],
	) {
		super(cwd, sessionDir, persist);
		if (persist && this.sessionDir && !existsSync(this.sessionDir)) {
			mkdirSync(this.sessionDir, { recursive: true });
		}

		if (sessionFile) {
			this._setSessionFile(sessionFile, preloadedFileEntries);
		} else if (preloadedFileEntries?.length) {
			this._loadEntries(preloadedFileEntries, newSessionOptions);
		} else {
			this.newSession(newSessionOptions);
		}
	}

	protected sessionFileName(fileTimestamp: string, sessionId: string): string {
		return `${fileTimestamp}_${sessionId}.sqlite`;
	}

	/** Switch to a different session file (used for resume and branching) */
	setSessionFile(sessionFile: string): void {
		this._setSessionFile(sessionFile);
	}

	private _setSessionFile(sessionFile: string, preloadedFileEntries?: FileEntry[]): void {
		const location = locateSession(resolvePath(sessionFile));
		if (location.kind === "database") {
			this._loadDatabase(location.path);
		} else if (location.kind === "jsonl") {
			this._importJsonl(location.jsonlPath, location.path, preloadedFileEntries);
		} else {
			this.newSession();
			this.sessionFile = location.path; // preserve explicit path from --session flag
		}
	}

	private _loadDatabase(path: string): void {
		const projected = projectSnapshot(readSessionSnapshot(path));
		if (projected.header === undefined) {
			this.newSession();
			this.sessionFile = path;
			return;
		}
		this.sessionFile = path;
		this._loadEntries(projected.fileEntries);
		this.flushed = true;
	}

	/** Load a JSONL session, migrated in memory, and import it into `databasePath`; the JSONL file is not changed. */
	private _importJsonl(jsonlPath: string, databasePath: string, preloadedFileEntries?: FileEntry[]): void {
		const entries = preloadedFileEntries ?? loadEntriesFromFile(jsonlPath, { repair: false });
		if (entries.length === 0) {
			if (statSync(jsonlPath).size > 0) {
				throw new Error(`Session file is not a valid ${APP_NAME} session: ${jsonlPath}`);
			}
			// An empty JSONL file gets a session with its header at once, as JSONL sessions did.
			this.newSession();
			this.sessionFile = databasePath;
			this._writeAll();
			this.flushed = true;
			return;
		}
		this._loadEntries(entries);
		this.sessionFile = databasePath;
		this._writeAll();
		this.flushed = true;
	}

	/** Migration happens in memory; the import writes the migrated entries and the JSONL file stays as it was. */
	protected onMigrated(): void {}

	_persist(entry: SessionEntry): void {
		if (!this.persist) {
			this.#memoryStore?.write([this.#plan(entry)]);
			return;
		}
		if (!this.sessionFile) return;

		if (!this.flushed) {
			if (!this._hasConversation()) return;
			this._writeAll();
			this.flushed = true;
		} else {
			DurableSessionStore.forPath(this.sessionFile).write([this.#plan(entry)]);
		}
	}

	protected _rewriteFile(): void {
		if (!this.persist || !this.sessionFile) return;
		this._writeAll();
	}

	/** Write the header and every entry to the session's store. */
	private _writeAll(): void {
		if (!this.sessionFile) return;
		DurableSessionStore.forPath(this.sessionFile).write(this.#planAll());
	}

	#planAll(): EntryPlan[] {
		const plans: EntryPlan[] = [];
		const header = this.getHeader();
		if (header) plans.push(planHeader(header));
		for (const entry of this.getEntries()) plans.push(this.#plan(entry));
		return plans;
	}

	#plan(entry: SessionEntry): EntryPlan {
		return planEntry(entry, this, convertToLlm);
	}

	/** Resolve once every entry appended so far is durably written; appends are synchronous unless an engine runs. */
	async flush(): Promise<void> {
		if (!this.persist) {
			await this.#memoryStore?.flush();
			return;
		}
		if (this.sessionFile && this.flushed) await DurableSessionStore.forPath(this.sessionFile).flush();
	}

	/**
	 * The durable store of this session, for an engine that runs on it. Writes the session first if nothing was
	 * written yet; an in-memory session gets a memory store holding its entries.
	 */
	durableStore(): DurableSessionStore {
		if (!this.persist) {
			if (this.#memoryStore === undefined) {
				this.#memoryStore = DurableSessionStore.inMemory();
				this.#memoryStore.write(this.#planAll());
			}
			return this.#memoryStore;
		}
		if (!this.sessionFile) throw new Error("Session has no file");
		if (!this.flushed) {
			this._writeAll();
			this.flushed = true;
		}
		return DurableSessionStore.forPath(this.sessionFile);
	}

	/**
	 * Create a new session.
	 * @param cwd Working directory (stored in session header)
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.nek/agent/sessions/<encoded-cwd>/).
	 */
	static create(cwd: string, sessionDir?: string, options?: NewSessionOptions): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		return new SessionManager(cwd, dir, undefined, true, options);
	}

	/**
	 * Open a specific session file: a durable session, or a JSONL session, which is imported.
	 * @param path Path to session file
	 * @param sessionDir Optional session directory for /new or /branch. If omitted, derives from file's parent.
	 * @param cwdOverride Optional cwd override instead of the session header cwd.
	 */
	static open(path: string, sessionDir?: string, cwdOverride?: string): SessionManager {
		const resolvedPath = resolvePath(path);
		let header: SessionHeader | null = null;
		let preloadedFileEntries: FileEntry[] | undefined;
		if (cwdOverride === undefined) {
			const read = readLocatedHeader(locateSession(resolvedPath));
			header = read.header;
			preloadedFileEntries = read.entries;
		}
		const cwd = cwdOverride ?? (header ? getSessionHeaderCwd(header) : undefined) ?? process.cwd();
		// If no sessionDir provided, derive from file's parent directory
		const dir = sessionDir ? normalizePath(sessionDir) : resolve(resolvedPath, "..");
		return new SessionManager(cwd, dir, resolvedPath, true, undefined, preloadedFileEntries);
	}

	/**
	 * Continue the most recent session, or create new if none.
	 * @param cwd Working directory
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.nek/agent/sessions/<encoded-cwd>/).
	 */
	static continueRecent(cwd: string, sessionDir?: string): SessionManager {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
		const mostRecent = findMostRecentSessionFile(dir, filterCwd ? resolvePath(cwd) : undefined);
		if (mostRecent) {
			return new SessionManager(cwd, dir, mostRecent, true);
		}
		return new SessionManager(cwd, dir, undefined, true);
	}

	/** Create an in-memory session (no file persistence), optionally from entries held outside the filesystem. */
	static inMemory(cwd: string = process.cwd(), options?: NewSessionOptions, entries?: FileEntry[]): SessionManager {
		return new SessionManager(cwd, "", undefined, false, options, entries);
	}

	/**
	 * Fork a session from another project directory into the current project.
	 * Creates a new session in the target cwd with the full history from the source session.
	 * @param sourcePath Path to the source session file
	 * @param targetCwd Target working directory (where the new session will be stored)
	 * @param sessionDir Optional session directory. If omitted, uses default for targetCwd.
	 */
	static forkFrom(
		sourcePath: string,
		targetCwd: string,
		sessionDir?: string,
		options?: NewSessionOptions,
	): SessionManager {
		const resolvedSourcePath = resolvePath(sourcePath);
		const resolvedTargetCwd = resolvePath(targetCwd);
		const location = locateSession(resolvedSourcePath);
		const sourceEntries =
			location.kind === "database"
				? projectSnapshot(readSessionSnapshot(location.path)).fileEntries
				: location.kind === "jsonl"
					? loadEntriesFromFile(location.jsonlPath, { repair: false })
					: [];
		if (sourceEntries.length === 0) {
			throw new Error(`Cannot fork: source session file is empty or invalid: ${resolvedSourcePath}`);
		}

		const sourceHeader = sourceEntries.find((e) => e.type === "session") as SessionHeader | undefined;
		if (!sourceHeader) {
			throw new Error(`Cannot fork: source session has no header: ${resolvedSourcePath}`);
		}
		// Bring the copied entries to the current version under their own header before replacing it.
		migrateToCurrentVersion(sourceEntries);

		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(resolvedTargetCwd);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		// Create new session file with new ID but forked content
		if (options?.id !== undefined) {
			assertValidSessionId(options.id);
		}
		const newSessionId = options?.id ?? createSessionId();
		const timestamp = new Date().toISOString();
		const fileTimestamp = timestamp.replace(/[:.]/g, "-");
		const newSessionFile = join(dir, `${fileTimestamp}_${newSessionId}.sqlite`);

		// New header pointing to source as parent, with updated cwd
		const newHeader: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: newSessionId,
			timestamp,
			cwd: resolvedTargetCwd,
			parentSession: resolvedSourcePath,
		};
		const entries: FileEntry[] = [newHeader, ...sourceEntries.filter((entry) => entry.type !== "session")];
		const manager = new SessionManager(resolvedTargetCwd, dir, undefined, true, undefined, entries);
		manager.sessionFile = newSessionFile;
		manager._writeAll();
		manager.flushed = true;
		return manager;
	}

	/**
	 * Find an exact session ID without loading transcript bodies.
	 * @param cwd Working directory (used to compute default session directory)
	 * @param id Exact session ID
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.nek/agent/sessions/<encoded-cwd>/).
	 */
	static findById(cwd: string, id: string, sessionDir?: string): string | undefined {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
		return findSessionFileById(dir, id, filterCwd ? resolvePath(cwd) : undefined);
	}

	/**
	 * List all sessions for a directory.
	 * @param cwd Working directory (used to compute default session directory)
	 * @param sessionDir Optional session directory. If omitted, uses default (~/.nek/agent/sessions/<encoded-cwd>/).
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 */
	static async list(
		cwd: string,
		sessionDir?: string,
		onProgress?: SessionListProgress,
		signal?: AbortSignal,
	): Promise<SessionInfo[]> {
		const dir = sessionDir ? normalizePath(sessionDir) : getDefaultSessionDir(cwd);
		const filterCwd = sessionDir !== undefined && dir !== getDefaultSessionDirPath(cwd);
		const resolvedCwd = resolvePath(cwd);
		const includeSession = (session: SessionInfo) => !filterCwd || sessionCwdMatches(session.cwd, resolvedCwd);
		const progress: SessionListProgress | undefined = onProgress
			? (loaded, total, partialSessions) => onProgress(loaded, total, partialSessions?.filter(includeSession))
			: undefined;
		const sessions = (await listSessionFilesFromDir(dir, progress, signal)).filter(includeSession);
		return sortSessionInfos(sessions);
	}

	/**
	 * List all sessions across all project directories.
	 * @param onProgress Optional callback for progress updates (loaded, total)
	 */
	static async listAll(onProgress?: SessionListProgress, signal?: AbortSignal): Promise<SessionInfo[]>;
	static async listAll(
		sessionDir?: string,
		onProgress?: SessionListProgress,
		signal?: AbortSignal,
	): Promise<SessionInfo[]>;
	static async listAll(
		sessionDirOrOnProgress?: string | SessionListProgress,
		onProgressOrSignal?: SessionListProgress | AbortSignal,
		signal?: AbortSignal,
	): Promise<SessionInfo[]> {
		const customSessionDir =
			typeof sessionDirOrOnProgress === "string" ? normalizePath(sessionDirOrOnProgress) : undefined;
		const progress =
			typeof sessionDirOrOnProgress === "function"
				? sessionDirOrOnProgress
				: typeof onProgressOrSignal === "function"
					? onProgressOrSignal
					: undefined;
		const abortSignal =
			typeof sessionDirOrOnProgress === "string" || typeof onProgressOrSignal === "function"
				? signal
				: (onProgressOrSignal ?? signal);
		abortSignal?.throwIfAborted();
		if (customSessionDir) {
			return sortSessionInfos(await listSessionFilesFromDir(customSessionDir, progress, abortSignal));
		}
		return listAllSessionFiles(getSessionsDir(), progress, abortSignal);
	}
}
