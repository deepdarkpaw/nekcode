import type { AgentMessage, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ImageContent, TextContent, Usage } from "@earendil-works/pi-ai";
import type { CompactionPreparation, CompactionResult } from "../compaction/index.ts";
import type { ConvertToLlm } from "./entries.ts";

/** `tool_call` event input; handlers may mutate `input` in place to change the arguments, as in pi. */
export type HostToolCall = {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly input: Record<string, unknown>;
};

/** `tool_call` decision. */
export type HostToolCallDecision = { readonly block?: boolean; readonly reason?: string; readonly terminate?: boolean };

/** `tool_result` event input. */
export type HostToolResult = {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly input: Record<string, unknown>;
	readonly content: (TextContent | ImageContent)[];
	readonly details: unknown;
	readonly structuredContent?: AgentToolResult["structuredContent"];
	readonly isError: boolean;
	readonly usage?: Usage;
};

/** `tool_result` replacement fields; absent fields keep the tool's values. */
export type HostToolResultPatch = {
	readonly content?: (TextContent | ImageContent)[];
	readonly details?: unknown;
	readonly structuredContent?: AgentToolResult["structuredContent"];
	readonly isError?: boolean;
	readonly usage?: Usage;
};

/** `session_before_compact` input, built from durable's range selection. */
export type HostCompactionRequest = {
	readonly reason: "manual" | "threshold" | "overflow";
	readonly preparation: CompactionPreparation;
	readonly customInstructions?: string;
	readonly signal: AbortSignal;
};

/** `session_before_compact` outcome: cancel, a supplied summary, or `undefined` to run pi's summarizer. */
export type HostCompactionDecision = { readonly cancel: true } | { readonly compaction: CompactionResult } | undefined;

/**
 * Pi extension callbacks the durable engine calls from inside durable hooks and tools.
 *
 * Durable runs hooks off the Session line before the commit that consumes their result. A crash between the two
 * reruns the hook after reopen, so every callback here may be called more than once for the same call, request, or
 * compaction. Handlers must tolerate that.
 */
export interface DurableHostHooks {
	/** `tool_call`; may mutate `event.input`. A throw blocks the call with the error text, as in pi. */
	toolCall?(event: HostToolCall): Promise<HostToolCallDecision | undefined>;
	/** `tool_result` plus pi's result normalization (image resizing). */
	toolResult?(event: HostToolResult): Promise<HostToolResultPatch | undefined>;
	/** `context`: replace the pi messages for one request. */
	context?(messages: AgentMessage[], signal: AbortSignal | undefined): Promise<AgentMessage[]>;
	/** `session_before_compact`. */
	beforeCompact?(request: HostCompactionRequest): Promise<HostCompactionDecision>;
	/** Pi message conversion for requests; default pi `convertToLlm`. Hosts add image blocking here. */
	convertToLlm?: ConvertToLlm;
	/** A compaction ended without a summary because summarization failed; durable keeps the context unchanged. */
	compactionFailed?(reason: HostCompactionRequest["reason"], error: unknown): void;
}
