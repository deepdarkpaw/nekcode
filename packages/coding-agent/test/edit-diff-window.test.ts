import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatch } from "diff";
import { describe, expect, it } from "vitest";
import { generateDiffString, generateEditDiff, generateUnifiedPatch } from "../src/core/tools/edit-diff.ts";
import { applyTextReplacements, type TextReplacement } from "../src/core/tools/edit-replacements.ts";

const tmp = fileURLToPath(new URL("../../../.tmp/", import.meta.url));

/** Keep any heap regression isolated from the test runner and all generated data under the workspace. */
function runHeapProbe(script: string, heapLimit: number, preload?: string): string {
	mkdirSync(tmp, { recursive: true });
	return execFileSync(
		process.execPath,
		[
			`--max-old-space-size=${heapLimit}`,
			...(preload ? ["--import", preload] : []),
			"--input-type=module",
			"--eval",
			script,
		],
		{
			cwd: tmp,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 20000,
			env: {
				...process.env,
				TMP: tmp,
				TEMP: tmp,
				TMPDIR: tmp,
				NODE_COMPILE_CACHE: join(tmp, "node-compile-cache"),
				NEK_OFFLINE: "1",
			},
		},
	);
}

/** Deterministic mulberry32 generator using the high bits. */
function createRandom(seed: number): (max: number) => number {
	let state = seed;
	return (max) => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * max);
	};
}

/** Generate sorted, disjoint replacements, including insertions and edits near EOF. */
function randomCase(random: (max: number) => number, distinct: boolean) {
	const lineCount = random(600);
	const lines = Array.from({ length: lineCount }, (_, i) => (distinct ? `line ${i}` : ["a", "b", "", "}"][random(4)]));
	const content = lines.join("\n") + (random(2) === 0 ? "\n" : "");
	const replacements: TextReplacement[] = [];
	let position = 0;
	const count = 1 + random(5);
	for (let i = 0; i < count && position <= content.length; i++) {
		const matchIndex = position + random(content.length - position + 1);
		const matchLength = random(Math.min(content.length - matchIndex, 120) + 1);
		const newLines = Array.from({ length: random(4) }, (_, j) => `new ${i} ${j}`);
		const newText = random(3) === 0 ? "" : newLines.join("\n") + (random(2) === 0 ? "\n" : "");
		replacements.push({ matchIndex, matchLength, newText });
		position = matchIndex + Math.max(1, matchLength);
	}
	return { content, replacements, newContent: applyTextReplacements(content, replacements) };
}

describe("generateEditDiff", () => {
	it("matches whole-file display, patch, and firstChangedLine for distinct lines", () => {
		const random = createRandom(1);
		for (let run = 0; run < 2000; run++) {
			const { content, replacements, newContent } = randomCase(random, true);
			if (content === newContent) continue;
			const windowed = generateEditDiff("f.txt", content, newContent, replacements);
			const whole = generateDiffString(content, newContent);
			expect(windowed, `run ${run}`).toEqual({
				diff: whole.diff,
				patch: generateUnifiedPatch("f.txt", content, newContent),
				firstChangedLine: whole.firstChangedLine,
			});
			expect(applyPatch(content, windowed.patch), `run ${run}`).toBe(newContent);
		}
	});

	it("produces applicable patches with repeated lines, insertions, and missing final newlines", () => {
		const random = createRandom(2);
		for (let run = 0; run < 2000; run++) {
			const { content, replacements, newContent } = randomCase(random, false);
			if (content === newContent) continue;
			const { patch } = generateEditDiff("f.txt", content, newContent, replacements);
			expect(applyPatch(content, patch), `run ${run}`).toBe(newContent);
		}
	});

	it.each([1, 4, 40])("renumbers separated windows and merges adjacent windows with %i context lines", (context) => {
		const content = Array.from({ length: 600 }, (_, i) => `line ${i}\n`).join("");
		const replacements = [
			{ matchIndex: 0, matchLength: 0, newText: "intro\n" },
			{ matchIndex: content.indexOf("line 150\n"), matchLength: 9, newText: "A\nB\n" },
			{ matchIndex: content.indexOf("line 200\n"), matchLength: 9, newText: "" },
			{ matchIndex: content.indexOf("line 500\n"), matchLength: 9, newText: "last" },
			{ matchIndex: content.length, matchLength: 0, newText: "end" },
		];
		const newContent = applyTextReplacements(content, replacements);
		const whole = generateDiffString(content, newContent, context);
		const windowed = generateEditDiff("f.txt", content, newContent, replacements, context);
		expect(windowed).toEqual({
			diff: whole.diff,
			patch: generateUnifiedPatch("f.txt", content, newContent, context),
			firstChangedLine: whole.firstChangedLine,
		});
		expect(applyPatch(content, windowed.patch)).toBe(newContent);
	});

	it("handles a replacement of many lines without spreading it onto the call stack", () => {
		const newText = "x\n".repeat(150000);
		const replacements = [{ matchIndex: 0, matchLength: 2, newText }];
		const { patch } = generateEditDiff("f.txt", "a\nb\n", `${newText}b\n`, replacements);
		expect(applyPatch("a\nb\n", patch)).toBe(`${newText}b\n`);
	});

	it("diffs a small change in a 20 MB file in a child process with a 96 MB heap", () => {
		const editDiffUrl = new URL("../src/core/tools/edit-diff.ts", import.meta.url).href;
		const script = `
			import { generateEditDiff } from ${JSON.stringify(editDiffUrl)};
			const half = ("x".repeat(99) + "\\n").repeat(100000);
			const base = half + "TARGET = 1\\n" + half;
			const replacement = { matchIndex: half.length, matchLength: 10, newText: "TARGET = 2" };
			const changed = half + "TARGET = 2\\n" + half;
			const { diff, patch, firstChangedLine } = generateEditDiff("big.txt", base, changed, [replacement]);
			if (firstChangedLine !== 100001 || patch.length > 2000) throw new Error("Unexpected window");
			process.stdout.write(diff.split("\\n").filter((line) => /^[+-]/.test(line)).join("\\n"));
		`;
		const output = runHeapProbe(script, 96);
		expect(output).toBe("-100001 TARGET = 1\n+100001 TARGET = 2");
	});

	it("executes a real 20 MB file edit in a child process with a 192 MB heap", () => {
		mkdirSync(tmp, { recursive: true });
		const dir = mkdtempSync(join(tmp, "edit-heap-"));
		try {
			const resolverUrl = new URL("../src/experimental/source-resolver.ts", import.meta.url).href;
			const editUrl = new URL("../src/core/tools/edit.ts", import.meta.url).href;
			const filePath = join(dir, "large.txt");
			const script = `
				import { readFileSync, writeFileSync } from "node:fs";
				import { createEditToolDefinition } from ${JSON.stringify(editUrl)};
				const path = ${JSON.stringify(filePath)};
				const half = ("x".repeat(99) + "\\n").repeat(100000);
				writeFileSync(path, half + "TARGET = 1\\n" + half);
				const result = await createEditToolDefinition(${JSON.stringify(dir)}).execute(
					"large", { file_path: path, old_string: "TARGET = 1", new_string: "TARGET = 2" },
					undefined, undefined, undefined,
				);
				if (readFileSync(path, "utf8") !== half + "TARGET = 2\\n" + half) throw new Error("Wrong content");
				if (result.details.firstChangedLine !== 100001 || result.details.patch.length > 2000) {
					throw new Error("Unexpected window");
				}
				process.stdout.write("edited");
			`;
			expect(runHeapProbe(script, 192, resolverUrl)).toBe("edited");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
