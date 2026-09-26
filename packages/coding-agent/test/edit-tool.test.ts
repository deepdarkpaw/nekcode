import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { createReadStateStore, type ReadStateStore } from "../src/core/tools/read-state.ts";
import { createWriteToolDefinition } from "../src/core/tools/write.ts";

const tempDirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-edit-m7-"));
	tempDirs.push(dir);
	return dir;
}
function seed(store: ReadStateStore, path: string, content: string): void {
	store.set(path, { content, timestamp: Math.floor(statSync(path).mtimeMs), offset: undefined, limit: undefined });
}
function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((entry) => entry.text ?? "").join("\n");
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("M7 edit tool", () => {
	it("rejects an unread file and edits after a seeded read", async () => {
		const dir = tempDir();
		const path = join(dir, "file.txt");
		writeFileSync(path, "before\n");
		const store = createReadStateStore();
		const tool = createEditToolDefinition(dir, { readState: store });
		await expect(
			tool.execute(
				"unread",
				{ file_path: path, old_string: "before", new_string: "after" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("File has not been read yet");
		seed(store, path, "before\n");
		const result = await tool.execute(
			"read",
			{ file_path: path, old_string: "before", new_string: "after" },
			undefined,
			undefined,
			{} as never,
		);
		expect(text(result)).toContain("updated successfully");
		expect(readFileSync(path, "utf8")).toBe("after\n");
	});

	it("rejects write overwrite until the existing file is read", async () => {
		const dir = tempDir();
		const path = join(dir, "write.txt");
		writeFileSync(path, "before\n");
		const store = createReadStateStore();
		const tool = createWriteToolDefinition(dir, { readState: store });
		await expect(
			tool.execute("unread-write", { path, content: "after\n" }, undefined, undefined, {} as never),
		).rejects.toThrow("File has not been read yet");
		seed(store, path, "before\n");
		await tool.execute("read-write", { path, content: "after\n" }, undefined, undefined, {} as never);
		expect(readFileSync(path, "utf8")).toBe("after\n");
	});
	it("requires uniqueness unless replace_all is enabled", async () => {
		const dir = tempDir();
		const path = join(dir, "repeat.txt");
		writeFileSync(path, "x x\n");
		const store = createReadStateStore();
		seed(store, path, "x x\n");
		const tool = createEditToolDefinition(dir, { readState: store });
		const args = { file_path: path, old_string: "x", new_string: "y" };
		await expect(tool.execute("one", args, undefined, undefined, {} as never)).rejects.toThrow("Found 2 matches");
		await tool.execute("all", { ...args, replace_all: "true" }, undefined, undefined, {} as never);
		expect(readFileSync(path, "utf8")).toBe("y y\n");
	});

	it("preserves literal replacement tokens and removes the following newline", async () => {
		const dir = tempDir();
		const path = join(dir, "special.txt");
		writeFileSync(path, "one\ntwo\n");
		const store = createReadStateStore();
		seed(store, path, "one\ntwo\n");
		const tool = createEditToolDefinition(dir, { readState: store });
		await tool.execute(
			"tokens",
			{ file_path: path, old_string: "one", new_string: "$&-$1-$$" },
			undefined,
			undefined,
			{} as never,
		);
		seed(store, path, "$&-$1-$$two\n");
		await tool.execute(
			"delete",
			{ file_path: path, old_string: "$&-$1-$$", new_string: "" },
			undefined,
			undefined,
			{} as never,
		);
		expect(readFileSync(path, "utf8")).toBe("two\n");
	});

	it("preserves CRLF, UTF-8 BOM, and UTF-16LE encoding", async () => {
		const dir = tempDir();
		const crlf = join(dir, "crlf.txt");
		writeFileSync(crlf, Buffer.from("\uFEFFone\r\ntwo\r\n", "utf8"));
		const store = createReadStateStore();
		seed(store, crlf, "one\ntwo\n");
		const tool = createEditToolDefinition(dir, { readState: store });
		await tool.execute(
			"crlf",
			{ file_path: crlf, old_string: "one", new_string: "ONE" },
			undefined,
			undefined,
			{} as never,
		);
		const crlfBytes = readFileSync(crlf);
		expect(crlfBytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
		expect(crlfBytes.toString("utf8")).toBe("\uFEFFONE\r\ntwo\r\n");

		const utf16 = join(dir, "utf16.txt");
		writeFileSync(utf16, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("one\r\ntwo\r\n", "utf16le")]));
		seed(store, utf16, "one\ntwo\n");
		await tool.execute(
			"utf16",
			{ file_path: utf16, old_string: "two", new_string: "TWO" },
			undefined,
			undefined,
			{} as never,
		);
		const bytes = readFileSync(utf16);
		expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
		expect(bytes.toString("utf16le")).toContain("TWO");
	});

	it("rejects stale content but tolerates an unchanged full read mtime", async () => {
		const dir = tempDir();
		const path = join(dir, "stale.txt");
		writeFileSync(path, "before\n");
		const store = createReadStateStore();
		seed(store, path, "before\n");
		const tool = createEditToolDefinition(dir, { readState: store });
		writeFileSync(path, "changed\n");
		utimesSync(path, new Date(), new Date(Date.now() + 2000));
		await expect(
			tool.execute(
				"stale",
				{ file_path: path, old_string: "changed", new_string: "new" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("modified since read");
		writeFileSync(path, "before\n");
		seed(store, path, "before\n");
		utimesSync(path, new Date(), new Date(Date.now() + 2000));
		await tool.execute(
			"mtime",
			{ file_path: path, old_string: "before", new_string: "after" },
			undefined,
			undefined,
			{} as never,
		);
		expect(readFileSync(path, "utf8")).toBe("after\n");
	});

	it("rejects directories and supports new files", async () => {
		const dir = tempDir();
		const store = createReadStateStore();
		const tool = createEditToolDefinition(dir, { readState: store });
		await expect(
			tool.execute(
				"directory",
				{ file_path: dir, old_string: "x", new_string: "y" },
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("existing directory");
		const path = join(dir, "new.txt");
		await tool.execute(
			"new",
			{ file_path: path, old_string: "", new_string: "created" },
			undefined,
			undefined,
			{} as never,
		);
		expect(readFileSync(path, "utf8")).toBe("created");
	});

	it.skipIf(process.platform === "win32")("edits through a symlink and preserves its target mode", async () => {
		const dir = tempDir();
		const target = join(dir, "target.txt");
		const link = join(dir, "link.txt");
		writeFileSync(target, "before\n");
		try {
			symlinkSync(target, link);
		} catch {
			return;
		}
		const mode = statSync(target).mode & 0o777;
		const store = createReadStateStore();
		seed(store, link, "before\n");
		const tool = createEditToolDefinition(dir, { readState: store });
		await tool.execute(
			"symlink",
			{ file_path: link, old_string: "before", new_string: "after" },
			undefined,
			undefined,
			{} as never,
		);
		expect(readFileSync(target, "utf8")).toBe("after\n");
		expect(statSync(link).isSymbolicLink()).toBe(true);
		expect(statSync(target).mode & 0o777).toBe(mode);
	});
});
