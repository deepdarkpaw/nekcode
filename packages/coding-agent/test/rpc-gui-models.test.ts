/**
 * `fetch_provider_models` for the three listable API families, against a local HTTP server.
 *
 * The server asserts the request shape nek sends (path, auth headers, pagination) and the test asserts the
 * mapping into `NekRemoteModel`, including the structured failures for 401 and 404.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { GuiContext } from "../src/modes/rpc/gui/context.ts";
import { fetchProviderModels, testProvider } from "../src/modes/rpc/gui/models.ts";
import type { RpcFetchModelsResult } from "../src/modes/rpc/gui/protocol.ts";

interface RecordedRequest {
	path: string;
	query: URLSearchParams;
	headers: IncomingMessage["headers"];
}

type Route = (request: RecordedRequest, response: ServerResponse) => void;

/** A local server whose routes are matched by path prefix; every request is recorded. */
async function startServer(routes: Record<string, Route>): Promise<{
	baseUrl: string;
	requests: RecordedRequest[];
	close: () => Promise<void>;
}> {
	const requests: RecordedRequest[] = [];
	const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", "http://127.0.0.1");
		const recorded: RecordedRequest = { path: url.pathname, query: url.searchParams, headers: request.headers };
		requests.push(recorded);
		const route = Object.entries(routes).find(([prefix]) => url.pathname.startsWith(prefix))?.[1];
		if (!route) {
			response.writeHead(404, { "content-type": "application/json" });
			response.end(JSON.stringify({ error: { message: "not found" } }));
			return;
		}
		route(recorded, response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as AddressInfo).port;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		requests,
		close: () => new Promise<void>((resolve) => server.close(() => resolve())),
	};
}

