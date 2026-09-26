import type { ReadOutline, ReadOutlineSymbol } from "./read-outline.ts";

/** Cursor-inspired thresholds used by the read representation selector. */
export const CHUNK_TARGET_LINES = 100;
export const FOLD_MIN_LINES = 10;
export const CHUNK_FALLBACK_LINES = 50;
export const CHUNK_MAX_AVERAGE_CHARACTERS = 10_000;

/** A rendered read chunk, with physical source line numbers retained. */
export interface ReadChunk {
	startLine: number;
	endLine: number;
	label?: string;
	lines: Array<{ lineNumber: number; text: string }>;
	contents: string;
}

/** Chunking result and whether fixed-line fallback was required. */
export interface ReadChunksResult {
	chunks: ReadChunk[];
	usedFallback: boolean;
}

const FOLDABLE_KINDS = new Set(["namespace", "class", "method", "constructor", "interface", "function"]);

function symbolSpan(symbol: ReadOutlineSymbol): number {
	return symbol.endLine - symbol.startLine + 1;
}

function shouldFold(symbol: ReadOutlineSymbol): boolean {
	return FOLDABLE_KINDS.has(symbol.kind) && symbolSpan(symbol) >= FOLD_MIN_LINES;
}

function symbolLabel(symbol: ReadOutlineSymbol): string {
	return `${symbol.name} (${symbol.kind})`;
}

function symbolPath(symbol: ReadOutlineSymbol): string {
	const path: string[] = [];
	let current: ReadOutlineSymbol | undefined = symbol;
	while (current) {
		path.unshift(symbolLabel(current));
		current = current.parent;
	}
	return path.join(" > ");
}

function renderRange(
	lines: string[],
	startLine: number,
	endLine: number,
	root: ReadOutlineSymbol | undefined,
): Array<{ lineNumber: number; text: string }> {
	const rootFold = root && root.kind !== "class" && shouldFold(root) ? [root] : [];
	const folded = [...rootFold, ...(root ? descendants(root) : [])].filter(
		(symbol) => shouldFold(symbol) && symbol.startLine >= startLine && symbol.endLine <= endLine,
	);
	const result: Array<{ lineNumber: number; text: string }> = [];
	let line = startLine;
	while (line <= endLine) {
		const fold = folded.find((symbol) => symbol.startLine === line);
		if (!fold) {
			result.push({ lineNumber: line, text: lines[line - 1] ?? "" });
			line++;
			continue;
		}
		result.push({ lineNumber: line, text: lines[line - 1] ?? "" });
		result.push({ lineNumber: fold.startLine + 1, text: "..." });
		result.push({ lineNumber: fold.endLine, text: lines[fold.endLine - 1] ?? "" });
		line = fold.endLine + 1;
	}
	return result;
}

function descendants(symbol: ReadOutlineSymbol): ReadOutlineSymbol[] {
	const result: ReadOutlineSymbol[] = [];
	for (const child of symbol.children) {
		result.push(child, ...descendants(child));
	}
	return result;
}

function makeChunk(
	lines: string[],
	startLine: number,
	endLine: number,
	root: ReadOutlineSymbol | undefined,
	label?: string,
): ReadChunk {
	const rendered = renderRange(lines, startLine, endLine, root);
	return {
		startLine,
		endLine,
		label,
		lines: rendered,
		contents: rendered.map((line) => line.text).join("\n"),
	};
}

function fixedChunks(lines: string[], chunkSize: number): ReadChunk[] {
	const chunks: ReadChunk[] = [];
	for (let start = 1; start <= lines.length; start += chunkSize) {
		const end = Math.min(lines.length, start + chunkSize - 1);
		chunks.push(makeChunk(lines, start, end, undefined, `${chunkSize}-line`));
	}
	return chunks;
}

function topLevelSymbols(outline: ReadOutline): ReadOutlineSymbol[] {
	return outline.symbols.slice().sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

function addGapChunks(lines: string[], occupied: boolean[], chunks: ReadChunk[]): void {
	let start = 1;
	while (start <= lines.length) {
		while (start <= lines.length && occupied[start - 1]) start++;
		if (start > lines.length) return;
		let end = start;
		while (end <= lines.length && !occupied[end - 1] && end - start + 1 < CHUNK_TARGET_LINES) end++;
		chunks.push(makeChunk(lines, start, end - 1, undefined));
		start = end;
	}
}

function markOccupied(occupied: boolean[], startLine: number, endLine: number): void {
	for (let line = startLine; line <= endLine && line <= occupied.length; line++) occupied[line - 1] = true;
}

function buildSymbolChunks(lines: string[], symbols: ReadOutlineSymbol[], occupied: boolean[]): ReadChunk[] {
	const chunks: ReadChunk[] = [];
	const imports = symbols.filter((symbol) => symbol.kind === "import" || symbol.kind === "use");
	if (imports.length > 0) {
		const startLine = Math.min(...imports.map((symbol) => symbol.startLine));
		const endLine = Math.max(...imports.map((symbol) => symbol.endLine));
		chunks.push(makeChunk(lines, startLine, endLine, undefined, "imports"));
		markOccupied(occupied, startLine, endLine);
	}
	for (const symbol of symbols.filter((candidate) => !imports.includes(candidate))) {
		const span = symbolSpan(symbol);
		if (span >= CHUNK_TARGET_LINES && symbol.kind === "class") {
			for (let start = symbol.startLine; start <= symbol.endLine; start += CHUNK_TARGET_LINES) {
				const end = Math.min(symbol.endLine, start + CHUNK_TARGET_LINES - 1);
				chunks.push(makeChunk(lines, start, end, symbol, symbolPath(symbol)));
			}
		} else if (span >= CHUNK_TARGET_LINES && !shouldFold(symbol)) {
			for (let start = symbol.startLine; start <= symbol.endLine; start += CHUNK_TARGET_LINES) {
				const end = Math.min(symbol.endLine, start + CHUNK_TARGET_LINES - 1);
				chunks.push(makeChunk(lines, start, end, symbol, symbolPath(symbol)));
			}
		} else {
			chunks.push(makeChunk(lines, symbol.startLine, symbol.endLine, symbol, symbolPath(symbol)));
		}
		markOccupied(occupied, symbol.startLine, symbol.endLine);
	}
	return chunks;
}

/** Build symbol-aligned chunks, folding long bodies and falling back to 50-line windows. */
export function buildReadChunks(content: string, outline: ReadOutline | undefined): ReadChunksResult {
	const lines = content.split("\n");
	if (!outline || outline.symbols.length === 0) {
		return { chunks: fixedChunks(lines, CHUNK_FALLBACK_LINES), usedFallback: true };
	}
	const occupied = Array.from({ length: lines.length }, () => false);
	const chunks = buildSymbolChunks(lines, topLevelSymbols(outline), occupied);
	addGapChunks(lines, occupied, chunks);
	chunks.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
	const average =
		chunks.length === 0
			? Number.POSITIVE_INFINITY
			: chunks.reduce((sum, chunk) => sum + chunk.contents.length, 0) / chunks.length;
	if (chunks.length === 0 || average > CHUNK_MAX_AVERAGE_CHARACTERS) {
		return { chunks: fixedChunks(lines, CHUNK_FALLBACK_LINES), usedFallback: true };
	}
	return { chunks, usedFallback: false };
}

/** Format a read chunk with the six-column physical line-number prefix. */
export function formatReadChunkLines(chunks: ReadChunk[]): string {
	return chunks
		.flatMap((chunk) => chunk.lines)
		.map((line) => `${String(line.lineNumber).padStart(6, " ")}|${line.text}`)
		.join("\n");
}
