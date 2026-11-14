import { createHash } from "node:crypto";
import {
	appendFileSync,
	closeSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildGuiInfo } from "../src/cli/gui-info.ts";
import * as historyStorage from "../src/core/durable/history-storage.ts";
import { openHistoryStorage } from "../src/core/durable/history-storage.ts";
import { setSqliteDriver } from "../src/core/durable/sqlite.ts";
import type { SessionEntry, SessionHeader } from "../src/core/session-entries.ts";
import type { GuiContext } from "../src/modes/rpc/gui/context.ts";
import { GUI_COMMAND_TYPES, handleGuiCommand } from "../src/modes/rpc/gui/handlers.ts";
import { readHistoryCommand } from "../src/modes/rpc/gui/history.ts";
import type {
	RpcHistoryCommand,
	RpcHistoryCommandResult,
	RpcHistoryContent,
	RpcHistoryTurnPage,
} from "../src/modes/rpc/gui/history-protocol.ts";
import { NEK_CONTROL_COMMANDS } from "../src/modes/rpc/gui/protocol.ts";

const TMP = resolve(import.meta.dirname, "../../../.tmp/history-tests");
const TIME = "2026-11-01T00:00:00.000Z";
let root: string;
let ctx: GuiContext;
let sql: { text: string; args: unknown[] }[];
const header = (id: string): SessionHeader => ({ type: "session", version: 3, id, timestamp: TIME, cwd: "/workspace" });
function rounds(count: number): SessionEntry[] {
	const entries: SessionEntry[] = [];
	for (let i = 0; i < count; i++) {
		entries.push({
			type: "message",
			id: `u${i}`,
			parentId: entries.at(-1)?.id ?? null,
			timestamp: TIME,
			message: { role: "user", content: `round ${i}`, timestamp: 1 },
		});
		entries.push({
			type: "message",
			id: `a${i}`,
			parentId: `u${i}`,
			timestamp: TIME,
			message: {
				role: "assistant",
				content: [{ type: "text", text: `answer ${i}` }],
				api: "openai-responses",
				provider: "mock",
				model: "offline",
				stopReason: "stop",
				timestamp: 1,
				usage: {
					input: 2,
					output: 3,
					cacheRead: 4,
					cacheWrite: 5,
					totalTokens: 14,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 },
				},
			},
		});
	}
	return entries;
}
/** One user, 1000 process entries, then the actual final reply. */
function longRound(index = 0, body = "result 界😀"): SessionEntry[] {
	const [user, answer] = rounds(index + 1).slice(-2);
	const entries = [user];
	for (let i = 0; i < 1000; i++)
		entries.push({
			type: "message",
			id: `t${index}-${i}`,
			parentId: entries.at(-1)!.id,
			timestamp: TIME,
			message: {
				role: "toolResult",
				toolCallId: `call${index}-${i}`,
				toolName: "read",
				isError: false,
				timestamp: 1,
				content: [{ type: "text", text: body }],
			},
		});
	entries.push({ ...answer, parentId: entries.at(-1)!.id });
	return entries;
}
function sqlite(name: string, entries: SessionEntry[]): string {
	const path = join(root, `${name}.sqlite`);
	const db = new DatabaseSync(path);
	db.exec(
		"CREATE TABLE durable_schema(singleton INTEGER PRIMARY KEY,version INTEGER); INSERT INTO durable_schema VALUES(1,1); CREATE TABLE durable_metadata(singleton INTEGER PRIMARY KEY,next_seq INTEGER); INSERT INTO durable_metadata VALUES(1,10000); CREATE TABLE conversations(id INTEGER PRIMARY KEY,record TEXT); INSERT INTO conversations VALUES(1,'{\"id\":1}'); CREATE TABLE entries(id INTEGER PRIMARY KEY,conversation_id INTEGER,commit_seq INTEGER,record TEXT); CREATE INDEX entries_by_conversation ON entries(conversation_id,id DESC)",
	);
	db.exec("BEGIN");
	const insert = db.prepare("INSERT INTO entries VALUES(?,?,?,?)");
	insert.run(
		2,
		1,
		1,
		JSON.stringify({ id: 2, conversationId: 1, kind: "nek.session", data: { header: header(name) } }),
	);
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i];
		const id = i + 3;
		const kind =
			entry.type === "message"
				? (({ user: "pi.user", assistant: "pi.assistant", toolResult: "pi.tool-result" } as Record<string, string>)[
						entry.message.role
					] ?? "nek.message")
				: `nek.${entry.type}`;
		const own = entry.type === "message" && ["user", "assistant", "toolResult"].includes(entry.message.role);
		const stored = own ? { ...entry, message: undefined } : entry;
		insert.run(
			id,
			1,
			id,
			JSON.stringify({
				id,
				conversationId: 1,
				kind,
				data: { entry: stored },
				...(own ? { model: [entry.message] } : {}),
			}),
		);
	}
	db.exec("COMMIT");
	db.close();
	return path;
}
function appendHistory(path: string, entries: SessionEntry[]): void {
	if (path.endsWith(".jsonl")) {
		for (const entry of entries) appendFileSync(path, `${JSON.stringify(entry)}\n`);
		return;
	}
	const db = new DatabaseSync(path);
	let id = Number((db.prepare("SELECT max(id) AS id FROM entries").get() as { id: number }).id);
	const insert = db.prepare("INSERT INTO entries VALUES(?,?,?,?)");
	for (const entry of entries) {
		id++;
		insert.run(id, 1, id, JSON.stringify({ id, conversationId: 1, kind: "nek.message", data: { entry } }));
	}
	db.close();
}
function jsonl(name: string, entries: SessionEntry[]): string {
	const path = join(root, `${name}.jsonl`);
	writeFileSync(path, `${JSON.stringify(header(name))}\n`);
	for (const entry of entries) appendFileSync(path, `${JSON.stringify(entry)}\n`);
	return path;
}
function read<C extends RpcHistoryCommand>(command: C): Extract<RpcHistoryCommandResult<C>, { ok: true }> {
	const result = readHistoryCommand(ctx, command);
	expect(result, JSON.stringify(result.ok ? "ok" : result)).toMatchObject({ ok: true });
	return result as Extract<RpcHistoryCommandResult<C>, { ok: true }>;
}
function error(command: RpcHistoryCommand, code: string): void {
	expect(readHistoryCommand(ctx, command)).toMatchObject({ ok: false, error: { code } });
}
function hash(path: string): string {
	const fd = openSync(path, "r");
	const digest = createHash("sha256");
	const buffer = Buffer.alloc(65536);
	try {
		for (;;) {
			const count = readSync(fd, buffer);
			if (!count) break;
			digest.update(buffer.subarray(0, count));
		}
	} finally {
		closeSync(fd);
	}
	return digest.digest("hex");
}
beforeEach(() => {
	mkdirSync(TMP, { recursive: true });
	root = mkdtempSync(join(TMP, "case-"));
	ctx = { mode: "control", cwd: root, session: undefined } as GuiContext;
	sql = [];
	setSqliteDriver({
		open: (path, options) => {
			const db = new DatabaseSync(path, { readOnly: options.readOnly });
			return {
				close: () => db.close(),
				exec: (text) => db.exec(text),
				prepare: (text) => {
					const stmt = db.prepare(text);
					return {
						get: (...args) => {
							sql.push({ text, args });
							return stmt.get(...args);
						},
						all: (...args) => {
							sql.push({ text, args });
							return stmt.all(...args);
						},
						run: (...args) => stmt.run(...args),
					};
				},
			};
		},
	});
});
afterEach(() => {
	setSqliteDriver({ open: (path, options) => new DatabaseSync(path, { readOnly: options.readOnly }) });
	rmSync(root, { recursive: true, force: true });
});

