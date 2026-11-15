import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel, normalizeContext } from "../src/compat.ts";

function sseResponse(events: readonly { event: string; data: unknown }[]): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function fakeClient(response: Response): Anthropic {
	return {
		beta: { messages: { create: () => ({ asResponse: async () => response }) } },
	} as unknown as Anthropic;
}

function messageStart(id: string) {
	return {
		event: "message_start",
		data: { type: "message_start", message: { id, usage: { input_tokens: 1, output_tokens: 1 } } },
	};
}

function toolStart(index: number, id: string) {
	return {
		event: "content_block_start",
		data: {
			type: "content_block_start",
			index,
			content_block: { type: "tool_use", id, name: "read", input: {} },
		},
	};
}

function toolStop(index: number) {
	return { event: "content_block_stop", data: { type: "content_block_stop", index } };
}

function messageStop(stopReason = "tool_use") {
	return [
		{
			event: "message_delta",
			data: { type: "message_delta", delta: { stop_reason: stopReason }, usage: { output_tokens: 2 } },
		},
		{ event: "message_stop", data: { type: "message_stop" } },
	];
}

async function run(events: readonly { event: string; data: unknown }[]) {
	const model = getModel("anthropic", "claude-haiku-4-5");
	const stream = streamAnthropic(
		model,
		normalizeContext({ messages: [{ role: "user", content: "Read a file.", timestamp: 0 }] }),
		{ client: fakeClient(sseResponse(events)) },
	);
	return stream.result();
}

describe("Anthropic tool stream guards", () => {
	it("rejects a repeated content block index instead of leaving an empty orphan call", async () => {
		const result = await run([messageStart("msg_duplicate"), toolStart(0, "toolu_a"), toolStart(0, "toolu_b")]);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Anthropic stream reused content block index 0");
	});

	it("rejects a tool block that reaches message_stop without content_block_stop", async () => {
		const result = await run([messageStart("msg_unfinished"), toolStart(0, "toolu_unfinished"), ...messageStop()]);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Anthropic stream ended before content_block_stop");
	});

	it("accepts a normally completed empty-argument tool call", async () => {
		const result = await run([messageStart("msg_empty"), toolStart(0, "toolu_empty"), toolStop(0), ...messageStop()]);

		expect(result.stopReason).toBe("toolUse");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "toolCall", id: "toolu_empty", name: "read", arguments: {} }]);
	});
});
