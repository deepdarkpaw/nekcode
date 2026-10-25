/**
 * Session catalog commands: listing, snapshots, rename, and delete, including the lock rules.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { sessionLockPath } from "../src/core/durable/lock.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createGuiContext, type GuiContext } from "../src/modes/rpc/gui/context.ts";
import {
	deleteSession,
	importSession,
	listSessions,
	readSessionSnapshotFor,
	renameSession,
} from "../src/modes/rpc/gui/sessions.ts";

function stubModelRuntime(): ModelRuntime {
	return {} as unknown as ModelRuntime;
}

/** Lock a session as a live process would, so the catalog reports it as busy. */
function writeLockFile(sessionFile: string): void {
	writeFileSync(
		sessionLockPath(sessionFile),
		JSON.stringify({ pid: process.pid, token: "test", createdAt: Date.now() }),
	);
}

describe("GUI session catalog", () => {
	let root: string;
	let agentDir: string;
	let sessionDir: string;
	let cwd: string;
	let ctx: GuiContext;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "nek-gui-sessions-"));
		agentDir = join(root, "agent");
		sessionDir = join(root, "sessions");
		cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		ctx = createGuiContext({
			mode: "control",
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({ sessionDir }),
			modelRuntime: stubModelRuntime(),
			emit: () => {},
		});
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	/** A persisted session of `cwd` with one user message. */
	async function createSession(text: string): Promise<string> {
		const manager = SessionManager.create(cwd, sessionDir);
		manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		await manager.flush();
		const file = manager.getSessionFile();
		if (!file) throw new Error("session was not persisted");
		return file;
	}

	it("lists sessions newest first and truncates the first message", async () => {
		const first = await createSession("older");
		await new Promise((resolve) => setTimeout(resolve, 10));
		const second = await createSession("x".repeat(300));

		const sessions = await listSessions(ctx, {});

		expect(sessions.map((session) => session.path)).toEqual([second, first]);
		expect(sessions[0].firstMessage).toHaveLength(200);
		expect(sessions[1].firstMessage).toBe("older");
		expect(sessions[0].locked).toBe(false);
		expect(sessions[0].messageCount).toBe(1);
		expect(new Date(sessions[0].modifiedAt).getTime()).toBeGreaterThanOrEqual(
			new Date(sessions[0].createdAt).getTime(),
		);
	});

	it("caps the listing at the requested limit", async () => {
		await createSession("one");
		await createSession("two");
		await createSession("three");

		const sessions = await listSessions(ctx, { limit: 2 });

		expect(sessions).toHaveLength(2);
	});

	it("reads a snapshot without opening the session", async () => {
		const file = await createSession("snapshot me");

		const snapshot = readSessionSnapshotFor(file);

		expect(snapshot.session.path).toBe(file);
		expect(snapshot.session.firstMessage).toBe("snapshot me");
		expect(snapshot.entries.length).toBeGreaterThan(0);
		expect(snapshot.leafId).toBe((snapshot.entries[snapshot.entries.length - 1] as { id: string }).id);
		expect(JSON.stringify(snapshot.messages)).toContain("snapshot me");
		expect(snapshot.session.locked).toBe(false);
		expect(existsSync(sessionLockPath(file))).toBe(false);
	});

	it("renames a session and reports the new name", async () => {
		const file = await createSession("rename me");

		await renameSession(file, "  Renamed session  ");

		expect(readSessionSnapshotFor(file).session.name).toBe("Renamed session");
		expect((await listSessions(ctx, {}))[0].name).toBe("Renamed session");
	});

	it("refuses to rename a locked session", async () => {
		const file = await createSession("locked");
		writeLockFile(file);

		await expect(renameSession(file, "Nope")).rejects.toThrow(/locked by a live process/u);
	});

	it("deletes every file of a session", async () => {
		const file = await createSession("delete me");
		const sidecar = file.replace(/\.sqlite$/u, ".meta.json");

		deleteSession(ctx, file);

		expect(existsSync(file)).toBe(false);
		expect(existsSync(sidecar)).toBe(false);
		expect(await listSessions(ctx, {})).toEqual([]);
	});

	it("refuses to delete the current session or a locked session", async () => {
		const other = await createSession("other");
		writeLockFile(other);
		expect(() => deleteSession(ctx, other)).toThrow(/locked by a live process/u);
		rmSync(sessionLockPath(other), { force: true });

		const current = await createSession("current");
		const withSession = createGuiContext({
			mode: "session",
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({ sessionDir }),
			modelRuntime: stubModelRuntime(),
			session: { sessionFile: current } as unknown as AgentSession,
			emit: () => {},
		});

		expect(() => deleteSession(withSession, current)).toThrow(/current session/u);
		expect(existsSync(current)).toBe(true);
	});

	it("imports a session into a new session of the target cwd", async () => {
		const source = await createSession("import me");
		const target = join(root, "other-project");
		mkdirSync(target, { recursive: true });
		const imported = importSession(ctx, source, target);

		expect(imported).not.toBe(source);
		expect(existsSync(imported)).toBe(true);
		expect(imported.startsWith(sessionDir)).toBe(true);
		expect(readdirSync(sessionDir)).toContain(basename(imported));
		const snapshot = readSessionSnapshotFor(imported);
		expect(snapshot.session.cwd).toBe(target);
		expect(JSON.stringify(snapshot.messages)).toContain("import me");
		expect(existsSync(source)).toBe(true);
	});

	it("reports a missing session instead of creating one", () => {
		expect(() => readSessionSnapshotFor(join(sessionDir, "missing.sqlite"))).toThrow(/Session not found/u);
	});
});
