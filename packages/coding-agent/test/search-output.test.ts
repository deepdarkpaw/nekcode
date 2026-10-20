import { describe, expect, it } from "vitest";
import { formatPathList, formatSearchOutput } from "../src/core/tools/search-output.ts";

describe("compact search output", () => {
	it("groups repeated paths while leaving singleton files inline", () => {
		expect(
			formatSearchOutput([
				{ path: "src/config.ts", line: 32, text: "const config = {};" },
				{ path: "src/config.ts", line: 45, text: "export { config };" },
				{ path: "src/main.ts", line: 1, text: "start();" },
			]),
		).toBe("src/config.ts:\n  32: const config = {};\n  45: export { config };\nsrc/main.ts:1: start();");
	});

	it("does not make short paths longer", () => {
		expect(
			formatSearchOutput([
				{ path: "a", line: 1, text: "x" },
				{ path: "a", line: 2, text: "y" },
			]),
		).toBe("a:1: x\na:2: y");
	});

	it("preserves Windows drive colons, source indentation, and multiple AST matches on one line", () => {
		expect(
			formatSearchOutput([
				{ path: "C:/work/config.ts", line: 4, text: "  call(a);" },
				{ path: "C:/work/config.ts", line: 4, text: "  call(b); (+2 lines)" },
			]),
		).toBe("C:/work/config.ts:\n  4:   call(a);\n  4:   call(b); (+2 lines)");
	});

	it("preserves context markers and gaps between disjoint windows", () => {
		expect(
			formatSearchOutput([
				{ path: "notes.txt", line: 1, text: "before", context: true },
				{ path: "notes.txt", line: 2, text: "hit" },
				{ path: "notes.txt", line: 8, text: "later", context: true, breakBefore: true },
			]),
		).toBe("notes.txt:\n  1- before\n  2: hit\n  --\n  8- later");
	});

	it("handles Unicode paths and empty results", () => {
		expect(
			formatSearchOutput([
				{ path: "文档/说明.md", line: 1, text: "甲" },
				{ path: "文档/说明.md", line: 2, text: "乙" },
			]),
		).toBe("文档/说明.md:\n  1: 甲\n  2: 乙");
		expect(formatSearchOutput([])).toBe("");
	});
});

describe("compact file lists", () => {
	it("folds repeated parent directories without losing directory suffixes or spaces", () => {
		expect(
			formatPathList([
				"src/core/tools/grep.ts",
				"src/core/tools/find.ts",
				"src/core/tools/sub directory/",
				"README.md",
			]),
		).toBe("src/core/tools/\n  grep.ts\n  find.ts\n  sub directory/\nREADME.md");
	});

	it("leaves root entries, singleton directories, and short groups unchanged", () => {
		expect(formatPathList(["a", "b/", "x/a", "x/b", "other/only.ts"])).toBe("a\nb/\nx/a\nx/b\nother/only.ts");
		expect(formatPathList([])).toBe("");
	});
});
