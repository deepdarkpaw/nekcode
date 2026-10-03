import { describe, expect, it } from "vitest";
import { sanitizeBinaryOutput } from "../src/utils/shell.ts";

describe("sanitizeBinaryOutput", () => {
	it("matches the previous filter for every UTF-16 code unit", () => {
		const source = Array.from({ length: 0x10000 }, (_, code) => String.fromCharCode(code)).join("");
		const expected = Array.from(source)
			.filter((char) => {
				const code = char.codePointAt(0)!;
				return code === 0x09 || code === 0x0a || code === 0x0d || (code > 0x1f && (code < 0xfff9 || code > 0xfffb));
			})
			.join("");
		expect(sanitizeBinaryOutput(source)).toBe(expected);
	});

	it("preserves surrogate pairs, lone surrogates, and allowed whitespace", () => {
		const source = "\uD83D\uDE00\uD800x\uDC00\t\n\r";
		expect(sanitizeBinaryOutput(source)).toBe(source);
		expect(sanitizeBinaryOutput(`\0${source}\uFFF9\uFFFA\uFFFB\x1b`)).toBe(source);
	});
});
