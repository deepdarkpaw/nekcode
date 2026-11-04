import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type EntryId } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { derivedEntryId } from "../../src/core/durable/session-format.ts";
import {
	EMPTY_SNAPSHOT_WATER,
	projectSnapshot,
	type SessionSnapshot,
} from "../../src/core/durable/session-snapshot.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { JsonlSessionManager } from "../../src/core/session-manager-jsonl.ts";
import { tempDir } from "./support.ts";

const Progress = defineDoc({
	kind: "test.refresh-progress",
	version: 1,
	scope: "session",
	initial: () => ({ count: 0 }),
});
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	vi.restoreAllMocks();
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function setup(persist: boolean, history = 1) {
	const temp = tempDir("refresh-delta-");
	cleanup.push(temp.cleanup);
	const sm = persist ? SessionManager.create(temp.dir, temp.dir) : SessionManager.inMemory(temp.dir);
	for (let index = 0; index < history; index++)
		sm.appendMessage({ role: "user", content: `message ${index}`, timestamp: index + 1 });
	const store = sm.durableStore();
	const harness = await store.pin();
	cleanup.push(() => store.unpin());
	await sm.refresh();
	const root = await harness.root(BACKGROUND_CONTEXT);
	return { sm, store, harness, root };
}

function sameSelectedProjection(sm: SessionManager, snapshot: SessionSnapshot) {
	const full = projectSnapshot(snapshot);
	const oracle = SessionManager.inMemory(sm.getCwd(), undefined, full.fileEntries);
	const leaf = sm.getLeafId();
	if (leaf === null) oracle.resetLeaf();
	else oracle.branch(leaf);
	expect(sm.getEntries()).toEqual(oracle.getEntries());
	expect(sm.getTree()).toEqual(oracle.getTree());
	expect(sm.buildSessionProjection()).toEqual(oracle.buildSessionProjection());
	for (const entry of sm.getEntries()) expect(sm.durableIdOf(entry.id)).toBe(full.placement.durableIds.get(entry.id));
}

describe.each([false, true])("incremental refresh (persist=%s)", (persist) => {
	it("keeps a selected branch through document-only and unrelated committed entries", async () => {
		const { sm, store, harness, root } = await setup(persist, 3);
		const selected = sm.getEntries()[0].id;
		sm.branch(selected);
		await sm.refreshChanges();
		const before = sm.getEntry(selected);
		const delta = vi.spyOn(store, "readDelta");
		await harness.commit(async (tx) => {
			(await tx.doc(Progress)).count++;
		}, BACKGROUND_CONTEXT);
		expect(await sm.refreshChanges()).toMatchObject({ entries: [], contextChanged: false });
		expect(delta.mock.results.at(-1)?.value.entries).toHaveLength(0);
		expect(sm.getEntry(selected)).toBe(before);
		await root.commit(
			(tx) =>
				tx.appendEntry(root.id, {
					kind: "pi.user",
					model: [{ role: "user", content: "other branch", timestamp: 10 }],
				}),
			BACKGROUND_CONTEXT,
		);
		const changes = await sm.refreshChanges();
		expect(changes.added).toHaveLength(1);
		expect(changes.contextChanged).toBe(false);
		expect(sm.getLeafId()).toBe(selected);
		sameSelectedProjection(sm, store.readDelta(EMPTY_SNAPSHOT_WATER)!);
	});
	it("reconciles host entries, labels, context edits, compaction and forks", async () => {
		const { sm, store } = await setup(persist, 2);
		const first = sm.getEntries()[0].id;
		const id = sm.appendCustomEntry("test", { value: 1 });
		const own = sm.getEntry(id);
		await sm.refreshChanges();
		expect(sm.getEntry(id)).toBe(own);
		for (const append of [
			() => sm.appendLabelChange(first, "label"),
			() => sm.appendContextEdit(first, { content: "replaced" }),
			() => sm.appendCompaction("summary", first, 10),
			() => {
				sm.branch(first);
				return sm.appendCustomEntry("fork", {});
			},
		]) {
			append();
			expect((await sm.refreshChanges()).entries).toHaveLength(1);
			sameSelectedProjection(sm, store.readDelta(EMPTY_SNAPSHOT_WATER)!);
		}
		expect(sm.getLabel(first)).toBe("label");
	});
	it("corrects an already held host parent when the engine committed ahead of it", async () => {
		const { sm, store, harness, root } = await setup(persist);
		let release!: () => void;
		let started!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const ready = new Promise<void>((resolve) => {
			started = resolve;
		});
		const committing = harness.commit(async (tx) => {
			started();
			await gate;
			return tx.appendEntry(root.id, {
				kind: "pi.user",
				model: [{ role: "user", content: "engine", timestamp: 5 }],
			});
		}, BACKGROUND_CONTEXT);
		await ready;
		const reads = vi.spyOn(store, "readDelta");
		const id = sm.appendCustomEntry("host", { value: 1 });
		const before = sm.getEntry(id);
		try {
			await vi.waitFor(() => expect(reads).toHaveBeenCalled());
		} finally {
			release();
		}
		const engine = await committing;
		const changes = await sm.refreshChanges();
		expect(sm.getEntry(id)?.parentId).toBe(derivedEntryId(engine.id));
		expect(sm.getEntry(id)).not.toBe(before);
		expect(changes.replaced.map((entry) => entry.id)).toContain(id);
		sameSelectedProjection(sm, store.readDelta(EMPTY_SNAPSHOT_WATER)!);
	});
});

