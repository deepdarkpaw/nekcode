import {
	type CallToolResult,
	type JsonRpcMessage,
	type JsonRpcRequest,
	McpHttpError,
	McpSessionExpiredError,
} from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
	createWebSearchToolDefinition,
	parseWebSearchResults,
	type WebSearchToolInput,
	type WebSearchToolOptions,
} from "../src/core/tools/web-search.ts";

const text =
	"Title: Allowed\nURL: https://docs.example.com/a\nPublished: 2026-10-02\nAuthor: Docs\nHighlights:\nA\n---\nTitle: Blocked\nURL: https://blocked.test/b\nHighlights:\nB";
const peers: InMemoryTransport[] = [];
afterEach(async () => {
	await Promise.all(peers.splice(0).map((peer) => peer.close()));
});

function server(
	options: {
		fail?: () => Error;
		hang?: "initialize" | "tools/call";
		hangFirst?: boolean;
		result?: CallToolResult;
	} = {},
) {
	const pair = createInMemoryTransportPair();
	peers.push(pair.server);
	const requests: JsonRpcRequest[] = [];
	pair.server.onMessage((message) => {
		if (!("id" in message) || !("method" in message)) return;
		requests.push(message);
		if (
			message.method === options.hang &&
			(!options.hangFirst || requests.filter((request) => request.method === options.hang).length === 1)
		)
			return;
		const result =
			message.method === "initialize"
				? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "exa", version: "1" } }
				: (options.result ?? { content: [{ type: "text", text }] });
		void pair.server.send({ jsonrpc: "2.0", id: message.id, result });
	});
	void pair.server.start();
	if (options.fail) {
		const send = pair.client.send.bind(pair.client);
		pair.client.send = async (message: JsonRpcMessage) => {
			if ("method" in message && message.method === "tools/call") throw options.fail?.();
			return send(message);
		};
	}
	return { transport: pair.client, requests };
}

function execute(
	tool: ReturnType<typeof createWebSearchToolDefinition>,
	input: WebSearchToolInput = { query: "docs" },
	signal?: AbortSignal,
) {
	return tool.execute("call", input, signal, undefined, { cwd: "." } as never);
}

