import { spawn } from "node:child_process";
import { extname } from "node:path";
import { ensureTool } from "../../utils/tools-manager.ts";

/** A symbol discovered from an ast-grep syntax tree. Lines are 1-indexed and inclusive. */
export interface ReadOutlineSymbol {
	kind: string;
	name: string;
	startLine: number;
	endLine: number;
	declaration: string;
	description?: string;
	children: ReadOutlineSymbol[];
	parent?: ReadOutlineSymbol;
}

/** The symbol outline used by the read chunker. */
export interface ReadOutline {
	symbols: ReadOutlineSymbol[];
	text: string;
}

/** Options for testing or embedding outline discovery. */
export interface ReadOutlineOptions {
	ensureBinary?: () => Promise<string | null>;
	cacheKey?: string;
}

interface AstGrepMatch {
	text?: string;
	lines?: string;
	range?: {
		start?: { line?: number };
		end?: { line?: number; column?: number };
	};
}

interface LanguageSpec {
	language: string;
	kinds: Array<{ name: string; selector: string }>;
}

const outlineCache = new Map<string, ReadOutline>();
const MAX_OUTLINE_CACHE = 32;
const LANGUAGE_SPECS: Record<string, LanguageSpec> = {
	".ts": {
		language: "typescript",
		kinds: [
			{ name: "import", selector: "import_statement" },
			{ name: "class", selector: "class_declaration" },
			{ name: "interface", selector: "interface_declaration" },
			{ name: "function", selector: "function_declaration" },
			{ name: "method", selector: "method_definition" },
		],
	},
	".tsx": {
		language: "tsx",
		kinds: [
			{ name: "import", selector: "import_statement" },
			{ name: "class", selector: "class_declaration" },
			{ name: "function", selector: "function_declaration" },
			{ name: "method", selector: "method_definition" },
		],
	},
	".js": {
		language: "javascript",
		kinds: [
			{ name: "import", selector: "import_statement" },
			{ name: "class", selector: "class_declaration" },
			{ name: "function", selector: "function_declaration" },
			{ name: "method", selector: "method_definition" },
		],
	},
	".jsx": {
		language: "jsx",
		kinds: [
			{ name: "import", selector: "import_statement" },
			{ name: "class", selector: "class_declaration" },
			{ name: "function", selector: "function_declaration" },
			{ name: "method", selector: "method_definition" },
		],
	},
	".py": {
		language: "python",
		kinds: [
			{ name: "import", selector: "import_statement" },
			{ name: "import", selector: "import_from_statement" },
			{ name: "class", selector: "class_definition" },
			{ name: "function", selector: "function_definition" },
		],
	},
	".go": {
		language: "go",
		kinds: [
			{ name: "import", selector: "import_declaration" },
			{ name: "type", selector: "type_declaration" },
			{ name: "function", selector: "function_declaration" },
			{ name: "method", selector: "method_declaration" },
		],
	},
	".rs": {
		language: "rust",
		kinds: [
			{ name: "use", selector: "use_declaration" },
			{ name: "struct", selector: "struct_item" },
			{ name: "function", selector: "function_item" },
			{ name: "impl", selector: "impl_item" },
		],
	},
	".java": {
		language: "java",
		kinds: [
			{ name: "import", selector: "import_declaration" },
			{ name: "class", selector: "class_declaration" },
			{ name: "interface", selector: "interface_declaration" },
			{ name: "method", selector: "method_declaration" },
		],
	},
	".rb": {
		language: "ruby",
		kinds: [
			{ name: "class", selector: "class" },
			{ name: "method", selector: "method" },
		],
	},
	".c": { language: "c", kinds: [{ name: "function", selector: "function_definition" }] },
	".h": { language: "c", kinds: [{ name: "function", selector: "function_definition" }] },
	".cpp": { language: "cpp", kinds: [{ name: "function", selector: "function_definition" }] },
	".cs": {
		language: "csharp",
		kinds: [
			{ name: "class", selector: "class_declaration" },
			{ name: "method", selector: "method_declaration" },
		],
	},
};

function languageSpec(filePath: string): LanguageSpec | undefined {
	return LANGUAGE_SPECS[extname(filePath).toLowerCase()];
}

function parseMatch(line: string): AstGrepMatch | undefined {
	try {
		const value: unknown = JSON.parse(line);
		if (typeof value !== "object" || value === null) return undefined;
		return value as AstGrepMatch;
	} catch {
		return undefined;
	}
}

function lineRange(match: AstGrepMatch): { startLine: number; endLine: number } | undefined {
	const start = match.range?.start?.line;
	const end = match.range?.end?.line;
	if (typeof start !== "number" || typeof end !== "number") return undefined;
	const endColumn = match.range?.end?.column ?? 0;
	return { startLine: start + 1, endLine: end + (endColumn > 0 ? 1 : 0) };
}

