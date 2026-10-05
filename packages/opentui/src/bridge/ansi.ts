/**
 * ANSI line parser for the pi-tui bridge.
 *
 * pi-tui components render lines that carry SGR styling (16/256/truecolor colors, bold, dim,
 * italic, underline, inverse, strikethrough), OSC 8 hyperlinks, and the pi-tui cursor marker
 * (`ESC _ pi:c BEL`). This module parses those lines into plain styled segments, then converts the
 * segments to OpenTUI text chunks. Other escape sequences (cursor movement, image protocols) are
 * dropped, because a hosted component only owns the cells of its own lines.
 *
 * Each line is parsed with fresh state: pi-tui resets styles at the end of every rendered line.
 */

import { CURSOR_MARKER, visibleWidth } from "@earendil-works/pi-tui";
import { RGBA, StyledText, TextAttributes, type TextChunk } from "@opentui/core";

/** A color in a parsed segment. `indexed` keeps the terminal palette slot (0-255). */
export type AnsiColor = { kind: "indexed"; index: number } | { kind: "rgb"; r: number; g: number; b: number };

/** Text style of a segment. Undefined colors use the host's default foreground/background. */
export interface AnsiStyle {
	fg?: AnsiColor;
	bg?: AnsiColor;
	bold: boolean;
	dim: boolean;
	italic: boolean;
	underline: boolean;
	blink: boolean;
	inverse: boolean;
	hidden: boolean;
	strikethrough: boolean;
	/** OSC 8 hyperlink target. */
	link?: string;
}

/** A run of text with one style. */
export interface AnsiSegment {
	text: string;
	style: AnsiStyle;
}

export interface ParsedAnsiLine {
	segments: AnsiSegment[];
	/** Display width of the visible text. */
	width: number;
	/** Column of the pi-tui cursor marker, when the line contains it. */
	cursorColumn?: number;
}

export interface ParsedAnsiLines {
	lines: ParsedAnsiLine[];
	/** Position of the first cursor marker. */
	cursor?: { row: number; col: number };
}

const ESC = "\x1b";
const BEL = "\x07";

function plainStyle(): AnsiStyle {
	return {
		bold: false,
		dim: false,
		italic: false,
		underline: false,
		blink: false,
		inverse: false,
		hidden: false,
		strikethrough: false,
	};
}

function sameColor(a: AnsiColor | undefined, b: AnsiColor | undefined): boolean {
	if (a === b) return true;
	if (!a || !b || a.kind !== b.kind) return false;
	if (a.kind === "indexed" && b.kind === "indexed") return a.index === b.index;
	if (a.kind === "rgb" && b.kind === "rgb") return a.r === b.r && a.g === b.g && a.b === b.b;
	return false;
}

function sameStyle(a: AnsiStyle, b: AnsiStyle): boolean {
	return (
		sameColor(a.fg, b.fg) &&
		sameColor(a.bg, b.bg) &&
		a.bold === b.bold &&
		a.dim === b.dim &&
		a.italic === b.italic &&
		a.underline === b.underline &&
		a.blink === b.blink &&
		a.inverse === b.inverse &&
		a.hidden === b.hidden &&
		a.strikethrough === b.strikethrough &&
		a.link === b.link
	);
}

function clampByte(value: number | undefined): number {
	if (value === undefined || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.min(255, Math.trunc(value)));
}

/**
 * Read an extended color (`38;5;n`, `38;2;r;g;b`, or the colon forms `38:5:n`, `38:2::r:g:b`).
 * Returns the color and how many parameters after the introducer were consumed.
 */
function readExtendedColor(params: readonly string[], start: number): { color?: AnsiColor; consumed: number } {
	const head = params[start] ?? "";
	if (head.includes(":")) {
		const parts = head.split(":");
		if (parts[1] === "5") return { color: { kind: "indexed", index: clampByte(Number(parts[2])) }, consumed: 0 };
		if (parts[1] === "2") {
			// `38:2:<colorspace>:r:g:b` or `38:2:r:g:b`.
			const channels = parts.length >= 6 ? parts.slice(3, 6) : parts.slice(2, 5);
			const [r, g, b] = channels.map((part) => clampByte(Number(part)));
			return { color: { kind: "rgb", r, g, b }, consumed: 0 };
		}
		return { consumed: 0 };
	}
	const mode = params[start + 1];
	if (mode === "5") {
		return { color: { kind: "indexed", index: clampByte(Number(params[start + 2])) }, consumed: 2 };
	}
	if (mode === "2") {
		const [r, g, b] = [params[start + 2], params[start + 3], params[start + 4]].map((part) =>
			clampByte(Number(part)),
		);
		return { color: { kind: "rgb", r, g, b }, consumed: 4 };
	}
	return { consumed: 1 };
}

