import type { ConverseStreamCommandInput } from "@aws-sdk/client-bedrock-runtime";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stream as anthropic } from "../src/api/anthropic-messages.ts";
import { stream as bedrock } from "../src/api/bedrock-converse-stream.ts";
import { cleanupSessionResources } from "../src/session-resources.ts";
import type { Model, Tool } from "../src/types.ts";
import { normalizeContext } from "../src/utils/transcript.ts";

const aws = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@aws-sdk/client-bedrock-runtime", async (original) => ({
	...(await original<typeof import("@aws-sdk/client-bedrock-runtime")>()),
	BedrockRuntimeClient: class {
		send = aws.send;
	},
}));

const model: Model<"anthropic-messages"> = {
	id: "fixture",
	name: "fixture",
	provider: "fixture",
	api: "anthropic-messages",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 100,
	compat: { supportsStrictTools: true },
};
function tool(name: string, strict: "prefer" | "require"): Tool {
	return {
		name,
		description: "fixture",
		parameters: Type.Object({ value: Type.String(), optional: Type.Optional(Type.Number()) }),
		constrainedSampling: { type: "json_schema", strict },
	};
}
const preferred = tool("preferred", "prefer");
const required = tool("required", "require");
const context = normalizeContext({
	tools: [preferred, required],
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
});
const limitMessage = "Too many strict tools (21)";
function success(): Response {
	const events = [
		{
			type: "message_start",
			message: { id: "fixture", model: model.id, usage: { input_tokens: 1, output_tokens: 0 } },
		},
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), {
		headers: { "content-type": "text/event-stream" },
	});
}
afterEach(() => {
	cleanupSessionResources();
	aws.send.mockReset();
});

describe("preferred strict tool negotiation", () => {
	it("negotiates once, preserves require and input context, and remembers until cleanup", async () => {
		const flags: Array<Array<boolean | undefined>> = [];
		const before = JSON.stringify(context);
		const fetch: typeof globalThis.fetch = async (_url, init) => {
			const body = JSON.parse(init!.body as string);
			flags.push(body.tools.map((definition: { strict?: boolean }) => definition.strict));
			return flags.length === 1
				? Response.json(
						{ type: "error", error: { type: "invalid_request_error", message: limitMessage } },
						{ status: 400 },
					)
				: success();
		};
		const options = { apiKey: "fixture", fetch, maxRetries: 0, sessionId: "strict-fixture" };
		const first = await anthropic(model, context, options).result();
		expect(first.stopReason).toBe("stop");
		expect(first.diagnostics?.[0]?.type).toBe("anthropic_strict_tools_fallback");
		await anthropic(model, context, options).result();
		expect(flags).toEqual([
			[true, true],
			[undefined, true],
			[undefined, true],
		]);
		cleanupSessionResources(options.sessionId);
		await anthropic(model, context, options).result();
		expect(flags.at(-1)).toEqual([true, true]);
		expect(JSON.stringify(context)).toBe(before);
	});

	it.each(["invalid schema", limitMessage])("does not retry required-only tools: %s", async (message) => {
		const fetch = vi.fn(async () =>
			Response.json({ type: "error", error: { type: "invalid_request_error", message } }, { status: 400 }),
		);
		const input = normalizeContext({
			tools: [required],
			messages: [{ role: "user", content: "hello", timestamp: 1 }],
		});
		expect((await anthropic(model, input, { apiKey: "fixture", fetch, maxRetries: 0 }).result()).stopReason).toBe(
			"error",
		);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("does not send after the payload hook cancels the request", async () => {
		const controller = new AbortController();
		const fetch = vi.fn(async () => success());
		const result = await anthropic(model, context, {
			apiKey: "fixture",
			fetch,
			signal: controller.signal,
			onPayload: () => {
				controller.abort();
			},
		}).result();
		expect(result.stopReason).toBe("aborted");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does not reinterpret unrelated 400 errors as a strict capacity limit", async () => {
		const fetch = vi.fn(async () =>
			Response.json(
				{ type: "error", error: { type: "invalid_request_error", message: "unknown schema field" } },
				{ status: 400 },
			),
		);
		expect((await anthropic(model, context, { apiKey: "fixture", fetch, maxRetries: 0 }).result()).stopReason).toBe(
			"error",
		);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("attempts at most one renegotiation when the preferred request still fails", async () => {
		const fetch = vi.fn(async () =>
			Response.json(
				{ type: "error", error: { type: "invalid_request_error", message: limitMessage } },
				{ status: 400 },
			),
		);
		expect((await anthropic(model, context, { apiKey: "fixture", fetch, maxRetries: 0 }).result()).stopReason).toBe(
			"error",
		);
		expect(fetch).toHaveBeenCalledTimes(2);
	});

	it("renegotiates Bedrock preferred tools without weakening require", async () => {
		const flags: Array<Array<boolean | undefined>> = [];
		aws.send.mockImplementation(async ({ input }: { input: ConverseStreamCommandInput }) => {
			flags.push(input.toolConfig!.tools!.map((definition) => definition.toolSpec?.strict));
			if (flags.length === 1) throw Object.assign(new Error(limitMessage), { name: "ValidationException" });
			return {
				$metadata: {},
				stream: (async function* () {
					yield { messageStart: { role: "assistant" } };
					yield { messageStop: { stopReason: "end_turn" } };
				})(),
			};
		});
		const target: Model<"bedrock-converse-stream"> = {
			...model,
			api: "bedrock-converse-stream",
			compat: { supportsStrictMode: true },
		};
		const options = { region: "us-east-1", cacheRetention: "none" as const, sessionId: "bedrock-fixture" };
		expect((await bedrock(target, context, options).result()).stopReason).toBe("stop");
		await bedrock(target, context, options).result();
		expect(flags).toEqual([
			[true, true],
			[undefined, true],
			[undefined, true],
		]);
	});
});
