import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { Api, ImageContent, Model, ModelImageResizeOptions, TextContent } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { processImage } from "../../utils/image-process.ts";
import { detectSupportedImageMimeTypeFromFile } from "../../utils/mime.ts";
import { splitBom } from "../../utils/text.ts";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { normalizeToLF } from "./edit-diff.ts";
import { detectEncoding } from "./file-text.ts";
import { resolveReadPathAsync } from "./path-utils.ts";
import { buildReadChunks, formatReadChunkLines, type ReadChunk } from "./read-chunks.ts";
import { buildReadOutline, type ReadOutline } from "./read-outline.ts";
import type { ReadStateStore } from "./read-state.ts";
import { readRenderers } from "./renderers/read.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "The absolute path of the file to read." }),
	offset: Type.Optional(
		Type.Integer({
			description:
				"The line number to start reading from. Positive values are 1-indexed from the start of the file. Negative values count backwards from the end (e.g. -1 is the last line). Only provide if the file is too large to read at once.",
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			description: "The number of lines to read. Only provide if the file is too large to read at once.",
		}),
	),
});

export const readToolSystemPromptContribution = {
	snippet: "Read file contents",
	guidelines: ["Use read to examine files instead of cat or sed."],
} as const;

/** Parameters accepted by the read tool. */
export type ReadToolInput = Static<typeof readSchema>;

/** Representation selected for a successful text read. */
export type ReadRepresentation = "full" | "outline" | "chunks" | "50-line";

/** Compact chunk metadata for read renderers and callers. */
export interface ReadChunkDetails {
	startLine: number;
	endLine: number;
	label?: string;
}

/** Structured details returned by the Cursor-style read tool. */
export interface ReadToolDetails {
	truncation?: TruncationResult;
	representation?: ReadRepresentation;
	chunks?: ReadChunkDetails[];
}

/** Pluggable operations for the read tool. */
export interface ReadOperations {
	/** Read file contents as a Buffer. */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Check if file is readable (throw if not). */
	access: (absolutePath: string) => Promise<void>;
	/** Detect image MIME type, return null or undefined for non-images. */
	detectImageMimeType?: (absolutePath: string) => Promise<string | null | undefined>;
	/** Return file mtime for read-state freshness checks. */
	stat?: (absolutePath: string) => Promise<{ mtimeMs: number }>;
}

const defaultReadOperations: ReadOperations = {
	readFile: (path) => fsReadFile(path),
	access: (path) => fsAccess(path, constants.R_OK),
	detectImageMimeType: detectSupportedImageMimeTypeFromFile,
	stat: async (path) => ({ mtimeMs: (await fsStat(path)).mtimeMs }),
};

/** Options controlling image handling, filesystem operations, and per-session read state. */
export interface ReadToolOptions {
	/** Whether to auto-resize images. Default: true. */
	autoResizeImages?: boolean;
	/** Fallback resize profile when the execution context has no model metadata. */
	resizeOptions?: ModelImageResizeOptions;
	/** Custom operations for file reading. Default: local filesystem. */
	operations?: ReadOperations;
	/** Read state to record each successful text read into. */
	readState?: ReadStateStore;
}

function getNonVisionImageNote(model: Model<Api> | undefined): string | undefined {
	if (!model || model.input.includes("image")) return undefined;
	return "[Current model does not support images. The image will be omitted from this request.]";
}

function decodeText(buffer: Buffer): string {
	const decoded = buffer.toString(detectEncoding(buffer));
	return normalizeToLF(splitBom(decoded).text);
}

function getStartLine(offset: number | undefined, totalLines: number): number {
	if (offset === undefined) return 0;
	return offset < 0 ? totalLines + offset : Math.max(0, offset - 1);
}

function numberLines(lines: string[], startLine: number): Array<{ lineNumber: number; text: string }> {
	return lines.map((text, index) => ({ lineNumber: startLine + index + 1, text }));
}

function chunkDetails(chunks: ReadChunk[]): ReadChunkDetails[] {
	return chunks.map(({ startLine, endLine, label }) => ({ startLine, endLine, label }));
}

function renderSelectedText(
	allLines: string[],
	offset: number | undefined,
	limit: number | undefined,
	outline: ReadOutline | undefined,
): {
	text: string;
	representation: ReadRepresentation;
	chunks?: ReadChunkDetails[];
	firstLine: number;
	outputLines: number;
} {
	const ranged = offset !== undefined || limit !== undefined;
	if (ranged) {
		const startLine = getStartLine(offset, allLines.length);
		if (startLine < 0 || startLine >= allLines.length) {
			throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
		}
		const endLine = limit === undefined ? allLines.length : Math.min(allLines.length, startLine + Math.max(0, limit));
		const selected = numberLines(allLines.slice(startLine, endLine), startLine);
		return {
			text: selected.map((line) => `${String(line.lineNumber).padStart(6, " ")}|${line.text}`).join("\n"),
			representation: "full",
			firstLine: startLine + 1,
			outputLines: selected.length,
		};
	}
	// Cursor's getValueLength() counts UTF-16 code units, matching JavaScript string length.
	if (allLines.join("\n").length <= 10_000) {
		const selected = numberLines(allLines, 0);
		return {
			text: selected.map((line) => `${String(line.lineNumber).padStart(6, " ")}|${line.text}`).join("\n"),
			representation: "full",
			firstLine: 1,
			outputLines: selected.length,
		};
	}
	const chunkResult = buildReadChunks(allLines.join("\n"), outline);
	return {
		text: formatReadChunkLines(chunkResult.chunks),
		representation: chunkResult.usedFallback ? "50-line" : "chunks",
		chunks: chunkDetails(chunkResult.chunks),
		firstLine: 1,
		outputLines: chunkResult.chunks.reduce((sum, chunk) => sum + chunk.lines.length, 0),
	};
}