describe("explicit projection initialization", () => {
	it("keeps structural projection failures visible until explicit reopen", async () => {
		const { sm } = await setup(true);
		const internal = sm as unknown as { _applyEntryDelta(...args: unknown[]): unknown };
		const failure = new Error("broken projection");
		const apply = vi.spyOn(internal, "_applyEntryDelta").mockImplementationOnce(() => {
			throw failure;
		});
		await expect(sm.refreshChanges()).rejects.toBe(failure);
		apply.mockRestore();
		await expect(sm.refreshChanges()).rejects.toBe(failure);
		sm.setSessionFile(sm.getSessionFile()!);
		await expect(sm.refreshChanges()).resolves.toMatchObject({ entries: [] });
	});
	it("resets watermarks when an existing manager switches through a JSONL import", async () => {
		const { sm } = await setup(true, 4);
		const previous = sm.getSessionFile()!;
		const imported = JsonlSessionManager.create(sm.getCwd(), sm.getSessionDir());
		imported.appendMessage({ role: "user", content: "imported", timestamp: 1 });
		sm.setSessionFile(imported.getSessionFile()!);
		await sm.refresh();
		expect(sm.durableIdOf(sm.getLeafId()!)).toBeGreaterThan(0);
		expect(JSON.stringify(sm.buildSessionContext())).toContain("imported");
		expect((await sm.refreshChanges()).entries).toEqual([]);
		sm.setSessionFile(previous);
		expect(sm.getEntries()).toHaveLength(4);
		expect((await sm.refreshChanges()).entries).toEqual([]);
	});
});

describe("long-session refresh work", () => {
	it("reads no historical rows for progress and only new rows for an ordinary append", async () => {
		const { sm, store, harness, root } = await setup(false, 2000);
		const baselineStart = performance.now();
		let referenceRows = 0;
		for (let index = 0; index < 20; index++) {
			const snapshot = store.readDelta(EMPTY_SNAPSHOT_WATER)!;
			referenceRows += snapshot.entries.length;
			projectSnapshot(snapshot);
		}
		const baselineMs = performance.now() - baselineStart;
		const reads = vi.spyOn(store, "readDelta");
		const allEntries = vi.spyOn(sm, "getEntries");
		const start = performance.now();
		const heapBefore = process.memoryUsage().heapUsed;
		for (let index = 0; index < 20; index++) {
			await harness.commit(async (tx) => {
				(await tx.doc(Progress)).count++;
			}, BACKGROUND_CONTEXT);
			expect((await sm.refreshChanges()).contextChanged).toBe(false);
		}
		const rows = reads.mock.results.reduce(
			(sum, result) => sum + (result.type === "return" ? (result.value?.entries.length ?? 0) : 0),
			0,
		);
		expect(rows).toBe(0);
		expect(allEntries).not.toHaveBeenCalled();
		console.info("refresh work", {
			history: 2000,
			refreshes: 20,
			fullReferenceRows: referenceRows,
			incrementalRows: rows,
			fullReferenceMs: baselineMs,
			incrementalWithCommitsMs: performance.now() - start,
			heapDeltaKB: Math.round((process.memoryUsage().heapUsed - heapBefore) / 1024),
		});
		await root.commit(
			(tx) =>
				tx.appendEntry(root.id, { kind: "pi.user", model: [{ role: "user", content: "new", timestamp: 3000 }] }),
			BACKGROUND_CONTEXT,
		);
		expect((await sm.refreshChanges()).added).toHaveLength(1);
		expect(reads.mock.results.at(-1)?.value.entries).toHaveLength(1);
		expect(sm.durableIdOf(sm.getLeafId()!)).toBeGreaterThan(0 as EntryId);
	});
});
