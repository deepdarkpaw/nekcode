import type { Stats } from "node:fs";
import { constants } from "node:fs";
import { access as fsAccess, readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../extensions/types.ts";
import { atomicWriteFileAsync } from "./atomic-write.ts";
import { generateDiffString, generateUnifiedPatch } from "./edit-diff.ts";
import { applyEditToFile, validateEditText } from "./edit-validate.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { decodeFileText } from "./file-text.ts";
import { resolveToCwd } from "./path-utils.ts";
import { createReadStateStore, type ReadStateStore } from "./read-state.ts";
import { type EditRenderState, editRenderers } from "./renderers/edit.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

const editSchema = Type.Object({
	file_path: Type.String({ description: "The absolute path to the file to modify" }),
	old_string: Type.String({ description: "The text to replace" }),
	new_string: Type.String({ description: "The text to replace it with (must be different from old_string)" }),
	replace_all: Type.Optional(
		Type.Union([Type.Boolean(), Type.Literal("true"), Type.Literal("false")], {
			description: "Replace all occurrences of old_string (default false)",
		}),
	),
});

export const editToolSystemPromptContribution = {
	snippet: "Make precise file edits with exact string replacement",
	guidelines: ["Use edit for exact string replacements after reading the target file."],
} as const;

export type EditToolInput = Static<typeof editSchema>;

/** Display-oriented result details for one file edit. */
export interface EditToolDetails {
	/** Display-oriented diff of the changes made. */
	diff: string;
	/** Standard unified patch of the changes made. */
	patch: string;
	/** Line number of the first change in the new file. */
	firstChangedLine?: number;
}

/** Pluggable operations for file editing. */
export interface EditOperations {
	/** Read file contents as bytes. */
	readFile: (absolutePath: string) => Promise<Buffer>;
	/** Write content to a file. */
	writeFile: (absolutePath: string, content: string, encoding: BufferEncoding) => Promise<void>;
	/** Check if file is readable and writable. */
	access: (absolutePath: string) => Promise<void>;
}

const defaultEditOperations: EditOperations = {
	readFile: (path) => fsReadFile(path),
	writeFile: (path, content, encoding) => atomicWriteFileAsync(path, content, { encoding }),
	access: (path) => fsAccess(path, constants.R_OK | constants.W_OK),
};

/** Options for the edit tool. */
export interface EditToolOptions {
	/** Custom filesystem operations. */
	operations?: EditOperations;
	/** Read state that must contain the file before it can be edited. */
	readState?: ReadStateStore;
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function normalizeReplaceAll(value: boolean | "true" | "false" | undefined): boolean {
	return value === true || value === "true";
}

function restoreContent(content: string, bom: string, lineEnding: "\r\n" | "\n"): string {
	const withBom = bom + content;
	return lineEnding === "\r\n" ? withBom.replaceAll("\r\n", "\n").replaceAll("\n", "\r\n") : withBom;
}

function getEditDescription(): string {
	return `Performs exact string replacements in files.\n\nUsage:\n- You must use your \`read\` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.\n- When editing text from read output, preserve exact indentation after the line number prefix. The line number prefix format is: line number + |. Everything after that is the actual file content to match. Never include any part of the line number prefix in old_string or new_string.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.\n- Use \`replace_all\` for replacing and renaming strings across the file.\n- The file_path must be a file path, not a directory path. If the path resolves to an existing directory, the tool will reject it.`;
}

export function createEditToolDefinition(
	cwd: string,
	options?: EditToolOptions,
): ToolDefinition<typeof editSchema, EditToolDetails | undefined, EditRenderState> {
	const ops = options?.operations ?? defaultEditOperations;
	const readState = options?.readState ?? createReadStateStore();
	return {
		name: "edit",
		label: "edit",
		description: getEditDescription(),
		promptSnippet: editToolSystemPromptContribution.snippet,
		promptGuidelines: [...editToolSystemPromptContribution.guidelines],
		parameters: editSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		renderShell: "self",
		prepareArguments(input) {
			if (!input || typeof input !== "object") return input as EditToolInput;
			const args = input as Record<string, unknown>;
			if (args.replace_all === "true") return { ...args, replace_all: true } as EditToolInput;
			if (args.replace_all === "false") return { ...args, replace_all: false } as EditToolInput;
			return input as EditToolInput;
		},
		async execute(_toolCallId, input: EditToolInput, signal?: AbortSignal, _onUpdate?, ctx?: ExtensionContext) {
			const filePath = input.file_path;
			const absolutePath = resolveToCwd(filePath, ctx?.cwd || cwd);
			const replaceAll = normalizeReplaceAll(input.replace_all);
			return withFileMutationQueue(absolutePath, async () => {
				if (signal?.aborted) throw new Error("Operation aborted");
				if (input.old_string === input.new_string) {
					throw new Error("No changes to make: old_string and new_string are exactly the same.");
				}
				let fileStat: Stats | undefined;
				try {
					fileStat = await fsStat(absolutePath);
				} catch (error) {
					if (!isMissingFileError(error)) throw error;
				}
				if (!fileStat) {
					if (input.old_string !== "") {
						throw new Error(`File does not exist. Note: your current working directory is ${ctx?.cwd || cwd}.`);
					}
					const newContent = input.new_string;
					await ops.writeFile(absolutePath, newContent, "utf8");
					const statResult = await fsStat(absolutePath);
					const content = Buffer.from(input.new_string, "utf8").toString("utf8");
					readState.set(absolutePath, {
						content,
						timestamp: Math.floor(statResult.mtimeMs),
						offset: undefined,
						limit: undefined,
					});
					return successResult(filePath, "", newContent, "", newContent);
				}
				if (fileStat.isDirectory())
					throw new Error(`Cannot edit '${filePath}': the specified path is an existing directory.`);
				if (fileStat.size > 1024 * 1024 * 1024) {
					throw new Error(
						`File is too large to edit (${fileStat.size} bytes). Maximum editable file size is 1 GB.`,
					);
				}
				if (filePath.toLowerCase().endsWith(".ipynb"))
					throw new Error("File is a Jupyter Notebook, which this tool cannot edit.");
				if (!readState.get(absolutePath))
					throw new Error("File has not been read yet. Read it first before editing it.");
				await ops.access(absolutePath);
				const buffer = await ops.readFile(absolutePath);
				if (signal?.aborted) throw new Error("Operation aborted");
				const metadata = decodeFileText(buffer);
				const record = readState.get(absolutePath);
				if (!record) throw new Error("File has not been read yet. Read it first before editing it.");
				const currentTimestamp = Math.floor(fileStat.mtimeMs);
				const fullRead = record.offset === undefined && record.limit === undefined;
				if (currentTimestamp > record.timestamp && (!fullRead || metadata.content !== record.content)) {
					throw new Error(
						"File has been modified since read, either by the user or by a linter. Read it again before attempting to write it.",
					);
				}
				const validated = validateEditText(metadata.content, {
					filePath,
					oldString: input.old_string,
					newString: input.new_string,
					replaceAll,
				});
				const newContent = applyEditToFile(
					metadata.content,
					validated.actualOldString,
					validated.newString,
					replaceAll,
				);
				if (newContent === metadata.content)
					throw new Error("No changes to make: old_string and new_string are exactly the same.");
				const finalContent = restoreContent(newContent, metadata.bom, metadata.lineEnding);
				await ops.writeFile(absolutePath, finalContent, metadata.encoding);
				const updatedStat = await fsStat(absolutePath);
				readState.set(absolutePath, {
					content: newContent,
					timestamp: Math.floor(updatedStat.mtimeMs),
					offset: undefined,
					limit: undefined,
				});
				if (signal?.aborted) throw new Error("Operation aborted");
				return successResult(
					filePath,
					metadata.content,
					newContent,
					validated.actualOldString,
					validated.newString,
					replaceAll,
				);
			});
		},
		...editRenderers,
	};
}

function successResult(
	filePath: string,
	oldContent: string,
	newContent: string,
	oldString: string,
	newString: string,
	replaceAll = false,
) {
	const diff = generateDiffString(oldContent, newContent);
	return {
		content: [
			{
				type: "text" as const,
				text: replaceAll
					? "All occurrences were successfully replaced."
					: `The file ${filePath} has been updated successfully.`,
			},
		],
		details: {
			diff: diff.diff,
			patch: generateUnifiedPatch(filePath, oldContent, newContent),
			firstChangedLine: diff.firstChangedLine,
			oldString,
			newString,
		},
	};
}

export function createEditTool(cwd: string, options?: EditToolOptions): AgentTool<typeof editSchema> {
	return wrapToolDefinition(createEditToolDefinition(cwd, options));
}
