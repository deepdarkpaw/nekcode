import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGrepTool } from "../src/core/tools/grep.ts";
import { formatSearchOutput, type SearchOutputLine } from "../src/core/tools/search-output.ts";
import { DEFAULT_MAX_BYTES, truncateHead, truncateLine } from "../src/core/tools/truncate.ts";
import { getToolPath } from "../src/utils/tools-manager.ts";

const workspaceTmp = fileURLToPath(new URL("../../../.tmp/", import.meta.url));
mkdirSync(workspaceTmp, { recursive: true });
let directory: string;
beforeEach(() => {
	directory = mkdtempSync(join(workspaceTmp, "grep-streaming-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.flatMap((block) => (block.type === "text" ? [block.text ?? ""] : [])).join("\n");
}

describe.skipIf(getToolPath("rg") === null)("rg context streaming", () => {
	it("merges windows and finishes the final allowed match's context, even with a further match inside it", async () => {
		const path = join(directory, "context.txt");
		writeFileSync(path, ["a", "hit one", "b", "hit two", "hit three", "c", "hit four"].join("\n"));
		const readFile = vi.fn(() => {
			throw new Error("Must not reread matched files");
		});
		const tool = createGrepTool(directory, { operations: { isDirectory: () => false, readFile } });
		const result = await tool.execute("grep", { pattern: "hit", path, context: 1, limit: 2 });
		expect(textOf(result).split("\n\n")[0]).toBe(
			"context.txt:\n  1- a\n  2: hit one\n  3- b\n  4: hit two\n  5- hit three",
		);
		expect(result.details?.matchLimitReached).toBe(2);
		expect(readFile).not.toHaveBeenCalled();
	});

	it.each([0, 1, 3])("reports a match limit only with proof of another match, context=%s", async (context) => {
		const path = join(directory, "exact.txt");
		writeFileSync(path, "before\nhit one\nbetween\nhit two\nafter\n");
		const tool = createGrepTool(directory);
		const exact = await tool.execute("grep", { pattern: "hit", path, context, limit: 2 });
		expect(textOf(exact)).not.toContain("limit reached");
		expect(exact.details?.matchLimitReached).toBeUndefined();
		for (const limit of [0, 1, 1.5]) {
			const over = await tool.execute("grep", { pattern: "hit", path, context, limit });
			expect(over.details?.matchLimitReached).toBe(1);
			expect(textOf(over)).toContain("[1 matches limit reached. Use limit=2 for more, or refine pattern]");
		}
	});

	it("keeps context across multiple files with distinct paths and marks only disjoint windows", async () => {
		for (const folder of ["one", "two"]) {
			mkdirSync(join(directory, folder));
			writeFileSync(join(directory, folder, "same.txt"), "a\nhit one\nb\nskip\nskip\nc\nhit two\nd");
		}
		const readFile = vi.fn(() => {
			throw new Error("Must not read files");
		});
		const tool = createGrepTool(directory, {
			operations: { isDirectory: async (path) => (await stat(path)).isDirectory(), readFile },
		});
		const result = await tool.execute("grep", { pattern: "hit", context: 1, limit: 4 });
		for (const folder of ["one", "two"]) {
			expect(textOf(result)).toContain(
				`${folder}/same.txt:\n  1- a\n  2: hit one\n  3- b\n  --\n  6- c\n  7: hit two\n  8- d`,
			);
		}
		expect(result.details?.matchLimitReached).toBeUndefined();
		expect(readFile).not.toHaveBeenCalled();
	});

	it("keeps a final context window at EOF while finding limit proof in another file", async () => {
		writeFileSync(join(directory, "one.txt"), "before\nhit one\n");
		writeFileSync(join(directory, "two.txt"), "before\nhit two\nafter\n");
		const result = await createGrepTool(directory).execute("grep", { pattern: "hit", context: 5, limit: 1 });
		expect(result.details?.matchLimitReached).toBe(1);
		expect(textOf(result)).toMatch(/(one|two)\.txt:\n {2}1- before\n {2}2: hit (one|two)/);
		expect(textOf(result).match(/hit (one|two)/g)).toHaveLength(1);
	});

	it.each(["utf16le", "utf16be"])("takes decoded %s context from rg", async (encoding) => {
		const path = join(directory, "encoded.txt");
		const bytes = Buffer.from("\uFEFFbefore\r\nneedle 中文😀\r\nafter\r\n", "utf16le");
		writeFileSync(path, encoding === "utf16be" ? bytes.swap16() : bytes);
		const result = await createGrepTool(directory).execute("grep", { pattern: "needle", path, context: 1 });
		expect(textOf(result)).toBe("encoded.txt:\n  1- before\n  2: needle 中文😀\n  3- after");
	});

	it("decodes base64 line records and strips only LF/CRLF terminators", async () => {
		const path = join(directory, "bytes.txt");
		writeFileSync(path, Buffer.concat([Buffer.from([0xff]), Buffer.from("before\r\nneedle\rprogress\r\nafter\r")]));
		const tool = createGrepTool(directory);
		const result = await tool.execute("grep", { pattern: "needle", path, context: 1 });
		expect(textOf(result)).toBe("bytes.txt:\n  1- �before\n  2: needle\rprogress\n  3- after\r");
		const plain = await tool.execute("grep", { pattern: "needle", path });
		expect(textOf(plain)).toBe("bytes.txt:2: needle\rprogress");
	});

	it("accepts huge context without exponential integer arguments", async () => {
		const path = join(directory, "huge.txt");
		writeFileSync(path, "before\nneedle\nafter");
		const result = await createGrepTool(directory).execute("grep", { pattern: "needle", path, context: 1e30 });
		expect(textOf(result)).toBe("huge.txt:\n  1- before\n  2: needle\n  3- after");
	});

	it.each(["x", "long-path-for-grouping.txt"])(
		"keeps the old shortest layout and exact byte totals beyond the output cap: %s",
		async (name) => {
			const path = join(directory, name);
			const lines = Array.from({ length: 160 }, (_, index) => `hit ${index} ${"x".repeat(550)}`);
			writeFileSync(path, lines.join("\n"));
			const rows: SearchOutputLine[] = lines
				.slice(0, 150)
				.map((text, index) => ({ path: name, line: index + 1, text: truncateLine(text).text }));
			const expected = truncateHead(formatSearchOutput(rows), { maxLines: Number.MAX_SAFE_INTEGER });
			const result = await createGrepTool(directory).execute("grep", { pattern: "hit", path, limit: 150 });
			expect(textOf(result).split("\n\n")[0]).toBe(expected.content);
			expect(result.details?.truncation).toEqual(expected);
			expect(result.details?.matchLimitReached).toBe(150);
			expect(result.details?.linesTruncated).toBe(true);
		},
	);

	it("does not report bytes at the exact cap, but reports and counts the next row", async () => {
		const name = "cap.txt";
		const path = join(directory, name);
		const rows: SearchOutputLine[] = [];
		for (;;) {
			const row = { path: name, line: rows.length + 1, text: `hit${"x".repeat(490)}` };
			if (Buffer.byteLength(formatSearchOutput([...rows, row])) > DEFAULT_MAX_BYTES) break;
			rows.push(row);
		}
		let remaining =
			DEFAULT_MAX_BYTES - Buffer.byteLength(formatSearchOutput(rows)) - 1 - (String(rows.length + 1).length + 4);
		if (remaining < 3) {
			rows.at(-1)!.text = rows.at(-1)!.text.slice(0, -20);
			remaining += 20;
		}
		expect(remaining).toBeLessThanOrEqual(500);
		rows.push({ path: name, line: rows.length + 1, text: `hit${"x".repeat(remaining - 3)}` });
		const expected = formatSearchOutput(rows);
		expect(Buffer.byteLength(expected)).toBe(DEFAULT_MAX_BYTES);
		writeFileSync(path, rows.map((row) => row.text).join("\n"));
		const tool = createGrepTool(directory);
		const exact = await tool.execute("grep", { pattern: "hit", path, limit: 1000 });
		expect(textOf(exact)).toBe(expected);
		expect(exact.details).toBeUndefined();
		appendFileSync(path, "\nhit extra");
		const over = await tool.execute("grep", { pattern: "hit", path, limit: 1000 });
		expect(textOf(over)).toBe(`${expected}\n\n[50.0KB limit reached]`);
		expect(over.details?.truncation?.totalLines).toBe(rows.length + 2);
		expect(over.details?.truncation?.outputBytes).toBe(DEFAULT_MAX_BYTES);
	});

	it("does not split an emoji at the long-line cutoff", async () => {
		const path = join(directory, "emoji.txt");
		writeFileSync(path, `${"a".repeat(499)}😀 tail`);
		const result = await createGrepTool(directory).execute("grep", { pattern: "tail", path });
		expect(textOf(result)).toContain(`${"a".repeat(499)}... [truncated]`);
		expect(textOf(result)).not.toContain("\ud83d");
	});

	it("keeps context/match accumulation bounded with a 64 MB heap", () => {
		const toolUrl = new URL("../src/core/tools/grep.ts", import.meta.url).href;
		const resolverUrl = new URL("../src/experimental/source-resolver.ts", import.meta.url).href;
		const path = join(directory, "many.log");
		const script = `
			import { openSync, writeSync, closeSync } from 'node:fs';
			import { createGrepTool } from ${JSON.stringify(toolUrl)};
			const path = ${JSON.stringify(path)};
			const fd = openSync(path, 'w');
			const chunk = Buffer.from('hit row abcdefghijklmnopqrstuvwxyz\\n'.repeat(1000));
			try { for (let index = 0; index < 250; index++) writeSync(fd, chunk); } finally { closeSync(fd); }
			const result = await createGrepTool(process.cwd()).execute('grep', { path, pattern: 'hit', context: 1, limit: 300000 });
			if (!result.details?.truncation?.truncated) throw new Error('Missing truncation');
			if (result.details.matchLimitReached) throw new Error('False match limit');
			if (result.details.truncation.totalLines !== 250001) throw new Error(JSON.stringify(result.details));
			process.stdout.write('bounded');
		`;
		expect(
			execFileSync(
				process.execPath,
				["--max-old-space-size=64", "--import", resolverUrl, "--input-type=module", "--eval", script],
				{
					cwd: directory,
					env: { ...process.env, TMP: workspaceTmp, TEMP: workspaceTmp, TMPDIR: workspaceTmp, NEK_OFFLINE: "1" },
					encoding: "utf8",
					timeout: 30_000,
					maxBuffer: DEFAULT_MAX_BYTES,
				},
			),
		).toBe("bounded");
	}, 40_000);
});

describe.skipIf(getToolPath("rg") === null)("grep glob roots", () => {
	it("anchors directory globs at path, including relative paths, symlinks and leading ./", async () => {
		const repo = join(directory, "repo");
		mkdirSync(join(repo, "migrations", "main"), { recursive: true });
		mkdirSync(join(repo, "nested", "migrations", "main"), { recursive: true });
		writeFileSync(join(repo, "migrations", "main", "a.js"), "hello\n");
		writeFileSync(join(repo, "nested", "migrations", "main", "b.js"), "hello\n");
		const link = join(directory, "repo-link");
		symlinkSync(repo, link, process.platform === "win32" ? "junction" : "dir");
		const tool = createGrepTool(directory);
		for (const path of ["repo", "./repo", repo, link]) {
			for (const glob of ["migrations/main/*.js", "./migrations/main/*.js", "././migrations/main/*.js"]) {
				const result = await tool.execute("grep", { pattern: "hello", path, glob });
				expect(textOf(result), `${path}, ${glob}`).toBe("migrations/main/a.js:1: hello");
			}
			for (const glob of ["**/migrations/main/*.js", "*.js", undefined]) {
				const result = await tool.execute("grep", { pattern: "hello", path, glob });
				expect(textOf(result).split("\n").sort()).toEqual([
					"migrations/main/a.js:1: hello",
					"nested/migrations/main/b.js:1: hello",
				]);
			}
			const negated = await tool.execute("grep", { pattern: "hello", path, glob: "!./migrations/**" });
			expect(textOf(negated)).toBe("nested/migrations/main/b.js:1: hello");
		}
	});

	it("searches explicit files from their parent, with normalized output and rg's explicit-file glob behavior", async () => {
		const folder = join(directory, "folder with spaces");
		mkdirSync(folder);
		const file = join(folder, "-file.txt");
		writeFileSync(file, "hit one\nhit two");
		const tool = createGrepTool(directory);
		for (const path of [file, "./folder with spaces/-file.txt"]) {
			const result = await tool.execute("grep", { pattern: "hit", path, glob: "./not-a-match/*.js" });
			expect(textOf(result)).toBe("-file.txt:\n  1: hit one\n  2: hit two");
		}
	});

	it("preserves paths whose first component begins with two dots", async () => {
		mkdirSync(join(directory, "..named"));
		writeFileSync(join(directory, "..named", "hit.txt"), "hit");
		const result = await createGrepTool(directory).execute("grep", { pattern: "hit" });
		expect(textOf(result)).toBe("..named/hit.txt:1: hit");
	});
});