describe.each(["sqlite", "jsonl"] as const)("bounded GUI history %s", (format) => {
	const fixture = (name: string, entries: SessionEntry[]) =>
		format === "sqlite" ? sqlite(name, entries) : jsonl(name, entries);
	it("HP1 latest 20 then 20 then 20 then 10; 1000-round first payload remains bounded", () => {
		const sessionPath = fixture("seventy", rounds(70));
		let page = read({ type: "read_history_page", sessionPath });
		const lengths = [page.turns.length];
		expect(page.turns[0].id).toBe("turn:u50");
		if (format === "sqlite")
			expect(
				sql
					.filter((call) => call.text.startsWith("SELECT substr(CAST(record AS BLOB)"))
					.every((call) => Number(call.args[2]) >= 103),
			).toBe(true);
		while (page.olderCursor) {
			page = read({ type: "read_history_page", sessionPath, beforeCursor: page.olderCursor });
			lengths.push(page.turns.length);
		}
		expect(lengths).toEqual([20, 20, 20, 10]);
		const large = read({ type: "read_history_page", sessionPath: fixture("thousand", rounds(1000)) });
		expect(large.turns).toHaveLength(20);
		expect(Buffer.byteLength(JSON.stringify(large))).toBeLessThan(65536);
		if (format === "sqlite") {
			expect(sql.some((call) => /SELECT record FROM entries/iu.test(call.text))).toBe(false);
			const bodyReads = sql.filter((call) => call.text.startsWith("SELECT substr(CAST(record AS BLOB)"));
			expect(bodyReads.every((call) => Number(call.args[1]) <= 65536)).toBe(true);
		}
	});
	it("HP3 huge text/image/tool fields reconstruct exactly; HP4 counts full UTF8 envelope", () => {
		const entries = rounds(1);
		const original = `${'界\\"\n😀'.repeat(2000)}END`;
		entries[0] = { ...entries[0], type: "message", message: { role: "user", content: original, timestamp: 1 } };
		const sessionPath = fixture("giant", entries);
		const command = { type: "read_history_page", sessionPath, maxBytes: 65536, id: "utf8-界" } as const;
		const page = read(command);
		const lazy = page.entries[0].omissions.find((item) => item.pointer === "/message/content")!;
		expect(lazy).toBeDefined();
		expect(page.turns[0].header.id).toBe("u0");
		const chunks: Buffer[] = [];
		let offset: number | undefined = 0;
		do {
			const chunk: RpcHistoryContent = read({
				type: "read_history_content",
				sessionPath,
				ref: lazy.ref,
				offset,
				limit: 3001,
				maxBytes: 65536,
			});
			chunks.push(Buffer.from(chunk.data, "base64"));
			offset = chunk.nextOffset;
		} while (offset !== undefined);
		expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toBe(original);
		expect(
			Buffer.byteLength(
				JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: page }),
			),
		).toBeLessThanOrEqual(command.maxBytes);
		error({ type: "read_history_page", sessionPath, maxBytes: 65535 }, "INVALID_REQUEST");
		error({ type: "read_history_page", sessionPath, turnLimit: 21 }, "INVALID_REQUEST");
	});
	it("HP3/HP4 within-turn continuation advances through many process entries", () => {
		const entries = rounds(1);
		for (let i = 0; i < 600; i++)
			entries.push({
				type: "message",
				id: `t${i}`,
				parentId: entries.at(-1)!.id,
				timestamp: TIME,
				message: {
					role: "toolResult",
					toolCallId: `call${i}`,
					toolName: "read",
					isError: false,
					timestamp: 1,
					content: [{ type: "text", text: "result" }],
				},
			});
		const sessionPath = fixture("process", entries);
		const page = read({ type: "read_history_page", sessionPath, maxBytes: 65536 });
		expect(page.turns).toHaveLength(1);
		const ids = page.entries.map((entry) => entry.id);
		let cursor = page.turns[0].continuationCursor;
		expect(cursor).toBeDefined();
		while (cursor) {
			const turn = read({ type: "read_history_turn", sessionPath, turnId: "turn:u0", cursor, maxBytes: 65536 });
			expect(turn.turn.header.id).toBe("u0");
			expect(turn.entries.length).toBeGreaterThan(0);
			ids.push(...turn.entries.map((entry) => entry.id));
			cursor = turn.continuationCursor;
		}
		expect([...new Set(ids)].sort()).toEqual(entries.map((entry) => entry.id).sort());
		expect(ids.filter((id) => id !== "u0")).toHaveLength(entries.length - 1);
	});
	it("HP5/HP6 stable directory, around, refetch, foreign/corrupt cursor and branch invalidation", () => {
		const entries = rounds(70);
		const sessionPath = fixture("branch", entries);
		const page = read({ type: "read_history_page", sessionPath });
		const around = read({ type: "read_history_page", sessionPath, aroundEntryId: "a55" });
		expect(around.entries.find((entry) => entry.id === "a55")?.position).toBe(
			page.entries.find((entry) => entry.id === "a55")?.position,
		);
		const target = read({ type: "read_history_directory", sessionPath, aroundEntryId: "u55", limit: 1 });
		expect(target.items[0]).toMatchObject({ entryId: "u55", turnId: "turn:u55", position: 110 });
		expect(
			read({ type: "read_history_directory", sessionPath, aroundEntryId: "a55", limit: 1 }).items[0].entryId,
		).toBe("u55");
		error({ type: "read_history_page", sessionPath, beforeCursor: "bad" }, "INVALID_CURSOR");
		error(
			{ type: "read_history_page", sessionPath: fixture("foreign", entries), beforeCursor: page.olderCursor },
			"FOREIGN_CURSOR",
		);
		if (format === "jsonl") {
			const appended = rounds(1)[0];
			appended.id = "append";
			appended.parentId = entries.at(-1)!.id;
			appendFileSync(sessionPath, `${JSON.stringify(appended)}\n`);
			expect(read({ type: "read_history_page", sessionPath, beforeCursor: page.olderCursor }).turns).toHaveLength(
				20,
			);
			writeFileSync(sessionPath, `${JSON.stringify(header("branch"))}\n${JSON.stringify(entries[0])}\n`);
		} else {
			const db = new DatabaseSync(sessionPath);
			db.exec("DELETE FROM entries WHERE id>3");
			db.close();
		}
		error({ type: "read_history_page", sessionPath, beforeCursor: page.olderCursor }, "STALE_CURSOR");
	});
	it("HP7 independent cumulative usage/selection and HP9 persisted subagent identity preserves spawn", () => {
		const entries = rounds(70);
		const fact = {
			id: "child-id",
			type: "explorer",
			description: "inspect",
			background: false,
			startedAt: 1,
			status: "running",
			sessionFile: join(root, "child.sqlite"),
			finalText: "must not leak",
		};
		for (const [index, status] of [
			[3, "running"],
			[9, "completed"],
		] as const)
			entries.splice(index, 0, {
				type: "message",
				id: `spawn-${index}`,
				parentId: null,
				timestamp: TIME,
				message: {
					role: "toolResult",
					toolCallId: "call",
					toolName: index === 3 ? "subagent" : "await",
					content: [],
					isError: false,
					timestamp: 1,
					details: index === 3 ? { subagent: { ...fact, status } } : { subagents: [{ ...fact, status }] },
				},
			});
		for (let i = 0; i < entries.length; i++) entries[i].parentId = entries[i - 1]?.id ?? null;
		const sessionPath = fixture("parent", entries);
		const meta = read({ type: "read_session_metadata", sessionPath });
		expect(meta.usage).toMatchObject({ input: 140, output: 210, cacheRead: 280, cacheWrite: 350, totalTokens: 980 });
		expect(meta.selection.model).toEqual({ provider: "mock", modelId: "offline" });
		expect(meta.children.count).toBe(1);
		expect(meta).not.toHaveProperty("entries");
		const child = read({ type: "read_history_subagent", sessionPath, subagentId: "child-id" });
		expect(child.subagent).toMatchObject({ spawnEntryId: "spawn-3", status: "completed", detached: true });
		expect(child.subagent).not.toHaveProperty("finalText");
		error({ type: "read_history_subagent", sessionPath, subagentId: "unrelated" }, "NOT_FOUND");
	});
	it("HP13 latest 20 long rounds include every real header and final reply without reading prefixes", () => {
		const entries = Array.from({ length: 20 }, (_, index) => longRound(index)).flat();
		for (let i = 0; i < entries.length; i++) entries[i].parentId = entries[i - 1]?.id ?? null;
		const sessionPath = fixture("twenty-long", entries);
		const page = read({ type: "read_history_page", sessionPath });
		expect(page.turns).toHaveLength(20);
		expect(page.entries.length).toBeLessThanOrEqual(256);
		for (let i = 0; i < 20; i++) {
			expect(page.turns[i].header.id).toBe(`u${i}`);
			expect(page.entries.find((entry) => entry.id === `a${i}`)?.entry.message).toMatchObject({
				content: [{ type: "text", text: `answer ${i}` }],
			});
			expect(page.turns[i].continuationCursor).toBeDefined();
		}
		expect(page.entries.map((entry) => entry.position)).toEqual(
			page.entries.map((entry) => entry.position).sort((a, b) => a - b),
		);
		if (format === "sqlite") {
			const bodies = sql.filter((call) => call.text.startsWith("SELECT substr(CAST(record AS BLOB)"));
			expect(bodies.length).toBeGreaterThan(0);
			// SQLite row = branch position + 3. Only headers and tail process entries are hydrated.
			expect(
				bodies.every((call) => {
					const position = Number(call.args[2]) - 3;
					return position % 1002 === 0 || position % 1002 > 740;
				}),
			).toBe(true);
		}
		const around = read({ type: "read_history_page", sessionPath, aroundEntryId: "t10-500", maxBytes: 65536 });
		expect(around.entries.some((entry) => entry.id === "t10-500")).toBe(true);
		for (let i = 0; i < 20; i++) {
			expect(around.turns[i].header.id).toBe(`u${i}`);
			if (i !== 10) expect(around.entries.some((entry) => entry.id === `a${i}`)).toBe(true);
		}
	}, 120000);
	it("HP13 a 1000-tool-call turn opens its final answer with bounded body reads and original anchors", () => {
		const entries = longRound();
		const expanded: SessionEntry[] = [entries[0]];
		for (const result of entries.slice(1, -1)) {
			if (result.type !== "message" || result.message.role !== "toolResult") throw new Error("fixture");
			const call: SessionEntry = {
				...rounds(1)[1],
				id: `call-${result.id}`,
				parentId: expanded.at(-1)!.id,
			};
			if (call.type !== "message" || call.message.role !== "assistant") throw new Error("fixture");
			call.message.content = [
				{ type: "toolCall", id: result.message.toolCallId, name: "read", arguments: { path: "file.ts" } },
			];
			expanded.push(call, { ...result, parentId: call.id });
		}
		expanded.push({ ...entries.at(-1)!, parentId: expanded.at(-1)!.id });
		const sessionPath = fixture("thousand-calls", expanded);
		const page = read({ type: "read_history_page", sessionPath, maxBytes: 65536 });
		expect(page.entries.at(-1)).toMatchObject({ id: "a0", position: 2001 });
		expect(page.entries.at(-1)!.entry.message).toMatchObject({ content: [{ type: "text", text: "answer 0" }] });
		expect(page.entries.find((entry) => entry.id === "t0-999")?.toolCallOrigin).toMatchObject({
			entryId: "call-t0-999",
			position: 1999,
			toolCallId: "call0-999",
		});
		if (format === "sqlite") {
			const bodies = sql.filter((call) => call.text.startsWith("SELECT substr(CAST(record AS BLOB)"));
			expect(bodies.length).toBeLessThan(600);
			expect(bodies.every((call) => Number(call.args[2]) === 3 || Number(call.args[2]) > 1700)).toBe(true);
		}
	});
	it("HP14 around a deep entry hydrates that entry and leaves oversized fields explicitly readable", () => {
		const entries = longRound();
		const target = entries[501];
		if (target.type !== "message" || target.message.role !== "toolResult") throw new Error("fixture");
		target.message.content = [{ type: "text", text: "deep 界😀".repeat(2000) }];
		const sessionPath = fixture("deep", entries);
		const page = read({ type: "read_history_page", sessionPath, aroundEntryId: target.id, maxBytes: 65536 });
		const loaded = page.entries.find((entry) => entry.id === target.id);
		expect(loaded).toMatchObject({ id: target.id, position: 501, turnId: "turn:u0", role: "toolResult" });
		expect(loaded!.entry.message).toMatchObject({ role: "toolResult", content: null });
		const lazy = loaded!.omissions.find((item) => item.pointer === "/message/content")!;
		expect(lazy).toBeDefined();
		const chunk = read({ type: "read_history_content", sessionPath, ref: lazy.ref, limit: 256 * 1024 });
		expect(JSON.parse(Buffer.from(chunk.data, "base64").toString("utf8"))).toEqual(target.message.content);
		expect(page.turns[0].header.id).toBe("u0");
	});
	it.each([undefined, "t0-500"])(
		"HP15 continuation covers both omitted sides once with no cursor loop (%s)",
		(aroundEntryId) => {
			const entries = longRound(0, "界😀".repeat(60));
			const sessionPath = fixture(`itinerary-${aroundEntryId ?? "tail"}`, entries);
			const command = {
				type: "read_history_page",
				sessionPath,
				aroundEntryId,
				id: "页-😀",
				maxBytes: 65536,
			} as const;
			const page = read(command);
			const ids = page.entries.map((entry) => entry.id);
			let cursor = page.turns[0].continuationCursor;
			expect(cursor).toBeDefined();
			const target = aroundEntryId ? entries.findIndex((entry) => entry.id === aroundEntryId) : entries.length - 1;
			expect(page.entries.some((entry) => entry.position === target)).toBe(true);
			if (aroundEntryId) {
				expect(page.entries.some((entry) => entry.position > 0 && entry.position < target)).toBe(true);
				expect(page.entries.some((entry) => entry.position > target)).toBe(true);
			}
			const seen = new Set<string>();
			while (cursor) {
				expect(seen.has(cursor)).toBe(false);
				seen.add(cursor);
				expect(seen.size).toBeLessThan(100);
				const request = {
					type: "read_history_turn",
					sessionPath,
					turnId: "turn:u0",
					cursor,
					id: "续-😀",
					maxBytes: 65536,
				} as const;
				const turn = read(request);
				expect(turn.turn.header.id).toBe("u0");
				expect(turn.entries.length).toBeGreaterThan(0);
				expect(turn.entries.length).toBeLessThanOrEqual(256);
				expect(turn.entries.map((entry) => entry.position)).toEqual(
					turn.entries.map((entry) => entry.position).sort((a, b) => a - b),
				);
				expect(
					Buffer.byteLength(
						JSON.stringify({
							id: request.id,
							type: "response",
							command: request.type,
							success: true,
							data: turn,
						}),
					),
				).toBeLessThanOrEqual(request.maxBytes);
				ids.push(...turn.entries.map((entry) => entry.id));
				expect(turn.hasMore).toBe(turn.continuationCursor !== undefined);
				cursor = turn.continuationCursor;
			}
			const withoutHeader = ids.filter((id) => id !== "u0");
			expect(withoutHeader.length).toBe(new Set(withoutHeader).size);
			expect([...new Set(ids)].sort()).toEqual(entries.map((entry) => entry.id).sort());
			expect(
				Buffer.byteLength(
					JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data: page }),
				),
			).toBeLessThanOrEqual(command.maxBytes);
		},
	);
	it("HP15 malformed, foreign, wrong-turn, wrong-kind and stale continuations fail explicitly", () => {
		const entries = [...longRound(), ...rounds(1).map((entry) => ({ ...entry, id: `${entry.id}-next` }))];
		for (let i = 0; i < entries.length; i++) entries[i].parentId = entries[i - 1]?.id ?? null;
		const sessionPath = fixture("cursor-owner", entries);
		const page = read({ type: "read_history_page", sessionPath, turnLimit: 1, aroundEntryId: "t0-500" });
		const cursor = page.turns[0].continuationCursor!;
		const request = { type: "read_history_turn", sessionPath, turnId: "turn:u0", cursor } as const;
		expect(read(request)).toEqual(read(request));
		error({ ...request, cursor: `${cursor}x` }, "INVALID_CURSOR");
		error({ ...request, cursor: "" }, "INVALID_CURSOR");
		error({ ...request, sessionPath: fixture("cursor-foreign", entries) }, "FOREIGN_CURSOR");
		error({ ...request, turnId: "turn:u0-next" }, "INVALID_CURSOR");
		error({ ...request, cursor: page.newerCursor }, "INVALID_CURSOR");
		if (format === "sqlite") {
			const db = new DatabaseSync(sessionPath);
			db.exec("DELETE FROM entries WHERE id>4");
			db.close();
		} else writeFileSync(sessionPath, `${JSON.stringify(header("cursor-owner"))}\n${JSON.stringify(entries[0])}\n`);
		error(request, "STALE_CURSOR");
	});
	it("HP16 summary refreshes latest boundaries without body reads, projections or content refs", () => {
		const entries = longRound(0, "huge 界😀".repeat(2000));
		const sessionPath = fixture("summary-growth", entries);
		const spanSpy = vi.spyOn(historyStorage, "historyEntrySpans");
		try {
			const summary = read({ type: "read_history_page", sessionPath, view: "summary" } as const);
			expect(summary).toMatchObject({ view: "summary", totalTurns: 1, totalEntries: 1002 });
			expect(summary).not.toHaveProperty("entries");
			expect(summary.turns[0]).toMatchObject({
				id: "turn:u0",
				userEntryId: "u0",
				entryCount: 1002,
				headerEntryId: "u0",
				headerPosition: 0,
			});
			expect(summary.turns[0]).not.toHaveProperty("header");
			expect(JSON.stringify(summary)).not.toContain("omissions");
			expect(JSON.stringify(summary)).not.toContain("huge");
			expect(spanSpy).not.toHaveBeenCalled();
			if (format === "sqlite")
				expect(sql.some((call) => call.text.startsWith("SELECT substr(CAST(record AS BLOB)"))).toBe(false);
			const page = read({ type: "read_history_page", sessionPath });
			expect(page).toMatchObject({
				view: "entries",
				branchRevision: summary.branchRevision,
				leafId: summary.leafId,
				watermark: summary.watermark,
			});
			const all = read({
				type: "read_history_turn",
				sessionPath,
				turnId: "turn:u0",
				cursor: summary.turns[0].continuationCursor,
			});
			expect(all.entries[0].id).toBe("u0");
			error(
				{ type: "read_history_page", sessionPath, view: "bad" } as unknown as RpcHistoryCommand,
				"INVALID_REQUEST",
			);
		} finally {
			spanSpy.mockRestore();
		}
	}, 120000);
	it("HP15/HP16 long live append refreshes metadata while old turn itineraries remain bounded to their snapshot", () => {
		const entries = longRound();
		const sessionPath = fixture("live-boundaries", entries);
		const initial = read({ type: "read_history_page", sessionPath, view: "summary" });
		const growth = longRound(1)
			.slice(1)
			.map((entry) => ({ ...entry }));
		for (let i = 0; i < growth.length; i++) growth[i].parentId = growth[i - 1]?.id ?? entries.at(-1)!.id;
		appendHistory(sessionPath, growth);
		sql = [];
		const summary = read({ type: "read_history_page", sessionPath, view: "summary" });
		expect(summary).toMatchObject({ view: "summary", totalEntries: 2003, totalTurns: 1, leafId: "a1" });
		expect(summary.turns[0].entryCount).toBe(2003);
		expect(summary.branchRevision).not.toBe(initial.branchRevision);
		if (format === "sqlite")
			expect(sql.some((call) => call.text.startsWith("SELECT substr(CAST(record AS BLOB)"))).toBe(false);
		let cursor: string | undefined = initial.turns[0].continuationCursor;
		const ids: string[] = [];
		while (cursor) {
			const part: RpcHistoryTurnPage = read({ type: "read_history_turn", sessionPath, turnId: "turn:u0", cursor });
			ids.push(...part.entries.map((entry) => entry.id));
			cursor = part.continuationCursor;
		}
		expect(ids).toEqual(entries.map((entry) => entry.id));
		const latest = read({ type: "read_history_page", sessionPath });
		expect(latest.entries.at(-1)?.id).toBe("a1");
		expect(latest.branchRevision).toBe(summary.branchRevision);
	});
	it("HP16 summary page navigation preserves 20-round boundaries, source identity and default entry callers", () => {
		const sessionPath = fixture("summary-pages", rounds(70));
		let summary = read({ type: "read_history_page", sessionPath, view: "summary" });
		const counts = [summary.turns.length];
		expect(summary.turns[0].id).toBe("turn:u50");
		const first = summary;
		while (summary.olderCursor) {
			summary = read({ type: "read_history_page", sessionPath, view: "summary", beforeCursor: summary.olderCursor });
			counts.push(summary.turns.length);
		}
		expect(counts).toEqual([20, 20, 20, 10]);
		const newer = read({ type: "read_history_page", sessionPath, view: "summary", afterCursor: summary.newerCursor });
		expect(newer.turns[0].id).toBe("turn:u10");
		const entries = read({ type: "read_history_page", sessionPath, view: "entries" });
		expect(entries.turns.map((turn) => turn.id)).toEqual(first.turns.map((turn) => turn.id));
		expect(entries.olderCursor).toBe(first.olderCursor);
		expect(entries.entries.length).toBeGreaterThan(0);
		const around = read({ type: "read_history_page", sessionPath, view: "summary", aroundEntryId: "a35" });
		expect(around.turns.some((turn) => turn.id === "turn:u35")).toBe(true);
		error({ type: "read_history_page", sessionPath, view: "summary", beforeCursor: "bad" }, "INVALID_CURSOR");
	});
	it("HP8 bounded request-local storage index; HP10 directory/search streams oversized content", () => {
		const entries = rounds(70);
		entries[0] = {
			...entries[0],
			type: "message",
			message: { role: "user", content: `${"x".repeat(90000)}needle-at-end`, timestamp: 1 },
		};
		const sessionPath = fixture("search", entries);
		const directory = read({ type: "read_history_directory", sessionPath, limit: 20 });
		expect(directory.items).toHaveLength(20);
		expect(directory.hasMore).toBe(true);
		expect(directory.items[0].preview.length).toBeLessThanOrEqual(256);
		const search = read({ type: "read_history_directory", sessionPath, query: "needle-at-end", limit: 1 });
		expect(search.items[0].entryId).toBe("u0");
		const index = openHistoryStorage(sessionPath);
		try {
			expect(JSON.stringify(index.entries).length).toBeLessThan(90000);
		} finally {
			index.close();
		}
	});
});

