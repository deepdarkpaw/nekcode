/** Session databases on Bun: files are released on close, so sessions can be created (moved into place) and deleted. */

import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { setSqliteDriver } from "@earendil-works/pi-coding-agent/core/durable/sqlite";
import { SessionManager } from "@earendil-works/pi-coding-agent/core/session-manager";
import { bunSqliteDriver } from "../../src/storage/bun-sqlite.ts";

const answer: AssistantMessage = {
	role: "assistant",
	content: [{ type: "text", text: "hello" }],
	api: "faux",
	provider: "faux",
	model: "faux-1",
	usage: {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: 1,
};

test("creates, reopens, and deletes a session database through bun:sqlite", async () => {
	setSqliteDriver(bunSqliteDriver);
	const dir = mkdtempSync(join(tmpdir(), "nek-bun-sqlite-"));
	const manager = SessionManager.create(dir, join(dir, "sessions"));
	manager.appendMessage({ role: "user", content: "hi", timestamp: 1 });
	// The first conversation writes a temporary database and moves it into place.
	manager.appendMessage(answer);
	const file = manager.getSessionFile();
	expect(file !== undefined && existsSync(file)).toBe(true);
	const store = manager.durableStore();
	await store.pin();
	await store.unpin();
	expect(SessionManager.open(file!).getEntries()).toHaveLength(2);
	rmSync(dir, { recursive: true });
	expect(existsSync(dir)).toBe(false);
});
