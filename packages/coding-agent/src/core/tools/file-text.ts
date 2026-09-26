import { readFileSync } from "node:fs";
import { splitBom } from "../../utils/text.ts";
import { detectLineEnding, normalizeToLF } from "./edit-diff.ts";

/** Line ending style of a file. */
export type LineEnding = "\r\n" | "\n";

/** Content, encoding, and line endings of one file, read in a single pass. */
export interface FileTextMetadata {
	/** Content with the BOM removed and CRLF normalized to LF. */
	content: string;
	/** Detected BOM, `\uFEFF` for a UTF-8 BOM and `""` otherwise. */
	bom: string;
	/** Encoding the file was decoded with; write back with the same value. */
	encoding: BufferEncoding;
	/** Line ending style to restore when writing the file back. */
	lineEnding: LineEnding;
}

/** Number of leading bytes inspected when detecting the encoding (Claude Code reads 4096). */
const ENCODING_SAMPLE_BYTES = 4096;

/**
 * Encoding of a buffer: UTF-16LE when it starts with FF FE, otherwise UTF-8 (a UTF-8 BOM and empty files are
 * both UTF-8). Claude Code detectEncodingForResolvedPath.
 */
export function detectEncoding(buffer: Buffer): BufferEncoding {
	const head = buffer.subarray(0, ENCODING_SAMPLE_BYTES);
	if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) return "utf16le";
	return "utf8";
}

/**
 * Read one file and report its content, encoding, and line endings from the same bytes, so callers that write
 * the file back do not have to re-read it to detect them (Claude Code readFileSyncWithMetadata).
 */
export function readFileText(absolutePath: string): FileTextMetadata {
	const buffer = readFileSync(absolutePath);
	const encoding = detectEncoding(buffer);
	const decoded = buffer.toString(encoding);
	const { bom, text } = splitBom(decoded);
	return {
		content: normalizeToLF(text),
		bom,
		encoding,
		lineEnding: detectLineEnding(text),
	};
}
