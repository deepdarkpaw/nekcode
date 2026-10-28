import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { hostname } from "node:os";
import { dirname } from "node:path";

/** How the process that holds a session is driven; recorded so other processes can describe the holder. */
export type SessionLockKind = "tui" | "rpc" | "print" | "json";

/** Contents of a session lock file. */
type LockOwner = {
	readonly pid: number;
	readonly token: string;
	readonly createdAt: number;
	/** Hostname of the owning process; absent in locks written before the field existed. */
	readonly hostname?: string;
	/** How the owning process runs sessions; absent in locks written before the field existed. */
	readonly kind?: SessionLockKind;
};

/** What another process can report about a live lock: its pid, host, kind, and start time. */
export interface SessionLockOwnerInfo {
	readonly pid: number;
	readonly hostname: string;
	readonly kind: SessionLockKind;
	/** Epoch milliseconds when the lock was created. */
	readonly startedAt: number;
}

/** Kinds a lock file may record, for validation of what is read back. */
const LOCK_KINDS: ReadonlySet<string> = new Set<SessionLockKind>(["tui", "rpc", "print", "json"]);

/** How this process runs sessions; `undefined` until the entry point declares it. */
let processLockKind: SessionLockKind | undefined;

/**
 * Declare how this process runs sessions, so the lock files it writes identify it. The entry point calls this
 * once, before any session is opened; without it the lock is written exactly as before.
 */
export function setSessionLockKind(kind: SessionLockKind): void {
	processLockKind = kind;
}

/** A lock file younger than this whose owner cannot be read is assumed to be mid-creation by its owner. */
const UNREADABLE_LOCK_GRACE_MS = 5_000;

/** Raised when another live process owns the session. */
export class SessionLockedError extends Error {
	readonly path: string;
	readonly ownerPid: number | undefined;

	constructor(path: string, ownerPid: number | undefined) {
		super(
			ownerPid === undefined
				? `Session is locked by another process (${path})`
				: `Session is locked by process ${ownerPid} (${path})`,
		);
		this.name = "SessionLockedError";
		this.path = path;
		this.ownerPid = ownerPid;
	}
}

/** Exclusive ownership of one session by this process. */
export interface SessionLock {
	readonly path: string;
	/** Remove the lock file if this lock still owns it. Idempotent. */
	release(): void;
}

/**
 * Acquire the lock file at `path`. Only one process may open a session: a second open fails with
 * {@link SessionLockedError} while the owner lives. A lock left by a dead process (its PID no longer exists) is
 * reclaimed. Two opens inside one process are rejected too, since two Harness instances must never share storage.
 */
export function acquireSessionLock(path: string): SessionLock {
	mkdirSync(dirname(path), { recursive: true });
	const owner: LockOwner = {
		pid: process.pid,
		token: randomUUID(),
		createdAt: Date.now(),
		hostname: hostname(),
		...(processLockKind === undefined ? {} : { kind: processLockKind }),
	};
	for (let attempt = 0; attempt < 2; attempt++) {
		if (tryCreate(path, owner)) return ownedLock(path, owner);
		const current = readOwner(path);
		if (!isStale(path, current)) throw new SessionLockedError(path, current?.pid);
		removeIfPresent(path);
	}
	throw new SessionLockedError(path, readOwner(path)?.pid);
}

function tryCreate(path: string, owner: LockOwner): boolean {
	let fd: number;
	try {
		fd = openSync(path, "wx");
	} catch (error) {
		if (errorCode(error) === "EEXIST") return false;
		throw error;
	}
	try {
		writeSync(fd, JSON.stringify(owner));
	} finally {
		closeSync(fd);
	}
	return true;
}

function ownedLock(path: string, owner: LockOwner): SessionLock {
	let released = false;
	return {
		path,
		release() {
			if (released) return;
			released = true;
			if (readOwner(path)?.token === owner.token) removeIfPresent(path);
		},
	};
}

function readOwner(path: string): LockOwner | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (
			parsed !== null &&
			typeof parsed === "object" &&
			"pid" in parsed &&
			typeof parsed.pid === "number" &&
			"token" in parsed &&
			typeof parsed.token === "string" &&
			"createdAt" in parsed &&
			typeof parsed.createdAt === "number"
		) {
			const hostname = "hostname" in parsed && typeof parsed.hostname === "string" ? parsed.hostname : undefined;
			const kind =
				"kind" in parsed && typeof parsed.kind === "string" && LOCK_KINDS.has(parsed.kind)
					? (parsed.kind as SessionLockKind)
					: undefined;
			return {
				pid: parsed.pid,
				token: parsed.token,
				createdAt: parsed.createdAt,
				...(hostname === undefined ? {} : { hostname }),
				...(kind === undefined ? {} : { kind }),
			};
		}
		return undefined;
	} catch {
		return undefined;
	}
}

/** A lock is stale when its owner process is gone, or when it stayed unreadable past the creation grace period. */
function isStale(path: string, owner: LockOwner | undefined): boolean {
	if (owner !== undefined) return !isProcessAlive(owner.pid);
	try {
		return Date.now() - statSync(path).mtimeMs > UNREADABLE_LOCK_GRACE_MS;
	} catch (error) {
		// Removed between the failed create and this check: free to retry.
		return errorCode(error) === "ENOENT";
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: the process exists but belongs to another user.
		return errorCode(error) === "EPERM";
	}
}

function removeIfPresent(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
	}
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Lock file guarding a session database against a second process. */
export function sessionLockPath(path: string): string {
	return `${path}.lock`;
}

/** Whether a live process holds the lock of the session at `path`. A stale lock does not count. */
export function isSessionLocked(path: string): boolean {
	const lockPath = sessionLockPath(path);
	if (!existsSync(lockPath)) return false;
	return !isStale(lockPath, readOwner(lockPath));
}

/**
 * Holder of the live lock of the session at `path`, for a client that wants to say which process is using it.
 * `undefined` when no live lock exists, and also when the lock was written before the holder described itself.
 */
export function readSessionLockOwner(path: string): SessionLockOwnerInfo | undefined {
	const lockPath = sessionLockPath(path);
	if (!existsSync(lockPath)) return undefined;
	const owner = readOwner(lockPath);
	if (owner === undefined || isStale(lockPath, owner)) return undefined;
	if (owner.hostname === undefined || owner.kind === undefined) return undefined;
	return { pid: owner.pid, hostname: owner.hostname, kind: owner.kind, startedAt: owner.createdAt };
}
