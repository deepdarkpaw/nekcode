import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setSqliteDriver } from "../src/core/durable/sqlite.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type { GuiContext } from "../src/modes/rpc/gui/context.ts";
import { readHistoryCommand } from "../src/modes/rpc/gui/history.ts";

let manager: SessionManager;
let ctx: GuiContext;
beforeEach(() => {
	const tmp = resolve(import.meta.dirname, "../../../.tmp/history-unpersisted");
	mkdirSync(tmp, { recursive: true });
	const root = mkdtempSync(join(tmp, "case-"));
	setSqliteDriver({
		open(path, options) {
			const db = new DatabaseSync(path, { readOnly: options.readOnly });
			return {
				close: () => db.close(),
				exec: (sql) => db.exec(sql),
				prepare: (sql) => {
					const statement = db.prepare(sql);
					return {
						get: (...args) => statement.get(...args),
						all: (...args) => statement.all(...args),
						run: (...args) => statement.run(...args),
					};
				},
			};
		},
	});
	manager = SessionManager.create(root, join(root, "sessions"));
	ctx = {
		mode: "session",
		cwd: root,
		session: { sessionFile: manager.getSessionFile(), sessionManager: manager },
	} as unknown as GuiContext;
});
afterEach(() => {
	vi.restoreAllMocks();
	setSqliteDriver({ open: (path, options) => new DatabaseSync(path, { readOnly: options.readOnly }) });
});

it("HO7: initial current history is empty without creating a file or walking queued setup entries", () => {
	manager.appendModelChange("mock", "offline");
	expect(existsSync(manager.getSessionFile()!)).toBe(false);
	vi.spyOn(manager, "getEntries").mockImplementation(() => {
		throw new Error("GUI must not read model context");
	});
	const page = readHistoryCommand(ctx, { type: "read_history_page" });
	expect(page).toMatchObject({ ok: true, totalTurns: 0, totalEntries: 0, entries: [], turns: [], leafId: null });
	expect(readHistoryCommand(ctx, { type: "read_session_metadata" })).toMatchObject({
		ok: true,
		totalTurns: 0,
		session: { id: manager.getSessionId(), messageCount: 0 },
	});
	expect(readHistoryCommand(ctx, { type: "read_history_subagent" })).toMatchObject({
		ok: true,
		total: 0,
		subagents: [],
	});
	expect(existsSync(manager.getSessionFile()!)).toBe(false);
});

it("HO7: missing explicit or previously initialized storage is never presented as an empty new session", () => {
	expect(readHistoryCommand(ctx, { type: "read_history_page", sessionPath: manager.getSessionFile()! })).toMatchObject(
		{ ok: false, error: { code: "INVALID_STORAGE" } },
	);
	vi.spyOn(manager, "hasInitializedStorage").mockReturnValue(true);
	expect(readHistoryCommand(ctx, { type: "read_history_page" })).toMatchObject({
		ok: false,
		error: { code: "INVALID_STORAGE" },
	});
});

it("HO7: the first user append persists normally and is then read through the ordinary indexed path", async () => {
	const before = readHistoryCommand(ctx, { type: "read_history_page" });
	expect(before.ok).toBe(true);
	manager.appendMessage({ role: "user", content: "offline fixture", timestamp: 1000 });
	await manager.flush();
	expect(existsSync(manager.getSessionFile()!)).toBe(true);
	expect(manager.hasInitializedStorage()).toBe(true);
	const after = readHistoryCommand(ctx, { type: "read_history_page" });
	expect(after).toMatchObject({ ok: true, totalTurns: 1, totalEntries: 1 });
	if (!before.ok || !after.ok) throw new Error("Expected bounded history pages");
	expect(after.sessionId).toBe(before.sessionId);
	expect(after.sessionPath).toBe(before.sessionPath);
});