it("HP2 >64MiB SQLite and legacy JSONL stay read-only and first-page bodies stay bounded", () => {
	const entries = rounds(71);
	entries[0] = {
		...entries[0],
		type: "message",
		message: { role: "user", content: "x".repeat(65 * 1024 * 1024), timestamp: 1 },
	};
	for (const sessionPath of [sqlite("huge", entries), jsonl("huge-legacy", entries)]) {
		expect(statSync(sessionPath).size).toBeGreaterThan(64 * 1024 * 1024);
		const before = hash(sessionPath);
		const started = performance.now();
		const meta = read({ type: "read_session_metadata", sessionPath });
		const page = read({ type: "read_history_page", sessionPath });
		expect(meta.totalTurns).toBe(71);
		expect(page.turns).toHaveLength(20);
		expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(65536);
		expect(hash(sessionPath)).toBe(before);
		console.log(
			JSON.stringify({
				case: "HP2",
				format: sessionPath.endsWith("sqlite") ? "sqlite" : "jsonl",
				elapsedMs: Math.round(performance.now() - started),
				sourceBytes: statSync(sessionPath).size,
				payloadBytes: Buffer.byteLength(JSON.stringify(page)),
			}),
		);
	}
}, 120000);

it("HP3 huge image/tool arrays and derived custom entries have exact lazy sources", () => {
	const entries = rounds(1);
	const blocks = Array.from({ length: 3000 }, (_, i) => ({ type: "text" as const, text: `tool ${i} 界` }));
	entries.push({
		type: "message",
		id: "large-tool",
		parentId: "a0",
		timestamp: TIME,
		message: {
			role: "toolResult",
			toolCallId: "call",
			toolName: "read",
			isError: false,
			timestamp: 1,
			content: [...blocks, { type: "image", data: "a".repeat(10000), mimeType: "image/png" }],
		},
	});
	for (const sessionPath of [sqlite("blocks", entries), jsonl("blocks", entries)]) {
		const page = read({ type: "read_history_page", sessionPath, maxBytes: 65536 });
		const lazy = page.entries.find((entry) => entry.id === "large-tool")!.omissions[0];
		const chunk = read({ type: "read_history_content", sessionPath, ref: lazy.ref, limit: 256 * 1024 });
		expect(JSON.parse(Buffer.from(chunk.data, "base64").toString("utf8"))).toEqual(
			(entries.at(-1) as unknown as { message: { content: unknown } }).message.content,
		);
		error(
			{
				type: "read_history_content",
				sessionPath: sqlite(`foreign-${sessionPath.endsWith("sqlite")}`, rounds(1)),
				ref: lazy.ref,
			},
			"FOREIGN_CURSOR",
		);
	}
	const path = sqlite("derived", rounds(1));
	const db = new DatabaseSync(path);
	db.prepare("INSERT INTO entries VALUES(?,?,?,?)").run(
		5,
		1,
		5,
		JSON.stringify({
			id: 5,
			conversationId: 1,
			kind: "nek.message",
			data: { message: { role: "custom", customType: "large-note", display: true, content: "note".repeat(10000) } },
		}),
	);
	db.close();
	const page = read({ type: "read_history_page", sessionPath: path });
	const lazy = page.entries.at(-1)!.omissions[0];
	expect(lazy).toMatchObject({ pointer: "", format: "durable-record" });
	const content = read({ type: "read_history_content", sessionPath: path, ref: lazy.ref });
	expect(JSON.parse(Buffer.from(content.data, "base64").toString("utf8")).data.message.content).toBe(
		"note".repeat(10000),
	);
});

