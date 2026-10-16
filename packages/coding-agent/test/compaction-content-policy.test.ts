import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { prepareCompaction } from "../src/core/compaction/compaction.ts";
import {
	DEFAULT_COMPACTION_CONTENT_SETTINGS,
	resolveCompactionContentSettings,
} from "../src/core/compaction/content-policy.ts";
import { prepareToolResultEdits } from "../src/core/compaction/tool-result-edits.ts";
import {
	buildSessionProjection,
	type CompactionEntry,
	type ProjectedSessionEntry,
} from "../src/core/session-entries.ts";

function assistant(toolName: string, toolCallId: string, path: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: toolCallId, name: toolName, arguments: { path } }],
		api: "anthropic-messages",
		provider: "faux",
		model: "main",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function result(toolName: string, toolCallId: string, text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

function projected(sourceEntry: ProjectedSessionEntry["sourceEntry"], message: AgentMessage): ProjectedSessionEntry {
	return { sourceEntry, messages: [message] };
}

function messageEntry(
	id: string,
	message: AgentMessage,
	parentId: string | null = null,
): ProjectedSessionEntry["sourceEntry"] {
	return { type: "message", id, parentId, timestamp: new Date().toISOString(), message };
}

describe("compaction content policy", () => {
	it("uses bounded defaults and rejects unknown or malformed settings", () => {
		expect(resolveCompactionContentSettings()).toEqual(DEFAULT_COMPACTION_CONTENT_SETTINGS);
		expect(resolveCompactionContentSettings({ thinkingMaxChars: 100 })).toMatchObject({ thinkingMaxChars: 100 });
		expect(() => resolveCompactionContentSettings({ unknown: 1 } as never)).toThrow(
			"Unknown compaction.content setting",
		);
		expect(() => resolveCompactionContentSettings({ toolResultMaxChars: 1 })).toThrow("toolResultMaxChars");
	});

	it("folds old successful observations but protects the recent tool batch and errors", () => {
		const entries: ProjectedSessionEntry[] = [];
		for (let index = 0; index < 3; index++) {
			const callId = `call-${index}`;
			const call = assistant("read", callId, `file-${index}.ts`);
			const callEntry = messageEntry(`call-entry-${index}`, call);
			const output = result("read", callId, `line-${index}\n${"x".repeat(2000)}`);
			const outputEntry = messageEntry(`result-entry-${index}`, output, `call-entry-${index}`);
			entries.push(projected(callEntry, call), projected(outputEntry, output));
		}
		const errorMessage = result("bash", "error-call", "error: failed");
		const error = messageEntry("error", errorMessage);
		(errorMessage as Extract<AgentMessage, { role: "toolResult" }>).isError = true;
		entries.push(projected(error, errorMessage));

		const edits = prepareToolResultEdits(
			entries,
			{
				...DEFAULT_COMPACTION_CONTENT_SETTINGS,
				protectedRecentTokens: 0,
				protectedToolResults: 0,
			},
			() => 1,
		);

		expect(edits.map((edit) => edit.targetId)).toEqual(["result-entry-0", "result-entry-1"]);
		expect(edits.every((edit) => edit.text.includes("original entry"))).toBe(true);
		expect(edits.some((edit) => edit.targetId === "error")).toBe(false);
	});

	it("carries prior cleanup edits into the next compaction boundary", () => {
		const call = assistant("read", "call-1", "file.ts");
		const original = result("read", "call-1", "original output");
		const callEntry = messageEntry("call-entry", call);
		const resultEntry = messageEntry("result-entry", original, "call-entry");
		const firstCompaction: CompactionEntry = {
			type: "compaction",
			id: "compaction-1",
			parentId: "result-entry",
			timestamp: new Date().toISOString(),
			summary: "first checkpoint",
			firstKeptEntryId: "call-entry",
			tokensBefore: 100,
			details: {
				readFiles: [],
				modifiedFiles: [],
				toolResultEdits: [{ targetId: "result-entry", toolCallId: "call-1", text: "folded output" }],
			},
		};
		const userEntry = messageEntry(
			"user-2",
			{ role: "user", content: "continue", timestamp: Date.now() },
			"compaction-1",
		);
		const nextCall = assistant("read", "call-2", "next.ts");
		const nextCallEntry = messageEntry("call-entry-2", nextCall, "user-2");
		const nextResult = result("read", "call-2", "next output");
		const nextResultEntry = messageEntry("result-entry-2", nextResult, "call-entry-2");

		const preparation = prepareCompaction(
			[callEntry, resultEntry, firstCompaction, userEntry, nextCallEntry, nextResultEntry],
			{
				enabled: true,
				reserveTokens: 100,
				keepRecentTokens: 1,
				content: { ...DEFAULT_COMPACTION_CONTENT_SETTINGS, protectedRecentTokens: 0 },
			},
		);

		expect(preparation?.toolResultEdits).toContainEqual({
			targetId: "result-entry",
			toolCallId: "call-1",
			text: "folded output",
		});
	});

	it("replays an append-only compaction fold without changing the raw tool result", () => {
		const call = assistant("read", "call-1", "file.ts");
		const original = result("read", "call-1", "original output that is long");
		const callEntry = messageEntry("call-entry", call);
		const resultEntry = messageEntry("result-entry", original, "call-entry");
		const summary: CompactionEntry = {
			type: "compaction",
			id: "compaction",
			parentId: "result-entry",
			timestamp: new Date().toISOString(),
			summary: "checkpoint",
			firstKeptEntryId: "call-entry",
			tokensBefore: 100,
			details: {
				readFiles: [],
				modifiedFiles: [],
				toolResultEdits: [{ targetId: "result-entry", toolCallId: "call-1", text: "folded output" }],
			},
		};
		const entries = [callEntry, resultEntry, summary];
		const projection = buildSessionProjection(entries, "compaction");

		expect(resultEntry).toMatchObject({ message: original });
		expect(projection.messages.filter((message) => message.role === "toolResult")).toEqual([
			{ ...original, content: [{ type: "text", text: "folded output" }] },
		]);
	});
});
