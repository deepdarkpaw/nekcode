import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createFindTool } from "../src/core/tools/find.ts";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { DEFAULT_MAX_BYTES } from "../src/core/tools/truncate.ts";
import { getToolPath } from "../src/utils/tools-manager.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("\n");
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "nek-search-output-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(getToolPath("rg") === null)("grep output", () => {
	it("groups repeated matches in the model-visible result", async () => {
		writeFileSync(join(dir, "matches.txt"), "hit one\nnope\nhit two\n");
		const result = await createGrepTool(dir).execute("grep", { pattern: "hit" });
		expect(textOf(result)).toBe("matches.txt:\n  1: hit one\n  3: hit two");
	});

	it("merges overlapping context once and keeps both matches marked", async () => {
		const content = "before\r\nhit one\r\nbetween\r\nhit two\r\nafter";
		const path = join(dir, "context.txt");
		writeFileSync(path, content);
		const read = vi.fn((file: string) => readFile(file, "utf8"));
		const tool = createGrepTool(dir, { operations: { isDirectory: () => false, readFile: read } });
		const result = await tool.execute("grep", { pattern: "hit", path, context: 1 });
		expect(textOf(result)).toBe("context.txt:\n  1- before\n  2: hit one\n  3- between\n  4: hit two\n  5- after");
		expect(read).toHaveBeenCalledTimes(1);
	});

	it("still reports when requested context cannot be read", async () => {
		const path = join(dir, "matches.txt");
		writeFileSync(path, "hit one");
		const tool = createGrepTool(dir, {
			operations: {
				isDirectory: () => false,
				readFile: async () => {
					throw new Error("permission denied");
				},
			},
		});
		const result = await tool.execute("grep", { pattern: "hit", path, context: 1 });
		expect(textOf(result)).toBe("matches.txt:1: (unable to read file)");
	});

	it("joins adjacent context windows but marks omitted regions", async () => {
		writeFileSync(
			join(dir, "context.txt"),
			"before\nhit one\nafter\nbefore\nhit two\nafter\nskip\nskip\nbefore\nhit three\nafter",
		);
		const result = await createGrepTool(dir).execute("grep", { pattern: "hit", context: 1 });
		expect(textOf(result)).toBe(
			"context.txt:\n  1- before\n  2: hit one\n  3- after\n  4- before\n  5: hit two\n  6- after\n  --\n  9- before\n  10: hit three\n  11- after",
		);
	});

	it("keeps distinct files with the same basename separate", async () => {
		for (const folder of ["one", "two"]) {
			mkdirSync(join(dir, folder));
			writeFileSync(join(dir, folder, "same.txt"), `hit ${folder}\nhit again`);
		}
		const result = await createGrepTool(dir).execute("grep", { pattern: "hit" });
		expect(textOf(result)).toContain("one/same.txt:\n  1: hit one\n  2: hit again");
		expect(textOf(result)).toContain("two/same.txt:\n  1: hit two\n  2: hit again");
	});

	it("counts matches, not headings, toward the result limit", async () => {
		writeFileSync(join(dir, "matches.txt"), "hit one\nhit two\nhit three");
		const result = await createGrepTool(dir).execute("grep", { pattern: "hit", limit: 2 });
		expect(textOf(result)).toContain("matches.txt:\n  1: hit one\n  2: hit two");
		expect(textOf(result)).not.toContain("hit three");
		expect(result.details?.matchLimitReached).toBe(2);
	});

	it("retains byte and long-line truncation notices after grouping", async () => {
		const lines = Array.from({ length: 250 }, () => "x".repeat(600));
		lines[125] = `hit ${"x".repeat(600)}`;
		writeFileSync(join(dir, "large.txt"), lines.join("\n"));
		const result = await createGrepTool(dir).execute("grep", { pattern: "hit", context: 120 });
		expect(result.details?.truncation?.truncated).toBe(true);
		expect(result.details?.truncation?.outputBytes).toBeLessThanOrEqual(DEFAULT_MAX_BYTES);
		expect(result.details?.linesTruncated).toBe(true);
		expect(textOf(result)).toContain("limit reached");
		expect(textOf(result)).toContain("Some lines truncated");
	});
});

describe("find output", () => {
	it("groups custom-backend results and still counts files rather than headings", async () => {
		const tool = createFindTool(dir, {
			operations: {
				exists: () => true,
				glob: () => ["src/core/tools/a.ts", "src/core/tools/b.ts"],
			},
		});
		const result = await tool.execute("find", { pattern: "*.ts", limit: 2 });
		expect(textOf(result)).toBe("src/core/tools/\n  a.ts\n  b.ts\n\n[2 results limit reached]");
		expect(result.details?.resultLimitReached).toBe(2);
	});

	it.skipIf(getToolPath("fd") === null)("groups fd results too", async () => {
		mkdirSync(join(dir, "src", "long-directory"), { recursive: true });
		for (const name of ["a.ts", "b.ts"]) writeFileSync(join(dir, "src", "long-directory", name), "");
		const result = await createFindTool(dir).execute("find", { pattern: "*.ts" });
		const output = textOf(result);
		expect(output).toContain("src/long-directory/\n");
		expect(output).toContain("  a.ts");
		expect(output).toContain("  b.ts");
	});
});
