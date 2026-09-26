export {
	type AstGrepToolDetails,
	type AstGrepToolInput,
	type AstGrepToolOptions,
	createAstGrepTool,
	createAstGrepToolDefinition,
} from "./ast-grep.ts";
export {
	type BashOperations,
	type BashSpawnContext,
	type BashSpawnHook,
	type BashToolDetails,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "./bash.ts";
export {
	createEditTool,
	createEditToolDefinition,
	type EditOperations,
	type EditToolDetails,
	type EditToolInput,
	type EditToolOptions,
} from "./edit.ts";
export { withFileMutationQueue } from "./file-mutation-queue.ts";
export {
	createFindTool,
	createFindToolDefinition,
	type FindOperations,
	type FindToolDetails,
	type FindToolInput,
	type FindToolOptions,
} from "./find.ts";
export {
	createGrepTool,
	createGrepToolDefinition,
	type GrepOperations,
	type GrepToolDetails,
	type GrepToolInput,
	type GrepToolOptions,
} from "./grep.ts";
export {
	createLsTool,
	createLsToolDefinition,
	type LsOperations,
	type LsToolDetails,
	type LsToolInput,
	type LsToolOptions,
} from "./ls.ts";
export {
	createLocalPowerShellOperations,
	createPowerShellTool,
	createPowerShellToolDefinition,
	type PowerShellOperations,
	type PowerShellSpawnContext,
	type PowerShellSpawnHook,
	type PowerShellToolDetails,
	type PowerShellToolInput,
	type PowerShellToolOptions,
} from "./powershell.ts";
export {
	createReadTool,
	createReadToolDefinition,
	type ReadChunkDetails,
	type ReadOperations,
	type ReadRepresentation,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	buildReadChunks,
	CHUNK_FALLBACK_LINES,
	CHUNK_MAX_AVERAGE_CHARACTERS,
	CHUNK_TARGET_LINES,
	FOLD_MIN_LINES,
	formatReadChunkLines,
	type ReadChunk,
	type ReadChunksResult,
} from "./read-chunks.ts";
export {
	buildReadOutline,
	clearReadOutlineCache,
	getReadOutlineLanguage,
	type ReadOutline,
	type ReadOutlineOptions,
	type ReadOutlineSymbol,
	renderReadOutline,
} from "./read-outline.ts";
export {
	createReadStateStore,
	DEFAULT_READ_STATE_BYTES,
	DEFAULT_READ_STATE_ENTRIES,
	type ReadStateRecord,
	type ReadStateStore,
	readStateKey,
} from "./read-state.ts";
export {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	type TruncationOptions,
	type TruncationResult,
	truncateHead,
	truncateLine,
	truncateTail,
} from "./truncate.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { type AstGrepToolOptions, createAstGrepTool, createAstGrepToolDefinition } from "./ast-grep.ts";
import { type BashToolOptions, createBashTool, createBashToolDefinition } from "./bash.ts";
import { createEditTool, createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindTool, createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepTool, createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsTool, createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createPowerShellTool, createPowerShellToolDefinition, type PowerShellToolOptions } from "./powershell.ts";
import { createReadTool, createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createReadStateStore, type ReadStateStore } from "./read-state.ts";
import { createWriteTool, createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export type ToolName = "read" | "bash" | "powershell" | "edit" | "write" | "grep" | "find" | "ls" | "ast_grep";
export const allToolNames: Set<ToolName> = new Set([
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"ast_grep",
]);

/** Built-in tools active in a new session when neither settings nor options select tools. */
export const DEFAULT_ACTIVE_TOOL_NAMES: readonly ToolName[] = ["read", "bash", "edit", "write", "ast_grep"];

export interface ToolsOptions {
	read?: ReadToolOptions;
	bash?: BashToolOptions;
	powershell?: PowerShellToolOptions;
	write?: WriteToolOptions;
	edit?: EditToolOptions;
	grep?: GrepToolOptions;
	find?: FindToolOptions;
	ls?: LsToolOptions;
	ast_grep?: AstGrepToolOptions;
	/**
	 * Read state shared by read, write, and edit so an edit cannot overwrite a file the model has not read.
	 * Omitted callers get one store per tool set.
	 */
	readState?: ReadStateStore;
}

/** One read state store per tool set when the caller supplies none. */
function resolveReadState(options: ToolsOptions | undefined): ReadStateStore {
	return options?.readState ?? createReadStateStore();
}

export function createToolDefinition(toolName: ToolName, cwd: string, options?: ToolsOptions): ToolDef {
	const readState = resolveReadState(options);
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd, { ...options?.read, readState });
		case "bash":
			return createBashToolDefinition(cwd, options?.bash);
		case "powershell":
			return createPowerShellToolDefinition(cwd, options?.powershell);
		case "edit":
			return createEditToolDefinition(cwd, { ...options?.edit, readState });
		case "write":
			return createWriteToolDefinition(cwd, { ...options?.write, readState });
		case "grep":
			return createGrepToolDefinition(cwd, options?.grep);
		case "find":
			return createFindToolDefinition(cwd, options?.find);
		case "ls":
			return createLsToolDefinition(cwd, options?.ls);
		case "ast_grep":
			return createAstGrepToolDefinition(cwd, options?.ast_grep);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	const readState = resolveReadState(options);
	switch (toolName) {
		case "read":
			return createReadTool(cwd, { ...options?.read, readState });
		case "bash":
			return createBashTool(cwd, options?.bash);
		case "powershell":
			return createPowerShellTool(cwd, options?.powershell);
		case "edit":
			return createEditTool(cwd, { ...options?.edit, readState });
		case "write":
			return createWriteTool(cwd, { ...options?.write, readState });
		case "grep":
			return createGrepTool(cwd, options?.grep);
		case "find":
			return createFindTool(cwd, options?.find);
		case "ls":
			return createLsTool(cwd, options?.ls);
		case "ast_grep":
			return createAstGrepTool(cwd, options?.ast_grep);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	const readState = resolveReadState(options);
	return [
		createReadToolDefinition(cwd, { ...options?.read, readState }),
		createBashToolDefinition(cwd, options?.bash),
		createEditToolDefinition(cwd, { ...options?.edit, readState }),
		createWriteToolDefinition(cwd, { ...options?.write, readState }),
	];
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return [
		createReadToolDefinition(cwd, { ...options?.read, readState: resolveReadState(options) }),
		createGrepToolDefinition(cwd, options?.grep),
		createFindToolDefinition(cwd, options?.find),
		createLsToolDefinition(cwd, options?.ls),
		createAstGrepToolDefinition(cwd, options?.ast_grep),
	];
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	const readState = resolveReadState(options);
	return {
		read: createReadToolDefinition(cwd, { ...options?.read, readState }),
		bash: createBashToolDefinition(cwd, options?.bash),
		powershell: createPowerShellToolDefinition(cwd, options?.powershell),
		edit: createEditToolDefinition(cwd, { ...options?.edit, readState }),
		write: createWriteToolDefinition(cwd, { ...options?.write, readState }),
		grep: createGrepToolDefinition(cwd, options?.grep),
		find: createFindToolDefinition(cwd, options?.find),
		ls: createLsToolDefinition(cwd, options?.ls),
		ast_grep: createAstGrepToolDefinition(cwd, options?.ast_grep),
	};
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	const readState = resolveReadState(options);
	return [
		createReadTool(cwd, { ...options?.read, readState }),
		createBashTool(cwd, options?.bash),
		createEditTool(cwd, { ...options?.edit, readState }),
		createWriteTool(cwd, { ...options?.write, readState }),
	];
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	const readState = resolveReadState(options);
	return [
		createReadTool(cwd, { ...options?.read, readState }),
		createGrepTool(cwd, options?.grep),
		createFindTool(cwd, options?.find),
		createLsTool(cwd, options?.ls),
		createAstGrepTool(cwd, options?.ast_grep),
	];
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	const readState = resolveReadState(options);
	return {
		read: createReadTool(cwd, { ...options?.read, readState }),
		bash: createBashTool(cwd, options?.bash),
		powershell: createPowerShellTool(cwd, options?.powershell),
		edit: createEditTool(cwd, { ...options?.edit, readState }),
		write: createWriteTool(cwd, { ...options?.write, readState }),
		grep: createGrepTool(cwd, options?.grep),
		find: createFindTool(cwd, options?.find),
		ls: createLsTool(cwd, options?.ls),
		ast_grep: createAstGrepTool(cwd, options?.ast_grep),
	};
}
