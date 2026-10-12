import { type AssistantMessage, fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import type { ConversationId, EntryId, EntryRecord, SnapshotEvent } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import { DurableEventAdapter, type DurableSessionEvent } from "../../src/core/durable/events.ts";

function entry(id: number, kind: string, message: Message): EntryRecord {
	return { id: id as EntryId, conversationId: 0 as ConversationId, kind, model: [message] };
}

function snapshot(fields: Partial<SnapshotEvent>): SnapshotEvent {
	return {
		type: "snapshot",
		entries: [],
		tools: [],
		compactions: [],
		inbox: [],
		agent: {},
		usage: { models: {}, tools: {} },
		...fields,
	};
}

function adapterWith(missed: EntryRecord[]): { adapter: DurableEventAdapter; events: DurableSessionEvent[] } {
	const events: DurableSessionEvent[] = [];
	const adapter = new DurableEventAdapter({
		emit: async (event) => {
			events.push(event);
		},
		readInbox: async () => ({ items: [] }),
		readCompactionRecords: async () => [],
		readTaskOutcome: async () => undefined,
		entriesAfter: async (id) => missed.filter((each) => each.id > id),
		maxRetries: () => 3,
		retryDelayMs: (attempt) => 2 ** (attempt - 1),
		now: () => 0,
		report: (error) => {
			throw error;
		},
	});
	return { adapter, events };
}

describe("DurableEventAdapter snapshot catch-up", () => {
	it("emits the ends a delivery overflow skipped, then closes the turn and run", async () => {
		const user = entry(1, "pi.user", { role: "user", content: "go", timestamp: 1 });
		const call = fauxAssistantMessage([fauxToolCall("probe", {}, { id: "call-1" })], { stopReason: "toolUse" });
		const assistant = entry(2, "pi.assistant", call);
		const result = entry(3, "pi.tool-result", {
			role: "toolResult",
			toolCallId: "call-1",
			toolName: "probe",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 3,
		});
		const answer = entry(4, "pi.assistant", fauxAssistantMessage("done"));
		const { adapter, events } = adapterWith([user, assistant, result, answer]);
		// Attached mid-run, after the input; the tool was already running.
		adapter.attach(
			snapshot({
				entries: [user],
				run: { inputs: [] },
				tools: [{ callId: "call-1", name: "probe", status: "running" }],
			}),
		);

		await adapter.handle([snapshot({ entries: [user, assistant, result, answer] })]);

		const shape = events.map((event) =>
			event.type === "message_end" || event.type === "message_start"
				? `${event.type}:${event.message.role}`
				: event.type,
		);
		expect(shape).toEqual([
			// toolcall_start and toolcall_end; empty arguments have no delta.
			"message_start:assistant",
			"message_update",
			"message_update",
			"message_end:assistant",
			"tool_execution_end",
			"message_start:toolResult",
			"message_end:toolResult",
			"message_start:assistant",
			"message_update",
			"message_update",
			"message_update",
			"message_end:assistant",
			"turn_end",
			"agent_end",
			"agent_settled",
			"queue_update",
		]);
		const end = events.find((event) => event.type === "agent_end");
		expect(end?.type === "agent_end" ? end.messages.map((message) => message.role) : []).toEqual([
			"assistant",
			"toolResult",
			"assistant",
		]);
		expect(adapter.running).toBe(false);
		expect(adapter.lastEntryId).toBe(4);
	});

	it("starts a run it missed and continues the in-flight partial", async () => {
		const { adapter, events } = adapterWith([entry(1, "pi.user", { role: "user", content: "go", timestamp: 1 })]);
		adapter.attach(snapshot({}));
		const partial: AssistantMessage = fauxAssistantMessage("partial text");

		await adapter.handle([snapshot({ run: { inputs: [] }, generation: { attempt: 1, message: partial } })]);

		expect(events.map((event) => event.type)).toEqual([
			"agent_start",
			"turn_start",
			"message_start",
			"message_end",
			"message_start",
			"message_update",
			"message_update",
			"queue_update",
		]);
		expect(adapter.running).toBe(true);
	});
});
