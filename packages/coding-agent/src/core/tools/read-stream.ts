import { open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { splitBom } from "../../utils/text.ts";
import { normalizeToLF } from "./edit-diff.ts";
import { detectEncoding } from "./file-text.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult } from "./truncate.ts";

/** A fresh byte stream for each call; negative offsets require two passes over the same file. */
export type ReadStreamFactory = (absolutePath: string, options: { signal?: AbortSignal }) => AsyncIterable<Uint8Array>;

/** Stream a regular file only up to its opening size, like readFile, including files that keep growing. */
export async function* readLocalFileChunks(
	path: string,
	{ signal }: { signal?: AbortSignal },
): AsyncIterable<Uint8Array> {
	if (signal?.aborted) throw new Error("Operation aborted");
	const handle = await open(path, "r");
	try {
		if (signal?.aborted) throw new Error("Operation aborted");
		const stats = await handle.stat();
		const end = stats.isFile() && stats.size > 0 ? stats.size - 1 : undefined;
		yield* handle.createReadStream({ end, signal, autoClose: false });
	} finally {
		await handle.close();
	}
}

/** Decode like Buffer.toString(detectEncoding()), removing one BOM and normalizing CRLF and lone CR. */
async function* decodeChunks(chunks: AsyncIterable<Uint8Array>, signal?: AbortSignal): AsyncIterable<string> {
	let decoder: StringDecoder | undefined;
	let probe = Buffer.alloc(0);
	let firstText = true;
	let skipLF = false;
	let highSurrogate = "";
	const normalize = (decoded: string, final = false): string => {
		let text = highSurrogate + decoded;
		highSurrogate = "";
		const last = text.charCodeAt(text.length - 1);
		// StringDecoder can emit UTF-16 surrogate halves separately for odd-sized byte chunks. Keep
		// one code unit pending so UTF-8 byte counts and truncation measure the joined character.
		if (!final && last >= 0xd800 && last <= 0xdbff) {
			highSurrogate = text.slice(-1);
			text = text.slice(0, -1);
		}
		if (text.length === 0) return "";
		if (firstText) text = splitBom(text).text;
		firstText = false;
		if (text.length === 0) return "";
		if (skipLF && text.startsWith("\n")) text = text.slice(1);
		skipLF = text.endsWith("\r");
		return normalizeToLF(text);
	};
	try {
		for await (const chunk of chunks) {
			if (signal?.aborted) throw new Error("Operation aborted");
			let bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
			if (!decoder) {
				const needed = Math.min(2 - probe.length, bytes.length);
				probe = Buffer.concat([probe, bytes.subarray(0, needed)]);
				bytes = bytes.subarray(needed);
				if (probe.length < 2) continue;
				decoder = new StringDecoder(detectEncoding(probe));
				yield normalize(decoder.write(probe));
			}
			yield normalize(decoder.write(bytes));
		}
		if (signal?.aborted) throw new Error("Operation aborted");
		if (!decoder) {
			decoder = new StringDecoder(detectEncoding(probe));
			yield normalize(decoder.write(probe));
		}
		yield normalize(decoder.end(), true);
	} catch (error) {
		if (signal?.aborted) throw new Error("Operation aborted");
		throw error;
	}
}

/** Bounded selected output and exact counts of the normalized file and numbered selection. */
export interface StreamedRead {
	totalFileLines: number;
	totalCharacters: number;
	firstLineBytes: number;
	truncation: TruncationResult;
	/** Complete normalized content only for small files; larger reads record evidence without caching text. */
	fullContent: string | undefined;
}

/**
 * Scan every line for accurate counts, keeping at most the output budget plus one decoder chunk.
 * Even a selected multi-GB single line is measured without retaining it. File line counts deliberately
 * follow split("\n"), so an empty file has one line and a trailing newline adds an empty final line.
 */
export async function selectReadStream(
	chunks: AsyncIterable<Uint8Array>,
	startLine: number,
	limit: number | undefined,
	signal?: AbortSignal,
): Promise<StreamedRead> {
	const endLine = limit === undefined ? Number.POSITIVE_INFINITY : startLine + Math.max(0, limit);
	const output: string[] = [];
	let outputBytes = 0;
	let selectedLines = 0;
	let selectedBytes = 0;
	let firstLineBytes = 0;
	let truncatedBy: "lines" | "bytes" | null = null;
	let line = 0;
	let lineBytes = 0;
	let pieces: string[] = [];
	let totalCharacters = 0;
	let contentBytes = 0;
	let contentPieces: string[] | undefined = [];

	const selected = () => line >= startLine && line < endLine;
	const append = (piece: string) => {
		if (!selected()) return;
		lineBytes += Buffer.byteLength(piece, "utf-8");
		if (truncatedBy || output.length >= DEFAULT_MAX_LINES) return;
		const prefixBytes = Math.max(6, String(line + 1).length) + 1;
		if (outputBytes + (output.length > 0 ? 1 : 0) + prefixBytes + lineBytes <= DEFAULT_MAX_BYTES) {
			pieces.push(piece);
		} else {
			pieces = [];
		}
	};
	const finishLine = () => {
		if (selected()) {
			if (selectedLines === 0) firstLineBytes = lineBytes;
			const prefix = `${String(line + 1).padStart(6, " ")}|`;
			const rowBytes = prefix.length + lineBytes;
			selectedBytes += (selectedLines > 0 ? 1 : 0) + rowBytes;
			selectedLines++;
			if (!truncatedBy) {
				if (output.length >= DEFAULT_MAX_LINES) truncatedBy = "lines";
				else if (outputBytes + (output.length > 0 ? 1 : 0) + rowBytes > DEFAULT_MAX_BYTES) truncatedBy = "bytes";
				else {
					outputBytes += (output.length > 0 ? 1 : 0) + rowBytes;
					output.push(prefix + pieces.join(""));
				}
			}
		}
		line++;
		lineBytes = 0;
		pieces = [];
	};

	for await (const text of decodeChunks(chunks, signal)) {
		totalCharacters += text.length;
		if (contentPieces) {
			contentBytes += Buffer.byteLength(text, "utf-8");
			if (contentBytes <= DEFAULT_MAX_BYTES) {
				if (text.length > 0) contentPieces.push(text);
			} else contentPieces = undefined;
		}
		let position = 0;
		while (position < text.length) {
			const newline = text.indexOf("\n", position);
			if (newline === -1) {
				append(text.slice(position));
				break;
			}
			append(text.slice(position, newline));
			finishLine();
			position = newline + 1;
		}
	}
	finishLine();
	return {
		totalFileLines: line,
		totalCharacters,
		firstLineBytes,
		fullContent: contentPieces?.join(""),
		truncation: {
			content: output.join("\n"),
			truncated: truncatedBy !== null,
			truncatedBy,
			totalLines: selectedLines,
			totalBytes: selectedBytes,
			outputLines: output.length,
			outputBytes,
			lastLinePartial: false,
			firstLineExceedsLimit:
				selectedLines > 0 && firstLineBytes + Math.max(6, String(startLine + 1).length) + 1 > DEFAULT_MAX_BYTES,
			maxLines: DEFAULT_MAX_LINES,
			maxBytes: DEFAULT_MAX_BYTES,
		},
	};
}
