import { describe, expect, it } from "vitest";
import { clampMaxTokensToContext } from "../src/api/simple-options.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { Model, TranscriptContext } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const model: Model<"openai-completions"> = {
	id: "fixture",
	name: "fixture",
	provider: "fixture",
	api: "openai-completions",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 160000,
};
function context(input: number): TranscriptContext {
	const message = fauxAssistantMessage("ok");
	message.usage = { ...message.usage, input, output: 0, totalTokens: input };
	return normalizeContext({ messages: [message] });
}

describe("output budget input-count uncertainty", () => {
	it("leaves a proportional input margin without exceeding the caller's cap", () => {
		expect(clampMaxTokensToContext(model, context(40000), 160000)).toBe(154000);
		expect(clampMaxTokensToContext(model, context(40000), 1000)).toBe(1000);
	});
	it("caps near-full output while preserving the fixed safety margin", () => {
		expect(clampMaxTokensToContext(model, context(150000), 160000)).toBe(32768);
		expect(clampMaxTokensToContext(model, context(199000), 160000)).toBe(1);
	});
	it("keeps small windows usable", () => {
		expect(clampMaxTokensToContext({ ...model, contextWindow: 32000 }, context(10000), 32000)).toBe(17904);
	});
});
