import type { Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { leadWithSystemBy, orderToolResults, orderToolResultsBy } from "../src/harness/context.ts";
import { assistant, system, toolResult, user } from "./harness-support.ts";

type Item = { source: number; message?: Message };

/** Frozen pre-extraction ordering policy, including provenance of synthesized results. */
function reference(items: Item[]): Item[] {
	const result: Item[] = [];
	for (let index = 0; index < items.length; index++) {
		const item = items[index];
		const message = item.message;
		if (message?.role === "toolResult") continue;
		result.push(item);
		if (message?.role !== "assistant") continue;
		const candidates: Item[] = [];
		for (let next = index + 1; next < items.length && items[next].message?.role !== "assistant"; next++)
			candidates.push(items[next]);
		for (const call of message.content) {
			if (call.type !== "toolCall") continue;
			result.push(
				candidates.find((item) => item.message?.role === "toolResult" && item.message.toolCallId === call.id) ?? {
					source: -1,
					message: {
						role: "toolResult",
						toolCallId: call.id,
						toolName: call.name,
						content: [
							{ type: "text", text: "Tool result unavailable: history ends before this call completed." },
						],
						isError: true,
						details: { reason: "missing_result" },
						timestamp: message.timestamp,
					},
				},
			);
		}
	}
	const first = result.findIndex((item) => item.message !== undefined && item.message.role !== "user");
	if (
		first >= 0 &&
		result[first].message?.role === "system" &&
		result.slice(0, first).some((item) => item.message !== undefined)
	) {
		return [result[first], ...result.slice(0, first), ...result.slice(first + 1)];
	}
	return result;
}

describe("context ordering policy extraction", () => {
	it("matches the previous policy across generated sequences with context-only items", () => {
		const choices = [
			undefined,
			user("one"),
			system({ main: "base" }),
			assistant("empty"),
			assistant("calls", { calls: ["b", "a", "a"] }),
			toolResult("a"),
			toolResult("b"),
			toolResult("stray"),
		];
		let seed = 0x51a7;
		for (let run = 0; run < 500; run++) {
			const items = Array.from({ length: run % 37 }, (_, source) => {
				seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
				return { source, message: choices[(seed >>> 16) % choices.length] };
			});
			const messageOf = (item: Item) => item.message;
			const synthesize = (message: ToolResultMessage): Item => ({ source: -1, message });
			const actual = leadWithSystemBy(orderToolResultsBy(items, messageOf, synthesize), messageOf);
			expect(actual).toEqual(reference(items));
			for (const item of actual) if (item.source !== -1) expect(item).toBe(items[item.source]);
		}
	});
	it("does not add system promotion to the tool-ordering-only entry point", () => {
		const messages = [user("before"), system({ main: "base" })];
		expect(orderToolResults(messages)).toEqual(messages);
	});
});
