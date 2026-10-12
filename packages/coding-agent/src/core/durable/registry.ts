import type { Context } from "@earendil-works/chord";
import type { AgentMessage, AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, Message, TextContent, ToolResultMessage } from "@earendil-works/pi-ai";
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

/** Section key of a prompt stored as one text (sessions written before keyed sections). */
export const PROMPT_SECTION_KEY = "nek";

/** One named part of the system prompt, rendered verbatim (pi's sections carry their own tags). */
export type PromptSection = { key: string; value: string };

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
 * The effective system prompt of a conversation for its current run, after `before_agent_start`, as pi's ordered
 * sections. It lives in a document so a request prepared after a crash renders exactly the prompt the run started
 * with. `text` holds a prompt stored as one text, rendered under {@link PROMPT_SECTION_KEY} when `sections` is absent.
 */
export const PromptDoc = defineDoc<{ text: string; sections?: PromptSection[] }>({
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

/** The stored prompt's sections in order; a prompt stored as one text is one section. */
export function storedPromptSections(doc: { text: string; sections?: PromptSection[] } | undefined): PromptSection[] {
	if (doc === undefined) return [];
	if (doc.sections !== undefined) return doc.sections;
	return doc.text === "" ? [] : [{ key: PROMPT_SECTION_KEY, value: doc.text }];
}

/**
 * Prompt extension: one untagged section per key, in order, each rendering the conversation's stored value. The host
 * reinstalls it when the keys change; durable renders sections in extension order.
 */
export function createPromptExtension(keys: readonly string[] = [PROMPT_SECTION_KEY]): Extension {
	return defineExtension({
		name: PROMPT_EXTENSION,
		sections: keys.map((key) =>
			section(
				key,
				async (input, context) => {
					const doc = await input.read.snapshot(PromptDoc, input.conversationId, context);
					return storedPromptSections(doc).find((part) => part.key === key)?.value;
				},
				{ tag: false },
			),
		),
	});
}

/**
 * Values a wrapped tool reports that the result entry cannot carry, kept until `afterTool` of the same task reads
 * them. In memory only: a crash loses them, like the rest of an unfinished execution.
 */
export type PendingResults = {
	/** `structuredContent` a tool returned, by tool task, for `afterTool`. */
	readonly byTask: Map<number, { readonly structuredContent: AgentToolResult["structuredContent"] }>;
	/**
	 * The final result's `structuredContent` and `terminate`, by tool call ID, until the call's `tool_execution_end`
	 * event takes them; durable's result entry has no place for them.
	 */
	readonly extras: Map<string, ResultExtras>;
	/** Calls whose final result asked to end the run, until the round's `afterTools` takes them. */
	readonly terminated: Set<string>;
};

/** The parts of a pi tool result that only events carry. */
export type ResultExtras = {
	readonly structuredContent?: AgentToolResult["structuredContent"];
	readonly terminate?: boolean;
};

/** What the hook extension needs from the engine. */
export type HookBridge = CompactionBridge & {
	/** Shared with the wrapped tools. */
	readonly pending: PendingResults;
};

export function createPendingResults(): PendingResults {
	return { byTask: new Map(), extras: new Map(), terminated: new Set() };
}

function setExtras(pending: PendingResults, callId: string, extras: ResultExtras): void {
	if (extras.terminate === true) pending.terminated.add(callId);
	else pending.terminated.delete(callId);
	if (extras.structuredContent === undefined && extras.terminate !== true) pending.extras.delete(callId);
	else pending.extras.set(callId, extras);
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
			if (blocked !== undefined) {
				setExtras(pending, api.callId, { terminate: blocked.terminate });
				return blockedResult(blocked);
			}
			const signal = context.abortSignal;
			let result: AgentToolResult<unknown>;
			try {
				result = await tool.execute(api.callId, args, signal, (partial) => publishPartial(api, partial, context));
			} catch (error) {
				return errorResult(error instanceof Error ? error.message : String(error));
			}
			if (result.structuredContent !== undefined) {
				pending.byTask.set(api.taskId, { structuredContent: result.structuredContent });
			}
			setExtras(pending, api.callId, {
				...(result.structuredContent === undefined ? {} : { structuredContent: result.structuredContent }),
				...(result.terminate === true ? { terminate: true } : {}),
			});
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
				// These pi extension handlers run from durable hooks and may rerun after a crash before their consuming commit.
				afterResponse: async (message) => {
					const result = await bridge.hooks.afterResponse?.({ message });
					return result?.message === undefined ? undefined : { message: result.message };
				},
				onYield: async (message) => await bridge.hooks.onYield?.({ message }),
				afterTools: async (assistant, results, api, context) => {
					const conversation = await bridge.harness().conversation(api.conversationId, context);
					if (conversation === undefined) return undefined;
					const readEntry = async (id: typeof assistant) =>
						(await conversation.entries({ minEntryId: id, maxEntryId: id }, 1, undefined, context)).items[0];
					const [assistantEntry, resultEntries] = await Promise.all([
						readEntry(assistant),
						Promise.all(results.map((id) => readEntry(id))),
					]);
					const message = assistantEntry?.model?.[0];
					if (message?.role !== "assistant") return undefined;
					const toolResults = resultEntries.flatMap((entry): ToolResultMessage[] => {
						const candidate = entry?.model?.[0];
						return candidate?.role === "toolResult" ? [candidate] : [];
					});
					const result = await bridge.hooks.afterTools?.({ assistant, results, message, toolResults });
					return result?.entries === undefined ? undefined : { entries: result.entries };
				},
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
					const stored = bridge.pending.byTask.get(api.taskId);
					bridge.pending.byTask.delete(api.taskId);
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
					// A new structured result replaces the tool's; new content without one drops it, as in pi.
					const structuredContent =
						patch.structuredContent !== undefined
							? patch.structuredContent
							: patch.content !== undefined
								? undefined
								: stored?.structuredContent;
					const previous = bridge.pending.extras.get(call.id);
					setExtras(bridge.pending, call.id, {
						...(structuredContent === undefined ? {} : { structuredContent }),
						...(previous?.terminate === true ? { terminate: true } : {}),
					});
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
