/**
 * Strict JSONL framing for the nek RPC protocol.
 *
 * Records are split on LF only, with an optional preceding CR removed. Node `readline` is not used
 * because it also splits on U+2028 and U+2029, which are valid inside JSON strings.
 */

import { StringDecoder } from "node:string_decoder";

/** One record as a JSON line terminated by LF. */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/** Incremental LF-only line splitter over UTF-8 chunks. Multi-byte characters may span chunks. */
export class JsonlDecoder {
	private readonly decoder = new StringDecoder("utf8");
	private buffer = "";

	/** Lines completed by this chunk, without their terminators. */
	push(chunk: string | Uint8Array): string[] {
		this.buffer += typeof chunk === "string" ? chunk : this.decoder.write(Buffer.from(chunk));
		const lines: string[] = [];
		let newline = this.buffer.indexOf("\n");
		while (newline !== -1) {
			lines.push(stripCr(this.buffer.slice(0, newline)));
			this.buffer = this.buffer.slice(newline + 1);
			newline = this.buffer.indexOf("\n");
		}
		return lines;
	}

	/** The unterminated last line at end of stream, if any. */
	end(): string[] {
		this.buffer += this.decoder.end();
		const rest = this.buffer;
		this.buffer = "";
		return rest.length > 0 ? [stripCr(rest)] : [];
	}
}

function stripCr(line: string): string {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** Parse one line into a JSON object, or undefined when it is blank, malformed, or not an object. */
export function parseRecord(line: string): Record<string, unknown> | undefined {
	if (line.trim() === "") return undefined;
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return undefined;
	}
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
