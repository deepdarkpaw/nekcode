import type { JsonValue } from "@earendil-works/chord";

/**
 * Normalize an arbitrary runtime value to strict JSON, the only shape durable documents and entries accept.
 *
 * Pi tool details and extension payloads are typed `unknown` and may hold `undefined` fields, `Date`s, class
 * instances, or functions. A JSON round trip drops what JSON cannot represent, the same way pi's JSONL session files
 * already persisted these values. Values JSON cannot encode at all (cycles, `BigInt`) become `null`.
 */
export function toStrictJson(value: unknown): JsonValue {
	if (value === undefined) return null;
	try {
		const encoded = JSON.stringify(value);
		return encoded === undefined ? null : (JSON.parse(encoded) as JsonValue);
	} catch {
		return null;
	}
}

/** Strict JSON object form of `value`; non-objects become an empty object. */
export function toStrictJsonObject(value: unknown): { [key: string]: JsonValue } {
	const json = toStrictJson(value);
	return json !== null && typeof json === "object" && !Array.isArray(json) ? json : {};
}
