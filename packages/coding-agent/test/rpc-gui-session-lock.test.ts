/**
 * Session lock holders: the lock file records which process owns a session, and `read_session_snapshot`
 * reports it as `lockedBy`.
 *
 * Old lock files and the locks of processes that never declare their kind stay readable: they keep reporting
 * `locked` and simply omit `lockedBy`.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	acquireSessionLock,
	readSessionLockOwner,
	sessionLockPath,
	setSessionLockKind,
} from "../src/core/durable/lock.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { readSessionSnapshotFor } from "../src/modes/rpc/gui/sessions.ts";

/** A pid that no process holds, so its lock counts as stale. */
const DEAD_PID = 4_000_000;

describe("session lock holder", () => {
	let root: string;
	let sessionDir: string;
	let cwd: string;
	let sessionFile: string;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "nek-gui-lock-"));
		sessionDir = join(root, "sessions");
		cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		sessionFile = await createSession();
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	/** A persisted session of `cwd` with one user message. */
	async function createSession(): Promise<string> {
		const manager = SessionManager.create(cwd, sessionDir);
		manager.appendMessage({ role: "user", content: "lock me", timestamp: Date.now() });
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("session was not persisted");
		return file;
	}

	/** A lock file as an older nek wrote it: no host and no kind. */
	function writeLegacyLock(pid: number): void {
		writeFileSync(sessionLockPath(sessionFile), JSON.stringify({ pid, token: "test", createdAt: Date.now() }));
	}

	it("records the holder kind and host in the lock file", () => {
		setSessionLockKind("rpc");
		const lock = acquireSessionLock(sessionLockPath(sessionFile));
		try {
			const owner = readSessionLockOwner(sessionFile);

			expect(owner).toEqual({
				pid: process.pid,
				hostname: hostname(),
				kind: "rpc",
				startedAt: expect.any(Number),
			});
		} finally {
			lock.release();
		}
		expect(readSessionLockOwner(sessionFile)).toBeUndefined();
		expect(existsSync(sessionLockPath(sessionFile))).toBe(false);
	});

	it("reports the holder in a session snapshot", () => {
		setSessionLockKind("tui");
		const lock = acquireSessionLock(sessionLockPath(sessionFile));
		try {
			const snapshot = readSessionSnapshotFor(sessionFile);

			expect(snapshot.session.locked).toBe(true);
			expect(snapshot.lockedBy).toEqual({
				pid: process.pid,
				hostname: hostname(),
				kind: "tui",
				startedAt: expect.any(String),
			});
			expect(Number.isNaN(Date.parse(snapshot.lockedBy?.startedAt ?? ""))).toBe(false);
		} finally {
			lock.release();
		}
		expect(readSessionSnapshotFor(sessionFile).lockedBy).toBeUndefined();
	});

	it("omits the holder for a lock written before the field existed", () => {
		writeLegacyLock(process.pid);

		const snapshot = readSessionSnapshotFor(sessionFile);

		expect(snapshot.session.locked).toBe(true);
		expect(snapshot.lockedBy).toBeUndefined();
		expect(readSessionLockOwner(sessionFile)).toBeUndefined();
	});

	it("omits the holder for an unknown kind", () => {
		writeFileSync(
			sessionLockPath(sessionFile),
			JSON.stringify({
				pid: process.pid,
				token: "test",
				createdAt: Date.now(),
				hostname: "other-host",
				kind: "web",
			}),
		);

		expect(readSessionSnapshotFor(sessionFile).session.locked).toBe(true);
		expect(readSessionSnapshotFor(sessionFile).lockedBy).toBeUndefined();
	});

	it("omits the holder of a stale lock", () => {
		writeFileSync(
			sessionLockPath(sessionFile),
			JSON.stringify({ pid: DEAD_PID, token: "test", createdAt: Date.now(), hostname: "gone", kind: "tui" }),
		);

		expect(readSessionSnapshotFor(sessionFile).session.locked).toBe(false);
		expect(readSessionSnapshotFor(sessionFile).lockedBy).toBeUndefined();
	});

	it("reports no holder for an unlocked session", () => {
		const snapshot = readSessionSnapshotFor(sessionFile);

		expect(snapshot.session.locked).toBe(false);
		expect(snapshot.lockedBy).toBeUndefined();
	});
});
