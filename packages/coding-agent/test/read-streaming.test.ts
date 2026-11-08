import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it, vi } from "vitest";
import { normalizeToLF } from "../src/core/tools/edit-diff.ts";
import { detectEncoding } from "../src/core/tools/file-text.ts";
import { createReadToolDefinition, type ReadOperations } from "../src/core/tools/read.ts";
import { createReadStateStore } from "../src/core/tools/read-state.ts";
import { readLocalFileChunks, selectReadStream } from "../src/core/tools/read-stream.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "../src/core/tools/truncate.ts";
import { splitBom } from "../src/utils/text.ts";

const workspaceTmp = fileURLToPath(new URL("../../../.tmp/", import.meta.url));
mkdirSync(workspaceTmp, { recursive: true });
const directory = mkdtempSync(join(workspaceTmp, "read-streaming-"));
const fixture = join(directory, "fixture.log");
afterAll(() => rmSync(directory, { recursive: true, force: true }));

async function* chunked(bytes: Buffer, size: number): AsyncIterable<Uint8Array> {
	for (let position = 0; position < bytes.length; position += size) yield bytes.subarray(position, position + size);
}

function operations(bytes: Buffer, size?: number): ReadOperations {
	return {
		access: async () => {},
		readFile: async () => {
			if (size !== undefined) throw new Error("Streaming text must not call readFile");
			return bytes;
		},
		...(size === undefined ? {} : { createReadStream: () => chunked(bytes, size) }),
	};
}

async function outcome(ops: ReadOperations, offset?: number, limit?: number) {
	const tool = createReadToolDefinition(directory, { operations: ops });
	try {
		return await tool.execute("read", { path: fixture, offset, limit }, undefined, undefined, undefined as never);
	} catch (error) {
		return { error: (error as Error).message };
	}
}

const shortCases = {
	empty: Buffer.alloc(0),
	"trailing newline": Buffer.from("alpha\nbeta\n"),
	"empty final lines": Buffer.from("alpha\n\n\n"),
	"CRLF and lone CR": Buffer.from("\uFEFFalpha\r\nbeta\rgamma\r\n\r\r\nend\r"),
	"UTF-8 across chunks": Buffer.from("\uFEFFaé€😀\n字𐍈\r\n😀\r尾"),
	"invalid UTF-8": Buffer.from([0x61, 0xc3, 0x0a, 0xe2, 0x82, 0x0a, 0xff, 0x80, 0xf0, 0x9f, 0x98, 0x0a]),
	"UTF-16LE BOM": Buffer.from("\uFEFFé€😀\r\n字𐍈\r尾\r\n", "utf16le"),
	"UTF-16LE odd byte and unpaired surrogates": Buffer.concat([
		Buffer.from("\uFEFFa\ud800b\r\n\udc00\ud800", "utf16le"),
		Buffer.from([0xff]),
	]),
};
const longCases = {
	"2000 lines": Array.from({ length: 2000 }, () => "a").join("\n"),
	"2001 lines, blank line and more": `${Array.from({ length: 2001 }, () => "a").join("\n")}\n\nmore`,
	"first line exceeds byte cap": `${"é".repeat(DEFAULT_MAX_BYTES / 2)}\nnext`,
	"later line exceeds byte cap": `a\nb\n${"x".repeat(60 * 1024)}\nlast\n`,
	"numbered line exactly byte cap": `${"x".repeat(DEFAULT_MAX_BYTES - 7)}\n`,
	"numbered line below byte cap": `${"x".repeat(DEFAULT_MAX_BYTES - 8)}\n\nmore`,
	"multibyte byte truncation": Array.from({ length: 600 }, (_, index) => `${index} ${"€😀".repeat(20)}`).join("\n"),
};