function applyTextTruncation(
	selected: ReturnType<typeof renderSelectedText>,
	allLines: string[],
	path: string,
	offset: number | undefined,
	limit: number | undefined,
): { text: string; truncation?: TruncationResult } {
	const truncation = truncateHead(selected.text);
	if (truncation.firstLineExceedsLimit) {
		const firstLine = selected.firstLine;
		const firstLineSize = formatSize(Buffer.byteLength(allLines[firstLine - 1] ?? "", "utf-8"));
		return {
			text: `[Line ${firstLine} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${firstLine}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`,
			truncation,
		};
	}
	if (truncation.truncated) {
		const shownLine =
			selected.outputLines > 0 ? (selected.text.slice(0, truncation.content.length).split("\n").pop() ?? "") : "";
		const match = shownLine.match(/^(\s*\d+)\|/);
		const endLine = match ? Number(match[1]) : selected.firstLine + truncation.outputLines - 1;
		const nextOffset = endLine + 1;
		let text = truncation.content;
		if (truncation.truncatedBy === "lines") {
			text += `\n\n[Showing lines ${selected.firstLine}-${endLine} of ${allLines.length}. Use offset=${nextOffset} to continue.]`;
		} else {
			text += `\n\n[Showing lines ${selected.firstLine}-${endLine} of ${allLines.length} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
		}
		return { text, truncation };
	}
	if (limit !== undefined) {
		const startLine = getStartLine(offset, allLines.length);
		const selectedLines = Math.max(0, Math.min(allLines.length, startLine + Math.max(0, limit)) - startLine);
		if (startLine + selectedLines < allLines.length) {
			const remaining = allLines.length - (startLine + selectedLines);
			return {
				text: `${selected.text}\n\n[${remaining} more lines in file. Use offset=${startLine + selectedLines + 1} to continue.]`,
			};
		}
	}
	return { text: truncation.content };
}

/** Create the Cursor-compatible read tool definition. */
export function createReadToolDefinition(
	cwd: string,
	options?: ReadToolOptions,
): ToolDefinition<typeof readSchema, ReadToolDetails | undefined> {
	const autoResizeImages = options?.autoResizeImages ?? true;
	const fallbackResizeOptions = options?.resizeOptions;
	const ops = options?.operations ?? defaultReadOperations;
	return {
		name: "read",
		label: "read",
		description:
			"Reads a file from the local filesystem. This tool can also read image files when called with the appropriate path. Formats supported: jpeg/jpg, png, gif, webp.",
		promptSnippet: readToolSystemPromptContribution.snippet,
		promptGuidelines: [...readToolSystemPromptContribution.guidelines],
		parameters: readSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(
			_toolCallId,
			{ path, offset, limit }: ReadToolInput,
			signal?: AbortSignal,
			_onUpdate?,
			ctx?: ExtensionContext,
		) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const absolutePath = await resolveReadPathAsync(path, ctx?.cwd || cwd);
			await ops.access(absolutePath);
			if (signal?.aborted) throw new Error("Operation aborted");
			const mimeType = ops.detectImageMimeType ? await ops.detectImageMimeType(absolutePath) : undefined;
			let content: (TextContent | ImageContent)[];
			let details: ReadToolDetails | undefined;
			const nonVisionImageNote = getNonVisionImageNote(ctx?.model);
			if (mimeType) {
				const buffer = await ops.readFile(absolutePath);
				const processed = await processImage(buffer, mimeType, {
					autoResizeImages,
					resizeOptions: ctx?.model?.inputLimits?.images?.resize ?? fallbackResizeOptions,
				});
				if (!processed.ok) {
					let textNote = `Read image file [${mimeType}]\n${processed.message}`;
					if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
					content = [{ type: "text", text: textNote }];
				} else {
					let textNote = `Read image file [${processed.mimeType}]`;
					if (processed.hints.length > 0) textNote += `\n${processed.hints.join("\n")}`;
					if (nonVisionImageNote) textNote += `\n${nonVisionImageNote}`;
					content = [
						{ type: "text", text: textNote },
						{ type: "image", data: processed.data, mimeType: processed.mimeType },
					];
				}
			} else {
				const buffer = await ops.readFile(absolutePath);
				const textContent = decodeText(buffer);
				const allLines = textContent.split("\n");
				const timestamp = ops.stat ? (await ops.stat(absolutePath)).mtimeMs : Date.now();
				const outline =
					offset === undefined && limit === undefined
						? await buildReadOutline(absolutePath, textContent, {
								cacheKey: `${absolutePath}:${timestamp}:${textContent.length}`,
							})
						: undefined;
				const selected = renderSelectedText(allLines, offset, limit, outline);
				const rendered = applyTextTruncation(selected, allLines, absolutePath, offset, limit);
				details = {
					representation: selected.representation,
					chunks: selected.chunks,
					...(rendered.truncation ? { truncation: rendered.truncation } : {}),
				};
				if (options?.readState) {
					options.readState.set(absolutePath, { content: textContent, timestamp, offset, limit });
				}
				content = [{ type: "text", text: rendered.text }];
			}
			if (signal?.aborted) throw new Error("Operation aborted");
			return { content, details };
		},
		...readRenderers,
	};
}

/** Create the Cursor-compatible read tool. */
export function createReadTool(cwd: string, options?: ReadToolOptions): AgentTool<typeof readSchema> {
	return wrapToolDefinition(createReadToolDefinition(cwd, options));
}
