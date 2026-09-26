import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createReadTool, type ReadChunkDetails } from "../src/core/tools/read.ts";
import { createReadStateStore } from "../src/core/tools/read-state.ts";
import { getToolPath } from "../src/utils/tools-manager.ts";

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text ?? "")
		.join("\n");
}

describe("Cursor read tool", () => {
	const directories: string[] = [];

	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("returns a small file in FULL form with physical line numbers", async () => {
		const directory = mkdtempSync(join(tmpdir(), "cursor-read-"));
		directories.push(directory);
		const path = join(directory, "small.txt");
		writeFileSync(path, "first\nsecond");

		const tool = createReadTool(directory, { readState: createReadStateStore() });
		const result = await tool.execute("id", { path });

		expect(textOf(result)).toContain("     1|first");
		expect(textOf(result)).toContain("     2|second");
		expect(result.details?.representation).toBe("full");
	});

	it.skipIf(!getToolPath("ast-grep"))("returns symbol-aligned chunks and folds long function bodies", async () => {
		const directory = mkdtempSync(join(tmpdir(), "cursor-read-"));
		directories.push(directory);
		const path = join(directory, "large.ts");
		const body = Array.from({ length: 120 }, (_, index) => `  const value${index} = ${index};`).join("\n");
		const filler = Array.from({ length: 700 }, (_, index) => `const filler${index} = ${index};`).join("\n");
		writeFileSync(path, `import value from "value";\n\nfunction large() {\n${body}\n}\n\n${filler}\n`);

		const result = await createReadTool(directory).execute("id", { path });
		const output = textOf(result);

		expect(result.details?.representation).toBe("chunks");
		expect(result.details?.chunks?.some((chunk: ReadChunkDetails) => chunk.label === "imports")).toBe(true);
		expect(output).toContain("...");
		expect(output).toContain("     3|function large() {");
	});

	it("uses fixed 50-line chunks when the language has no outline provider", async () => {
		const directory = mkdtempSync(join(tmpdir(), "cursor-read-"));
		directories.push(directory);
		const path = join(directory, "large.unknown");
		writeFileSync(path, Array.from({ length: 120 }, (_, index) => `line ${index + 1} ${"x".repeat(100)}`).join("\n"));

		const result = await createReadTool(directory).execute("id", { path });
		const chunks = result.details?.chunks ?? [];

		expect(result.details?.representation).toBe("50-line");
		expect(chunks.map((chunk: ReadChunkDetails) => [chunk.startLine, chunk.endLine])).toEqual([
			[1, 50],
			[51, 100],
			[101, 120],
		]);
	});

	it("supports negative offsets and records successful reads", async () => {
		const directory = mkdtempSync(join(tmpdir(), "cursor-read-"));
		directories.push(directory);
		const path = join(directory, "lines.txt");
		writeFileSync(path, "one\ntwo\nthree");
		const readState = createReadStateStore();

		const result = await createReadTool(directory, { readState }).execute("id", { path, offset: -1 });

		expect(textOf(result)).toBe("     3|three");
		expect(readState.get(path)?.content).toBe("one\ntwo\nthree");
		expect(readState.get(path)?.offset).toBe(-1);
	});

	it("keeps ranged reads in FULL form", async () => {
		const directory = mkdtempSync(join(tmpdir(), "cursor-read-"));
		directories.push(directory);
		const path = join(directory, "ranged.ts");
		writeFileSync(path, Array.from({ length: 300 }, (_, index) => `line ${index + 1}`).join("\n"));

		const result = await createReadTool(directory).execute("id", { path, offset: 10, limit: 3 });
		const output = textOf(result);

		expect(result.details?.representation).toBe("full");
		expect(output).toContain("    10|line 10");
		expect(output).toContain("    12|line 12");
		expect(output).not.toContain("...");
	});
});