function symbolName(kind: string, declaration: string): string {
	if (kind === "import" || kind === "use") return declaration;
	if (kind === "class" || kind === "interface" || kind === "function" || kind === "type") {
		const match = declaration.match(/\b(?:class|interface|function|struct|type|def|fn)\s+([\w$]+)/);
		return match?.[1] ?? declaration;
	}
	if (kind === "method") {
		const match = declaration.match(/(?:async\s+|static\s+|get\s+|set\s+)*([\w$]+)\s*\(/);
		return match?.[1] ?? declaration;
	}
	return declaration;
}

function cleanCommentLine(line: string): string {
	return line
		.replace(/^\s*\/\*+\s?/, "")
		.replace(/\s*\*\/\s*$/, "")
		.replace(/^\s*\*\s?/, "")
		.replace(/^\s*#\s?/, "")
		.trim();
}

function findDescription(lines: string[], startLine: number): string | undefined {
	let cursor = startLine - 2;
	while (cursor >= 0 && lines[cursor].trim() === "") cursor--;
	if (cursor < 0) return undefined;
	if (lines[cursor].includes("*/")) {
		const collected: string[] = [];
		while (cursor >= 0) {
			collected.unshift(cleanCommentLine(lines[cursor]));
			if (lines[cursor].includes("/**")) return collected.filter(Boolean).join("\n");
			cursor--;
		}
		return undefined;
	}
	if (lines[cursor].trimStart().startsWith("#")) {
		const collected: string[] = [];
		while (cursor >= 0 && lines[cursor].trimStart().startsWith("#")) {
			collected.unshift(cleanCommentLine(lines[cursor]));
			cursor--;
		}
		return collected.join("\n");
	}
	return undefined;
}

function renderSymbol(symbol: ReadOutlineSymbol, depth: number, output: string[]): void {
	const indent = " ".repeat(depth * 4);
	if (new Set(["function", "method", "constructor"]).has(symbol.kind)) output.push(`${indent}${symbol.declaration}`);
	else output.push(`${indent}(${symbol.kind}) ${symbol.name}`);
	if (symbol.description) {
		output.push(`${indent}  DESCRIPTION:`);
		for (const line of symbol.description.split("\n")) output.push(`${indent}    ${line}`);
	}
	for (const child of symbol.children) renderSymbol(child, depth + 1, output);
}

/** Render an outline with Cursor's four-space indentation and declaration fallback. */
export function renderReadOutline(symbols: ReadOutlineSymbol[]): string {
	const output: string[] = [];
	for (const symbol of symbols) renderSymbol(symbol, 0, output);
	return output.join("\n");
}

function addToCache(key: string, outline: ReadOutline): void {
	outlineCache.delete(key);
	outlineCache.set(key, outline);
	while (outlineCache.size > MAX_OUTLINE_CACHE) {
		const oldest = outlineCache.keys().next();
		if (oldest.done) return;
		outlineCache.delete(oldest.value);
	}
}

function buildTree(symbols: ReadOutlineSymbol[]): ReadOutlineSymbol[] {
	const sorted = symbols.sort((a, b) => a.startLine - b.startLine || b.endLine - a.endLine);
	const roots: ReadOutlineSymbol[] = [];
	for (const symbol of sorted) {
		let parent: ReadOutlineSymbol | undefined;
		for (const candidate of sorted) {
			if (candidate === symbol) continue;
			if (candidate.startLine <= symbol.startLine && candidate.endLine >= symbol.endLine) {
				if (!parent || candidate.endLine - candidate.startLine < parent.endLine - parent.startLine)
					parent = candidate;
			}
		}
		if (parent) {
			symbol.parent = parent;
			parent.children.push(symbol);
		} else roots.push(symbol);
	}
	for (const symbol of sorted) symbol.children.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
	return roots;
}

function runSelector(binary: string, filePath: string, spec: LanguageSpec, selector: string): Promise<AstGrepMatch[]> {
	return new Promise((resolve) => {
		const child = spawn(
			binary,
			["run", `--kind=${selector}`, `--lang=${spec.language}`, "--json=stream", "--color=never", "--", filePath],
			{ stdio: ["ignore", "pipe", "ignore"] },
		);
		let output = "";
		child.stdout?.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.on("error", () => resolve([]));
		child.on("close", () => {
			const matches: AstGrepMatch[] = [];
			for (const line of output.split("\n")) {
				const parsed = parseMatch(line);
				if (parsed) matches.push(parsed);
			}
			resolve(matches);
		});
	});
}

/** Build a best-effort ast-grep outline for a local source file. */
export async function buildReadOutline(
	filePath: string,
	content: string,
	options: ReadOutlineOptions = {},
): Promise<ReadOutline | undefined> {
	const spec = languageSpec(filePath);
	if (!spec) return undefined;
	const cacheKey = options.cacheKey ?? `${filePath}:${content.length}`;
	const cached = outlineCache.get(cacheKey);
	if (cached) return cached;
	const binary = await (options.ensureBinary ?? (() => ensureTool("ast-grep")))();
	if (!binary) return undefined;
	const sourceLines = content.split("\n");
	const symbols: ReadOutlineSymbol[] = [];
	for (const kindSpec of spec.kinds) {
		const matches = await runSelector(binary, filePath, spec, kindSpec.selector);
		for (const match of matches) {
			const range = lineRange(match);
			if (!range || range.endLine < range.startLine) continue;
			const declaration = (sourceLines[range.startLine - 1] ?? match.lines ?? match.text ?? "").trim();
			const symbolKind =
				kindSpec.name === "method" && /^constructor\s*\(/.test(declaration) ? "constructor" : kindSpec.name;
			const duplicate = symbols.some(
				(existing) =>
					existing.kind === symbolKind &&
					existing.startLine === range.startLine &&
					existing.endLine === range.endLine,
			);
			if (duplicate) continue;
			symbols.push({
				kind: symbolKind,
				name: symbolName(kindSpec.name, declaration),
				startLine: range.startLine,
				endLine: Math.min(sourceLines.length, range.endLine),
				declaration,
				description: findDescription(sourceLines, range.startLine),
				children: [],
			});
		}
	}
	const roots = buildTree(symbols);
	const outline = { symbols: roots, text: renderReadOutline(roots) };
	addToCache(cacheKey, outline);
	return outline;
}

/** Clear outline cache; intended for focused tests and reload boundaries. */
export function clearReadOutlineCache(): void {
	outlineCache.clear();
}

/** Return the configured ast-grep language for a path, if supported. */
export function getReadOutlineLanguage(filePath: string): string | undefined {
	return languageSpec(filePath)?.language;
}
