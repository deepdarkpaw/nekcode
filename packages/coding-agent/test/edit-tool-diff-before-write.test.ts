import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Diff from "diff";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createReadStateStore } from "../src/core/tools/read-state.ts";

vi.mock("diff", async (importOriginal) => {
	const original = await importOriginal<typeof import("diff")>();
	return {
		...original,
		diffLines: vi.fn(original.diffLines),
		structuredPatch: vi.fn(original.structuredPatch),
	};
});

const tmp = fileURLToPath(new URL("../../../.tmp/", import.meta.url));
const tempDirs: string[] = [];

afterEach(() => {
	vi.clearAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("edit computes all diffs before writing", () => {
	it.each([
		{ exists: true, stage: "display" },
		{ exists: true, stage: "patch" },
		{ exists: false, stage: "display" },
		{ exists: false, stage: "patch" },
	])("leaves file/readState untouched on a $stage failure (existing=$exists)", async ({ exists, stage }) => {
		mkdirSync(tmp, { recursive: true });
		const dir = mkdtempSync(join(tmp, "edit-diff-failure-"));
		tempDirs.push(dir);
		const path = join(dir, "file.txt");
		const readState = createReadStateStore();
		if (exists) {
			writeFileSync(path, "before\r\nuntouched\n");
			readState.set(path, {
				content: "before\nuntouched\n",
				timestamp: Math.floor(statSync(path).mtimeMs),
				offset: undefined,
				limit: undefined,
			});
		}
		const initialState = readState.get(path);
		const write = vi.fn(async (file: string, content: string, encoding: BufferEncoding) => {
			await writeFile(file, content, encoding);
		});
		const tool = createEditToolDefinition(dir, {
			readState,
			operations: { access: async () => {}, readFile, writeFile: write },
		});
		const fail = () => {
			throw new Error(`${stage} diff failed`);
		};
		if (stage === "display") vi.mocked(Diff.diffLines).mockImplementationOnce(fail);
		else vi.mocked(Diff.structuredPatch).mockImplementationOnce(fail);

		await expect(
			tool.execute(
				"diff-failure",
				{ file_path: path, old_string: exists ? "before" : "", new_string: "after" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow(`${stage} diff failed`);
		expect(write).not.toHaveBeenCalled();
		expect(readState.get(path)).toEqual(initialState);
		if (exists) expect(readFileSync(path).equals(Buffer.from("before\r\nuntouched\n"))).toBe(true);
		else expect(existsSync(path)).toBe(false);
	});
});
