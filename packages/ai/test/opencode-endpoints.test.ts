import { describe, expect, it } from "vitest";
import { getOpenCodeBaseUrl, OPENCODE_BASE_PATHS, updateOpenCodeEndpoints } from "../scripts/opencode-endpoints.ts";

describe("OpenCode protocol endpoint generation", () => {
	it.each([
		["openai-responses", "/openai/v1"],
		["openai-completions", "/openai/v1"],
		["anthropic-messages", "/anthropic"],
		["google-generative-ai", "/google/v1beta"],
		["typesafe-system-one", "/systemone/v1"],
	])("routes %s to its own protocol path", (api, suffix) => {
		expect(getOpenCodeBaseUrl(OPENCODE_BASE_PATHS.opencode, api)).toBe(`https://opencode.ai/inference${suffix}`);
		expect(getOpenCodeBaseUrl(OPENCODE_BASE_PATHS["opencode-go"], api)).toBe(
			`https://opencode.ai/inference/go${suffix}`,
		);
	});
	it("keeps metadata and IDs while removing the obsolete Go MiniMax auth workaround", () => {
		const model = {
			id: "minimax-m2.7",
			api: "openai-completions",
			baseUrl: "https://opencode.ai/zen/go/v1",
			cost: { input: 1 },
			contextWindow: 1000,
		};
		const input = { "openai-completions": { "chat:minimax-m2.7": model } };
		const output = updateOpenCodeEndpoints("opencode-go", input);
		expect(output["anthropic-messages"]["chat:minimax-m2.7"]).toEqual({
			...model,
			api: "anthropic-messages",
			baseUrl: "https://opencode.ai/inference/go/anthropic",
		});
		expect(model.api).toBe("openai-completions");
		expect(updateOpenCodeEndpoints("opencode-go", output)).toEqual(output);
	});
	it("does not send long cache retention for renamed OpenCode DeepSeek", () => {
		const output = updateOpenCodeEndpoints("opencode", {
			"openai-completions": {
				"chat:deepseek-v4.1-flash": {
					id: "deepseek-v4.1-flash",
					api: "openai-completions",
					baseUrl: "old",
					compat: { supportsStore: false },
				},
			},
		});
		expect(output["openai-completions"]["chat:deepseek-v4.1-flash"].compat).toEqual({
			supportsStore: false,
			supportsLongCacheRetention: false,
		});
	});
});
