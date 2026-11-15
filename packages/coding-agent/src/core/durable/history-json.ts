import { closeSync, openSync, readSync } from "node:fs";

/** Random-access byte source. Readers retain at most one 64KiB chunk, never one JSONL line. */
export interface HistoryBytes {
	length: number;
	read(offset: number, length: number): Buffer;
	close(): void;
}
export function historyFileBytes(path: string, length: number): HistoryBytes {
	const fd = openSync(path, "r");
	return {
		length,
		read(offset, size) {
			const buffer = Buffer.alloc(Math.min(size, length - offset));
			let filled = 0;
			while (filled < buffer.length) {
				const count = readSync(fd, buffer, filled, buffer.length - filled, offset + filled);
				if (!count) throw new Error("History storage changed during read");
				filled += count;
			}
			return buffer;
		},
		close: () => closeSync(fd),
	};
}
export type JsonSpan = { start: number; end: number; path: (string | number)[]; value?: unknown };

/** Token walker with bounded key/scalar samples, nesting and chunk memory, including giant strings/arrays. */
export class HistoryJson {
	position = 0;
	#chunk: Buffer = Buffer.alloc(0);
	#chunkAt = 0;
	readonly source: HistoryBytes;
	/** Optional streaming decoded string chunks, with boundaries so search never joins unrelated fields. */
	onText?: (text: string, first: boolean) => void;
	constructor(source: HistoryBytes) {
		this.source = source;
	}
	byte(): number {
		if (this.position >= this.source.length) return -1;
		if (this.position < this.#chunkAt || this.position >= this.#chunkAt + this.#chunk.length) {
			this.#chunkAt = this.position;
			this.#chunk = this.source.read(this.position, 65536);
		}
		return this.#chunk[this.position - this.#chunkAt];
	}
	space(): void {
		while ([32, 10, 13, 9].includes(this.byte())) this.position++;
	}
	#string(key: boolean): string {
		this.position++;
		let sample = '"';
		let bytes = 0;
		let escaped = false;
		let unicode = 0;
		let truncated = false;
		let search = "";
		let first = true;
		const emit = () => {
			const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(search, "latin1"));
			this.onText?.(JSON.parse(`"${decoded}"`) as string, first);
			first = false;
			search = "";
		};
		for (;;) {
			const byte = this.byte();
			if (byte < 0 || byte < 32) throw new Error("Invalid history JSON string");
			this.position++;
			if (!escaped && !unicode && byte === 34) break;
			if (bytes++ < 2048) sample += String.fromCharCode(byte);
			else truncated = true;
			if (unicode) {
				if (!((byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102)))
					throw new Error("Invalid history JSON unicode escape");
				unicode--;
			} else if (escaped) {
				if (byte === 117) unicode = 4;
				else if (![34, 92, 47, 98, 102, 110, 114, 116].includes(byte))
					throw new Error("Invalid history JSON escape");
				escaped = false;
			} else if (byte === 92) escaped = true;
			if (this.onText && !key) {
				search += String.fromCharCode(byte);
				// An ASCII boundary cannot bisect a UTF8 code point or JSON escape.
				if (search.length >= 4096 && byte < 128 && !escaped && !unicode) emit();
				// Non-ASCII-only strings also flush on a complete UTF8 boundary.
				else if (search.length >= 8192 && !escaped && !unicode) {
					try {
						new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(search, "latin1"));
					} catch {
						if (search.length > 8196) throw new Error("Invalid UTF8 history string");
						continue;
					}
					emit();
				}
			}
		}
		if (this.onText && !key && search) emit();
		if (key && truncated) throw new Error("History JSON member name exceeds 2048 bytes");
		let prefix = Buffer.from(sample, "latin1").toString("utf8");
		if (truncated) {
			// Drop only an incomplete final escape; all complete escapes still decode identically to SQLite.
			for (let trim = 0; trim <= 6; trim++) {
				try {
					return (JSON.parse(`${prefix}"`) as string).slice(0, 256);
				} catch {
					prefix = prefix.slice(0, -1);
				}
			}
			throw new Error("Invalid history JSON prefix");
		}
		return JSON.parse(`${prefix}"`) as string;
	}
	walk(visit: (span: JsonSpan) => void, path: (string | number)[] = []): void {
		if (path.length > 48) throw new Error("History JSON nesting exceeds 48");
		this.space();
		const start = this.position;
		const byte = this.byte();
		let value: unknown;
		if (byte === 123 || byte === 91) {
			this.position++;
			this.space();
			const close = byte === 123 ? 125 : 93;
			let index = 0;
			while (this.byte() !== close) {
				let key: string | number = index++;
				if (byte === 123) {
					if (this.byte() !== 34) throw new Error("Invalid history JSON member");
					key = this.#string(true);
					this.space();
					if (this.byte() !== 58) throw new Error("Invalid history JSON colon");
					this.position++;
				}
				this.walk(visit, [...path, key]);
				this.space();
				if (this.byte() === close) break;
				if (this.byte() !== 44) throw new Error("Invalid history JSON separator");
				this.position++;
				this.space();
				if (this.byte() === close) throw new Error("Invalid history JSON trailing comma");
			}
			this.position++;
		} else if (byte === 34) value = this.#string(false);
		else {
			let token = "";
			while (this.byte() >= 0 && ![32, 10, 13, 9, 44, 93, 125].includes(this.byte())) {
				if (token.length >= 64) throw new Error("Invalid history JSON scalar");
				token += String.fromCharCode(this.byte());
				this.position++;
			}
			value = JSON.parse(token) as unknown;
		}
		visit({ start, end: this.position, path, value });
	}
}

/** Safe assignment: persisted keys must never mutate object prototypes. */
export function setHistoryPath(
	target: Record<string, unknown>,
	path: readonly (string | number)[],
	value: unknown,
): void {
	let cursor: Record<string | number, unknown> = target;
	for (let i = 0; i < path.length; i++) {
		const key = path[i];
		if (["__proto__", "constructor", "prototype"].includes(String(key)))
			throw new Error("Unsafe history JSON member");
		if (i === path.length - 1) cursor[key] = value;
		else {
			cursor[key] ??= typeof path[i + 1] === "number" ? [] : {};
			cursor = cursor[key] as Record<string | number, unknown>;
		}
	}
}
