import type { Context } from "@earendil-works/chord";
import type { AgentMessage, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent } from "@earendil-works/pi-ai";
import {
	CompactionTask,
	defineDoc,
	defineExtension,
	type Extension,
	type GenerationCheckpoint,
	GenerationTask,
	type HookApi,
	hook,
	section,
	type ToolExecutionApi,
	type ToolExecutionResult,
	type ToolRegistration,
	ToolTask,
} from "@earendil-works/pi-durable";
import { convertToLlm } from "../messages.ts";
import { type CompactionBridge, createBeforeCompact } from "./compaction.ts";
import { agentContext, sameModelContext } from "./context.ts";
import { CompactionDetailsDoc } from "./entries.ts";
import { toStrictJson, toStrictJsonObject } from "./json.ts";

/** Registry extension names owned by the engine. */
export const PROMPT_EXTENSION = "nek-prompt";
export const HOOKS_EXTENSION = "nek-hooks";
export const TOOLS_EXTENSION = "nek-tools";

/** Section key of the effective system prompt. */
export const PROMPT_SECTION_KEY = "nek";

/** Built-in tools whose interrupted calls rerun after a crash: they only read, so a second run is harmless. */
export const REPLAY_SAFE_TOOL_NAMES: ReadonlySet<string> = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"ast_grep",
	"web_search",
]);

/**
 * Pi tools bound their own output (50 KB / 2,000 lines, bash keeping the tail). Durable's limits sit above every pi
 * cap so it never truncates again; the text the model reads is exactly what the tool produced.
 */
const UNBOUNDED = Number.MAX_SAFE_INTEGER;

/**
 * The effective system prompt of a conversation for its current run, after `before_agent_start`. It lives in a
 * document so a request prepared after a crash renders exactly the prompt the run started with.
 */
export const PromptDoc = defineDoc<{ text: string }>({
	kind: "nek.prompt",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "current",
	initial: () => ({ text: "" }),
});

/** Memo a `tool_call` block leaves for the tool's own execution; hook and task memos share one namespace. */
const BLOCK_MEMO = "nek:block";
type BlockMemo = { reason: string; terminate: boolean };

/** Prompt extension: one untagged section rendering the conversation's stored effective prompt. */
export function createPromptExtension(): Extension {
	return defineExtension({
		name: PROMPT_EXTENSION,
		sections: [
			section(
				PROMPT_SECTION_KEY,
				async (input, context) => {
					const text = (await input.read.snapshot(PromptDoc, input.conversationId, context))?.text;
					return text === undefined || text === "" ? undefined : text;
				},
				{ tag: false },
			),
		],
	});
}

/**
 * Values a wrapped tool reports that the result entry cannot carry, kept until `afterTool` of the same task reads
 * them. In memory only: a crash loses them, like the rest of an unfinished execution.
 */
type PendingResults = Map<number, { readonly structuredContent: AgentToolResult["structuredContent"] }>;

/** What the hook extension needs from the engine. */
export type HookBridge = CompactionBridge & {
	/** Shared with the wrapped tools. */
	readonly pending: PendingResults;
};

export function createPendingResults(): PendingResults {
	return new Map();
}

/**
 * Wrap a pi `AgentTool` as a durable tool. Arguments, validation, and details keep pi's shapes:
 *
 * - `onUpdate` partials are published as running details `{ partial }`, normalized to strict JSON.
 * - The result keeps pi's content, details, `isError`, usage, and `terminate`.
 * - A throw becomes pi's error result (the message as text), not durable's `<harness>` diagnostic.
 * - A `tool_call` block recorded by the hook bridge returns pi's block result.
 *
 * Replay: an interrupted call reruns after a crash when the tool declares `replay: "safe"`, or, without a
 * declaration, when it is one of {@link REPLAY_SAFE_TOOL_NAMES}.
 */
export function toDurableTool(tool: AgentTool, pending: PendingResults): ToolRegistration {
	const replay =
		tool.replay === "safe"
			? "safe"
			: tool.replay === "never"
				? "unsafe"
				: REPLAY_SAFE_TOOL_NAMES.has(tool.name)
					? "safe"
					: "unsafe";
	return {
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters,
		...(tool.constrainedSampling === undefined ? {} : { constrainedSampling: tool.constrainedSampling }),
		...(tool.prepareArguments === undefined ? {} : { prepareArguments: tool.prepareArguments }),
		...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
		replay,
		outputLimits: { maxBytes: UNBOUNDED, maxLines: UNBOUNDED, retain: tool.name === "bash" ? "tail" : "head" },
		execute: async (args, api, context) => {
			const blocked = await api.memo<BlockMemo>(BLOCK_MEMO, context);
			if (blocked !== undefined) return blockedResult(blocked);
			const signal = context.abortSignal;
			let result: AgentToolResult<unknown>;
			try {
				result = await tool.execute(api.callId, args, signal, (partial) => publishPartial(api, partial, context));
			} catch (error) {
				if (signal?.aborted) throw error;
				return errorResult(error instanceof Error ? error.message : String(error));
			}
			if (result.structuredContent !== undefined) {
				pending.set(api.taskId, { structuredContent: result.structuredContent });
			}
			return {
				content: result.content ?? [],
				details: toStrictJson(result.details),
				isError: result.isError === true,
				...(result.usage === undefined ? {} : { usage: result.usage }),
				...(result.terminate === true ? { control: { terminate: true } } : {}),
			};
		},
	};
}

/** Publish a pi partial as running details; updates after the call settled are dropped, as in pi. */
function publishPartial(api: ToolExecutionApi, partial: AgentToolResult<unknown>, context: Context): void {
	let committed: Promise<void>;
	try {
		committed = api.details({ partial: toStrictJson(partial) }, context);
	} catch {
		return;
	}
	committed.catch(() => {});
}

