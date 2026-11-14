/** JSON encoding in bounded slices, never a whole giant string/object serialization followed by slicing. */
function* stringTokens(value: string): Generator<string> {
	yield '"';
	for (let start = 0; start < value.length; ) {
		let end = Math.min(value.length, start + 8192);
		if (
			end < value.length &&
			value.charCodeAt(end - 1) >= 0xd800 &&
			value.charCodeAt(end - 1) <= 0xdbff &&
			value.charCodeAt(end) >= 0xdc00 &&
			value.charCodeAt(end) <= 0xdfff
		)
			end--;
		yield JSON.stringify(value.slice(start, end)).slice(1, -1);
		start = end;
	}
	yield '"';
}
function* tokens(input: unknown, ancestors: Set<object>): Generator<string> {
	if (
		input &&
		typeof input === "object" &&
		!(input instanceof Date) &&
		"toJSON" in input &&
		typeof input.toJSON === "function"
	)
		throw new Error("Custom toJSON is not a JSON-safe live event value");
	const value = input instanceof Date ? input.toJSON() : input;
	if (typeof value === "string") {
		yield* stringTokens(value);
		return;
	}
	if (typeof value === "number" || typeof value === "boolean" || value === null) {
		yield JSON.stringify(value);
		return;
	}
	if (typeof value === "bigint") throw new Error("BigInt is not JSON serializable");
	if (typeof value !== "object") {
		yield "null";
		return;
	}
	if (ancestors.size >= 64 || ancestors.has(value)) throw new Error("Live event JSON nesting/cycle limit exceeded");
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			yield "[";
			for (let index = 0; index < value.length; index++) {
				if (index) yield ",";
				yield* tokens(value[index], ancestors);
			}
			yield "]";
			return;
		}
		yield "{";
		let first = true;
		// Do not allocate Object.keys for a large structured tool result.
		for (const key in value) {
			if (!Object.hasOwn(value, key)) continue;
			const member = (value as Record<string, unknown>)[key];
			if (member === undefined || typeof member === "function" || typeof member === "symbol") continue;
			if (!first) yield ",";
			first = false;
			yield* stringTokens(key);
			yield ":";
			yield* tokens(member, ancestors);
		}
		yield "}";
	} finally {
		ancestors.delete(value);
	}
}
/** Raw JSON UTF8 bytes. Chunk boundaries may bisect UTF8/escape sequences; the wire uses base64. */
export function* historyJsonChunks(value: unknown): Generator<Buffer> {
	const maxBytes = 49152;
	let chunk = Buffer.allocUnsafe(maxBytes);
	let size = 0;
	for (const token of tokens(value, new Set())) {
		const buffer = Buffer.from(token, "utf8");
		for (let offset = 0; offset < buffer.length; ) {
			const length = Math.min(maxBytes - size, buffer.length - offset);
			buffer.copy(chunk, size, offset, offset + length);
			size += length;
			offset += length;
			if (size === maxBytes) {
				yield chunk;
				chunk = Buffer.allocUnsafe(maxBytes);
				size = 0;
			}
		}
	}
	if (size) yield chunk.subarray(0, size);
}
