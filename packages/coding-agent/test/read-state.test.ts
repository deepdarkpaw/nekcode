import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createReadStateStore, DEFAULT_READ_STATE_ENTRIES, readStateKey } from "../src/core/tools/read-state.ts";

/** Whether this process may create file symlinks; Windows needs developer mode or elevation. */
function canCreateFileSymlink(dir: string): boolean {
	try {
		const target = join(dir, "probe-target");
		const link = join(dir, "probe-link");
		writeFileSync(target, "x");
		symlinkSync(target, link);
		rmSync(link, { force: true });
		rmSync(target, { force: true });
		return true;
	} catch {
		return false;
	}
}

describe("read state store", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-read-state-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns undefined for a file that was never read", () => {
		const store = createReadStateStore();
		expect(store.get(join(dir, "missing.ts"))).toBeUndefined();
	});

	it("returns the record that was set for a path", () => {
		const store = createReadStateStore();
		const path = join(dir, "a.ts");
		writeFileSync(path, "const a = 1;\n");
		store.set(path, { content: "const a = 1;\n", timestamp: 123, offset: undefined, limit: undefined });
		expect(store.get(path)).toEqual({
			content: "const a = 1;\n",
			timestamp: 123,
			offset: undefined,
			limit: undefined,
		});
	});

	it("keys a symlink and its target to the same record", (ctx) => {
		if (!canCreateFileSymlink(dir)) ctx.skip();
		const target = join(dir, "target.ts");
		const link = join(dir, "link.ts");
		writeFileSync(target, "x\n");
		symlinkSync(target, link);
		const store = createReadStateStore();
		store.set(link, { content: "x\n", timestamp: 1, offset: undefined, limit: undefined });
		expect(store.get(target)).toBeDefined();
		expect(readStateKey(link)).toBe(readStateKey(target));
	});

	it("keys different spellings of one path to the same record", () => {
		const path = join(dir, "b.ts");
		writeFileSync(path, "y\n");
		const store = createReadStateStore();
		store.set(path, { content: "y\n", timestamp: 2, offset: undefined, limit: undefined });
		const withParentSegment = join(dir, "..", dir.split(/[\\/]/).pop() ?? "", "b.ts");
		expect(store.get(withParentSegment)).toBeDefined();
	});

	it("replaces a record for the same path instead of adding a second one", () => {
		const path = join(dir, "c.ts");
		writeFileSync(path, "z\n");
		const store = createReadStateStore();
		store.set(path, { content: "first\n", timestamp: 1, offset: undefined, limit: undefined });
		store.set(path, { content: "second\n", timestamp: 2, offset: undefined, limit: undefined });
		expect(store.get(path)?.content).toBe("second\n");
	});

	it("evicts the oldest record once the entry limit is reached", () => {
		const store = createReadStateStore(3, 1024 * 1024);
		const paths = ["a", "b", "c", "d"].map((name) => {
			const path = join(dir, `${name}.ts`);
			writeFileSync(path, "x\n");
			return path;
		});
		for (const [index, path] of paths.entries()) {
			store.set(path, { content: "x\n", timestamp: index, offset: undefined, limit: undefined });
		}
		expect(store.get(paths[0])).toBeUndefined();
		expect(store.get(paths[3])).toBeDefined();
	});

	it("keeps the newest record even when it exceeds the byte limit alone", () => {
		const store = createReadStateStore(DEFAULT_READ_STATE_ENTRIES, 4);
		const path = join(dir, "big.ts");
		writeFileSync(path, "long content\n");
		store.set(path, { content: "long content\n", timestamp: 1, offset: undefined, limit: undefined });
		expect(store.get(path)?.content).toBe("long content\n");
	});
});
