import { describe, expect, it } from "vitest";
import { sliceHead, sliceTail, truncateLine } from "../src/core/tools/truncate.ts";

const emoji = "😀";
const hasLoneSurrogate = (text: string) =>
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);

describe("surrogate-safe truncation", () => {
	it("drops a character crossing the cutoff whole and retains one ending exactly there", () => {
		expect(truncateLine(`${"a".repeat(499)}${emoji}tail`).text).toBe(`${"a".repeat(499)}... [truncated]`);
		expect(truncateLine(`${"a".repeat(498)}${emoji}tail`).text).toBe(`${"a".repeat(498)}${emoji}... [truncated]`);
	});

	it("never creates an unpaired surrogate at either boundary", () => {
		for (const text of [emoji, `${emoji}x${emoji}`, `a${emoji}b${emoji}c`]) {
			for (let units = 0; units <= text.length + 1; units++) {
				const head = sliceHead(text, units);
				const tail = sliceTail(text, units);
				expect(hasLoneSurrogate(head)).toBe(false);
				expect(hasLoneSurrogate(tail)).toBe(false);
				expect(text.startsWith(head)).toBe(true);
				expect(text.endsWith(tail)).toBe(true);
				expect(head.length).toBeGreaterThanOrEqual(Math.min(units, text.length) - 1);
				expect(tail.length).toBeGreaterThanOrEqual(Math.min(units, text.length) - 1);
			}
		}
	});

	it("matches ordinary slicing without surrogate pairs", () => {
		for (const units of [-1, 0, 1, 3, 3.5, 10]) {
			expect(sliceHead("abcdef", units)).toBe("abcdef".slice(0, Math.max(0, units)));
			expect(sliceTail("abcdef", units)).toBe(units <= 0 ? "" : "abcdef".slice(-units));
		}
	});
});
