import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { spawn } from "child_process";
import path from "path";
import { type Static, Type } from "typebox";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { grepRenderers } from "./renderers/grep.ts";
import { formatSearchOutput, type SearchOutputLine } from "./search-output.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateHead,
	truncateLine,
} from "./truncate.ts";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "ripgrep regex, or exact text when literal is true" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(
		Type.String({ description: "Filter files by glob, e.g. '*.ts', '**/*.spec.ts', or '!**/*.test.ts' to exclude" }),
	),
	ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
	literal: Type.Optional(
		Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" }),
	),
	context: Type.Optional(
		Type.Number({ description: "Number of lines to show before and after each match (default: 0)" }),
	),
	limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});

export const grepToolSystemPromptContribution = {
	snippet: "Search file contents by regex or literal text (respects .gitignore)",
	guidelines: ["Use grep for plain-text or regex search across files, not grep or rg in the shell"],
} as const;

export type GrepToolInput = Static<typeof grepSchema>;
const DEFAULT_LIMIT = 100;

/** grep description: output format, regex flavor, filters, and limits of the ripgrep-backed search. */
const GREP_DESCRIPTION = `Search file contents with ripgrep.

- Paths are relative to the search directory. Repeated paths are grouped as \`path:\` followed by indented \`line: text\` rows when shorter; otherwise rows use \`path:line: text\`.
- Context rows use \`line- text\` (or \`path-line- text\` inline). Overlapping context is merged; \`--\` separates disjoint context windows.
- pattern is a ripgrep (Rust) regex; set literal to match exact text that contains regex characters such as ( [ . * or ?.
- Narrow the search with path (a directory or one file) and glob ('*.ts', or '!**/*.test.ts' to exclude files).
- Respects .gitignore and includes dotfiles. Matching is case-sensitive unless ignoreCase is set.
- Output is truncated to ${DEFAULT_LIMIT} matches (raise limit to see more) or ${DEFAULT_MAX_BYTES / 1024}KB, whichever is hit first; long lines are truncated to ${GREP_MAX_LINE_LENGTH} characters.`;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

/**
 * Pluggable operations for the grep tool.
 * Override these to delegate search to remote systems (for example SSH).
 */
export interface GrepOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** Read file contents for context lines */
	readFile: (absolutePath: string) => Promise<string> | string;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
	readFile: (p) => fsReadFile(p, "utf-8"),
};

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem plus ripgrep */
	operations?: GrepOperations;
}

interface GrepMatch {
	filePath: string;
	lineNumber: number;
	lineText?: string;
}

/** Merge context windows before formatting, preserving each selected match and showing each context line once. */
async function formatGrepMatches(
	matches: readonly GrepMatch[],
	context: number,
	ops: GrepOperations,
	formatPath: (filePath: string) => string,
): Promise<{ output: string; linesTruncated: boolean }> {
	const files = new Map<string, GrepMatch[]>();
	for (const match of matches) {
		const group = files.get(match.filePath);
		if (group) group.push(match);
		else files.set(match.filePath, [match]);
	}
	const rows: SearchOutputLine[] = [];
	let linesTruncated = false;
	const append = (path: string, line: number, text: string, isContext = false, breakBefore = false) => {
		const truncated = truncateLine(text);
		linesTruncated ||= truncated.wasTruncated;
		rows.push({ path, line, text: truncated.text, context: isContext, breakBefore });
	};
	for (const [filePath, fileMatches] of files) {
		const path = formatPath(filePath);
		let fileLines: string[] | undefined;
		if (context > 0 || fileMatches.some((match) => match.lineText === undefined)) {
			try {
				fileLines = (await ops.readFile(filePath)).replace(/\r\n?/g, "\n").split("\n");
			} catch {
				// Preserve the match location even if its file disappeared after the search.
			}
		}
		if (context === 0 || !fileLines) {
			for (const match of fileMatches) {
				const text =
					context > 0 && !fileLines
						? "(unable to read file)"
						: (fileLines?.[match.lineNumber - 1] ?? match.lineText ?? "(unable to read file)");
				append(path, match.lineNumber, text.replace(/\r\n/g, "\n").replace(/\r/g, "").replace(/\n$/, ""));
			}
			continue;
		}
		const matchLines = [...new Set(fileMatches.map((match) => match.lineNumber))].sort((a, b) => a - b);
		const selected = new Set(matchLines);
		const ranges: Array<{ start: number; end: number }> = [];
		for (const line of matchLines) {
			const start = Math.max(1, line - context);
			const end = Math.min(fileLines.length, line + context);
			const previous = ranges.at(-1);
			if (previous && start <= previous.end + 1) previous.end = Math.max(previous.end, end);
			else ranges.push({ start, end });
		}
		for (const [index, range] of ranges.entries()) {
			for (let line = range.start; line <= range.end; line++) {
				append(path, line, fileLines[line - 1] ?? "", !selected.has(line), index > 0 && line === range.start);
			}
		}
	}
	return { output: formatSearchOutput(rows), linesTruncated };
}

