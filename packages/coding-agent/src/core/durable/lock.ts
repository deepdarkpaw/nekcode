import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** Contents of a session lock file. */
type LockOwner = { readonly pid: number; readonly token: string; readonly createdAt: number };

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
	const owner: LockOwner = { pid: process.pid, token: randomUUID(), createdAt: Date.now() };
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
			return { pid: parsed.pid, token: parsed.token, createdAt: parsed.createdAt };
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
