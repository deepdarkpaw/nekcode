import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createReadStateStore } from "../src/core/tools/read-state.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("edit atomic write boundary", () => {
	it("does not alter the target when the write operation fails", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-edit-atomic-"));
		tempDirs.push(dir);
		const filePath = join(dir, "atomic.txt");
		writeFileSync(filePath, "before\n", "utf8");
		const readState = createReadStateStore();
		readState.set(filePath, {
			content: "before\n",
			timestamp: Math.floor(statSync(filePath).mtimeMs),
			offset: undefined,
			limit: undefined,
		});
		const tool = createEditToolDefinition(dir, {
			readState,
			operations: {
				access: async () => {},
				readFile: async () => Buffer.from("before\n", "utf8"),
				writeFile: async () => {
					throw new Error("disk full");
				},
			},
		});

		await expect(
			tool.execute(
				"atomic-failure",
				{ file_path: filePath, old_string: "before", new_string: "after" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("disk full");
		expect(readFileSync(filePath, "utf8")).toBe("before\n");
		expect(readState.get(filePath)?.content).toBe("before\n");
	});
});