it("HP3/HP4 excessive object members are one explicit source ref, never an oversized envelope", () => {
	const entries = rounds(1);
	Object.assign(
		entries[0],
		Object.fromEntries(Array.from({ length: 500 }, (_, i) => [`extra${i}`, "x".repeat(1000)])),
	);
	for (const sessionPath of [sqlite("members", entries), jsonl("members", entries)]) {
		const page = read({ type: "read_history_page", sessionPath, maxBytes: 65536 });
		expect(page.turns[0].header.id).toBe("u0");
		expect(page.entries[0].omissions[0]).toMatchObject({
			pointer: "",
			format: sessionPath.endsWith("sqlite") ? "durable-record" : "session-entry",
		});
		expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(65536);
	}
});

it("HP1/HP7 pre-user model/thinking entries do not add a 71st round or replace the real header", () => {
	const entries: SessionEntry[] = [
		{ type: "model_change", id: "model", parentId: null, timestamp: TIME, provider: "mock", modelId: "offline" },
		{ type: "thinking_level_change", id: "thinking", parentId: "model", timestamp: TIME, thinkingLevel: "high" },
		...rounds(70),
	];
	entries[2].parentId = "thinking";
	for (const sessionPath of [sqlite("preamble", entries), jsonl("preamble", entries)]) {
		let page = read({ type: "read_history_page", sessionPath });
		const counts = [page.turns.length];
		while (page.olderCursor) {
			page = read({ type: "read_history_page", sessionPath, beforeCursor: page.olderCursor });
			counts.push(page.turns.length);
		}
		expect(counts).toEqual([20, 20, 20, 10]);
		expect(page.totalTurns).toBe(70);
		expect(page.turns[0].header).toMatchObject({ id: "u0", position: 2 });
		expect(page.seed).toEqual({ model: { provider: "mock", modelId: "offline" }, thinkingLevel: "high" });
		expect(read({ type: "read_history_directory", sessionPath, limit: 1 }).items[0].entryId).toBe("u0");
	}
});