/** Apply one SGR parameter list to `style` (mutated). */
export function applySgr(style: AnsiStyle, paramText: string): void {
	const params = paramText === "" ? ["0"] : paramText.split(";");
	for (let i = 0; i < params.length; i++) {
		const raw = params[i] ?? "";
		const code = Number(raw.split(":")[0] === "" ? "0" : raw.split(":")[0]);
		switch (true) {
			case code === 0: {
				const link = style.link;
				Object.assign(style, plainStyle(), { fg: undefined, bg: undefined, link });
				break;
			}
			case code === 1:
				style.bold = true;
				break;
			case code === 2:
				style.dim = true;
				break;
			case code === 3:
				style.italic = true;
				break;
			case code === 4:
				// `4:0` turns underline off; other sub-styles (curly, dotted) render as underline.
				style.underline = raw !== "4:0";
				break;
			case code === 5 || code === 6:
				style.blink = true;
				break;
			case code === 7:
				style.inverse = true;
				break;
			case code === 8:
				style.hidden = true;
				break;
			case code === 9:
				style.strikethrough = true;
				break;
			case code === 21:
				style.underline = true;
				break;
			case code === 22:
				style.bold = false;
				style.dim = false;
				break;
			case code === 23:
				style.italic = false;
				break;
			case code === 24:
				style.underline = false;
				break;
			case code === 25:
				style.blink = false;
				break;
			case code === 27:
				style.inverse = false;
				break;
			case code === 28:
				style.hidden = false;
				break;
			case code === 29:
				style.strikethrough = false;
				break;
			case code >= 30 && code <= 37:
				style.fg = { kind: "indexed", index: code - 30 };
				break;
			case code === 38: {
				const { color, consumed } = readExtendedColor(params, i);
				if (color) style.fg = color;
				i += consumed;
				break;
			}
			case code === 39:
				style.fg = undefined;
				break;
			case code >= 40 && code <= 47:
				style.bg = { kind: "indexed", index: code - 40 };
				break;
			case code === 48: {
				const { color, consumed } = readExtendedColor(params, i);
				if (color) style.bg = color;
				i += consumed;
				break;
			}
			case code === 49:
				style.bg = undefined;
				break;
			case code === 58: {
				// Underline color: not representable per cell; skip its parameters.
				i += readExtendedColor(params, i).consumed;
				break;
			}
			case code >= 90 && code <= 97:
				style.fg = { kind: "indexed", index: code - 90 + 8 };
				break;
			case code >= 100 && code <= 107:
				style.bg = { kind: "indexed", index: code - 100 + 8 };
				break;
			default:
				break;
		}
	}
}

/** Index after a string terminator (BEL or `ESC \`) starting at `from`, or the string length. */
function findStringTerminator(line: string, from: number): { end: number; next: number } {
	for (let i = from; i < line.length; i++) {
		if (line[i] === BEL) return { end: i, next: i + 1 };
		if (line[i] === ESC && line[i + 1] === "\\") return { end: i, next: i + 2 };
	}
	return { end: line.length, next: line.length };
}

/** Parse one rendered line. */
export function parseAnsiLine(line: string): ParsedAnsiLine {
	const segments: AnsiSegment[] = [];
	const style = plainStyle();
	let text = "";
	let width = 0;
	let cursorColumn: number | undefined;

	const flush = () => {
		if (text.length === 0) return;
		const previous = segments[segments.length - 1];
		if (previous && sameStyle(previous.style, style)) {
			previous.text += text;
		} else {
			segments.push({ text, style: { ...style } });
		}
		width += visibleWidth(text);
		text = "";
	};

	let i = 0;
	while (i < line.length) {
		const ch = line[i];
		if (ch !== ESC) {
			// Drop C0 controls other than tab; they have no cell representation.
			if (ch === "\t") {
				text += "   ";
			} else if (ch >= " " && ch !== "\x7f") {
				text += ch;
			}
			i++;
			continue;
		}
		const kind = line[i + 1];
		if (kind === "[") {
			// CSI: parameters, intermediates, final byte.
			let j = i + 2;
			while (j < line.length && !(line.charCodeAt(j) >= 0x40 && line.charCodeAt(j) <= 0x7e)) j++;
			const final = line[j];
			if (final === "m") {
				flush();
				applySgr(style, line.slice(i + 2, j));
			}
			i = j + 1;
			continue;
		}
		if (kind === "]") {
			const { end, next } = findStringTerminator(line, i + 2);
			const body = line.slice(i + 2, end);
			if (body.startsWith("8;")) {
				flush();
				const url = body.slice(body.indexOf(";", 2) + 1);
				style.link = url.length > 0 ? url : undefined;
			}
			i = next;
			continue;
		}
		if (kind === "_" || kind === "P" || kind === "^" || kind === "X") {
			// APC/DCS/PM/SOS strings: the pi-tui cursor marker, Kitty graphics, and others.
			const { next } = findStringTerminator(line, i + 2);
			if (line.startsWith(CURSOR_MARKER, i)) {
				flush();
				cursorColumn = width;
			}
			i = next;
			continue;
		}
		// Two-character escapes (ESC 7, ESC =, ...).
		i += kind === undefined ? 1 : 2;
	}
	flush();
	return cursorColumn === undefined ? { segments, width } : { segments, width, cursorColumn };
}

