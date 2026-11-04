import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import {
	type ContextView,
	type EntryDraft,
	type EntryId,
	type EntryRecord,
	ROOT_CONVERSATION_ID,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { agentContext } from "../../src/core/durable/context.ts";
import { agentMessageEntry } from "../../src/core/durable/entries.ts";
import { convertToLlm } from "../../src/core/messages.ts";

function entry(id: number, draft: EntryDraft): EntryRecord {
	return {
		...draft,
		id: id as EntryId,
		conversationId: ROOT_CONVERSATION_ID,
		head: draft.head === "self" ? (id as EntryId) : draft.head,
	};
}
function view(entries: EntryRecord[]): ContextView {
	return { head: undefined, entries, contributions: entries.map((e) => e.model ?? []), messages: [] };
}

describe("agent context source mapping", () => {
	it("keeps context-only messages and custom replacements aligned with ordered model messages", () => {
		const hidden: AgentMessage = {
			role: "bashExecution",
			command: "echo hidden",
			output: "hidden",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			excludeFromContext: true,
			timestamp: 2,
		};
		const custom: AgentMessage = {
			role: "custom",
			customType: "example",
			content: "original",
			display: true,
			timestamp: 5,
		};
		const entries = [
			entry(1, { kind: "message", model: [{ role: "user", content: "before", timestamp: 1 }] }),
			entry(2, agentMessageEntry(hidden, convertToLlm)),
			entry(3, { kind: "pi.system", model: [{ role: "system", content: "base", sections: {}, timestamp: 3 }] }),
			entry(4, { kind: "message", model: [fauxAssistantMessage(fauxToolCall("read", {}, { id: "call" }))] }),
			entry(5, agentMessageEntry(custom, convertToLlm)),
			entry(6, {
				kind: "message",
				model: [
					{ role: "toolResult", toolCallId: "call", toolName: "read", content: [], isError: false, timestamp: 6 },
				],
			}),
		];
		const replacement: Message = { role: "user", content: "replacement", timestamp: 5 };
		const input = {
			...view(entries),
			contributions: entries.map((entry, index) => (index === 4 ? [replacement] : (entry.model ?? []))),
		};
		const context = agentContext(input, []);
		expect(context.messages.map((message) => message.role)).toEqual([
			"system",
			"user",
			"bashExecution",
			"assistant",
			"toolResult",
			"custom",
		]);
		expect(context.messages.at(-1)).toMatchObject({ ...custom, content: "replacement" });
		expect(context.llm).toEqual([
			entries[2].model![0],
			entries[0].model![0],
			entries[3].model![0],
			entries[5].model![0],
			replacement,
		]);
		const cut = agentContext(input, [], 4 as EntryId);
		expect(cut.messages.at(-1)).toMatchObject({ role: "toolResult", toolCallId: "call", isError: true });
	});
	it("preserves the agent summary role while promoting the imported system message", () => {
		const input = view([
			entry(1, {
				kind: "pi.compaction",
				head: 1 as EntryId,
				model: [
					{ role: "user", content: "summary", timestamp: 1 },
					{ role: "system", content: "base", sections: {}, timestamp: 1 },
				],
			}),
		]);
		const context = agentContext(input, []);
		expect(context.messages).toEqual([
			input.contributions[0][1],
			{ role: "compactionSummary", summary: "summary", tokensBefore: 0, timestamp: 1 },
		]);
	});
});