it("HP6/HP8 legacy v1/v2 migrate virtually with stable identities and no file repair", () => {
	for (const version of [1, 2]) {
		const path = join(root, `legacy-v${version}.jsonl`);
		const lines: Record<string, unknown>[] = [
			{ ...header(`legacy-${version}`), version: version === 1 ? undefined : 2 },
			...rounds(1).map((entry) => ({ ...entry })),
		];
		lines.push({
			type: "message",
			id: "hook",
			parentId: "a0",
			timestamp: TIME,
			message: { role: "hookMessage", customType: "old-note", content: "note", display: true, timestamp: 1 },
		});
		if (version === 1) {
			for (const line of lines.slice(1)) {
				delete line.id;
				delete line.parentId;
			}
			lines.push({
				type: "compaction",
				timestamp: TIME,
				summary: "summary",
				firstKeptEntryIndex: 1,
				tokensBefore: 10,
			});
		}
		writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"));
		const before = hash(path);
		const page = read({ type: "read_history_page", sessionPath: path });
		expect(page.totalTurns).toBe(1);
		expect(page.entries[2].entry.message).toMatchObject({ role: "custom" });
		expect(read({ type: "read_history_page", sessionPath: path }).entries.map((entry) => entry.id)).toEqual(
			page.entries.map((entry) => entry.id),
		);
		if (version === 1) expect(page.entries[3].entry).toMatchObject({ firstKeptEntryId: page.entries[0].id });
		expect(hash(path)).toBe(before);
	}
});

