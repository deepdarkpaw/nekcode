import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectEncoding, readFileText } from "../src/core/tools/file-text.ts";

describe("file text metadata", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-file-text-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("detects utf8 for a plain file", () => {
		expect(detectEncoding(Buffer.from("hello", "utf-8"))).toBe("utf8");
	});

	it("detects utf16le for a file starting with FF FE", () => {
		expect(detectEncoding(Buffer.from([0xff, 0xfe, 0x61, 0x00]))).toBe("utf16le");
	});

	it("reports utf8 for an empty file", () => {
		expect(detectEncoding(Buffer.alloc(0))).toBe("utf8");
	});

	it("reads a UTF-8 BOM file and reports the BOM separately", () => {
		const path = join(dir, "bom.txt");
		writeFileSync(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("hi\n", "utf-8")]));
		const metadata = readFileText(path);
		expect(metadata.content).toBe("hi\n");
		expect(metadata.bom).toBe("\uFEFF");
		expect(metadata.encoding).toBe("utf8");
		expect(metadata.lineEnding).toBe("\n");
	});

	it("normalizes CRLF content and reports the original line ending", () => {
		const path = join(dir, "crlf.txt");
		writeFileSync(path, "a\r\nb\r\n");
		const metadata = readFileText(path);
		expect(metadata.content).toBe("a\nb\n");
		expect(metadata.lineEnding).toBe("\r\n");
	});

	it("decodes a UTF-16LE file", () => {
		const path = join(dir, "utf16.txt");
		writeFileSync(path, Buffer.from("\uFEFFhello\n", "utf16le"));
		const metadata = readFileText(path);
		expect(metadata.encoding).toBe("utf16le");
		expect(metadata.content).toBe("hello\n");
		expect(metadata.bom).toBe("\uFEFF");
	});
});