export function createGrepToolDefinition(
	cwd: string,
	options?: GrepToolOptions,
): ToolDefinition<typeof grepSchema, GrepToolDetails | undefined> {
	const customOps = options?.operations;
	return {
		name: "grep",
		label: "grep",
		description: GREP_DESCRIPTION,
		promptSnippet: grepToolSystemPromptContribution.snippet,
		promptGuidelines: [...grepToolSystemPromptContribution.guidelines],
		parameters: grepSchema,
		async execute(
			_toolCallId,
			{
				pattern,
				path: searchDir,
				glob,
				ignoreCase,
				literal,
				context,
				limit,
			}: {
				pattern: string;
				path?: string;
				glob?: string;
				ignoreCase?: boolean;
				literal?: boolean;
				context?: number;
				limit?: number;
			},
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			return new Promise((resolve, reject) => {
				if (signal?.aborted) {
					reject(new Error("Operation aborted"));
					return;
				}
				let settled = false;
				const settle = (fn: () => void) => {
					if (!settled) {
						settled = true;
						fn();
					}
				};

				(async () => {
					try {
						const rgPath = await ensureTool("rg");
						if (!rgPath) {
							settle(() => reject(new Error("ripgrep (rg) is not available and could not be downloaded")));
							return;
						}

						const searchPath = resolveToCwd(searchDir || ".", ctx?.cwd || cwd);
						const ops = customOps ?? defaultGrepOperations;
						let isDirectory: boolean;
						try {
							isDirectory = await ops.isDirectory(searchPath);
						} catch {
							settle(() => reject(new Error(`Path not found: ${searchPath}`)));
							return;
						}

						const contextValue = context && context > 0 ? context : 0;
						const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
						const formatPath = (filePath: string): string => {
							if (isDirectory) {
								const relative = path.relative(searchPath, filePath);
								if (relative && !relative.startsWith("..")) {
									return relative.replace(/\\/g, "/");
								}
							}
							return path.basename(filePath);
						};

						const args: string[] = ["--json", "--line-number", "--color=never", "--hidden"];
						if (ignoreCase) args.push("--ignore-case");
						if (literal) args.push("--fixed-strings");
						if (glob) args.push("--glob", glob);
						args.push("--", pattern, searchPath);

						const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"] });
						const rl = createInterface({ input: child.stdout });
						let stderr = "";
						let matchCount = 0;
						let matchLimitReached = false;
						let aborted = false;
						let killedDueToLimit = false;

						const cleanup = () => {
							rl.close();
							signal?.removeEventListener("abort", onAbort);
						};
						const stopChild = (dueToLimit = false) => {
							if (!child.killed) {
								killedDueToLimit = dueToLimit;
								child.kill();
							}
						};
						const onAbort = () => {
							aborted = true;
							stopChild();
						};
						signal?.addEventListener("abort", onAbort, { once: true });
						child.stderr?.on("data", (chunk) => {
							stderr += chunk.toString();
						});

						// Collect matches during streaming, then format them after rg exits.
						const matches: GrepMatch[] = [];
						rl.on("line", (line) => {
							if (!line.trim() || matchCount >= effectiveLimit) return;
							let event: any;
							try {
								event = JSON.parse(line);
							} catch {
								return;
							}
							if (event.type === "match") {
								matchCount++;
								const filePath = event.data?.path?.text;
								const lineNumber = event.data?.line_number;
								const lineText = event.data?.lines?.text;
								if (filePath && typeof lineNumber === "number")
									matches.push({ filePath, lineNumber, lineText });
								if (matchCount >= effectiveLimit) {
									matchLimitReached = true;
									stopChild(true);
								}
							}
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
						});
						child.on("close", async (code) => {
							cleanup();
							if (aborted) {
								settle(() => reject(new Error("Operation aborted")));
								return;
							}
							if (!killedDueToLimit && code !== 0 && code !== 1) {
								const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
								settle(() => reject(new Error(errorMsg)));
								return;
							}
							if (matchCount === 0) {
								settle(() =>
									resolve({ content: [{ type: "text", text: "No matches found" }], details: undefined }),
								);
								return;
							}

							// Format matches after streaming finishes so custom readFile() backends can be async.
							const { output: rawOutput, linesTruncated } = await formatGrepMatches(
								matches,
								contextValue,
								ops,
								formatPath,
							);
							// Apply byte truncation. There is no line limit here because the match limit already capped rows.
							const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
							let output = truncation.content;
							const details: GrepToolDetails = {};
							// Build actionable notices for truncation and match limits.
							const notices: string[] = [];
							if (matchLimitReached) {
								notices.push(
									`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`,
								);
								details.matchLimitReached = effectiveLimit;
							}
							if (truncation.truncated) {
								notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
								details.truncation = truncation;
							}
							if (linesTruncated) {
								notices.push(
									`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`,
								);
								details.linesTruncated = true;
							}
							if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
							settle(() =>
								resolve({
									content: [{ type: "text", text: output }],
									details: Object.keys(details).length > 0 ? details : undefined,
								}),
							);
						});
					} catch (err) {
						settle(() => reject(err as Error));
					}
				})();
			});
		},
		...grepRenderers,
	};
}

export function createGrepTool(cwd: string, options?: GrepToolOptions): AgentTool<typeof grepSchema> {
	return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
