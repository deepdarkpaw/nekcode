import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TextContent } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AstGrepToolDetails, createAstGrepTool } from "../src/core/tools/ast-grep.ts";
import { getToolPath } from "../src/utils/tools-manager.ts";

const astGrepAvailable = getToolPath("ast-grep") !== null;

const SOURCE = ["const a = 1;", "console.log(a);", "console.log(", "  a,", "  2,", ");", "foo(a);", ""].join("\n");

function textOf(result: { content: Array<{ type: string }> }): string {
	return result.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

describe.skipIf(!astGrepAvailable)("ast_grep tool", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-ast-grep-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(join(testDir, "src"), { recursive: true });
		writeFileSync(join(testDir, "src", "sample.ts"), SOURCE);
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("returns matches in path:line format with multi-line markers", async () => {
		const tool = createAstGrepTool(testDir);
		const result = await tool.execute("ast-grep-1", { pattern: "console.log($$$A)", lang: "ts" });

		const lines = textOf(result).split("\n");
		expect(lines).toEqual(["src/sample.ts:2: console.log(a);", "src/sample.ts:3: console.log( (+3 lines)"]);
		expect(result.details).toBeUndefined();
	});

	it("uses the file name when searching a single file", async () => {
		const tool = createAstGrepTool(testDir);
		const result = await tool.execute("ast-grep-2", { pattern: "foo($A)", path: "src/sample.ts" });

		expect(textOf(result)).toBe("sample.ts:7: foo(a);");
	});

	it("stops at the match limit", async () => {
		const tool = createAstGrepTool(testDir);
		const result = await tool.execute("ast-grep-3", { pattern: "console.log($$$A)", lang: "ts", limit: 1 });
		const details = result.details as AstGrepToolDetails | undefined;

		const output = textOf(result);
		expect(output).toContain("src/sample.ts:2: console.log(a);");
		expect(output).not.toContain("src/sample.ts:3:");
		expect(output).toContain("[1 matches limit reached. Use limit=2 for more, or refine pattern]");
		expect(details?.matchLimitReached).toBe(1);
	});

	it("reports no matches", async () => {
		const tool = createAstGrepTool(testDir);
		const result = await tool.execute("ast-grep-4", { pattern: "bar($A)", lang: "ts" });

		expect(textOf(result)).toBe("No matches found");
		expect(result.details).toBeUndefined();
	});

	it("rejects an invalid language with the ast-grep error", async () => {
		const tool = createAstGrepTool(testDir);

		await expect(tool.execute("ast-grep-5", { pattern: "foo($A)", lang: "not-a-lang" })).rejects.toThrow(
			"invalid value 'not-a-lang' for '--lang <LANG>'",
		);
	});

	it("surfaces pattern parse warnings", async () => {
		const tool = createAstGrepTool(testDir);
		const result = await tool.execute("ast-grep-6", { pattern: "console.log(", lang: "ts" });
		const details = result.details as AstGrepToolDetails | undefined;

		expect(details?.parseWarning).toContain("Pattern contains an ERROR node");
		expect(textOf(result)).toContain("Pattern contains an ERROR node");
	});

	it("treats flag-like patterns as patterns", async () => {
		writeFileSync(join(testDir, "src", "neg.ts"), "const b = -a;\n");
		const tool = createAstGrepTool(testDir);
		const result = await tool.execute("ast-grep-7", { pattern: "-$A", lang: "ts", globs: ["**/neg.ts"] });

		expect(textOf(result)).toBe("src/neg.ts:1: const b = -a;");
	});

	it("rejects a missing path", async () => {
		const tool = createAstGrepTool(testDir);

		await expect(tool.execute("ast-grep-8", { pattern: "foo($A)", path: "missing" })).rejects.toThrow(
			"Path not found",
		);
	});
});
