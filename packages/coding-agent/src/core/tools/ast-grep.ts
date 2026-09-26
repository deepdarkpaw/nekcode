import { stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { StringEnum } from "@earendil-works/pi-ai";
import { spawn } from "child_process";
import path from "path";
import { type Static, Type } from "typebox";
import { getBinDir } from "../../config.ts";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { astGrepRenderers } from "./renderers/ast-grep.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.ts";

const astGrepSchema = Type.Object({
	pattern: Type.String({
		description: "AST pattern, e.g. 'console.log($$$ARGS)'. $X matches one node, $$$X matches zero or more.",
	}),
	lang: Type.Optional(
		Type.String({
			description: "Pattern language (ts, tsx, js, py, go, rust, ...). Inferred from file extensions when omitted.",
		}),
	),
	path: Type.Optional(Type.String({ description: "File or directory to search (default: cwd)" })),
	globs: Type.Optional(
		Type.Array(Type.String(), { description: "Include/exclude globs, e.g. ['src/**', '!**/*.test.ts']" }),
	),
	strictness: Type.Optional(
		StringEnum(["cst", "smart", "ast", "relaxed", "signature"] as const, {
			description: "Pattern matching strictness (default: smart)",
		}),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum matches (default: 100)" })),
});

/**
 * System prompt snippet and guidelines for ast_grep.
 * Source: plan.md section 4.2; Cursor and Codex have no equivalent tool, so there is no Cursor original.
 */
export const astGrepToolSystemPromptContribution = {
	snippet: "Structural code search by AST pattern (ast-grep); prefer over grep for code constructs",
	guidelines: ["Use ast_grep for syntax-aware code search (calls, definitions, imports); use grep for plain text"],
} as const;

/** Parameters accepted by the ast_grep tool. */
export type AstGrepToolInput = Static<typeof astGrepSchema>;
const DEFAULT_LIMIT = 100;
const PARSE_WARNING_MARKER = "Pattern contains an ERROR node";

/** Structured result details for the ast_grep tool. */
export interface AstGrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
	parseWarning?: string;
}

/** Options for the ast_grep tool. The tool always runs the local ast-grep binary. */
export interface AstGrepToolOptions {}

interface AstGrepMatch {
	file: string;
	lines: string;
	range: { start: { line: number }; end: { line: number } };
}

interface MatchCollector {
	limit: number;
	lines: string[];
	linesTruncated: boolean;
	formatPath: (filePath: string) => string;
}

interface AstGrepRun {
	code: number | null;
	stderr: string;
	killedDueToLimit: boolean;
}

function buildAstGrepArgs(input: AstGrepToolInput, searchPath: string): string[] {
	const args = ["run", `--pattern=${input.pattern}`, "--json=stream", "--color=never"];
	if (input.lang) args.push(`--lang=${input.lang}`);
	if (input.strictness) args.push(`--strictness=${input.strictness}`);
	for (const glob of input.globs ?? []) args.push(`--globs=${glob}`);
	args.push("--", searchPath);
	return args;
}

function createPathFormatter(searchPath: string, isDirectory: boolean): (filePath: string) => string {
	return (filePath) => {
		if (!isDirectory) return path.basename(filePath);
		const relative = path.relative(searchPath, path.resolve(searchPath, filePath));
		if (relative && !relative.startsWith("..")) return relative.replace(/\\/g, "/");
		return path.basename(filePath);
	};
}

function isAstGrepMatch(value: unknown): value is AstGrepMatch {
	if (typeof value !== "object" || value === null) return false;
	const match = value as Partial<AstGrepMatch>;
	return (
		typeof match.file === "string" &&
		typeof match.lines === "string" &&
		typeof match.range?.start?.line === "number" &&
		typeof match.range?.end?.line === "number"
	);
}

function parseMatch(line: string): AstGrepMatch | undefined {
	if (!line.trim()) return undefined;
	try {
		const value: unknown = JSON.parse(line);
		return isAstGrepMatch(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/** Add one JSON stream line to the collector. Returns true when this match reached the limit. */
function collectMatch(collector: MatchCollector, line: string): boolean {
	if (collector.lines.length >= collector.limit) return false;
	const match = parseMatch(line);
	if (!match) return false;
	const firstLine = match.lines.replace(/\r/g, "").split("\n")[0] ?? "";
	const { text, wasTruncated } = truncateLine(firstLine);
	if (wasTruncated) collector.linesTruncated = true;
	const extraLines = match.range.end.line - match.range.start.line;
	const suffix = extraLines > 0 ? ` (+${extraLines} lines)` : "";
	collector.lines.push(`${collector.formatPath(match.file)}:${match.range.start.line + 1}: ${text}${suffix}`);
	return collector.lines.length >= collector.limit;
}

function runAstGrep(
	binaryPath: string,
	args: string[],
	collector: MatchCollector,
	signal: AbortSignal | undefined,
): Promise<AstGrepRun> {
	return new Promise((resolve, reject) => {
		const child = spawn(binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
		const rl = createInterface({ input: child.stdout });
		let stderr = "";
		let aborted = false;
		let killedDueToLimit = false;
		const onAbort = () => {
			aborted = true;
			child.kill();
		};
		const cleanup = () => {
			rl.close();
			signal?.removeEventListener("abort", onAbort);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stderr?.on("data", (chunk) => {
			if (stderr.length < DEFAULT_MAX_BYTES) stderr += chunk.toString();
		});
		rl.on("line", (line) => {
			if (!collectMatch(collector, line) || child.killed) return;
			killedDueToLimit = true;
			child.kill();
		});
		child.on("error", (error) => {
			cleanup();
			reject(new Error(`Failed to run ast-grep: ${error.message}`));
		});
		child.on("close", (code) => {
			cleanup();
			if (aborted) reject(new Error("Operation aborted"));
			else resolve({ code, stderr, killedDueToLimit });
		});
	});
}

function formatMatchOutput(collector: MatchCollector, details: AstGrepToolDetails): string {
	if (collector.lines.length === 0) return "No matches found";
	// Byte truncation only: the match limit already capped the number of rows.
	const truncation = truncateHead(collector.lines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
	const notices: string[] = [];
	if (collector.lines.length >= collector.limit) {
		notices.push(
			`${collector.limit} matches limit reached. Use limit=${collector.limit * 2} for more, or refine pattern`,
		);
		details.matchLimitReached = collector.limit;
	}
	if (truncation.truncated) {
		notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
		details.truncation = truncation;
	}
	if (collector.linesTruncated) {
		notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
		details.linesTruncated = true;
	}
	return notices.length > 0 ? `${truncation.content}\n\n[${notices.join(". ")}]` : truncation.content;
}

function buildAstGrepResult(
	collector: MatchCollector,
	run: AstGrepRun,
): AgentToolResult<AstGrepToolDetails | undefined> {
	if (!run.killedDueToLimit && run.code !== 0 && run.code !== 1) {
		throw new Error(run.stderr.trim() || `ast-grep exited with code ${run.code}`);
	}
	const details: AstGrepToolDetails = {};
	let output = formatMatchOutput(collector, details);
	if (run.stderr.includes(PARSE_WARNING_MARKER)) {
		details.parseWarning = run.stderr.trim();
		output += `\n\n${details.parseWarning}`;
	}
	return {
		content: [{ type: "text", text: output }],
		details: Object.keys(details).length > 0 ? details : undefined,
	};
}

async function isDirectoryPath(searchPath: string): Promise<boolean> {
	try {
		return (await fsStat(searchPath)).isDirectory();
	} catch {
		throw new Error(`Path not found: ${searchPath}`);
	}
}

/** Create the ast_grep tool definition: structural code search through the ast-grep CLI. */
export function createAstGrepToolDefinition(
	cwd: string,
	_options?: AstGrepToolOptions,
): ToolDefinition<typeof astGrepSchema, AstGrepToolDetails | undefined> {
	return {
		name: "ast_grep",
		label: "ast_grep",
		description: `Search code structurally by AST pattern using ast-grep. Returns matches as path:line: first matched line, with (+N lines) for multi-line matches. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
		promptSnippet: astGrepToolSystemPromptContribution.snippet,
		promptGuidelines: [...astGrepToolSystemPromptContribution.guidelines],
		parameters: astGrepSchema,
		async execute(_toolCallId, input: AstGrepToolInput, signal?: AbortSignal, _onUpdate?, ctx?: ExtensionContext) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const binaryPath = await ensureTool("ast-grep");
			if (signal?.aborted) throw new Error("Operation aborted");
			if (!binaryPath) {
				throw new Error(
					`ast-grep is not available and could not be downloaded. Install it manually: put the ast-grep binary on PATH or in ${getBinDir()}`,
				);
			}
			const searchPath = resolveToCwd(input.path || ".", ctx?.cwd || cwd);
			const collector: MatchCollector = {
				limit: Math.max(1, input.limit ?? DEFAULT_LIMIT),
				lines: [],
				linesTruncated: false,
				formatPath: createPathFormatter(searchPath, await isDirectoryPath(searchPath)),
			};
			const run = await runAstGrep(binaryPath, buildAstGrepArgs(input, searchPath), collector, signal);
			return buildAstGrepResult(collector, run);
		},
		...astGrepRenderers,
	};
}

/** Create the ast_grep tool as an AgentTool. */
export function createAstGrepTool(cwd: string, options?: AstGrepToolOptions): AgentTool<typeof astGrepSchema> {
	return wrapToolDefinition(createAstGrepToolDefinition(cwd, options));
}
