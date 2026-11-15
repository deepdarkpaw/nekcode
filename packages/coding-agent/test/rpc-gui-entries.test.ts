/**
 * `get_entries` paging: `limit` and `beforeEntryId` window the append-order list from the leaf backwards, and
 * `hasMore` says an older page exists. Without both parameters the response is the full list, as before.
 *
 * The paging rule is tested directly, and through an in-process RPC mode so the command wiring is covered too.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { pageEntries } from "../src/modes/rpc/entry-page.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { createInMemoryModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

/** Entries with the given ids, as `get_entries` returns them. */
function entriesWithIds(ids: string[]): SessionEntry[] {
	return ids.map(
		(id) => ({ type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z" }) as SessionEntry,
	);
}

describe("get_entries paging", () => {
	it("returns every entry when neither parameter is given", () => {
		const entries = entriesWithIds(["e1", "e2", "e3"]);

		expect(pageEntries(entries)).toEqual({ entries, hasMore: false });
	});

	it("returns the newest page for a bare limit", () => {
		const entries = entriesWithIds(["e1", "e2", "e3", "e4"]);

		expect(pageEntries(entries, { limit: 2 }).entries.map((entry) => entry.id)).toEqual(["e3", "e4"]);
		expect(pageEntries(entries, { limit: 2 }).hasMore).toBe(true);
		expect(pageEntries(entries, { limit: 4 })).toEqual({ entries, hasMore: false });
	});

	it("ends the page at beforeEntryId and reports an older page", () => {
		const entries = entriesWithIds(["e1", "e2", "e3", "e4", "e5"]);

		const newest = pageEntries(entries, { beforeEntryId: "e4", limit: 2 });
		const older = pageEntries(entries, { beforeEntryId: "e2", limit: 2 });

		expect(newest.entries.map((entry) => entry.id)).toEqual(["e2", "e3"]);
		expect(newest.hasMore).toBe(true);
		expect(older.entries.map((entry) => entry.id)).toEqual(["e1"]);
		expect(older.hasMore).toBe(false);
	});

	it("returns everything older than beforeEntryId without a limit", () => {
		const entries = entriesWithIds(["e1", "e2", "e3"]);

		expect(pageEntries(entries, { beforeEntryId: "e3" })).toEqual({
			entries: entriesWithIds(["e1", "e2"]),
			hasMore: false,
		});
	});

	it("rejects an unknown entry id and a limit that is not a positive integer", () => {
		const entries = entriesWithIds(["e1"]);

		expect(() => pageEntries(entries, { beforeEntryId: "missing" })).toThrow(/Entry not found: missing/u);
		expect(() => pageEntries(entries, { limit: 0 })).toThrow(/positive integer/u);
		expect(() => pageEntries(entries, { limit: 1.5 })).toThrow(/positive integer/u);
	});
});

describe("get_entries over RPC", () => {
	let tempDir: string | undefined;
	let cleanup: (() => Promise<void>) | undefined;
	let currentSession: AgentSession | undefined;
	let rebind: (() => Promise<void>) | undefined;

	afterEach(async () => {
		await cleanup?.();
		cleanup = undefined;
		currentSession = undefined;
		rebind = undefined;
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		if (tempDir !== undefined && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	/** Start RPC mode on a session holding five user messages, and answer every line as the client would. */
	async function startWithEntries(persist = false): Promise<string[]> {
		tempDir = join(tmpdir(), `nek-rpc-entries-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Test model not found");
		const agent = new Agent({
			getApiKey: () => "test-api-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				throw new Error("get_entries must not send a request");
			},
		});
		const sessionManager = persist
			? SessionManager.create(tempDir, join(tempDir, "sessions"))
			: SessionManager.inMemory();
		for (const text of ["one", "two", "three", "four", "five"]) {
			sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
		}
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createInMemoryModelRegistry(authStorage);
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.create(tempDir, tempDir),
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
		currentSession = session;
		const runtimeHost = {
			session,
			newSession: vi.fn(async () => ({ cancelled: true })),
			switchSession: vi.fn(async () => ({ cancelled: true })),
			fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
			dispose: vi.fn(async () => {}),
			setRebindSession: vi.fn((callback: () => Promise<void>) => {
				rebind = callback;
			}),
		} as unknown as AgentSessionRuntime;
		cleanup = async () => {
			await session.dispose();
		};

		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		void runRpcMode(runtimeHost);
		await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());
		return sessionManager.getEntries().map((entry) => entry.id);
	}

	/** Send one command and return its response record. */
	async function request(command: Record<string, unknown>): Promise<Record<string, unknown>> {
		const id = `req-${rpcIo.outputLines.length}`;
		rpcIo.lineHandler?.(JSON.stringify({ id, ...command }));
		await vi.waitFor(() =>
			expect(
				rpcIo.outputLines.some((line) => JSON.parse(line).id === id && JSON.parse(line).type === "response"),
			).toBe(true),
		);
		const line = rpcIo.outputLines
			.map((raw) => JSON.parse(raw) as Record<string, unknown>)
			.find((record) => record.id === id && record.type === "response");
		return line!;
	}

	it("HP12 negotiates bounded live events only on explicit opt-in and restores legacy event semantics", async () => {
		await startWithEntries(true);
		expect(await request({ type: "set_history_stream", version: 1 })).toMatchObject({
			success: true,
			data: { version: 1, maxEventBytes: 1048576 },
		});
		await request({ type: "set_session_name", name: "bounded-name" });
		await vi.waitFor(() =>
			expect(
				rpcIo.outputLines
					.map((line) => JSON.parse(line))
					.some((record) => record.type === "history_event" && record.event.type === "session_info_changed"),
			).toBe(true),
		);
		expect(
			rpcIo.outputLines.map((line) => JSON.parse(line)).some((record) => record.type === "session_info_changed"),
		).toBe(false);
		expect(await request({ type: "set_history_stream", version: 0 })).toMatchObject({
			success: true,
			data: { version: 0 },
		});
		await request({ type: "set_session_name", name: "legacy-name" });
		expect(
			rpcIo.outputLines
				.map((line) => JSON.parse(line))
				.some((record) => record.type === "session_info_changed" && record.name === "legacy-name"),
		).toBe(true);
	});

	it("HP11 late extension callbacks from an old binding cannot acquire the replacement live epoch", async () => {
		await startWithEntries(true);
		await request({ type: "set_history_stream", version: 1 });
		const oldEmit = currentSession!.resourceLoader.getExtensions().runtime.emitRpcEvent!;
		expect(rebind).toBeDefined();
		await rebind!();
		oldEmit("late-old", { text: "must not resurrect" });
		currentSession!.resourceLoader.getExtensions().runtime.emitRpcEvent!("fresh", { text: "new binding" });
		await vi.waitFor(() =>
			expect(
				rpcIo.outputLines
					.map((line) => JSON.parse(line))
					.some((record) => record.type === "history_event" && record.event.name === "fresh"),
			).toBe(true),
		);
		const records = rpcIo.outputLines.map((line) => JSON.parse(line));
		expect(records.some((record) => record.type === "history_event" && record.event.name === "late-old")).toBe(false);
		const reset = records.findLast((record) => record.type === "history_stream_reset");
		expect(records.find((record) => record.type === "history_event" && record.event.name === "fresh").epoch).toBe(
			reset.epoch,
		);
	});

	interface EntriesData {
		entries: Array<{ id: string }>;
		leafId: string | null;
		hasMore: boolean;
	}

	it("answers the full list, then one page at a time", async () => {
		const ids = await startWithEntries();

		const full = (await request({ type: "get_entries" })).data as EntriesData;
		expect(full.entries.map((entry) => entry.id)).toEqual(ids);
		expect(full.hasMore).toBe(false);
		expect(full.leafId).toBe(ids[ids.length - 1]);

		const newest = (await request({ type: "get_entries", limit: 2 })).data as EntriesData;
		expect(newest.entries.map((entry) => entry.id)).toEqual(ids.slice(3));
		expect(newest.hasMore).toBe(true);

		const older = (await request({ type: "get_entries", limit: 2, beforeEntryId: ids[3] })).data as EntriesData;
		expect(older.entries.map((entry) => entry.id)).toEqual(ids.slice(1, 3));
		expect(older.hasMore).toBe(true);

		const oldest = (await request({ type: "get_entries", limit: 2, beforeEntryId: ids[1] })).data as EntriesData;
		expect(oldest.entries.map((entry) => entry.id)).toEqual(ids.slice(0, 1));
		expect(oldest.hasMore).toBe(false);
	});

	it("keeps the since cursor and combines it with paging", async () => {
		const ids = await startWithEntries();

		const since = (await request({ type: "get_entries", since: ids[0] })).data as EntriesData;
		expect(since.entries.map((entry) => entry.id)).toEqual(ids.slice(1));
		expect(since.hasMore).toBe(false);

		const paged = (await request({ type: "get_entries", since: ids[0], limit: 2 })).data as EntriesData;
		expect(paged.entries.map((entry) => entry.id)).toEqual(ids.slice(3));
		expect(paged.hasMore).toBe(true);
	});

	it("fails an unknown cursor or an invalid limit", async () => {
		await startWithEntries();

		const unknown = await request({ type: "get_entries", beforeEntryId: "missing" });
		expect(unknown.success).toBe(false);
		expect(unknown.error).toBe("Entry not found: missing");

		const invalid = await request({ type: "get_entries", limit: 0 });
		expect(invalid.success).toBe(false);
		expect(invalid.error).toContain("limit must be a positive integer");
	});
});