function json(response: ServerResponse, status: number, body: unknown): void {
	response.writeHead(status, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

/** Context the draft paths never read. */
const unusedContext = {} as GuiContext;

describe("fetch_provider_models", () => {
	const servers: Array<() => Promise<void>> = [];

	afterEach(async () => {
		for (const close of servers.splice(0)) await close();
	});

	async function serve(routes: Record<string, Route>) {
		const server = await startServer(routes);
		servers.push(server.close);
		return server;
	}

	it("lists OpenAI-compatible models with a bearer token and extension limit fields", async () => {
		const server = await serve({
			"/v1/models": (_request, response) =>
				json(response, 200, {
					data: [
						{
							id: "gpt-one",
							context_length: 128000,
							max_completion_tokens: 8192,
							architecture: { input_modalities: ["text", "image"] },
						},
						{ id: "gpt-two", top_provider: { context_length: 65536, max_completion_tokens: 2048 } },
					],
				}),
		});

		const result = (await fetchProviderModels(unusedContext, {
			draft: { api: "openai-completions", baseUrl: `${server.baseUrl}/v1`, apiKey: "sk-test" },
		})) as RpcFetchModelsResult;

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.endpoint).toBe(`${server.baseUrl}/v1/models`);
		expect(result.models).toEqual([
			{ id: "gpt-one", contextWindow: 128000, maxTokens: 8192, input: ["text", "image"] },
			{ id: "gpt-two", contextWindow: 65536, maxTokens: 2048 },
		]);
		expect(server.requests[0].headers.authorization).toBe("Bearer sk-test");
	});

	it("pages through Anthropic models and maps capabilities", async () => {
		const server = await serve({
			"/v1/models": (request, response) => {
				expect(request.headers["x-api-key"]).toBe("anthropic-key");
				expect(request.headers["anthropic-version"]).toBe("2023-06-01");
				expect(request.headers.authorization).toBeUndefined();
				if (request.query.get("after_id") === "claude-one") {
					json(response, 200, {
						data: [
							{
								id: "claude-two",
								display_name: "Claude Two",
								max_input_tokens: 200000,
								max_tokens: 4096,
								capabilities: { thinking: { supported: false } },
							},
						],
						has_more: false,
						last_id: "claude-two",
					});
					return;
				}
				json(response, 200, {
					data: [
						{
							id: "claude-one",
							display_name: "Claude One",
							max_input_tokens: 1000000,
							max_tokens: 64000,
							capabilities: {
								thinking: { supported: true },
								effort: { supported: true, low: { supported: true }, xhigh: { supported: false } },
								image_input: { supported: true },
							},
						},
					],
					has_more: true,
					last_id: "claude-one",
				});
			},
		});

		const result = (await fetchProviderModels(unusedContext, {
			draft: { api: "anthropic-messages", baseUrl: server.baseUrl, apiKey: "anthropic-key" },
		})) as RpcFetchModelsResult;

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.endpoint).toBe(`${server.baseUrl}/v1/models`);
		expect(server.requests).toHaveLength(2);
		expect(result.models).toEqual([
			{
				id: "claude-one",
				name: "Claude One",
				contextWindow: 1000000,
				maxTokens: 64000,
				reasoning: true,
				thinkingLevels: ["off", "low", "medium", "high", "max"],
				input: ["text", "image"],
			},
			{
				id: "claude-two",
				name: "Claude Two",
				contextWindow: 200000,
				maxTokens: 4096,
				reasoning: false,
				thinkingLevels: ["off"],
			},
		]);
	});

	it("pages through Gemini models, strips the prefix, and skips non-chat models", async () => {
		const server = await serve({
			"/v1beta/models": (request, response) => {
				expect(request.headers["x-goog-api-key"]).toBe("gemini-key");
				if (request.query.get("pageToken") === "next") {
					json(response, 200, { models: [{ name: "models/gemini-two", displayName: "Gemini Two" }] });
					return;
				}
				json(response, 200, {
					models: [
						{
							name: "models/gemini-one",
							displayName: "Gemini One",
							inputTokenLimit: 1048576,
							outputTokenLimit: 8192,
							thinking: true,
							supportedGenerationMethods: ["generateContent"],
						},
						{ name: "models/embedding-one", supportedGenerationMethods: ["embedContent"] },
					],
					nextPageToken: "next",
				});
			},
		});

		const result = (await fetchProviderModels(unusedContext, {
			draft: { api: "google-generative-ai", baseUrl: `${server.baseUrl}/v1beta`, apiKey: "gemini-key" },
		})) as RpcFetchModelsResult;

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.endpoint).toBe(`${server.baseUrl}/v1beta/models`);
		expect(server.requests).toHaveLength(2);
		expect(result.models).toEqual([
			{
				id: "gemini-one",
				name: "Gemini One",
				contextWindow: 1048576,
				maxTokens: 8192,
				reasoning: true,
				thinkingLevels: ["off", "low", "medium", "high"],
			},
			{ id: "gemini-two", name: "Gemini Two", reasoning: false, thinkingLevels: ["off"] },
		]);
	});

	it("reports 401 and 404 as data, not RPC errors", async () => {
		const server = await serve({
			"/unauthorized/v1/models": (_request, response) =>
				json(response, 401, { error: { message: "invalid x-api-key" } }),
		});

		const unauthorized = (await fetchProviderModels(unusedContext, {
			draft: { api: "openai-completions", baseUrl: `${server.baseUrl}/unauthorized/v1`, apiKey: "bad" },
		})) as RpcFetchModelsResult;
		const missing = (await fetchProviderModels(unusedContext, {
			draft: { api: "openai-completions", baseUrl: `${server.baseUrl}/missing/v1` },
		})) as RpcFetchModelsResult;

		expect(unauthorized).toMatchObject({ ok: false, status: 401 });
		expect(unauthorized.ok === false && unauthorized.message).toContain("invalid x-api-key");
		expect(missing).toMatchObject({ ok: false, status: 404 });
	});

	it("tests a draft endpoint with one minimal completion", async () => {
		/** One SSE chunk of a chat completion stream. */
		const chunk = (delta: Record<string, unknown>, finishReason: string | null, usage?: Record<string, number>) =>
			`data: ${JSON.stringify({
				id: "chatcmpl-gui",
				object: "chat.completion.chunk",
				created: 0,
				model: "draft-model",
				choices: [{ index: 0, delta, finish_reason: finishReason }],
				...(usage === undefined ? {} : { usage }),
			})}\n\n`;
		const server = await serve({
			"/v1/chat/completions": (request, response) => {
				expect(request.headers.authorization).toBe("Bearer sk-test");
				response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
				response.write(chunk({ role: "assistant", content: "ok" }, null));
				response.write(chunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1 }));
				response.write("data: [DONE]\n\n");
				response.end();
			},
		});

		const result = await testProvider(unusedContext, {
			modelId: "draft-model",
			draft: { api: "openai-completions", baseUrl: `${server.baseUrl}/v1`, apiKey: "sk-test" },
		});

		expect(result.ok).toBe(true);
		expect(server.requests).toHaveLength(1);
	});

	it("reports a rejected test request with its status", async () => {
		const server = await serve({
			"/v1/chat/completions": (_request, response) =>
				json(response, 401, { error: { message: "invalid api key", type: "authentication_error" } }),
		});

		const result = await testProvider(unusedContext, {
			modelId: "draft-model",
			draft: { api: "openai-completions", baseUrl: `${server.baseUrl}/v1`, apiKey: "nope" },
		});

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.status).toBe(401);
		expect(result.message).toContain("invalid api key");
	});

	it("rejects an invalid base URL", async () => {
		await expect(
			fetchProviderModels(unusedContext, {
				draft: { api: "openai-completions", baseUrl: "not-a-url" },
			}),
		).rejects.toThrow(/Invalid base URL/u);
	});
});
