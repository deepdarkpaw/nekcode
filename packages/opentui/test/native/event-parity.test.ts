import { describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent/core/agent-session";
import type { SessionEntry } from "@earendil-works/pi-coding-agent/core/session-manager";
import { InteractiveMode } from "@earendil-works/pi-coding-agent/modes/interactive/interactive-mode";
import { OpenTuiMode } from "../../src/mode/opentui-mode.ts";

const timestamp = "2026-11-03T00:00:00.000Z";
const retained: SessionEntry = {
	type: "message",
	id: "user",
	parentId: null,
	timestamp,
	message: { role: "user", content: "retained", timestamp: 1 },
};
const compacted: SessionEntry = {
	type: "compaction",
	id: "compact",
	parentId: "user",
	timestamp,
	summary: "summary",
	firstKeptEntryId: "user",
	tokensBefore: 100,
};
const after: SessionEntry = {
	type: "custom",
	id: "after",
	parentId: "compact",
	timestamp,
	customType: "state",
	data: {},
};

function adapter(prototype: object) {
	const trace: unknown[] = [];
	const tool = {
		updateArgs: (args: unknown) => trace.push(["args", args]),
		updateResult: (result: unknown, partial?: boolean) => trace.push(["result", result, partial]),
		setArgsComplete: () => trace.push(["complete"]),
		markExecutionStarted: () => trace.push(["started"]),
	};
	const chat = { clear: () => trace.push(["clear"]), addChild: () => {} };
	const mode = Object.setPrototypeOf(
		{
			isInitialized: true,
			stopped: false,
			ui: { requestRender: () => {} },
			requestRender: () => {},
			footer: { invalidate: () => {} },
			settingsManager: { getShowTerminalProgress: () => false },
			chatContainer: chat,
			transcript: { chat, clear: chat.clear },
			defaultEditor: {},
			pendingTools: new Map([["call", tool]]),
			entriesRenderedByBoundaryCompaction: new Set<string>(),
			streamingComponent: {
				updateContent: (message: { stopReason: string; errorMessage?: string }, streaming: boolean) =>
					trace.push(["content", message.stopReason, message.errorMessage, streaming]),
			},
			session: { retryAttempt: 2 },
			sessionManager: {
				buildContextEntries: () => [compacted, retained, after],
				getBranch: () => [retained, compacted, after],
			},
			clearStatusIndicator: (kind: string) => trace.push(["status-clear", kind]),
			renderSessionEntries: (entries: SessionEntry[]) => trace.push(["entries", entries.map((entry) => entry.id)]),
			addMessageToChat: (message: unknown) => trace.push(["message", message]),
			addCustomEntryToChat: (entry: SessionEntry) => trace.push(["custom", entry.id]),
			addCompactionCostNotice: (notice: unknown) => trace.push(["cost", notice]),
			maybeShowThinkingDropNotice: () => trace.push(["thinking-notice"]),
			maybeShowCacheMissNotice: () => trace.push(["cache-notice"]),
			showError: (text: string) => trace.push(["error", text]),
			showStatus: (text: string) => trace.push(["status", text]),
			flushCompactionQueue: async (options: unknown) => {
				trace.push(["flush", options]);
			},
		},
		prototype,
	);
	return { mode, trace };
}

async function drive(events: AgentSessionEvent[]) {
	const results = [];
	for (const prototype of [InteractiveMode.prototype, OpenTuiMode.prototype]) {
		const state = adapter(prototype);
		for (const event of events) await Reflect.get(prototype, "handleEvent").call(state.mode, structuredClone(event));
		results.push(state);
	}
	expect(results[1].trace).toEqual(results[0].trace);
	return results[0];
}

describe("native business-event adapter parity", () => {
	for (const stopReason of ["stop", "error", "aborted"] as const)
		test(`assistant completion: ${stopReason}`, async () => {
			const result = await drive([
				{
					type: "message_end",
					message: fauxAssistantMessage("reply", {
						stopReason,
						errorMessage: stopReason === "error" ? "failed" : undefined,
					}),
				},
			]);
			if (stopReason === "stop") expect(result.trace).toContainEqual(["complete"]);
			else expect(result.mode.pendingTools.size).toBe(0);
		});
	test("streams arguments, starts execution, updates output and removes a finished tool", async () => {
		const message = fauxAssistantMessage(fauxToolCall("read", { path: "file.ts" }, { id: "call" }));
		const result = await drive([
			{
				type: "message_update",
				message,
				assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: message },
			},
			{ type: "tool_execution_start", toolCallId: "call", toolName: "read", args: { path: "file.ts" } },
			{
				type: "tool_execution_update",
				toolCallId: "call",
				toolName: "read",
				args: { path: "file.ts" },
				partialResult: { content: [], details: {} },
			},
			{
				type: "tool_execution_end",
				toolCallId: "call",
				toolName: "read",
				result: { content: [], details: {} },
				isError: false,
			},
		]);
		expect(result.mode.pendingTools.size).toBe(0);
		expect(result.trace.filter((item) => Array.isArray(item) && item[0] === "started")).toHaveLength(1);
	});
	test("rebuilds around a compaction boundary and suppresses already rendered appended entries", async () => {
		const result = await drive([
			{ type: "entry_appended", entry: compacted },
			{ type: "entry_appended", entry: after },
		]);
		expect(result.trace[0]).toEqual(["clear"]);
		expect(result.trace).toContainEqual(["entries", ["user"]]);
		expect(result.trace).toContainEqual(["entries", ["after"]]);
		expect(result.trace).not.toContainEqual(["custom", "after"]);
	});
	for (const reason of ["manual", "threshold", "overflow"] as const)
		test(`cancels and flushes once: ${reason}`, async () => {
			const result = await drive([
				{ type: "compaction_end", reason, aborted: true, willRetry: reason === "overflow", result: undefined },
			]);
			expect(result.trace).toContainEqual([
				reason === "manual" ? "error" : "status",
				reason === "manual" ? "Compaction cancelled" : "Auto-compaction cancelled",
			]);
			expect(result.trace.filter((item) => Array.isArray(item) && item[0] === "flush")).toHaveLength(1);
		});
	test("keeps retry failure wording and cleanup order", async () => {
		const result = await drive([{ type: "auto_retry_end", success: false, attempt: 2, finalError: "failed" }]);
		expect(result.trace).toContainEqual(["error", "Retry failed after 2 attempts: failed"]);
	});
});
