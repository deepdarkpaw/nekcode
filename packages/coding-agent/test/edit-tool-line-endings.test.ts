import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatch } from "diff";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { computeEditDiff, generateDiffString, normalizeToLF } from "../src/core/tools/edit-diff.ts";
import { applyReplacementsToOriginal, applyTextReplacements } from "../src/core/tools/edit-replacements.ts";
import { getEditReplacements, validateEditText } from "../src/core/tools/edit-validate.ts";
import { createReadStateStore } from "../src/core/tools/read-state.ts";

const tmp = fileURLToPath(new URL("../../../.tmp/", import.meta.url));
const tempDirs: string[] = [];

function tempDir(): string {
	mkdirSync(tmp, { recursive: true });
	const dir = mkdtempSync(join(tmp, "edit-line-endings-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("edit preserves original line endings", () => {
	it("does not rescan a long line for every replace_all occurrence", () => {
		const original = `head\n${"X ".repeat(5_000)}\r\n`;
		const replacements = getEditReplacements(normalizeToLF(original), "X", "Y", true);
		const find = vi.spyOn(String.prototype, "indexOf");
		let actual = "";
		let lineScans = 0;
		try {
			actual = applyReplacementsToOriginal(original, replacements);
			lineScans = find.mock.calls.filter(([text]) => text === "\n").length;
		} finally {
			find.mockRestore();
		}
		expect(actual).toBe(`head\n${"Y ".repeat(5_000)}\r\n`);
		expect(lineScans).toBeLessThan(10);
	});

	it.each([
		{ name: "LF first", original: "a\nb\r\nX = 1\r\n", expected: "a\nb\r\nX = 2\r\n" },
		{ name: "CRLF first", original: "a\r\nb\nc\rX = 1", expected: "a\r\nb\nc\rX = 2" },
		{ name: "lone CR", original: "a\rb\nX = 1\n", expected: "a\rb\nX = 2\n" },
	])("does not rewrite untouched bytes with $name", async ({ original, expected }) => {
		const dir = tempDir();
		const path = join(dir, "mixed.txt");
		writeFileSync(path, original);
		const readState = createReadStateStore();
		const tool = createEditToolDefinition(dir, { readState });
		const preview = await computeEditDiff(path, "X = 1", "X = 2", false, dir);
		const result = await tool.execute(
			"mixed",
			{ file_path: path, old_string: "X = 1", new_string: "X = 2" },
			undefined,
			undefined,
			{} as never,
		);
		expect(readFileSync(path).equals(Buffer.from(expected))).toBe(true);
		expect(applyPatch(normalizeToLF(original), result.details?.patch ?? "")).toBe(normalizeToLF(expected));
		expect(preview).toEqual({ diff: result.details?.diff, firstChangedLine: result.details?.firstChangedLine });
		expect(readState.get(path)?.content).toBe(normalizeToLF(expected));
	});

	it.each(["\n", "\r\n", "\r"])("uses the replaced line's %j ending for inserted lines", async (ending) => {
		const dir = tempDir();
		const path = join(dir, "uniform.txt");
		const original = `first${ending}second${ending}third`;
		writeFileSync(path, original);
		const tool = createEditToolDefinition(dir);
		await tool.execute(
			"uniform",
			{ file_path: path, old_string: "second\nthird", new_string: "2a\r\n2b\nthird!" },
			undefined,
			undefined,
			{} as never,
		);
		expect(readFileSync(path).equals(Buffer.from(`first${ending}2a${ending}2b${ending}third!`))).toBe(true);
	});

	it("uses each replace_all occurrence's local line ending, including an unterminated last line", async () => {
		const dir = tempDir();
		const path = join(dir, "replace-all.txt");
		const original = "keep\rX\nlf\nX\r\ncrlf\r\nX";
		const expected = "keep\rA\nB\nlf\nA\r\nB\r\ncrlf\r\nA\r\nB";
		writeFileSync(path, original);
		const tool = createEditToolDefinition(dir);
		const preview = await computeEditDiff(path, "X", "A\nB", true, dir);
		const result = await tool.execute(
			"all",
			{ file_path: path, old_string: "X", new_string: "A\nB", replace_all: "true" },
			undefined,
			undefined,
			{} as never,
		);
		expect(readFileSync(path).equals(Buffer.from(expected))).toBe(true);
		expect(preview).toEqual({ diff: result.details?.diff, firstChangedLine: result.details?.firstChangedLine });
		expect(applyPatch(normalizeToLF(original), result.details?.patch ?? "")).toBe(normalizeToLF(expected));
	});

	it.each<BufferEncoding>(["utf8", "utf16le"])("preserves mixed endings, BOM, and %s encoding", async (encoding) => {
		const dir = tempDir();
		const path = join(dir, "bom.txt");
		const original = "\uFEFF中文\r\nkeep\nold\r\ntail\r";
		const expected = "\uFEFF中文\r\nkeep\nnew\r\ninserted\r\ntail\r";
		writeFileSync(path, Buffer.from(original, encoding));
		const tool = createEditToolDefinition(dir);
		const result = await tool.execute(
			"bom",
			{ file_path: path, old_string: "old", new_string: "new\ninserted" },
			undefined,
			undefined,
			{} as never,
		);
		expect(readFileSync(path).equals(Buffer.from(expected, encoding))).toBe(true);
		expect(applyPatch(normalizeToLF(original.slice(1)), result.details?.patch ?? "")).toBe(
			normalizeToLF(expected.slice(1)),
		);
	});

	it.each([
		{ original: "a\rb\nc", oldString: "b", newString: "\nB", expected: "a\r\n\nB\nc" },
		{ original: "a\rb\n\nc", oldString: "b\n", newString: "", expected: "a\r\n\nc" },
	])("keeps two line breaks at a CR/LF splice seam: $oldString -> $newString", async (testCase) => {
		const { original, oldString, newString, expected } = testCase;
		const dir = tempDir();
		const path = join(dir, "seam.txt");
		writeFileSync(path, original);
		const tool = createEditToolDefinition(dir);
		const result = await tool.execute(
			"seam",
			{ file_path: path, old_string: oldString, new_string: newString },
			undefined,
			undefined,
			{} as never,
		);
		expect(readFileSync(path).equals(Buffer.from(expected))).toBe(true);
		expect(applyPatch(normalizeToLF(original), result.details?.patch ?? "")).toBe(normalizeToLF(expected));
	});

	it("does not merge an inserted CR ending with a kept LF", () => {
		const written = applyReplacementsToOriginal("a\rb\nc", [{ matchIndex: 2, matchLength: 1, newText: "\r" }]);
		expect(written).toBe("a\r\r\n\nc");
		expect(normalizeToLF(written)).toBe("a\n\n\nc");
	});

	it.each([
		{ name: "deletes following LF", oldString: "b", newString: "", expected: "a\rc" },
		{ name: "trims trailing whitespace", oldString: "b", newString: "B  \nC\t", expected: "a\rB\nC\nc" },
		{ name: "keeps literal tokens", oldString: "b", newString: "$&-$1-$$", expected: "a\r$&-$1-$$\nc" },
	])("retains existing exact edit semantics: $name", async ({ oldString, newString, expected }) => {
		const dir = tempDir();
		const path = join(dir, "exact.txt");
		writeFileSync(path, "a\rb\nc");
		await createEditToolDefinition(dir).execute(
			"exact",
			{ file_path: path, old_string: oldString, new_string: newString },
			undefined,
			undefined,
			{} as never,
		);
		expect(readFileSync(path, "utf8")).toBe(expected);
	});

	it("retains Markdown trailing whitespace while preserving untouched mixed endings", async () => {
		const dir = tempDir();
		const path = join(dir, "exact.md");
		writeFileSync(path, "a\r\nb\nc\r");
		await createEditToolDefinition(dir).execute(
			"markdown",
			{ file_path: path, old_string: "b", new_string: "B  \nC\t" },
			undefined,
			undefined,
			{} as never,
		);
		expect(readFileSync(path, "utf8")).toBe("a\r\nB  \nC\t\nc\r");
	});

	it.each([
		{ name: "missing", initial: undefined, encoding: "utf8" as const },
		{ name: "empty", initial: "", encoding: "utf8" as const },
		{ name: "UTF-8 BOM only", initial: "\uFEFF", encoding: "utf8" as const },
		{ name: "UTF-16LE BOM only", initial: "\uFEFF", encoding: "utf16le" as const },
	])("keeps creation semantics and an applicable patch for $name files", async ({ initial, encoding }) => {
		const dir = tempDir();
		const path = join(dir, "created.txt");
		if (initial !== undefined) writeFileSync(path, initial, encoding);
		const newContent = "new  \r\nline\t\r\n";
		const readState = createReadStateStore();
		const tool = createEditToolDefinition(dir, { readState });
		const result = await tool.execute(
			"create",
			{ file_path: path, old_string: "", new_string: newContent },
			undefined,
			undefined,
			{} as never,
		);
		expect(readFileSync(path).equals(Buffer.from((initial ?? "") + newContent, encoding))).toBe(true);
		expect(applyPatch("", result.details?.patch ?? "")).toBe(newContent);
		expect(readState.get(path)?.content).toBe(newContent);
		expect(result.details?.firstChangedLine).toBe(1);
	});

	it("retains desanitization without accepting whitespace-fuzzy matches", async () => {
		const dir = tempDir();
		const path = join(dir, "desanitized.txt");
		writeFileSync(path, "a\r\n<name>before</name>\nc\r");
		const tool = createEditToolDefinition(dir);
		await tool.execute(
			"desanitize",
			{ file_path: path, old_string: "<n>before</n>", new_string: "<n>after</n>" },
			undefined,
			undefined,
			{} as never,
		);
		expect(readFileSync(path, "utf8")).toBe("a\r\n<name>after</name>\nc\r");
		await expect(
			tool.execute(
				"no-fuzzy",
				{ file_path: path, old_string: " <name>after</name>", new_string: "changed" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("String to replace not found");
	});

	it("keeps written normalized content equal to the diffed content for random mixed endings", () => {
		let seed = 1;
		const random = (max: number): number => {
			seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
			return Math.floor((seed / 4294967296) * max);
		};
		const endings = ["\n", "\r\n", "\r", ""];
		for (let run = 0; run < 3000; run++) {
			let original = "";
			for (let line = random(12) + 1; line > 0; line--) {
				original += `w${random(10)}${random(5) === 0 ? "  " : ""}${endings[random(4)]}`;
			}
			const normalized = normalizeToLF(original);
			const start = random(normalized.length);
			const oldString = normalized.slice(start, start + 1 + random(12));
			const newString = ["", "\n", "X\n", "\nY", "\r", "Z"][random(6)];
			const input = { filePath: "f.txt", oldString, newString, replaceAll: random(2) === 0 };
			let validated: ReturnType<typeof validateEditText>;
			try {
				validated = validateEditText(normalized, input);
			} catch {
				continue; // Ambiguous matches and identical inputs are intentionally rejected.
			}
			const replacements = getEditReplacements(
				normalized,
				validated.actualOldString,
				validated.newString,
				input.replaceAll,
			);
			const newContent = applyTextReplacements(normalized, replacements);
			const written = applyReplacementsToOriginal(original, replacements);
			expect(normalizeToLF(written), `run ${run}`).toBe(newContent);
			const whole = generateDiffString(normalized, newContent);
			expect(whole.firstChangedLine === undefined).toBe(normalized === newContent);
		}
	});
});
