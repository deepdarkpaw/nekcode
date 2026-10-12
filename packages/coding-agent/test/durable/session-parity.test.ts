import { createHash } from "node:crypto";
import { copyFileSync, readFileSync } from "node:fs";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { DurableSessionStore } from "../../src/core/durable/session-store.ts";
import { convertToLlm } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { JsonlSessionManager } from "../../src/core/session-manager-jsonl.ts";
import { writeFixtures } from "./session-fixtures.ts";
import { tempDir } from "./support.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function digest(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

const ID_KEYS = new Set([
	"id",
	"parentId",
	"targetId",
	"firstKeptEntryId",
	"fromId",
	"leafId",
	"branches",
	"roots",
	"children",
]);

/**
 * Replace entry IDs by their position, so sessions whose IDs were generated independently (version 1 files get
 * fresh IDs at every migration) compare by structure.
 */
function positional<T>(value: T, ids: ReadonlyMap<string, number>): T {
	return JSON.parse(
		JSON.stringify(value, (key, field: unknown) => (ID_KEYS.has(key) ? positionOf(field, ids) : field)),
	) as T;
}

/** The tree as rows in depth-first order: entry, child IDs in order, label; deep trees overflow recursive equality. */
function flattenTree(roots: ReturnType<SessionManager["getTree"]>) {
	const rows: unknown[] = [];
	const stack = [...roots].reverse();
	while (stack.length > 0) {
		const node = stack.pop()!;
		rows.push({
			entry: node.entry,
			children: node.children.map((child) => child.entry.id),
			label: node.label ?? null,
			labelTimestamp: node.labelTimestamp ?? null,
		});
		for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index]!);
	}
	return { roots: roots.map((root) => root.entry.id), rows };
}

function positionOf(field: unknown, ids: ReadonlyMap<string, number>): unknown {
	if (typeof field === "string") return ids.has(field) ? `#${ids.get(field)}` : field;
	if (Array.isArray(field)) return field.map((each) => positionOf(each, ids));
	return field;
}

/** Every read the parity contract covers, as plain data. */
function readAll(sm: Pick<SessionManager, keyof JsonlSessionManager & keyof SessionManager>) {
	const entries = sm.getEntries();
	const ids = new Map(entries.map((entry, index) => [entry.id, index]));
	return positional(readRaw(sm, entries), ids);
}

function readRaw(
	sm: Pick<SessionManager, keyof JsonlSessionManager & keyof SessionManager>,
	entries: ReturnType<SessionManager["getEntries"]>,
) {
	return {
		header: { ...sm.getHeader(), version: sm.getHeader()?.version },
		sessionId: sm.getSessionId(),
		cwd: sm.getCwd(),
		leafId: sm.getLeafId(),
		entries,
		context: sm.buildSessionContext(),
		projection: sm.buildSessionProjection(),
		contextEntries: sm.buildContextEntries(),
		tree: flattenTree(sm.getTree()),
		branch: sm.getBranch(),
		branches: entries.map((entry) => sm.getBranch(entry.id).map((each) => each.id)),
		labels: entries.map((entry) => sm.getLabel(entry.id) ?? null),
		name: sm.getSessionName() ?? null,
	};
}

/**
 * Model context compared by role, timestamp, and content. Durable leaves out aborted and errored answers and
 * synthesizes a result for a call without one; pi-ai's request transform does both too (`transform-messages.ts`, with
 * the text "No result provided"), so synthesized results are left out of the comparison.
 */
function durableShape(messages: readonly Message[]): string[] {
	return messages
		.filter((message) => message.role !== "assistant" || !["aborted", "error"].includes(message.stopReason))
		.filter(
			(message) =>
				message.role !== "toolResult" ||
				(message.details as { reason?: string } | undefined)?.reason !== "missing_result",
		)
		.map(
			(message) =>
				`${message.role}@${message.timestamp}:${JSON.stringify(message.role === "system" ? message.sections : message.content)}`,
		);
}

describe("durable SessionManager parity with the JSONL SessionManager", { timeout: 120_000 }, () => {
	const { dir, cleanup } = tempDir("nek-parity-");
	const fixtures = writeFixtures(dir);
	afterAll(cleanup);

	for (const fixture of fixtures) {
		it(`imports ${fixture.name}`, async () => {
			const before = digest(fixture.path);
			const oraclePath = `${fixture.path}.oracle.jsonl`;
			copyFileSync(fixture.path, oraclePath);
			const oracle = readAll(JsonlSessionManager.open(oraclePath));

			// Open imports into `<name>.sqlite` next to the JSONL file.
			const imported = SessionManager.open(fixture.path);
			const databasePath = imported.getSessionFile()!;
			expect(databasePath.endsWith(".sqlite")).toBe(true);
			await imported.flush();
			const store = DurableSessionStore.forPath(databasePath);
			cleanups.push(() => store.close());
			expect(readAll(imported)).toEqual({ ...oracle });

			// The JSONL file is left exactly as it was.
			expect(digest(fixture.path)).toBe(before);

			// Reopening the JSONL path, or the database, reads the database.
			for (const path of [fixture.path, databasePath]) {
				const reopened = SessionManager.open(path);
				expect(reopened.getSessionFile()).toBe(databasePath);
				expect(readAll(reopened)).toEqual(oracle);
			}

			// Durable's own model context of the leaf's conversation is pi's model context.
			const harness = await store.pin();
			try {
				const conversationId = store.conversationOf(imported.getLeafId()!);
				expect(conversationId).toBeDefined();
				const conversation = await harness.conversation(conversationId!, BACKGROUND_CONTEXT);
				const view = await conversation!.context(BACKGROUND_CONTEXT);
				expect(durableShape(view.messages)).toEqual(durableShape(convertToLlm(oracle.context.messages)));
			} finally {
				store.unpin();
			}
		});
	}

	it("appends after import exactly as the JSONL manager appends", async () => {
		const fixture = fixtures.find((each) => each.name.startsWith("synthetic: every entry type"))!;
		const oraclePath = `${fixture.path}.append.jsonl`;
		copyFileSync(fixture.path, oraclePath);
		const oracle = JsonlSessionManager.open(oraclePath);
		const durable = SessionManager.open(fixture.path);
		cleanups.push(() => DurableSessionStore.forPath(durable.getSessionFile()!).close());
		const target = durable.getEntries()[3]!.id;
		for (const sm of [oracle, durable]) {
			sm.branch(target);
			sm.appendMessage({ role: "user", content: "appended", timestamp: 1 });
			sm.appendLabelChange(target, "appended label");
			sm.appendSessionInfo("Renamed");
		}
		// Generated ids differ; compare the reopened durable session with the durable manager that wrote it.
		await durable.flush();
		const reopened = readAll(SessionManager.open(durable.getSessionFile()!));
		expect(reopened).toEqual(readAll(durable));
		expect(reopened.name).toBe("Renamed");
		expect(reopened.labels.filter((label) => label !== null)).toEqual(
			readAll(oracle).labels.filter((label) => label !== null),
		);
	});
});
