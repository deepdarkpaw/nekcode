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
export { restoreReadState } from "./read-state-replay.ts";
export {
	recognizeBashRead,
	recognizePowerShellRead,
	resolveShellRead,
	type ShellReadEvidence,
} from "./shell-read-recognition.ts";
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
	createWebSearchTool,
	createWebSearchToolDefinition,
	parseWebSearchResults,
	type WebSearchResult,
	type WebSearchToolDetails,
	type WebSearchToolInput,
	type WebSearchToolOptions,
} from "./web-search.ts";
export {
	createWriteTool,
	createWriteToolDefinition,
	type WriteOperations,
	type WriteToolInput,
	type WriteToolOptions,
} from "./write.ts";

import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { ToolDefinition } from "../extensions/types.ts";
import { BUILTIN_TOOL_NAMES, type ToolName } from "../tool-names.ts";
import { type AstGrepToolOptions, createAstGrepToolDefinition } from "./ast-grep.ts";
import { type BashToolOptions, createBashToolDefinition } from "./bash.ts";
import { createEditToolDefinition, type EditToolOptions } from "./edit.ts";
import { createFindToolDefinition, type FindToolOptions } from "./find.ts";
import { createGrepToolDefinition, type GrepToolOptions } from "./grep.ts";
import { createLsToolDefinition, type LsToolOptions } from "./ls.ts";
import { createPowerShellToolDefinition, type PowerShellToolOptions } from "./powershell.ts";
import { createReadToolDefinition, type ReadToolOptions } from "./read.ts";
import { createReadStateStore, type ReadStateStore } from "./read-state.ts";
import { wrapToolDefinition, wrapToolDefinitions } from "./tool-definition-wrapper.ts";
import { createWebSearchToolDefinition, type WebSearchToolOptions } from "./web-search.ts";
import { createWriteToolDefinition, type WriteToolOptions } from "./write.ts";

export type Tool = AgentTool<any>;
export type ToolDef = ToolDefinition<any, any>;
export { allToolNames, DEFAULT_ACTIVE_TOOL_NAMES, type ToolName } from "../tool-names.ts";

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
	web_search?: WebSearchToolOptions;
	/**
	 * Read state shared by read, write, edit, bash, and powershell. Edit remains allowed on unread files; overwriting an
	 * existing file with write requires a prior read. Omitted callers get one store per tool set.
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
			return createBashToolDefinition(cwd, { ...options?.bash, readState });
		case "powershell":
			return createPowerShellToolDefinition(cwd, { ...options?.powershell, readState });
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
		case "web_search":
			return createWebSearchToolDefinition(options?.web_search);
		default:
			throw new Error(`Unknown tool name: ${toolName}`);
	}
}

export function createTool(toolName: ToolName, cwd: string, options?: ToolsOptions): Tool {
	return wrapToolDefinition(createToolDefinition(toolName, cwd, options));
}

const CODING_TOOL_NAMES: readonly ToolName[] = ["read", "bash", "edit", "write", "web_search"];
const READ_ONLY_TOOL_NAMES: readonly ToolName[] = ["read", "grep", "find", "ls", "ast_grep", "web_search"];

/** Resolve one read state per set, not one per tool. */
function createDefinitions(names: readonly ToolName[], cwd: string, options?: ToolsOptions): ToolDef[] {
	const shared = { ...options, readState: resolveReadState(options) };
	return names.map((name) => createToolDefinition(name, cwd, shared));
}

export function createCodingToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return createDefinitions(CODING_TOOL_NAMES, cwd, options);
}

export function createReadOnlyToolDefinitions(cwd: string, options?: ToolsOptions): ToolDef[] {
	return createDefinitions(READ_ONLY_TOOL_NAMES, cwd, options);
}

export function createAllToolDefinitions(cwd: string, options?: ToolsOptions): Record<ToolName, ToolDef> {
	return Object.fromEntries(
		createDefinitions(BUILTIN_TOOL_NAMES, cwd, options).map((tool) => [tool.name, tool]),
	) as Record<ToolName, ToolDef>;
}

export function createCodingTools(cwd: string, options?: ToolsOptions): Tool[] {
	return wrapToolDefinitions(createCodingToolDefinitions(cwd, options));
}

export function createReadOnlyTools(cwd: string, options?: ToolsOptions): Tool[] {
	return wrapToolDefinitions(createReadOnlyToolDefinitions(cwd, options));
}

export function createAllTools(cwd: string, options?: ToolsOptions): Record<ToolName, Tool> {
	return Object.fromEntries(
		Object.entries(createAllToolDefinitions(cwd, options)).map(([name, definition]) => [
			name,
			wrapToolDefinition(definition),
		]),
	) as Record<ToolName, Tool>;
}
