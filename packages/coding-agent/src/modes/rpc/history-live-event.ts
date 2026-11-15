import type { AgentSessionEvent } from "../../core/agent-session.ts";
import { toJsonEvent } from "../json-event.ts";
import type { RpcHistoryStreamOmission } from "./gui/history-stream-protocol.ts";

export interface HistoryLiveEvent {
	event: Record<string, unknown>;
	omissions: RpcHistoryStreamOmission[];
}
function messageMetadata(value: unknown): Record<string, unknown> {
	const message: Record<string, unknown> = {};
	for (const key of [
		"role",
		"timestamp",
		"api",
		"provider",
		"model",
		"toolCallId",
		"toolName",
		"stopReason",
		"errorMessage",
		"usage",
		"customType",
		"display",
	]) {
		const field = (value as Record<string, unknown>)[key];
		if (field !== undefined) message[key] = field;
	}
	return message;
}
/** Strip only RPC copies whose authoritative bodies/deltas have another explicit owner. No model/TUI mutation. */
export function historyLiveEvent(source: AgentSessionEvent): HistoryLiveEvent {
	const omissions: RpcHistoryStreamOmission[] = [];
	const omit = (pointer: string, reason: RpcHistoryStreamOmission["reason"] = "persisted_body") =>
		omissions.push({ pointer, resolution: "history", reason });
	if (source.type === "message_start" || source.type === "message_end") {
		omit("/message");
		return { event: { type: source.type, message: messageMetadata(source.message) }, omissions };
	}
	if (source.type === "message_update") {
		const event = toJsonEvent(source);
		const update = event.assistantMessageEvent;
		if (update.type === "text_end" || update.type === "thinking_end") {
			const { content: _content, ...end } = update;
			omit("/assistantMessageEvent/content", "redundant_delta");
			return { event: { ...event, assistantMessageEvent: end }, omissions };
		}
		if (update.type === "toolcall_end") {
			const { toolCall: _toolCall, ...end } = update;
			omit("/assistantMessageEvent/toolCall", "redundant_delta");
			return { event: { ...event, assistantMessageEvent: end }, omissions };
		}
		// In particular, replacement start.message and argumentPath/replace deltas remain exact.
		return { event: event as unknown as Record<string, unknown>, omissions };
	}
	if (source.type === "tool_execution_start" || source.type === "tool_execution_update") {
		const { args: _args, ...event } = source;
		omit("/args");
		return { event, omissions };
	}
	if (source.type === "tool_execution_end") {
		const { content: _content, details: _details, ...extras } = source.result;
		omit("/result/content");
		omit("/result/details");
		return { event: { ...source, result: extras }, omissions };
	}
	if (source.type === "turn_end") {
		const { message: _message, toolResults: _results, ...event } = source;
		omit("/message");
		omit("/toolResults");
		// A synthetic aborted-before-first-token turn may have no persisted answer; keep its failure metadata.
		return { event: { ...event, message: messageMetadata(source.message) }, omissions };
	}
	if (source.type === "agent_end") {
		const { messages: _messages, ...event } = source;
		omit("/messages");
		return { event, omissions };
	}
	if (source.type === "compaction_end" && source.result !== undefined) {
		const { result: _result, ...event } = source;
		omit("/result");
		return { event, omissions };
	}
	return { event: toJsonEvent(source) as unknown as Record<string, unknown>, omissions };
}
