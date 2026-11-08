import { stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { spawn } from "child_process";
import path from "path";
import { type Static, Type } from "typebox";
import { ensureTool } from "../../utils/tools-manager.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { grepRenderers } from "./renderers/grep.ts";
import type { SearchOutputLine } from "./search-output.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import {
	DEFAULT_MAX_BYTES,
	formatSize,
	GREP_MAX_LINE_LENGTH,
	type TruncationResult,
	truncateLine,
} from "./truncate.ts";

const grepSchema = Type.Object({
	pattern: Type.String({ description: "ripgrep regex, or exact text when literal is true" }),
	path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
	glob: Type.Optional(
		Type.String({
			description:
				"Filter files by glob relative to path, e.g. '*.ts', 'src/**/*.ts', or '!**/*.test.ts' to exclude. A pattern without '/' matches file names at any depth; a leading './' is ignored",
		}),
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
- Narrow the search with path (a directory or one file) and glob ('*.ts', or '!**/*.test.ts' to exclude files). Directory globs are relative to path; a leading './' is ignored.
- Respects .gitignore and includes dotfiles. Matching is case-sensitive unless ignoreCase is set.
- Output is truncated to ${DEFAULT_LIMIT} matches (raise limit to see more) or ${DEFAULT_MAX_BYTES / 1024}KB, whichever is hit first; long lines are truncated to ${GREP_MAX_LINE_LENGTH} characters.`;

export interface GrepToolDetails {
	truncation?: TruncationResult;
	matchLimitReached?: number;
	linesTruncated?: boolean;
}

/** Pluggable directory check. Search and context always come from local rg; override execute() for remote search. */
export interface GrepOperations {
	/** Check if path is a directory. Throws if path does not exist. */
	isDirectory: (absolutePath: string) => Promise<boolean> | boolean;
	/** @deprecated Unused: context is emitted by rg, and matched files are never reread. */
	readFile?: (absolutePath: string) => Promise<string> | string;
}

const defaultGrepOperations: GrepOperations = {
	isDirectory: async (p) => (await fsStat(p)).isDirectory(),
};

export interface GrepToolOptions {
	/** Custom operations for grep. Default: local filesystem plus ripgrep */
	operations?: GrepOperations;
}

/** Decode rg's JSON text fields, including base64 records for invalid UTF-8 paths and lines. */
function decodeRgText(value: { text?: string; bytes?: string } | undefined): string {
	if (typeof value?.text === "string") return value.text;
	if (typeof value?.bytes === "string") return Buffer.from(value.bytes, "base64").toString("utf-8");
	return "";
}

/** Format one row exactly as search-output does, before comparing full-file inline/grouped sizes. */
function formatGrepRow(row: SearchOutputLine, grouped: boolean): string {
	const prefix = grouped ? "  " : row.path;
	const separator = row.context ? "-" : ":";
	return `${row.breakBefore ? (grouped ? "  --\n" : "--\n") : ""}${prefix}${grouped ? "" : separator}${row.line}${separator} ${row.text}`;
}

/**
 * rg emits each file's records together. Count both possible layouts for that file, retaining only the
 * prefix that could fit in either one. This preserves shortest-layout grouping even after the byte cap,
 * without storing every match/context row or every file name in a large search.
 */
function createGrepOutput() {
	const output: string[] = [];
	let outputBytes = 0;
	let firstLineBytes = 0;
	let stopped = false;
	let totalBytes = 0;
	let totalLines = 0;
	let groupPath: string | undefined;
	let rows: SearchOutputLine[] = [];
	let rowCount = 0;
	let inlineBytes = 0;
	let inlineLines = 0;
	let groupedBytes = 0;
	let groupedLines = 0;
	const keep = (text: string) => {
		if (stopped) return;
		for (const line of text.split("\n")) {
			const bytes = Buffer.byteLength(line, "utf-8");
			if (output.length === 0) firstLineBytes = bytes;
			if (outputBytes + (output.length > 0 ? 1 : 0) + bytes > DEFAULT_MAX_BYTES) {
				stopped = true;
				return;
			}
			outputBytes += (output.length > 0 ? 1 : 0) + bytes;
			output.push(line);
		}
	};
	const finishFile = () => {
		if (groupPath === undefined) return;
		const grouped = rowCount > 1 && groupedBytes < inlineBytes;
		if (grouped) keep(`${groupPath}:`);
		for (const row of rows) keep(formatGrepRow(row, grouped));
		totalBytes += (totalLines > 0 ? 1 : 0) + (grouped ? groupedBytes : inlineBytes);
		totalLines += grouped ? groupedLines : inlineLines;
		groupPath = undefined;
		rows = [];
	};
	return {
		append(row: SearchOutputLine) {
			if (row.path !== groupPath) {
				finishFile();
				groupPath = row.path;
				rowCount = 0;
				inlineBytes = 0;
				inlineLines = 0;
				groupedBytes = Buffer.byteLength(`${row.path}:`, "utf-8");
				groupedLines = row.path.split("\n").length;
			}
			if (totalBytes + Math.min(inlineBytes, groupedBytes) <= DEFAULT_MAX_BYTES) rows.push(row);
			const inline = formatGrepRow(row, false);
			const grouped = formatGrepRow(row, true);
			inlineBytes += (rowCount > 0 ? 1 : 0) + Buffer.byteLength(inline, "utf-8");
			inlineLines += inline.split("\n").length;
			groupedBytes += 1 + Buffer.byteLength(grouped, "utf-8");
			groupedLines += grouped.split("\n").length;
			rowCount++;
		},
		finish(): TruncationResult {
			finishFile();
			const truncated = totalBytes > DEFAULT_MAX_BYTES;
			return {
				content: output.join("\n"),
				truncated,
				truncatedBy: truncated ? "bytes" : null,
				totalLines,
				totalBytes,
				outputLines: output.length,
				outputBytes,
				lastLinePartial: false,
				firstLineExceedsLimit: firstLineBytes > DEFAULT_MAX_BYTES,
				maxLines: Number.MAX_SAFE_INTEGER,
				maxBytes: DEFAULT_MAX_BYTES,
			};
		},
	};
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

						// Avoid exponent notation in rg's integer argument and normalize fractional public API inputs.
						const contextValue =
							context && context > 0 ? Math.min(Math.floor(context), Number.MAX_SAFE_INTEGER) : 0;
						const effectiveLimit = Math.max(1, Math.floor(limit ?? DEFAULT_LIMIT));
						const formatPath = (filePath: string): string => {
							if (isDirectory) {
								const relative = path.relative(searchPath, path.resolve(searchPath, filePath));
								if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`)) {
									return relative.replace(/\\/g, "/");
								}
							}
							return path.basename(filePath);
						};

						const args: string[] = ["--no-config", "--json", "--line-number", "--color=never", "--hidden"];
						if (ignoreCase) args.push("--ignore-case");
						if (literal) args.push("--fixed-strings");
						if (glob) args.push("--glob", glob.replace(/^(!?)(?:\.\/)+/, "$1"));
						if (contextValue > 0) args.push("--context", String(contextValue));
						// rg anchors globs at cwd. Search "." there so symlinked cwd paths also stay relative.
						const rgCwd = isDirectory ? searchPath : path.dirname(searchPath);
						args.push("--", pattern, isDirectory ? "." : `.${path.sep}${path.basename(searchPath)}`);

						if (signal?.aborted) throw new Error("Operation aborted");
						const child = spawn(rgPath, args, { cwd: rgCwd, stdio: ["ignore", "pipe", "pipe"] });
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

						const outputRows = createGrepOutput();
						let linesTruncated = false;
						let lastFile: string | undefined;
						let lastLine = 0;
						let limitFile: string | undefined;
						let trailingContextEnd = 0;
						let done = false;
						const finish = () => {
							done = true;
							stopChild(true);
						};
						const append = (filePath: string, lineNumber: number, lineText: string, isMatch: boolean) => {
							const truncated = truncateLine(lineText.replace(/\r?\n$/, ""));
							linesTruncated ||= truncated.wasTruncated;
							outputRows.append({
								path: formatPath(filePath),
								line: lineNumber,
								text: truncated.text,
								context: !isMatch,
								breakBefore: contextValue > 0 && filePath === lastFile && lineNumber > lastLine + 1,
							});
							lastFile = filePath;
							lastLine = lineNumber;
						};
						rl.on("line", (line) => {
							if (done || !line.trim()) return;
							let event: any;
							try {
								event = JSON.parse(line);
							} catch {
								return;
							}
							if (event.type === "end") {
								if (matchLimitReached && decodeRgText(event.data?.path) === limitFile) finish();
								return;
							}
							const isMatch = event.type === "match";
							if (!isMatch && event.type !== "context") return;
							const filePath = decodeRgText(event.data?.path);
							const lineNumber = event.data?.line_number;
							if (!filePath || typeof lineNumber !== "number") return;
							const lineText = decodeRgText(event.data?.lines);
							if (matchCount < effectiveLimit) {
								append(filePath, lineNumber, lineText, isMatch);
								if (isMatch && ++matchCount === effectiveLimit) {
									limitFile = filePath;
									trailingContextEnd = lineNumber + contextValue;
								}
								return;
							}
							const inWindow = filePath === limitFile && lineNumber <= trailingContextEnd;
							// An extra match within the last allowed match's context remains a context row.
							if (inWindow) append(filePath, lineNumber, lineText, false);
							if (isMatch) matchLimitReached = true;
							if (matchLimitReached && !(inWindow && lineNumber < trailingContextEnd)) finish();
						});

						child.on("error", (error) => {
							cleanup();
							settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
						});
						child.on("close", (code) => {
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

							// The collector counts every formatted row but retains only the byte-bounded output prefix.
							const truncation = outputRows.finish();
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
