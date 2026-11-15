import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session.ts";
import type { EntryPlan } from "../src/core/durable/session-format.ts";
import { DurableSessionStore } from "../src/core/durable/session-store.ts";
import type { SessionEntry } from "../src/core/session-entries.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { toJsonEvent } from "../src/modes/json-event.ts";
import type { GuiContext } from "../src/modes/rpc/gui/context.ts";
import { readHistoryCommand } from "../src/modes/rpc/gui/history.ts";
import type { RpcHistoryStreamEvent } from "../src/modes/rpc/gui/history-stream-protocol.ts";
import { historyJsonChunks } from "../src/modes/rpc/history-json-stream.ts";
import { historyLiveEvent } from "../src/modes/rpc/history-live-event.ts";
import { createHistoryStreamEmitter, type HistoryStreamSource } from "../src/modes/rpc/history-stream.ts";
import { createHarness } from "./suite/harness.ts";

const BASE = resolve(import.meta.dirname, "../../../.tmp/history-stream-tests");
const HUGE = "x".repeat(65 * 1024 * 1024);
const usage = {
	input: 1,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 3,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const assistant = (text: string) => ({
	role: "assistant" as const,
	content: [{ type: "text" as const, text }],
	api: "openai-responses" as const,
	provider: "mock",
	model: "offline",
	timestamp: 1,
	stopReason: "stop" as const,
	usage,
});
let root: string;
beforeEach(() => {
	mkdirSync(BASE, { recursive: true });
	root = mkdtempSync(join(BASE, "case-"));
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
});
function source(): HistoryStreamSource & { entries: SessionEntry[] } {
	const sessionPath = join(root, "source.sqlite");
	writeFileSync(sessionPath, "fixture locator");
	const entries: SessionEntry[] = [];
	return {
		sessionPath,
		sessionId: "session",
		entries,
		leafId: () => entries.at(-1)?.id ?? null,
		waitForWrites: vi.fn(async () => {}),
		committedPosition: () => entries.length,
		hasCommittedEntry: (entryId) => entries.some((entry) => entry.id === entryId),
		committedSince: (position) => ({ position: entries.length, entries: entries.slice(position) }),
	};
}
function pending(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	return {
		promise: new Promise<void>((done) => {
			resolve = done;
		}),
		resolve: () => resolve(),
	};
}
function collect(owner = source()) {
	const frames: RpcHistoryStreamEvent[] = [];
	const stream = createHistoryStreamEmitter(owner, async (frame) => {
		expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(1048576);
		frames.push(frame);
	});
	return { owner, frames, stream };
}

describe("opt-in bounded live history", () => {
	it("HP12 default remains disabled and legacy toJsonEvent keeps its original full final message", async () => {
		const { owner, frames, stream } = collect();
		const event: AgentSessionEvent = { type: "message_end", message: assistant(HUGE) };
		expect(toJsonEvent(event)).toBe(event);
		stream.publish(event);
		await stream.drain();
		expect(stream.enabled()).toBe(false);
		expect(frames).toEqual([]);
		expect(owner.waitForWrites).not.toHaveBeenCalled();
	});
	it("HP3/HP4 emits only committed locators for giant entries without inspecting/serializing their body", async () => {
		const { owner, frames, stream } = collect();
		await stream.configure(1);
		let committed = false;
		owner.waitForWrites = vi.fn(async () => {
			committed = true;
		});
		const value = {
			id: "giant-entry",
			type: "custom",
			parentId: null,
			timestamp: "2026-11-01",
			customType: "giant",
		} as SessionEntry;
		Object.defineProperty(value, "data", {
			enumerable: true,
			get: () => {
				throw new Error("must not inspect the 65MiB body");
			},
		});
		owner.entries.push(value);
		stream.publish({ type: "entry_appended", entry: value });
		await stream.drain();
		expect(committed).toBe(true);
		const refs = frames.filter((frame) => frame.type === "history_entry_appended");
		expect(refs).toHaveLength(1);
		expect(refs[0]).toMatchObject({
			entryId: "giant-entry",
			ref: { command: "read_history_page", sessionPath: owner.sessionPath, aroundEntryId: "giant-entry" },
		});
		expect(JSON.stringify(frames).length).toBeLessThan(2048);
	});
	it("HP11 a stored host append is never announced ahead of earlier entries the projection has not folded", async () => {
		const { owner, frames, stream } = collect();
		await stream.configure(1);
		const custom = (id: string, parentId: string | null) =>
			({ id, type: "custom", parentId, timestamp: "2026-11-01", customType: "fixture" }) as SessionEntry;
		const earlier = custom("engine-commit", null);
		const host = custom("host-append", "engine-commit");
		// The durable store already holds both; the owner's projection has folded neither yet.
		owner.hasCommittedEntry = (entryId) => entryId === earlier.id || entryId === host.id;
		stream.publish({ type: "entry_appended", entry: host });
		await stream.drain();
		expect(frames.filter((frame) => frame.type === "history_entry_appended")).toEqual([]);
		owner.entries.push(earlier, host);
		stream.publish({ type: "agent_start" });
		await stream.drain();
		expect(frames.flatMap((frame) => (frame.type === "history_entry_appended" ? [frame.entryId] : []))).toEqual([
			"engine-commit",
			"host-append",
		]);
	});
	it("HP3/HP4 full final message/tool/turn/agent copies >64MiB become explicit history omissions", async () => {
		const { frames, stream } = collect();
		await stream.configure(1);
		const message = assistant(HUGE);
		const events: AgentSessionEvent[] = [
			{ type: "message_end", message },
			{ type: "tool_execution_start", toolCallId: "call", toolName: "read", args: { giant: HUGE } },
			{
				type: "tool_execution_end",
				toolCallId: "call",
				toolName: "read",
				isError: false,
				result: {
					content: [{ type: "text", text: HUGE }],
					details: { giant: HUGE },
					structuredContent: { retained: true },
				},
			},
			{ type: "turn_end", message, toolResults: [] },
			{ type: "agent_end", messages: [message, message], willRetry: false },
		];
		for (const event of events) stream.publish(event);
		await stream.drain();
		const updates = frames.filter((frame) => frame.type === "history_event");
		expect(updates).toHaveLength(events.length);
		expect(updates.every((frame) => frame.omissions.length > 0)).toBe(true);
		expect(JSON.stringify(frames).length).toBeLessThan(8192);
		expect(updates[2].event.result).toEqual({ structuredContent: { retained: true } });
		expect(message.content[0].text).toHaveLength(HUGE.length);
	});
	it("HP4 redundant end snapshots disappear, but replacement resets and argument-path/replace deltas remain exact", () => {
		const message = assistant(HUGE);
		const end = historyLiveEvent({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_end", contentIndex: 0, content: HUGE, partial: message },
		});
		expect(end.event.assistantMessageEvent).toEqual({ type: "text_end", contentIndex: 0 });
		expect(end.omissions[0]).toMatchObject({ reason: "redundant_delta" });
		const reset = historyLiveEvent({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "start", partial: message },
		});
		expect((reset.event.assistantMessageEvent as { message: unknown }).message).toBe(message);
		const delta = {
			type: "toolcall_delta" as const,
			contentIndex: 0,
			delta: "partial",
			argumentPath: ["field"],
			replace: true,
			partial: message,
		};
		expect(
			historyLiveEvent({ type: "message_update", message, assistantMessageEvent: delta }).event
				.assistantMessageEvent,
		).toEqual({ type: "toolcall_delta", contentIndex: 0, delta: "partial", argumentPath: ["field"], replace: true });
	});
	it("HP3/HP4 streams an exact >64MiB nonredundant text delta in bounded frames without whole JSON serialization", async () => {
		const owner = source();
		const hash = createHash("sha256");
		let bytes = 0;
		let maxFrame = 0;
		let chunks = 0;
		let lastSeq = 0;
		const stream = createHistoryStreamEmitter(owner, async (frame) => {
			expect(frame.seq).toBeGreaterThan(lastSeq);
			lastSeq = frame.seq;
			maxFrame = Math.max(maxFrame, Buffer.byteLength(JSON.stringify(frame)));
			if (frame.type !== "history_event_chunk") return;
			expect(frame.offset).toBe(bytes);
			if (frame.final) {
				expect(frame.totalBytes).toBe(bytes);
				return;
			}
			const buffer = Buffer.from(frame.data, "base64");
			expect(buffer.length).toBeLessThanOrEqual(49152);
			hash.update(buffer);
			bytes += buffer.length;
			chunks++;
		});
		await stream.configure(1);
		const message = assistant(HUGE);
		stream.publish({
			type: "message_update",
			message,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: HUGE, partial: message },
		});
		await stream.drain();
		const expected = createHash("sha256")
			.update(
				`{"type":"message_update","usage":${JSON.stringify(usage)},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"`,
			)
			.update(HUGE)
			.update('"}}')
			.digest("hex");
		expect(hash.digest("hex")).toBe(expected);
		expect(chunks).toBeGreaterThan(1000);
		expect(maxFrame).toBeLessThan(65536 + 1024);
		console.log(JSON.stringify({ case: "HP4-live-65MiB", bytes, chunks, maxFrame }));
	}, 30000);
	it("HP3 large transient tool progress and authoritative replacement snapshots reconstruct without truncation", async () => {
		const { frames, stream } = collect();
		await stream.configure(1);
		const text = '界😀\\"\n'.repeat(100000);
		const progress: AgentSessionEvent = {
			type: "tool_execution_update",
			toolCallId: "call",
			toolName: "read",
			args: { redundant: HUGE },
			partialResult: { content: [{ type: "text", text }], details: { value: 1 } },
		};
		stream.publish(progress);
		const message = assistant(text);
		stream.publish({ type: "message_update", message, assistantMessageEvent: { type: "start", partial: message } });
		await stream.drain();
		const starts = frames.filter((frame) => frame.type === "history_event_start");
		expect(starts).toHaveLength(2);
		const decoded = starts.map((start) =>
			JSON.parse(
				Buffer.concat(
					frames
						.filter(
							(frame) => frame.type === "history_event_chunk" && frame.eventId === start.eventId && !frame.final,
						)
						.map((frame) =>
							Buffer.from(
								(frame as Extract<RpcHistoryStreamEvent, { type: "history_event_chunk" }>).data,
								"base64",
							),
						),
				).toString("utf8"),
			),
		);
		expect(decoded[0].partialResult).toEqual(progress.partialResult);
		expect(decoded[0]).not.toHaveProperty("args");
		expect(decoded[1].assistantMessageEvent.message).toEqual(message);
	});
	it("HP11 backpressure and rebind fence old fragments rather than resurrecting another session", async () => {
		const owner = source();
		const gate = pending();
		const frames: RpcHistoryStreamEvent[] = [];
		const stream = createHistoryStreamEmitter(owner, async (frame) => {
			frames.push(frame);
			if (frame.type === "history_event_start") await gate.promise;
		});
		const first = await stream.configure(1);
		stream.publishExternal({ type: "extension_event", payload: "x".repeat(800000) });
		await vi.waitFor(() => expect(frames.some((frame) => frame.type === "history_event_start")).toBe(true));
		expect(frames.some((frame) => frame.type === "history_event_chunk")).toBe(false);
		await stream.rebind({ ...owner, sessionId: "new-session" });
		gate.resolve();
		stream.publish({ type: "agent_start" });
		await stream.drain();
		const reset = frames.findLast((frame) => frame.type === "history_stream_reset")!;
		expect(reset.epoch).not.toBe(first.epoch);
		expect(frames.filter((frame) => frame.type === "history_event_chunk" && frame.epoch === first.epoch)).toEqual([]);
		expect(frames.at(-1)).toMatchObject({
			type: "history_event",
			epoch: reset.epoch,
			event: { type: "agent_start" },
		});
	});
	it("HP4 pending event overflow and encoding failures are visible, never legacy fallback/provider rerun", async () => {
		const { owner, frames, stream } = collect();
		await stream.configure(1);
		const gate = pending();
		owner.waitForWrites = () => gate.promise;
		for (let i = 0; i < 40; i++) stream.publish({ type: "agent_start" });
		gate.resolve();
		await stream.drain();
		expect(frames.some((frame) => frame.type === "history_stream_error" && frame.code === "STREAM_LIMIT")).toBe(true);
		expect(stream.enabled()).toBe(true);
		const before = frames.length;
		stream.publish({ type: "message_end", message: assistant(HUGE) });
		await stream.drain();
		expect(frames).toHaveLength(before);
		owner.waitForWrites = async () => {};
		await stream.configure(1);
		stream.publishExternal({ type: "extension_event", payload: 1n });
		await stream.drain();
		expect(frames.at(-1)).toMatchObject({ type: "history_stream_error", code: "ENCODING_ERROR" });
	});
	it("HP4/HP11 checks commit bounds before allocating slices and makes normalization/rebind failures visible", async () => {
		const { owner, stream, frames } = collect();
		await stream.configure(1);
		owner.committedPosition = () => 5000;
		owner.committedSince = vi.fn(() => {
			throw new Error("must not allocate a huge delta");
		});
		stream.publish({ type: "agent_start" });
		await stream.drain();
		expect(owner.committedSince).not.toHaveBeenCalled();
		expect(frames.at(-1)).toMatchObject({ type: "history_stream_error", code: "STREAM_LIMIT" });
		owner.committedPosition = () => 0;
		owner.committedSince = () => ({ position: 0, entries: [] });
		await stream.configure(1);
		const message = assistant("");
		expect(() =>
			stream.publish({
				type: "message_update",
				message,
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 99, partial: message },
			}),
		).not.toThrow();
		expect(frames.at(-1)).toMatchObject({ type: "history_stream_error", code: "ENCODING_ERROR" });
		await stream.configure(1);
		await stream.rebind({ ...owner, sessionPath: undefined });
		expect(frames.at(-1)).toMatchObject({ type: "history_stream_error", code: "STORAGE_ERROR" });
		expect(stream.enabled()).toBe(true);
		await stream.configure(0);
		expect(stream.enabled()).toBe(false);
	});

	it("HP11 shutdown sealing drains accepted frames but never switches future callbacks back to legacy", async () => {
		const { owner, frames, stream } = collect();
		await stream.configure(1);
		const gate = pending();
		owner.waitForWrites = () => gate.promise;
		stream.publish({ type: "agent_start" });
		stream.seal();
		stream.publish({ type: "message_end", message: assistant(HUGE) });
		gate.resolve();
		await stream.drain();
		expect(frames.filter((frame) => frame.type === "history_event")).toHaveLength(1);
		expect(stream.enabled()).toBe(true);
		stream.stop();
		expect(stream.enabled()).toBe(true);
	});

	it("HP9 storage failures do not claim committed content, and pending setup entries have an explicit marker", async () => {
		const { owner, frames, stream } = collect();
		await stream.configure(1);
		owner.waitForWrites = async () => {
			throw new Error("fixture write failure");
		};
		stream.publish({ type: "agent_start" });
		await stream.drain();
		expect(frames.at(-1)).toMatchObject({ type: "history_stream_error", code: "STORAGE_ERROR" });
		owner.waitForWrites = async () => {};
		owner.sessionPath = join(root, "not-created.sqlite");
		await stream.configure(1);
		stream.publish({
			type: "entry_appended",
			entry: {
				type: "custom",
				id: "setup",
				parentId: null,
				timestamp: "2026-11-01",
				customType: "setup",
				data: { giant: HUGE },
			},
		});
		await stream.drain();
		expect(frames.at(-1)).toMatchObject({ type: "history_entry_pending", entryId: "setup" });
		owner.sessionPath = join(root, "source.sqlite");
		await stream.configure(1);
		stream.publish({
			type: "entry_appended",
			entry: { type: "custom", id: "unknown-commit", parentId: null, timestamp: "2026-11-01", customType: "setup" },
		});
		await stream.drain();
		expect(frames.at(-1)).toMatchObject({ type: "history_entry_pending", entryId: "unknown-commit" });
		stream.publish({
			type: "entry_appended",
			entry: { type: "custom", id: HUGE, parentId: null, timestamp: "2026-11-01", customType: "invalid-identity" },
		});
		await stream.drain();
		expect(frames.at(-1)).toMatchObject({ type: "history_stream_error", code: "STREAM_LIMIT" });
	});
	it("HC6/HP8 persisted locator resolves through complete target history on a real read-only storage path", async () => {
		const manager = SessionManager.create(root, join(root, "sessions"));
		manager.appendMessage({ role: "user", content: "question", timestamp: 1 });
		await manager.flush();
		const owner: HistoryStreamSource = {
			sessionPath: manager.getSessionFile(),
			sessionId: manager.getSessionId(),
			leafId: () => manager.getLeafId(),
			waitForWrites: () => manager.waitForWrites(),
			committedPosition: () => manager.getCommittedEntryCount(),
			hasCommittedEntry: (entryId) => manager.hasCommittedEntry(entryId),
			committedSince: (position) => manager.getCommittedEntriesSince(position),
		};
		const { stream, frames } = collect({ ...owner, entries: [] });
		await stream.configure(1);
		const id = manager.appendCustomEntry("large", { text: "x".repeat(1024 * 1024) });
		stream.publish({ type: "entry_appended", entry: manager.getEntry(id)! });
		await stream.drain();
		const ref = frames.find((frame) => frame.type === "history_entry_appended" && frame.entryId === id)! as Extract<
			RpcHistoryStreamEvent,
			{ type: "history_entry_appended" }
		>;
		const result = readHistoryCommand({ mode: "control", session: undefined } as GuiContext, {
			type: ref.ref.command,
			sessionPath: ref.ref.sessionPath,
			aroundEntryId: ref.ref.aroundEntryId,
			view: "target",
			maxBytes: 2 * 1024 * 1024,
		});
		expect(result).toMatchObject({ ok: true });
		if (!result.ok) throw new Error(result.error.message);
		expect(result.entries).toHaveLength(2);
		expect(result.entries.find((entry) => entry.id === id)?.entry.data).toEqual({ text: "x".repeat(1024 * 1024) });
		expect(JSON.stringify(frames).length).toBeLessThan(4096);
	});
	it("HP9 read-only persistence observation never consumes a write failure from the original session owner", async () => {
		const store = DurableSessionStore.inMemory();
		const failure = new Error("isolated write failure");
		const plan: EntryPlan = {
			source: { type: "custom", id: "failed", parentId: null, timestamp: "2026-11-01", customType: "failure" },
			kind: "nek.custom",
			data: {},
		};
		Object.defineProperty(plan, "data", {
			enumerable: true,
			get() {
				throw failure;
			},
		});
		store.write([plan]);
		try {
			await expect(store.waitForWrites()).rejects.toBe(failure);
			await expect(store.waitForWrites()).rejects.toBe(failure);
			await expect(store.flush()).rejects.toBe(failure);
			await expect(store.waitForWrites()).resolves.toBeUndefined();
		} finally {
			await store.close();
		}
	});

	it("HP11 real durable faux run announces ordinary committed user/assistant entries under existing backpressure", async () => {
		const manager = SessionManager.create(root, join(root, "faux-sessions"));
		const harness = await createHarness({
			sessionManager: manager,
			responses: [fauxAssistantMessage("offline answer")],
		});
		const owner: HistoryStreamSource = {
			sessionPath: manager.getSessionFile(),
			sessionId: manager.getSessionId(),
			leafId: () => manager.getLeafId(),
			waitForWrites: () => manager.waitForWrites(),
			committedPosition: () => manager.getCommittedEntryCount(),
			hasCommittedEntry: (entryId) => manager.hasCommittedEntry(entryId),
			committedSince: (position) => manager.getCommittedEntriesSince(position),
		};
		const { stream, frames } = collect({ ...owner, entries: [] });
		await stream.configure(1);
		const unsub = harness.session.subscribe((event) => stream.publish(event));
		const unpressure = harness.session.agent.subscribe(async () => {
			await stream.drain();
		});
		try {
			await harness.session.prompt("offline question");
			await harness.session.waitForIdle();
			await stream.drain();
			expect(frames.some((frame) => frame.type === "history_stream_error")).toBe(false);
			const ids = new Set(
				frames.filter((frame) => frame.type === "history_entry_appended").map((frame) => frame.entryId),
			);
			const messages = manager
				.getBranch()
				.filter((entry) => entry.type === "message" && ["user", "assistant"].includes(entry.message.role));
			expect(messages.length).toBeGreaterThanOrEqual(2);
			expect(messages.every((entry) => ids.has(entry.id))).toBe(true);
			expect(frames.some((frame) => frame.type === "history_event" && frame.event.type === "message_update")).toBe(
				true,
			);
		} finally {
			unsub();
			unpressure();
			stream.stop();
			await harness.session.dispose();
			harness.cleanup();
		}
	});

	it("HP4 encoder matches JSON across UTF8/surrogate/escape and ordinary JSON value boundaries", () => {
		const value = {
			text: `${'界😀\\"\n'.repeat(12000)}\ud800`,
			array: [undefined, null, NaN, true],
			missing: undefined,
			at: new Date("2026-11-01"),
		};
		const chunks = [...historyJsonChunks(value)];
		expect(chunks.every((chunk) => chunk.length <= 49152)).toBe(true);
		expect(Buffer.concat(chunks).toString("utf8")).toBe(JSON.stringify(value));
	});
});
