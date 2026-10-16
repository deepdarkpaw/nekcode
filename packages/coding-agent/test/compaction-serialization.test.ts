import type { Message } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { serializeConversation } from "../src/core/compaction/utils.ts";

describe("serializeConversation", () => {
	it("folds long tool results while preserving the tail", () => {
		const longContent = Array.from({ length: 300 }, (_, index) => `line-${index}: ${"x".repeat(20)}`).join("\n");
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: longContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("[Tool result read id=tc1 OK]:");
		expect(result).toContain("line-299");
		expect(result).toContain("characters omitted");
		expect(result).not.toContain("line-100");
	});

	it("keeps short tool results and records their identity", () => {
		const shortContent = "x".repeat(1500);
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tc1",
				toolName: "read",
				content: [{ type: "text", text: shortContent }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toBe(`[Tool result read id=tc1 OK]: ${shortContent}`);
		expect(result).not.toContain("omitted");
	});

	it("keeps the final thinking paragraphs and marks reasoning as unverified", () => {
		const thinking = ["premise".repeat(200), "middle".repeat(200), "final conclusion: keep this"].join("\n\n");
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking },
					{ type: "text", text: "done" },
				],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages, { thinkingMaxChars: 120, thinkingTotalMaxChars: 120 });

		expect(result).toContain("unverified reasoning");
		expect(result).toContain("final conclusion: keep this");
		expect(result).toContain("thinking characters omitted");
	});

	it("folds long tool arguments instead of duplicating their full payload", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: "tc1",
						name: "write",
						arguments: { path: "file.ts", content: "z".repeat(5000) },
					},
				],
				api: "anthropic",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
		];

		const result = serializeConversation(messages);

		expect(result).toContain("write(");
		expect(result).toContain("[... ");
		expect(result).not.toContain("z".repeat(3000));
	});
});
