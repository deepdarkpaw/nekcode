import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as anthropicStream } from "../src/api/anthropic-messages.ts";
import { convertTools } from "../src/api/google-shared.ts";
import { normalizeContext } from "../src/compat.ts";
import { fauxAssistantMessage } from "../src/providers/faux.ts";
import type { Model, Tool } from "../src/types.ts";
import { isRetryableAssistantError } from "../src/utils/retry.ts";
import { trustedHttpUrl } from "../src/utils/trusted-url.ts";

const model: Model<"anthropic-messages"> = {
	id: "test",
	name: "Test",
	provider: "test",
	api: "anthropic-messages",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

describe("upstream protocol regressions", () => {
	it.each(["file:///tmp/script", "javascript:alert(1)", "data:text/plain,hello", "custom:run", "/tmp/file", "bad"])(
		"rejects untrusted login URL %s",
		(url) => {
			expect(trustedHttpUrl(url)).toBeNull();
		},
	);
	it("normalizes HTTP(S) URLs before terminal hyperlink use", () => {
		expect(trustedHttpUrl("https://example.com/\u001b[2J")).toBe("https://example.com/%1B[2J");
		expect(trustedHttpUrl("http://localhost:1234")).toBe("http://localhost:1234/");
	});
	it("matches only standalone retryable status codes", () => {
		for (const message of ["status 429", "HTTP 503", "(502)"])
			expect(
				isRetryableAssistantError({ ...fauxAssistantMessage(""), stopReason: "error", errorMessage: message }),
			).toBe(true);
		for (const message of ["request id abc503def", "Read 150024 bytes", "code 42999"])
			expect(
				isRetryableAssistantError({ ...fauxAssistantMessage(""), stopReason: "error", errorMessage: message }),
			).toBe(false);
	});
	it("rewrites Gemini const nodes without changing literal data or special property names", () => {
		const parameters: Tool["parameters"] = JSON.parse(
			'{"type":"object","properties":{"kind":{"const":"test"},"__proto__":{"const":"safe"},"count":{"const":4}},"default":{"const":"literal"},"examples":[{"const":"literal"}]}',
		);
		const tool = { name: "example", description: "Test", parameters };
		const converted = convertTools([tool])?.[0].functionDeclarations[0].parametersJsonSchema;
		expect(converted).toMatchObject({
			properties: { kind: { enum: ["test"] }, count: { enum: [4] } },
			default: { const: "literal" },
			examples: [{ const: "literal" }],
		});
		expect(Object.hasOwn((converted as { properties: object }).properties, "__proto__")).toBe(true);
		expect(parameters).toMatchObject({ properties: { kind: { const: "test" } } });
	});
	it("preserves non-strict Anthropic root definitions but strips root unions", async () => {
		let payload: unknown;
		const parameters = Type.Unsafe({
			type: "object",
			properties: { item: { $ref: "#/$defs/item" } },
			$defs: { item: { type: "string" } },
			definitions: { legacy: { type: "string" } },
			anyOf: [],
		});
		await anthropicStream(
			model,
			normalizeContext({
				messages: [{ role: "user", content: "hi", timestamp: 0 }],
				tools: [{ name: "lookup", description: "lookup", parameters }],
			}),
			{
				apiKey: "test-key",
				onPayload(value) {
					payload = value;
					throw new Error("captured without network");
				},
			},
		).result();
		expect(payload).toMatchObject({
			tools: [
				{ input_schema: { $defs: { item: { type: "string" } }, definitions: { legacy: { type: "string" } } } },
			],
		});
		expect((payload as { tools: { input_schema: object }[] }).tools[0].input_schema).not.toHaveProperty("anyOf");
	});
});