/** Parse rendered lines and locate the cursor marker. */
export function parseAnsiLines(lines: readonly string[]): ParsedAnsiLines {
	const parsed = lines.map((line) => parseAnsiLine(line));
	const row = parsed.findIndex((line) => line.cursorColumn !== undefined);
	if (row === -1) return { lines: parsed };
	return { lines: parsed, cursor: { row, col: parsed[row]?.cursorColumn ?? 0 } };
}

/** Bit set of OpenTUI text attributes for a style. */
export function styleAttributes(style: AnsiStyle): number {
	let attributes = TextAttributes.NONE;
	if (style.bold) attributes |= TextAttributes.BOLD;
	if (style.dim) attributes |= TextAttributes.DIM;
	if (style.italic) attributes |= TextAttributes.ITALIC;
	if (style.underline) attributes |= TextAttributes.UNDERLINE;
	if (style.blink) attributes |= TextAttributes.BLINK;
	if (style.inverse) attributes |= TextAttributes.INVERSE;
	if (style.hidden) attributes |= TextAttributes.HIDDEN;
	if (style.strikethrough) attributes |= TextAttributes.STRIKETHROUGH;
	return attributes;
}

/** OpenTUI color for a parsed color. Indexed colors keep their palette slot. */
export function toRgba(color: AnsiColor): RGBA {
	return color.kind === "indexed" ? RGBA.fromIndex(color.index) : RGBA.fromInts(color.r, color.g, color.b, 255);
}

/** Convert one segment to an OpenTUI text chunk. */
export function segmentToChunk(segment: AnsiSegment): TextChunk {
	const chunk: TextChunk = { __isChunk: true, text: segment.text };
	if (segment.style.fg) chunk.fg = toRgba(segment.style.fg);
	if (segment.style.bg) chunk.bg = toRgba(segment.style.bg);
	const attributes = styleAttributes(segment.style);
	if (attributes !== TextAttributes.NONE) chunk.attributes = attributes;
	if (segment.style.link) chunk.link = { url: segment.style.link };
	return chunk;
}

/** A cell range of one line drawn with an overriding style (search matches). */
export interface CellHighlight {
	/** First highlighted cell (inclusive). */
	startCol: number;
	/** End cell (exclusive). */
	endCol: number;
	fg?: RGBA;
	bg?: RGBA;
	/** Attributes added to the text's own attributes. */
	attributes?: number;
}

/** Highlights per line index. */
export type LineHighlights = ReadonlyMap<number, readonly CellHighlight[]>;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function highlightAt(highlights: readonly CellHighlight[], col: number): CellHighlight | undefined {
	return highlights.find((highlight) => col >= highlight.startCol && col < highlight.endCol);
}

function highlightedChunk(segment: AnsiSegment, text: string, highlight: CellHighlight | undefined): TextChunk {
	const chunk = segmentToChunk({ text, style: segment.style });
	if (!highlight) return chunk;
	if (highlight.fg) chunk.fg = highlight.fg;
	if (highlight.bg) chunk.bg = highlight.bg;
	if (highlight.attributes) chunk.attributes = (chunk.attributes ?? TextAttributes.NONE) | highlight.attributes;
	return chunk;
}

/** Chunks of one line with cell-range highlights applied. */
function highlightLine(line: ParsedAnsiLine, highlights: readonly CellHighlight[]): TextChunk[] {
	const chunks: TextChunk[] = [];
	let col = 0;
	for (const segment of line.segments) {
		let text = "";
		let current: CellHighlight | undefined;
		for (const { segment: grapheme } of graphemes.segment(segment.text)) {
			const highlight = highlightAt(highlights, col);
			if (text.length > 0 && highlight !== current) {
				chunks.push(highlightedChunk(segment, text, current));
				text = "";
			}
			current = highlight;
			text += grapheme;
			col += visibleWidth(grapheme);
		}
		if (text.length > 0) chunks.push(highlightedChunk(segment, text, current));
	}
	return chunks;
}

/** Chunks for parsed lines, joined with newlines. */
export function parsedLinesToChunks(lines: readonly ParsedAnsiLine[], highlights?: LineHighlights): TextChunk[] {
	const chunks: TextChunk[] = [];
	lines.forEach((line, index) => {
		if (index > 0) chunks.push({ __isChunk: true, text: "\n" });
		const lineHighlights = highlights?.get(index);
		if (lineHighlights && lineHighlights.length > 0) {
			chunks.push(...highlightLine(line, lineHighlights));
			return;
		}
		for (const segment of line.segments) chunks.push(segmentToChunk(segment));
	});
	return chunks;
}

/** Styled text for rendered pi-tui lines, with optional cell highlights. */
export function ansiLinesToStyledText(lines: readonly string[], highlights?: LineHighlights): StyledText {
	return new StyledText(parsedLinesToChunks(parseAnsiLines(lines).lines, highlights));
}