describe("bounded read streaming", () => {
	it.each(Object.entries(shortCases))("matches the whole-file text path: %s", async (_name, bytes) => {
		for (const offset of [undefined, 0, 1, 2, 4, 50, -1, -3, -50]) {
			for (const limit of [undefined, -1, 0, 1, 4]) {
				const expected = await outcome(operations(bytes), offset, limit);
				for (const size of [1, 2, 3, 4096]) {
					expect(
						await outcome(operations(bytes, size), offset, limit),
						`offset=${offset}, limit=${limit}, chunk=${size}`,
					).toEqual(expected);
				}
			}
		}
	});

	it.each(Object.entries(longCases))("matches old limits and continuation metadata: %s", async (_name, text) => {
		const bytes = Buffer.from(text);
		const total = text.split("\n").length;
		for (const offset of [undefined, 1, 2, total, total + 1, -1, -total, -total - 1]) {
			for (const limit of [undefined, 0, 1, 2000]) {
				const expected = await outcome(operations(bytes), offset, limit);
				for (const size of [317, 65536]) {
					expect(
						await outcome(operations(bytes, size), offset, limit),
						`offset=${offset}, limit=${limit}, chunk=${size}`,
					).toEqual(expected);
				}
			}
		}
	});

	it("counts decoded UTF-16 units, numbered UTF-8 bytes and physical lines exactly", async () => {
		for (const bytes of Object.values(shortCases)) {
			const text = normalizeToLF(splitBom(bytes.toString(detectEncoding(bytes))).text);
			const numbered = text
				.split("\n")
				.map((line, index) => `${String(index + 1).padStart(6, " ")}|${line}`)
				.join("\n");
			for (const size of [1, 2, 3]) {
				const result = await selectReadStream(chunked(bytes, size), 0, undefined);
				expect(result.totalFileLines).toBe(text.split("\n").length);
				expect(result.totalCharacters).toBe(text.length);
				expect(result.truncation.totalBytes).toBe(Buffer.byteLength(numbered, "utf8"));
				expect(result.fullContent).toBe(text);
			}
		}
	});

	it("matches byte truncation and continuation for a large UTF-16LE file across chunk boundaries", async () => {
		const bytes = Buffer.from(
			`\uFEFF${Array.from({ length: 600 }, (_, index) => `${index} ${"€😀".repeat(20)}`).join("\r\n")}\r`,
			"utf16le",
		);
		for (const offset of [1, -500]) {
			for (const limit of [undefined, 1]) {
				const expected = await outcome(operations(bytes), offset, limit);
				for (const size of [1, 17, 4096])
					expect(await outcome(operations(bytes, size), offset, limit)).toEqual(expected);
			}
		}
	});

	it("uses two fresh streams for negative offsets and keeps small normalized read-state content", async () => {
		const bytes = Buffer.from("\uFEFFone\r\ntwo\rthree\n", "utf16le");
		const ops = operations(bytes, 1);
		const stream = vi.fn(ops.createReadStream!);
		const state = createReadStateStore();
		const tool = createReadToolDefinition(directory, {
			operations: { ...ops, createReadStream: stream },
			readState: state,
		});
		const result = await tool.execute(
			"read",
			{ path: fixture, offset: -2, limit: 1 },
			undefined,
			undefined,
			undefined as never,
		);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "     3|three\n\n[1 more lines in file. Use offset=4 to continue.]",
		});
		expect(stream).toHaveBeenCalledTimes(2);
		expect(state.get(fixture)).toMatchObject({ content: "one\ntwo\nthree\n", offset: -2, limit: 1 });
	});

	it("records large reads as evidence without caching their full text", async () => {
		const state = createReadStateStore();
		const bytes = Buffer.from(`first\n${"x".repeat(2 * DEFAULT_MAX_BYTES)}`);
		const tool = createReadToolDefinition(directory, { operations: operations(bytes, 1024), readState: state });
		await tool.execute("read", { path: fixture, limit: 1 }, undefined, undefined, undefined as never);
		expect(state.get(fixture)).toMatchObject({ content: "", limit: 1 });
	});

	it("counts numbered bytes and reports the physical continuation line at exact boundaries", async () => {
		const bytes = Buffer.from(Array.from({ length: 2001 }, () => "a").join("\n"));
		const result = await outcome(operations(bytes, 13), 1);
		if ("error" in result) throw new Error(result.error);
		expect(result.details?.truncation).toMatchObject({
			totalLines: 2001,
			totalBytes: 2001 * 9 - 1,
			outputLines: 2000,
			truncatedBy: "lines",
		});
		expect(result.content[0]).toMatchObject({
			text: expect.stringContaining("[Showing lines 1-2000 of 2001. Use offset=2001 to continue.]"),
		});
	});

	it("reads local encoded files through the default range and non-outline paths", async () => {
		const path = join(directory, "local.log");
		const tool = createReadToolDefinition(directory);
		for (const bytes of Object.values(shortCases)) {
			writeFileSync(path, bytes);
			for (const range of [{}, { offset: 1, limit: 2 }, { offset: -1 }]) {
				const expected = await outcome(operations(bytes), range.offset, "limit" in range ? range.limit : undefined);
				const actual = await tool.execute("read", { path, ...range }, undefined, undefined, undefined as never);
				expect(actual).toEqual(expected);
			}
		}
		await expect(
			tool.execute("read", { path: directory, limit: 1 }, undefined, undefined, undefined as never),
		).rejects.toThrow(/EISDIR|illegal operation/i);
	});

	it("bounds a growing local file at its opening size and closes the stream", async () => {
		const path = join(directory, "growing.log");
		writeFileSync(path, `head\n${"x".repeat(200_000)}`);
		const chunks = readLocalFileChunks(path, {})[Symbol.asyncIterator]();
		let size = (await chunks.next()).value?.byteLength ?? 0;
		appendFileSync(path, "\nappended");
		for (;;) {
			const chunk = await chunks.next();
			if (chunk.done) break;
			size += chunk.value.byteLength;
		}
		expect(size).toBe(200_005);
	});

	it.each([1, -1])("passes abort to the stream and destroys it during offset %s", async (offset) => {
		const controller = new AbortController();
		let pulled = 0;
		let closed = false;
		let stream: Readable | undefined;
		const state = createReadStateStore();
		const ops: ReadOperations = {
			readFile: async () => {
				throw new Error("Unexpected readFile");
			},
			access: async () => {},
			createReadStream(_path, { signal }) {
				expect(signal).toBe(controller.signal);
				stream = Readable.from(
					(async function* () {
						try {
							while (true) {
								pulled++;
								if (pulled === 3) controller.abort();
								yield Buffer.from("line\n");
							}
						} finally {
							closed = true;
						}
					})(),
					{ signal },
				);
				return stream;
			},
		};
		const tool = createReadToolDefinition(directory, { operations: ops, readState: state });
		await expect(
			tool.execute("read", { path: fixture, offset }, controller.signal, undefined, undefined as never),
		).rejects.toThrow("Operation aborted");
		expect(stream?.destroyed).toBe(true);
		expect(closed).toBe(true);
		expect(pulled).toBeLessThanOrEqual(4);
		expect(state.get(fixture)).toBeUndefined();
	});

	it("aborts and closes a real local stream", async () => {
		const path = join(directory, "abort.log");
		writeFileSync(path, "x".repeat(200_000));
		const controller = new AbortController();
		const chunks = readLocalFileChunks(path, { signal: controller.signal })[Symbol.asyncIterator]();
		await chunks.next();
		controller.abort();
		await expect(chunks.next()).rejects.toMatchObject({ name: "AbortError" });
		writeFileSync(path, "closed");
	});

	it("reads a 200 MB single line and a large local log with a 64 MB heap", () => {
		const readToolUrl = new URL("../src/core/tools/read.ts", import.meta.url).href;
		const sourceResolverUrl = new URL("../src/experimental/source-resolver.ts", import.meta.url).href;
		const script = `
			import { openSync, writeSync, closeSync, rmSync } from 'node:fs';
			import { createReadToolDefinition } from ${JSON.stringify(readToolUrl)};
			const chunk = Buffer.alloc(64 * 1024, 'x');
			async function* createReadStream() { for (let i = 0; i < 3200; i++) yield chunk; }
			const operations = { access: async () => {}, readFile: async () => { throw new Error('readFile'); }, createReadStream };
			const big = await createReadToolDefinition(process.cwd(), { operations }).execute('read', { path: 'big.log', offset: 1 });
			if (!big.content[0].text.includes('200.0MB')) throw new Error(big.content[0].text);
			const path = ${JSON.stringify(join(directory, "heap.log"))};
			const fd = openSync(path, 'w');
			const logChunk = Buffer.from('log row abcdefghijklmnopqrstuvwxyz\\n'.repeat(2048));
			try { for (let i = 0; i < 1536; i++) writeSync(fd, logChunk); } finally { closeSync(fd); }
			try {
				const tool = createReadToolDefinition(process.cwd());
				for (const offset of [1, -2]) {
					const read = await tool.execute('read', { path, offset, limit: 1 });
					if (!read.content[0].text.includes('log row')) throw new Error(read.content[0].text);
				}
			} finally { rmSync(path, { force: true }); }
			process.stdout.write('bounded');
		`;
		expect(
			execFileSync(
				process.execPath,
				["--max-old-space-size=64", "--import", sourceResolverUrl, "--input-type=module", "--eval", script],
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

	it("bounds fixed-window metadata for enormous non-outline files", async () => {
		const ops: ReadOperations = {
			access: async () => {},
			readFile: async () => {
				throw new Error("Unexpected readFile");
			},
			async *createReadStream() {
				const chunk = Buffer.from("x\n".repeat(1000));
				for (let index = 0; index < 110; index++) yield chunk;
			},
		};
		const result = await outcome(ops);
		if ("error" in result) throw new Error(result.error);
		expect(result.details?.representation).toBe("50-line");
		expect(result.details?.chunks).toHaveLength(DEFAULT_MAX_LINES);
		expect(result.details?.truncation?.totalLines).toBe(110_001);
	});
});
