import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple as google } from "../src/api/google-generative-ai.ts";
import { streamSimple as vertex } from "../src/api/google-vertex.ts";
import type { Api, FetchFunction, Model } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const context = normalizeContext({ messages: [{ role: "user", content: "hello", timestamp: 1 }] });
function model<T extends Api>(api: T): Model<T> {
	return {
		id: "fixture",
		name: "fixture",
		provider: "fixture",
		api,
		baseUrl: "https://example.invalid/v1beta",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 10000,
		maxTokens: 1000,
	};
}
afterEach(() => vi.unstubAllGlobals());

describe("Google continuation ownership", () => {
	it("ends as length without issuing SDK continuation requests", async () => {
		vi.stubGlobal("fetch", () => {
			throw new Error("ambient network forbidden");
		});
		const chunk = {
			candidates: [
				{
					content: { role: "model", parts: [{ text: "partial" }] },
					finishReason: "CONTINUATION",
					continuationToken: "token-1",
				},
			],
		};
		const fetch = vi.fn<FetchFunction>(
			async () =>
				new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { "content-type": "text/event-stream" } }),
		);
		const options = { apiKey: "fixture", fetch, maxRetries: 0 };
		const first = await google(model("google-generative-ai"), context, options).result();
		const second = await vertex(model("google-vertex"), context, options).result();
		expect(first.stopReason).toBe("length");
		expect(second.stopReason).toBe("length");
		expect(fetch).toHaveBeenCalledTimes(2);
		expect(String(fetch.mock.calls[0]?.[0])).toContain("/v1beta/models/fixture:streamGenerateContent?alt=sse");
	});
});