it("HP6/HP7 projection seeds resolve calls/spawns outside the loaded page without fake entries", () => {
	const entries = rounds(70);
	const firstAnswer = entries[1];
	if (firstAnswer.type !== "message" || firstAnswer.message.role !== "assistant") throw new Error("fixture");
	firstAnswer.message.content = [
		{ type: "toolCall", id: "historic-call", name: "read", arguments: { path: "file.ts" } },
	];
	entries.push({
		type: "message",
		id: "late-result",
		parentId: "a69",
		timestamp: TIME,
		message: {
			role: "toolResult",
			toolCallId: "historic-call",
			toolName: "read",
			content: [{ type: "text", text: "result" }],
			isError: false,
			timestamp: 1,
		},
	});
	for (const sessionPath of [sqlite("context", entries), jsonl("context", entries)]) {
		const page = read({ type: "read_history_page", sessionPath });
		expect(page.entries.at(-1)?.toolCallOrigin).toEqual({
			entryId: "a0",
			position: 1,
			toolCallId: "historic-call",
			name: "read",
		});
		expect(page.entries.some((entry) => entry.id === "a0")).toBe(false);
		expect(page.seed.model).toEqual({ provider: "mock", modelId: "offline" });
	}
});

it("HP5 SQLite append preserves cursors; HP6 hidden fork ownership matches durable projection", () => {
	const sessionPath = sqlite("append", rounds(70));
	const page = read({ type: "read_history_page", sessionPath });
	const db = new DatabaseSync(sessionPath);
	db.prepare("INSERT INTO entries VALUES(?,?,?,?)").run(
		143,
		1,
		143,
		JSON.stringify({
			id: 143,
			conversationId: 1,
			kind: "pi.user",
			data: {},
			model: [{ role: "user", content: "appended", timestamp: 1 }],
		}),
	);
	db.close();
	expect(read({ type: "read_history_page", sessionPath, beforeCursor: page.olderCursor }).turns[0].id).toBe(
		"turn:u30",
	);
	const fork = sqlite("hidden", rounds(1));
	const forkDb = new DatabaseSync(fork);
	forkDb
		.prepare("INSERT INTO entries VALUES(?,?,?,?)")
		.run(5, 1, 5, JSON.stringify({ id: 5, conversationId: 1, kind: "nek.hidden-attachment", data: {} }));
	forkDb
		.prepare("INSERT INTO conversations VALUES(?,?)")
		.run(6, JSON.stringify({ id: 6, parent: { conversationId: 1, at: 5 } }));
	forkDb.prepare("INSERT INTO entries VALUES(?,?,?,?)").run(
		7,
		6,
		7,
		JSON.stringify({
			id: 7,
			conversationId: 6,
			kind: "pi.assistant",
			data: {},
			model: [
				{
					role: "assistant",
					content: [{ type: "text", text: "fork" }],
					provider: "mock",
					model: "offline",
					timestamp: 1,
				},
			],
		}),
	);
	forkDb.close();
	const forkPage = read({ type: "read_history_page", sessionPath: fork });
	expect(forkPage.entries.at(-1)).toMatchObject({ id: "n7", parentId: "a0", position: 2, turnId: "turn:u0" });
});