/** Pi's result for a thrown tool error (`createErrorToolResult`). */
function errorResult(message: string): ToolExecutionResult {
	return { content: [{ type: "text", text: message }], details: {}, isError: true };
}

/** Pi's result for a call a `tool_call` handler blocked. */
function blockedResult(blocked: BlockMemo): ToolExecutionResult {
	return { ...errorResult(blocked.reason), ...(blocked.terminate ? { control: { terminate: true } } : {}) };
}

/**
 * Extension carrying pi's extension callbacks into durable's hooks: `context` → `beforeRequest`, `tool_call` →
 * `beforeTool`, `tool_result` → `afterTool`, `session_before_compact` → `beforeCompact`.
 *
 * Durable runs hooks before the commit that consumes their result; a crash in between reruns them after reopen.
 * Every pi callback invoked here can therefore run more than once for one request, call, or compaction.
 */
export function createHookExtension(bridge: HookBridge): Extension {
	const convert = bridge.hooks.convertToLlm ?? convertToLlm;
	return defineExtension({
		name: HOOKS_EXTENSION,
		hooks: [
			hook(GenerationTask, {
				// Reruns on every request attempt, including recovery and retries, like pi's `context` per request.
				beforeRequest: async (request, api, context) => {
					const messages = await requestAgentMessages(bridge, request.messages, api, context);
					const transformed =
						bridge.hooks.context === undefined
							? messages
							: await bridge.hooks.context(messages, context.abortSignal);
					if (transformed === messages && bridge.hooks.convertToLlm === undefined) return undefined;
					return { messages: convert(transformed) };
				},
			}),
			hook(ToolTask, {
				// Runs before durable records the call's intent; after a crash before that commit it runs again.
				beforeTool: async (call, api, context) => {
					const toolCall = bridge.hooks.toolCall;
					if (toolCall === undefined) return undefined;
					const input = toStrictJsonObject(call.arguments) as Record<string, unknown>;
					const original = JSON.stringify(input);
					let reason: string | undefined;
					let terminate = false;
					try {
						const decision = await toolCall({ toolName: call.name, toolCallId: call.id, input });
						if (decision?.block === true) {
							reason = decision.reason || "Tool execution was blocked";
							terminate = decision.terminate === true;
						}
					} catch (error) {
						if (context.abortSignal?.aborted) throw error;
						reason =
							error instanceof Error ? error.message : `Extension failed, blocking execution: ${String(error)}`;
					}
					if (reason !== undefined) {
						// Durable's own block result renders a `<harness>` diagnostic; the tool returns pi's text instead.
						await api.memo<BlockMemo>(BLOCK_MEMO, { reason, terminate }, context);
						return undefined;
					}
					const changed = JSON.stringify(input) !== original;
					return changed ? { arguments: toStrictJsonObject(input) } : undefined;
				},
				// Runs after execution and before the result commit; a crash in between reruns the call or interrupts it.
				afterTool: async (call, result, api, context) => {
					const stored = bridge.pending.get(api.taskId);
					bridge.pending.delete(api.taskId);
					if (bridge.hooks.toolResult === undefined) return undefined;
					if ((await api.memo<BlockMemo>(BLOCK_MEMO, context)) !== undefined) return undefined;
					const content = (result.content ?? []) as (TextContent | ImageContent)[];
					const patch = await bridge.hooks.toolResult({
						toolName: call.name,
						toolCallId: call.id,
						input: call.arguments,
						content,
						details: result.details,
						...(stored === undefined ? {} : { structuredContent: stored.structuredContent }),
						isError: result.isError === true,
						...(result.usage === undefined ? {} : { usage: result.usage }),
					});
					if (patch === undefined) return undefined;
					return {
						...result,
						content: patch.content ?? content,
						details: patch.details === undefined ? result.details : toStrictJson(patch.details),
						isError: patch.isError ?? result.isError === true,
						...(patch.usage === undefined ? {} : { usage: patch.usage }),
					};
				},
			}),
			hook(CompactionTask, { beforeCompact: createBeforeCompact(bridge) }),
		],
	});
}

/**
 * The pi messages a request stands for. The generation's `request` checkpoint names the newest entry the request
 * includes; the active context through it, with stored pi messages restored, must reproduce durable's model messages.
 * When it does not (another `beforeRequest` hook already replaced them), the model messages are passed as they are.
 */
async function requestAgentMessages(
	bridge: HookBridge,
	messages: readonly Message[],
	api: HookApi,
	context: Context,
): Promise<AgentMessage[]> {
	const harness = bridge.harness();
	const [task, conversation, details] = await Promise.all([
		harness.getTask(api.taskId, context),
		harness.conversation(api.conversationId, context),
		api.snapshot(CompactionDetailsDoc, api.conversationId, context),
	]);
	const checkpoint = task?.state.checkpoint as GenerationCheckpoint | undefined;
	if (conversation === undefined || checkpoint?.phase !== "request") return [...messages];
	const view = await conversation.context(context);
	const rebuilt = agentContext(view, details?.records ?? [], checkpoint.cutoff);
	if (sameModelContext(messages, rebuilt.llm)) return rebuilt.messages;
	bridge.report(new Error(`Request context of conversation ${api.conversationId} does not match its entries`));
	return [...messages];
}

/** Tools extension; reinstalled whenever the host's tool set changes. */
export function createToolsExtension(tools: readonly AgentTool[], pending: PendingResults): Extension {
	return defineExtension({ name: TOOLS_EXTENSION, tools: tools.map((tool) => toDurableTool(tool, pending)) });
}