describe("web_search", () => {
	it("parses Exa result blocks", () => {
		expect(parseWebSearchResults(text)).toEqual([
			{
				title: "Allowed",
				url: "https://docs.example.com/a",
				published: "2026-10-02",
				author: "Docs",
				highlights: "A",
			},
			{ title: "Blocked", url: "https://blocked.test/b", highlights: "B" },
		]);
	});

	it("connects lazily once and reuses the client across concurrent and sequential searches", async () => {
		let connects = 0;
		const fixture = server();
		const tool = createWebSearchToolDefinition({
			createTransport: (endpoint) => {
				expect(endpoint).toBe("https://mcp.exa.ai/mcp");
				connects++;
				return fixture.transport;
			},
		});
		expect(tool.exposure).toBe("direct");
		expect(connects).toBe(0);
		await Promise.all([execute(tool), execute(tool)]);
		const result = await execute(tool, {
			query: "current docs",
			objective: "official docs",
			num_results: 3,
			allowed_domains: ["example.com"],
			blocked_domains: ["blocked.test"],
		});
		expect(connects).toBe(1);
		expect(fixture.requests.filter((request) => request.method === "initialize")).toHaveLength(1);
		expect(fixture.requests.at(-1)?.params).toEqual({
			name: "web_search_exa",
			arguments: { query: "current docs", objective: "official docs", numResults: 3 },
		});
		expect(result.details?.results).toHaveLength(1);
		expect(result.content).toEqual([
			{ type: "text", text: "1. [Allowed](https://docs.example.com/a)\n2026-10-02 · Docs\nA" },
		]);
	});

	it.each(["json", "sse"] as const)(
		"uses the Streamable HTTP transport for %s responses without network access",
		async (format) => {
			const methods: string[] = [];
			const tool = createWebSearchToolDefinition({
				fetch: async (_url, init) => {
					const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
					methods.push(request.method);
					if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
					const result =
						request.method === "initialize"
							? {
									protocolVersion: "2025-06-18",
									capabilities: { tools: {} },
									serverInfo: { name: "exa", version: "1" },
								}
							: { content: [{ type: "text", text }] };
					const payload = JSON.stringify({ jsonrpc: "2.0", id: request.id, result });
					return new Response(format === "sse" ? `event: message\ndata: ${payload}\n\n` : payload, {
						headers: { "Content-Type": format === "sse" ? "text/event-stream" : "application/json" },
					});
				},
			});
			expect((await execute(tool)).details?.results).toHaveLength(2);
			await execute(tool);
			expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/call"]);
		},
	);

	it.each(["session", "transport"] as const)("reconnects and retries once after a %s failure", async (kind) => {
		let connects = 0;
		const tool = createWebSearchToolDefinition({
			createTransport: () => {
				connects++;
				return server(
					connects === 1
						? { fail: () => (kind === "session" ? new McpSessionExpiredError() : new TypeError("fetch failed")) }
						: {},
				).transport;
			},
		});
		expect((await execute(tool)).details?.results).toHaveLength(2);
		await execute(tool);
		expect(connects).toBe(2);
	});

	it("does not retry more than once", async () => {
		let connects = 0;
		const tool = createWebSearchToolDefinition({
			createTransport: () => {
				connects++;
				return server({ fail: () => new McpSessionExpiredError() }).transport;
			},
		});
		await expect(execute(tool)).rejects.toThrow("MCP session expired");
		expect(connects).toBe(2);
	});

	it("does not retry ordinary HTTP or tool errors", async () => {
		for (const fixture of [
			{ fail: () => new McpHttpError(400, "bad request") },
			{ result: { content: [{ type: "text" as const, text: "bad query" }], isError: true } },
		]) {
			let connects = 0;
			const tool = createWebSearchToolDefinition({
				createTransport: () => {
					connects++;
					return server(fixture).transport;
				},
			});
			await expect(execute(tool)).rejects.toThrow(/bad request|bad query/);
			expect(connects).toBe(1);
		}
	});

	it.each(["initialize", "tools/call"] as const)("honors timeout while waiting for %s", async (hang) => {
		let connects = 0;
		const tool = createWebSearchToolDefinition({
			timeoutMs: 20,
			createTransport: () => {
				connects++;
				return server({ hang }).transport;
			},
		});
		await expect(execute(tool)).rejects.toThrow(/timed out|timeout|aborted/i);
		expect(connects).toBe(1);
	});

	it("does not connect for an already-aborted call", async () => {
		let connects = 0;
		const tool = createWebSearchToolDefinition({
			createTransport: () => {
				connects++;
				return server().transport;
			},
		});
		await expect(execute(tool, undefined, AbortSignal.abort(new Error("cancelled")))).rejects.toThrow("cancelled");
		expect(connects).toBe(0);
	});

	it("cancels a running call and keeps the healthy client reusable", async () => {
		const fixture = server({ hang: "tools/call", hangFirst: true });
		let connects = 0;
		const tool = createWebSearchToolDefinition({
			createTransport: () => {
				connects++;
				return fixture.transport;
			},
		});
		const controller = new AbortController();
		const call = execute(tool, undefined, controller.signal);
		await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort(new Error("cancelled"));
		await expect(call).rejects.toThrow(/cancelled|aborted/i);
		expect((await execute(tool)).details?.results).toHaveLength(2);
		expect(connects).toBe(1);
	});

	it("keeps domain exclusion and result truncation", async () => {
		const fixture = server();
		const options: WebSearchToolOptions = { createTransport: () => fixture.transport, maxBytes: 70 };
		const result = await execute(createWebSearchToolDefinition(options), {
			query: "docs",
			blocked_domains: ["example.com"],
		});
		expect(result.details?.results).toEqual([{ title: "Blocked", url: "https://blocked.test/b", highlights: "B" }]);
		const truncated = await execute(
			createWebSearchToolDefinition({ createTransport: () => server().transport, maxBytes: 70 }),
		);
		expect(truncated.details?.truncation?.truncated).toBe(true);
	});
});