it("HP9 locked child history requires a persisted parent relation and never resumes it", () => {
	const parent = sqlite("parent-lock", rounds(1));
	const childDir = join(root, "subagents");
	mkdirSync(childDir);
	const child = join(childDir, "child.jsonl");
	writeFileSync(
		child,
		`${JSON.stringify({ ...header("child-id"), parentSession: parent })}\n${JSON.stringify(rounds(1)[0])}\n`,
	);
	error({ type: "read_history_page", sessionPath: child }, "FOREIGN_CURSOR");
	const db = new DatabaseSync(parent);
	db.prepare("INSERT INTO entries VALUES(?,?,?,?)").run(
		5,
		1,
		5,
		JSON.stringify({
			id: 5,
			conversationId: 1,
			kind: "pi.tool-result",
			data: {},
			model: [
				{
					role: "toolResult",
					toolName: "subagent",
					toolCallId: "spawn",
					timestamp: 1,
					content: [],
					details: {
						subagent: {
							id: "child-id",
							type: "explorer",
							description: "inspect",
							background: false,
							status: "running",
							sessionFile: child,
							startedAt: 1,
						},
					},
				},
			],
		}),
	);
	db.close();
	const lock = `${child}.lock`;
	writeFileSync(
		lock,
		JSON.stringify({ pid: process.pid, token: "test", createdAt: 1, hostname: "test-host", kind: "rpc" }),
	);
	const before = hash(lock);
	const meta = read({ type: "read_session_metadata", sessionPath: child });
	expect(meta.session.locked).toBe(true);
	expect(meta.lockedBy).toMatchObject({ pid: process.pid, kind: "rpc" });
	expect(read({ type: "read_history_page", sessionPath: child }).turns).toHaveLength(1);
	expect(hash(lock)).toBe(before);
});

