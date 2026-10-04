import { describe, expect, test } from "bun:test";
import { CURSOR_MARKER } from "@earendil-works/pi-tui";
import { TextAttributes } from "@opentui/core";
import { ansiLinesToStyledText, parseAnsiLine, parseAnsiLines, segmentToChunk } from "../../src/bridge/ansi.ts";

const ESC = "\x1b";

describe("parseAnsiLine", () => {
	test("plain text is one unstyled segment", () => {
		const line = parseAnsiLine("hello world");
		expect(line.segments).toHaveLength(1);
		expect(line.segments[0]?.text).toBe("hello world");
		expect(line.segments[0]?.style.fg).toBeUndefined();
		expect(line.width).toBe(11);
	});

	test("16-color foreground and background, including bright variants", () => {
		const line = parseAnsiLine(`${ESC}[31mred${ESC}[0m ${ESC}[92;44mbright${ESC}[0m`);
		const [red, space, bright] = line.segments;
		expect(red?.style.fg).toEqual({ kind: "indexed", index: 1 });
		expect(space?.text).toBe(" ");
		expect(space?.style.fg).toBeUndefined();
		expect(bright?.style.fg).toEqual({ kind: "indexed", index: 10 });
		expect(bright?.style.bg).toEqual({ kind: "indexed", index: 4 });
	});

	test("256-color and truecolor, semicolon and colon forms", () => {
		const line = parseAnsiLine(
			`${ESC}[38;5;208ma${ESC}[48;2;10;20;30mb${ESC}[0m${ESC}[38:2::1:2:3mc${ESC}[38:5:99md${ESC}[39me`,
		);
		const styles = line.segments.map((segment) => [segment.text, segment.style.fg, segment.style.bg]);
		expect(styles[0]).toEqual(["a", { kind: "indexed", index: 208 }, undefined]);
		expect(styles[1]).toEqual(["b", { kind: "indexed", index: 208 }, { kind: "rgb", r: 10, g: 20, b: 30 }]);
		expect(styles[2]).toEqual(["c", { kind: "rgb", r: 1, g: 2, b: 3 }, undefined]);
		expect(styles[3]).toEqual(["d", { kind: "indexed", index: 99 }, undefined]);
		expect(styles[4]).toEqual(["e", undefined, undefined]);
	});

	test("attributes set and reset individually", () => {
		const line = parseAnsiLine(
			`${ESC}[1;2;3;4;7;9mall${ESC}[22mnobolddim${ESC}[23;24;27;29mplain${ESC}[1mb${ESC}[mreset`,
		);
		const [all, noBoldDim, plain, bold, reset] = line.segments;
		expect(all?.style).toMatchObject({
			bold: true,
			dim: true,
			italic: true,
			underline: true,
			inverse: true,
			strikethrough: true,
		});
		expect(noBoldDim?.style).toMatchObject({ bold: false, dim: false, italic: true });
		expect(plain?.style).toMatchObject({ italic: false, underline: false, inverse: false, strikethrough: false });
		expect(bold?.style.bold).toBe(true);
		expect(reset?.style.bold).toBe(false);
	});

	test("OSC 8 hyperlinks with BEL and ST terminators", () => {
		const line = parseAnsiLine(
			`see ${ESC}]8;;https://example.com\x07link${ESC}]8;;\x07 and ${ESC}]8;id=1;https://b.dev${ESC}\\b${ESC}]8;;${ESC}\\`,
		);
		const linked = line.segments.filter((segment) => segment.style.link);
		expect(linked.map((segment) => [segment.text, segment.style.link])).toEqual([
			["link", "https://example.com"],
			["b", "https://b.dev"],
		]);
		expect(line.segments.map((segment) => segment.text).join("")).toBe("see link and b");
	});

	test("cursor marker position is recorded and not rendered", () => {
		const line = parseAnsiLine(`> ab${CURSOR_MARKER}${ESC}[7m ${ESC}[27m`);
		expect(line.cursorColumn).toBe(4);
		expect(line.segments.map((segment) => segment.text).join("")).toBe("> ab ");
	});

	test("other escapes and control characters are dropped, tabs expand", () => {
		const line = parseAnsiLine(`${ESC}[2Ka${ESC}_Gf=100;AAAA${ESC}\\b${ESC}]133;A\x07c\x01\td`);
		expect(line.segments.map((segment) => segment.text).join("")).toBe("abc   d");
	});

	test("wide characters count two cells", () => {
		expect(parseAnsiLine("中文").width).toBe(4);
	});
});

describe("parseAnsiLines", () => {
	test("each line starts with fresh state and the first cursor marker wins", () => {
		const parsed = parseAnsiLines([`${ESC}[31mred`, `x${CURSOR_MARKER}y`, `z${CURSOR_MARKER}`]);
		expect(parsed.lines[1]?.segments[0]?.style.fg).toBeUndefined();
		expect(parsed.cursor).toEqual({ row: 1, col: 1 });
	});
});

describe("conversion to OpenTUI chunks", () => {
	test("segment chunk carries colors, attributes, and link", () => {
		const [segment] = parseAnsiLine(`${ESC}[1;4;38;2;255;0;0m${ESC}]8;;https://x.y\x07t`).segments;
		if (!segment) throw new Error("missing segment");
		const chunk = segmentToChunk(segment);
		expect(chunk.text).toBe("t");
		expect(chunk.fg?.toInts()).toEqual([255, 0, 0, 255]);
		expect(chunk.attributes).toBe(TextAttributes.BOLD | TextAttributes.UNDERLINE);
		expect(chunk.link).toEqual({ url: "https://x.y" });
	});

	test("styled text joins lines with newlines", () => {
		const styled = ansiLinesToStyledText(["one", `${ESC}[32mtwo${ESC}[0m`]);
		expect(styled.chunks.map((chunk) => chunk.text).join("")).toBe("one\ntwo");
	});
});
