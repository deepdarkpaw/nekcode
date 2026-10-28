/**
 * `fetch_provider_models` and `test_provider` against a saved provider with overrides.
 *
 * A local HTTP server asserts what the request carries: the saved base URL, API, headers, and resolved key, with
 * each override replacing only its own field. The saved `{provider}`, `{draft}`, and unknown-provider cases are
 * pinned too, so the added shape changes nothing that existed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createGuiContext, type GuiContext } from "../src/modes/rpc/gui/context.ts";
import { fetchProviderModels, testProvider } from "../src/modes/rpc/gui/models.ts";
import type { RpcFetchModelsResult } from "../src/modes/rpc/gui/protocol.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";

/** Environment variable the saved provider reads its key from, so the test covers the resolution path. */
const SAVED_KEY_ENV = "NEK_TEST_SAVED_KEY";
const SAVED_KEY = "test-api-key";

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
	const handler = (request: IncomingMessage, response: ServerResponse) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		const recorded: RecordedRequest = { path: url.pathname, query: url.searchParams, headers: request.headers };
		requests.push(recorded);
		for (const [prefix, route] of Object.entries(routes)) {
			if (recorded.path.startsWith(prefix)) {
				route(recorded, response);
				return;
			}
		}
		response.writeHead(404, { "content-type": "application/json" });
		response.end(JSON.stringify({ error: "not found" }));
	};
	const server: Server = createServer(handler);
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

/** One SSE chunk of a chat completion stream. */
function chunk(delta: Record<string, unknown>, finishReason: string | null, usage?: Record<string, number>): string {
	return `data: ${JSON.stringify({
		id: "chatcmpl-overrides",
		object: "chat.completion.chunk",
		created: 0,
		model: "saved-model",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
		...(usage === undefined ? {} : { usage }),
	})}\n\n`;
}

describe("provider commands with a saved provider", () => {
	let root: string;
	let agentDir: string;
	let server: Awaited<ReturnType<typeof startServer>>;
	let ctx: GuiContext;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "nek-gui-overrides-"));
		agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
		process.env[SAVED_KEY_ENV] = SAVED_KEY;
		/** One complete chat completion stream, so a test request succeeds. */
		const completion: Route = (_request, response) => {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.write(chunk({ role: "assistant", content: "ok" }, null));
			response.write(chunk({}, "stop", { prompt_tokens: 1, completion_tokens: 1 }));
			response.write("data: [DONE]\n\n");
			response.end();
		};
		server = await startServer({
			"/v1/models": (_request, response) => json(response, 200, { data: [{ id: "saved-model" }] }),
			"/override/v1/models": (_request, response) => json(response, 200, { data: [{ id: "override-model" }] }),
			"/v1/chat/completions": completion,
			"/override/v1/chat/completions": completion,
		});
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"saved-endpoint": {
						name: "Saved endpoint",
						baseUrl: `${server.baseUrl}/v1`,
						api: "openai-completions",
						apiKey: `$${SAVED_KEY_ENV}`,
						headers: { "x-saved": "yes" },
						models: [{ id: "saved-model", contextWindow: 64_000, maxTokens: 1024 }],
					},
				},
			}),
		);
		const registry = await createModelRegistry(AuthStorage.inMemory(), join(agentDir, "models.json"));
		const modelRuntime: ModelRuntime = getModelRuntime(registry);
		ctx = createGuiContext({
			mode: "control",
			cwd: root,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			modelRuntime,
			emit: () => {},
		});
	});

	afterEach(async () => {
		delete process.env[SAVED_KEY_ENV];
		await server.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps listing a saved provider without overrides", async () => {
		const result = (await fetchProviderModels(ctx, { provider: "saved-endpoint" })) as RpcFetchModelsResult;

		expect(result.ok).toBe(true);
		expect(server.requests[0].path).toBe("/v1/models");
		expect(server.requests[0].headers.authorization).toBe(`Bearer ${SAVED_KEY}`);
		expect(server.requests[0].headers["x-saved"]).toBe("yes");
	});

	it("applies a base URL and header override on top of the saved configuration", async () => {
		const result = (await fetchProviderModels(ctx, {
			provider: "saved-endpoint",
			overrides: { baseUrl: `${server.baseUrl}/override/v1`, headers: { "x-override": "1" } },
		})) as RpcFetchModelsResult;

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.endpoint).toBe(`${server.baseUrl}/override/v1/models`);
		expect(result.models.map((model) => model.id)).toEqual(["override-model"]);
		expect(server.requests[0].headers["x-override"]).toBe("1");
		expect(server.requests[0].headers["x-saved"]).toBe("yes");
		expect(server.requests[0].headers.authorization).toBe(`Bearer ${SAVED_KEY}`);
	});

	it("uses an API key override instead of the saved one", async () => {
		const result = (await fetchProviderModels(ctx, {
			provider: "saved-endpoint",
			overrides: { apiKey: "test-override-key" },
		})) as RpcFetchModelsResult;

		expect(result.ok).toBe(true);
		expect(server.requests[0].headers.authorization).toBe("Bearer test-override-key");
	});

	it("honours an API override with the saved key", async () => {
		const result = (await fetchProviderModels(ctx, {
			provider: "saved-endpoint",
			overrides: { api: "anthropic-messages", baseUrl: server.baseUrl, headers: { "x-saved": "yes" } },
		})) as RpcFetchModelsResult;

		expect(result.ok).toBe(true);
		expect(server.requests[0].path).toBe("/v1/models");
		expect(server.requests[0].headers["x-api-key"]).toBe(SAVED_KEY);
		expect(server.requests[0].headers.authorization).toBeUndefined();
	});

	it("tests a saved provider with an edited base URL", async () => {
		const result = await testProvider(ctx, {
			provider: "saved-endpoint",
			modelId: "saved-model",
			overrides: { baseUrl: `${server.baseUrl}/override/v1` },
		});

		expect(result.ok).toBe(true);
		expect(server.requests[0].path).toBe("/override/v1/chat/completions");
		expect(server.requests[0].headers.authorization).toBe(`Bearer ${SAVED_KEY}`);
		expect(server.requests[0].headers["x-saved"]).toBe("yes");
	});

	it("tests a saved provider with an edited key", async () => {
		const result = await testProvider(ctx, {
			provider: "saved-endpoint",
			modelId: "saved-model",
			overrides: { apiKey: "test-override-key" },
		});

		expect(result.ok).toBe(true);
		expect(server.requests[0].headers.authorization).toBe("Bearer test-override-key");
	});

	it("reports an unknown saved provider instead of falling back to a draft", async () => {
		await expect(fetchProviderModels(ctx, { provider: "missing-endpoint" })).rejects.toThrow(
			/Unknown provider: missing-endpoint/u,
		);
		await expect(testProvider(ctx, { provider: "missing-endpoint", modelId: "m", overrides: {} })).rejects.toThrow(
			/Unknown provider: missing-endpoint/u,
		);
	});

	it("refuses overrides together with a draft", async () => {
		const draft = { api: "openai-completions" as const, baseUrl: `${server.baseUrl}/v1` };

		await expect(fetchProviderModels(ctx, { draft, overrides: { apiKey: "test-api-key" } })).rejects.toThrow(
			/not with a draft/u,
		);
		await expect(
			testProvider(ctx, { draft, modelId: "saved-model", overrides: { apiKey: "test-api-key" } }),
		).rejects.toThrow(/not with a draft/u);
	});
});