it("HP4/HP8 malformed large legacy tokens and over-limit metadata fail visibly without repair", () => {
	const path = jsonl("invalid", rounds(1));
	appendFileSync(
		path,
		`{"type":"message","id":"broken","parentId":"a0","message":{"role":"user","content":"${"x".repeat(10000)}\\q"}}\n`,
	);
	const before = hash(path);
	error({ type: "read_session_metadata", sessionPath: path }, "INVALID_STORAGE");
	expect(hash(path)).toBe(before);
	const oversized = rounds(1);
	oversized[0].id = "a".repeat(3000);
	error({ type: "read_history_page", sessionPath: jsonl("over-limit", oversized) }, "INDEX_LIMIT");
	const valid = sqlite("empty-cursor", rounds(1));
	error({ type: "read_history_page", sessionPath: valid, beforeCursor: "" }, "INVALID_CURSOR");
	error({ type: "read_history_page", sessionPath: valid, beforeCursor: "bad", afterCursor: "bad" }, "INVALID_REQUEST");
});

it("HP10 decoded streaming search handles escaped Unicode and never joins unrelated strings", () => {
	const path = jsonl("escaped-search", rounds(1));
	appendFileSync(
		path,
		`{"type":"message","id":"search","parentId":"a0","timestamp":"${TIME}","message":{"role":"user","timestamp":1,"content":"${"x".repeat(9000)}\\u754c\\ud83d\\ude00END"}}\n`,
	);
	const found = read({ type: "read_history_directory", sessionPath: path, query: "界😀END" });
	expect(found.items.map((item) => item.entryId)).toEqual(["search"]);
	expect(read({ type: "read_history_directory", sessionPath: path, query: "a0message" }).items).toEqual([]);
});

it("HP11 persisted watermark/active leaf fencing and explicit foreign session selection", () => {
	const entries = rounds(70);
	const sessionPath = sqlite("active", entries);
	let leaf = entries.at(-1)!.id;
	ctx = {
		...ctx,
		session: { sessionFile: sessionPath, sessionManager: { getLeafId: () => leaf } },
	} as unknown as GuiContext;
	const page = read({ type: "read_history_page" });
	expect(page.watermark.entryId).toBe(142);
	leaf = "a10";
	error({ type: "read_history_page", beforeCursor: page.olderCursor }, "STALE_CURSOR");
	error({ type: "read_history_page", branchRevision: page.branchRevision }, "STALE_CURSOR");
	const foreign = sqlite("explicit", rounds(2));
	expect(read({ type: "read_session_metadata", sessionPath: foreign }).sessionId).toBe("explicit");
});
it("HP12 capability, exported command table, control allowlist and real handler agree", async () => {
	const info = buildGuiInfo({ agentDir: join(root, "agent"), cwd: root, entryPath: join(root, "cli.ts") });
	expect(info.capabilities).toEqual({ historyPages: 1 });
	const sessionPath = sqlite("handler", rounds(1));
	for (const type of [
		"read_session_metadata",
		"read_history_page",
		"read_history_turn",
		"read_history_directory",
		"read_history_content",
		"read_history_subagent",
	]) {
		expect(GUI_COMMAND_TYPES.has(type)).toBe(true);
		expect(NEK_CONTROL_COMMANDS).toContain(type);
	}
	const result = await handleGuiCommand({ type: "read_history_page", sessionPath } as RpcHistoryCommand, ctx, {
		reload: async () => ({ deferred: false, diagnostics: [] }),
	});
	expect(result).toMatchObject({
		type: "response",
		command: "read_history_page",
		success: true,
		data: { ok: true, totalTurns: 1 },
	});
});
