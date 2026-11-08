import {
	type CallToolResult,
	type JsonRpcMessage,
	type JsonRpcRequest,
	McpHttpError,
	McpSessionExpiredError,
} from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair, type InMemoryTransport } from "@earendil-works/pi-mcp/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as configValues from "../src/core/resolve-config-value.ts";
import {
	createWebSearchToolDefinition,
	parseWebSearchResults,
	type WebSearchToolInput,
	type WebSearchToolOptions,
} from "../src/core/tools/web-search.ts";
import { parseSearchRetryAfter, WEB_SEARCH_MAX_RESPONSE_BYTES } from "../src/core/tools/web-search-http.ts";

const text =
	"Title: Allowed\nURL: https://docs.example.com/a\nPublished: 2026-10-02\nAuthor: Docs\nHighlights:\nA\n---\nTitle: Blocked\nURL: https://blocked.test/b\nHighlights:\nB";
const tavilyResult = { title: "Docs", url: "https://docs.example.com/a", content: "Current official docs" };
const peers: InMemoryTransport[] = [];
beforeEach(() => vi.stubEnv("TAVILY_API_KEY", ""));
afterEach(async () => {
	await Promise.all(peers.splice(0).map((peer) => peer.close()));
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
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

function exaTool(options: WebSearchToolOptions = {}) {
	return createWebSearchToolDefinition({ ...options, provider: "exa" });
}

function tavilyTool(options: WebSearchToolOptions = {}) {
	return createWebSearchToolDefinition({ apiKey: "test-tavily-key", ...options });
}

function mcpResponse(request: JsonRpcRequest, result?: CallToolResult) {
	if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
	return Response.json({
		jsonrpc: "2.0",
		id: request.id,
		result:
			request.method === "initialize"
				? { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "exa", version: "1" } }
				: (result ?? { content: [{ type: "text", text }] }),
	});
}

function oversizedStream() {
	let cancelled = false;
	let chunks = 0;
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			chunks++;
			controller.enqueue(new Uint8Array(64 * 1024));
		},
		cancel() {
			cancelled = true;
		},
	});
	return { body, cancelled: () => cancelled, chunks: () => chunks };
}

describe("web_search Tavily", () => {
	it.each([
		{ provider: "tavily" as const, endpoint: "https://mcp.exa.ai/mcp" },
		{ provider: "exa" as const, endpoint: "https://api.tavily.com/search" },
	])("rejects the other provider's endpoint before sending credentials: $provider", async (config) => {
		const fetch = vi.fn();
		const tool = createWebSearchToolDefinition({ ...config, apiKey: "test-selected-provider-key", fetch });
		await expect(execute(tool)).rejects.toThrow(/provider does not match/);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("defaults to Tavily JSON, bearer authentication, eight results, and the existing result structure", async () => {
		const fetch = vi.fn(async (url, init) => {
			expect(String(url)).toBe("https://api.tavily.com/search");
			expect(String(url)).not.toContain("test-tavily-key");
			expect(init?.method).toBe("POST");
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-tavily-key");
			expect(init?.redirect).toBe("error");
			expect(JSON.parse(String(init?.body))).toEqual({
				query: "docs",
				max_results: 8,
				search_depth: "basic",
				include_answer: false,
				include_raw_content: false,
			});
			return Response.json({ results: [{ ...tavilyResult, published_date: "2026-10-02" }] });
		});
		const tool = tavilyTool({ fetch });
		expect(tool.exposure).toBe("direct");
		expect(fetch).not.toHaveBeenCalled();
		expect(tool.parameters.properties.num_results).toMatchObject({ type: "integer", minimum: 1, maximum: 20 });
		const result = await execute(tool);
		expect(result.details).toEqual({
			query: "docs",
			results: [{ title: "Docs", url: tavilyResult.url, published: "2026-10-02", highlights: tavilyResult.content }],
		});
		expect(result.content).toEqual([
			{ type: "text", text: "1. [Docs](https://docs.example.com/a)\n2026-10-02\nCurrent official docs" },
		]);
	});

	it("pushes domain filters and requested count into the API instead of deleting top results locally", async () => {
		const fetch = vi.fn(async (_url, init) => {
			expect(JSON.parse(String(init?.body))).toMatchObject({
				query: "docs\n\nSearch objective: official sources",
				max_results: 3,
				include_domains: ["example.com"],
				exclude_domains: ["blocked.test"],
			});
			return Response.json({ results: [tavilyResult] });
		});
		const result = await execute(tavilyTool({ fetch }), {
			query: "docs",
			objective: "official sources",
			num_results: 3,
			allowed_domains: ["example.com"],
			blocked_domains: ["blocked.test"],
		});
		expect(result.details?.results).toHaveLength(1);
	});

	it("honors a custom endpoint and default count", async () => {
		const fetch = vi.fn(async (url, init) => {
			expect(String(url)).toBe("https://search.example.test/search");
			expect(JSON.parse(String(init?.body)).max_results).toBe(12);
			return Response.json({ results: [] });
		});
		await execute(tavilyTool({ endpoint: "https://search.example.test/search", defaultResults: 12, fetch }));
	});

	it("requires a key without silently connecting to Exa", async () => {
		const fetch = vi.fn();
		const createTransport = vi.fn();
		const tool = createWebSearchToolDefinition({ fetch, createTransport });
		await expect(execute(tool)).rejects.toThrow(/Tavily.*webSearch.apiKey or TAVILY_API_KEY.*no provider fallback/);
		expect(fetch).not.toHaveBeenCalled();
		expect(createTransport).not.toHaveBeenCalled();
	});

	it("reads TAVILY_API_KEY lazily only when apiKey is omitted", async () => {
		const headers: string[] = [];
		const fetch = vi.fn(async (_url, init) => {
			headers.push(new Headers(init?.headers).get("authorization") ?? "");
			return Response.json({ results: [] });
		});
		const tool = createWebSearchToolDefinition({ fetch });
		vi.stubEnv("TAVILY_API_KEY", "test-env-key");
		await execute(tool);
		vi.stubEnv("TAVILY_API_KEY", "rotated-test-key");
		await execute(tool);
		await execute(tavilyTool({ fetch }));
		expect(headers).toEqual(["Bearer test-env-key", "Bearer rotated-test-key", "Bearer test-tavily-key"]);
	});

	// biome-ignore lint/suspicious/noTemplateCurlyInString: Literal credential configuration syntax.
	it.each(["$TEST_SEARCH_KEY", "${TEST_SEARCH_KEY}"])(
		"resolves configured %s credentials on demand",
		async (apiKey) => {
			const fetch = vi.fn(async (_url, init) => {
				expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-config-env-key");
				return Response.json({ results: [] });
			});
			const tool = tavilyTool({ apiKey, fetch });
			vi.stubEnv("TEST_SEARCH_KEY", "test-config-env-key");
			await execute(tool);
		},
	);

	it("resolves existing !command syntax lazily without blocking the event loop", async () => {
		const fetch = vi.fn(async (_url, init) => {
			expect(new Headers(init?.headers).get("authorization")).toBe("Bearer test-command-key");
			return Response.json({ results: [] });
		});
		const tool = tavilyTool({ apiKey: '!printf "%s" "$TEST_SEARCH_COMMAND_KEY"', fetch });
		vi.stubEnv("TEST_SEARCH_COMMAND_KEY", "test-command-key");
		await execute(tool);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("never exposes credential resolution errors or failed command output", async () => {
		vi.spyOn(configValues, "resolveConfigValueOrThrow").mockImplementation(() => {
			throw new Error("sensitive resolver text");
		});
		const fetch = vi.fn();
		for (const apiKey of ["$TEST_KEY", "!printf sensitive-output; exit 1", "!printf '%10000s' oversized"]) {
			await expect(execute(tavilyTool({ apiKey, fetch }))).rejects.toThrow(
				"Failed to resolve Tavily web search API key; check webSearch.apiKey.",
			);
		}
		expect(fetch).not.toHaveBeenCalled();
	});

	it("cancels a running credential command before any HTTP request", async () => {
		const controller = new AbortController();
		const fetch = vi.fn();
		const call = execute(tavilyTool({ apiKey: "!while :; do :; done", fetch }), undefined, controller.signal);
		setTimeout(() => controller.abort(new Error("cancelled credential command")), 30);
		await expect(call).rejects.toThrow("cancelled credential command");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("includes credential command execution in the total timeout", async () => {
		const fetch = vi.fn();
		await expect(execute(tavilyTool({ apiKey: "!while :; do :; done", fetch, timeoutMs: 30 }))).rejects.toThrow(
			/total time budget/,
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("does not fall back to the standard env key when an explicit key reference is invalid", async () => {
		vi.stubEnv("TAVILY_API_KEY", "test-standard-key");
		vi.stubEnv("MISSING_SEARCH_KEY", "");
		const fetch = vi.fn();
		await expect(execute(tavilyTool({ apiKey: "$MISSING_SEARCH_KEY", fetch }))).rejects.toThrow(
			"Failed to resolve Tavily",
		);
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each(["", "\r\ninvalid"])("rejects invalid keys without putting them into errors", async (apiKey) => {
		const fetch = vi.fn();
		await expect(execute(tavilyTool({ apiKey, fetch }))).rejects.toThrow("Invalid web search API key");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("distinguishes a real empty array from invalid output", async () => {
		const result = await execute(tavilyTool({ fetch: async () => Response.json({ results: [] }) }));
		expect(result.details?.results).toEqual([]);
		expect(result.content).toEqual([{ type: "text", text: "No web search results found." }]);
	});

	it.each([
		null,
		{},
		{ results: null },
		{ results: [], error: "unsafe provider failure" },
		{ results: [{}] },
		{ results: [{ ...tavilyResult, content: null }] },
		{ results: [{ ...tavilyResult, url: "file:///not-a-source" }] },
		{ results: [{ ...tavilyResult, title: "" }] },
		{ results: [{ ...tavilyResult, title: "x".repeat(2_049) }] },
	])("rejects invalid JSON shapes instead of reporting no results: %j", async (payload) => {
		await expect(execute(tavilyTool({ fetch: async () => Response.json(payload) }))).rejects.toThrow(
			/invalid output/,
		);
	});

	it.each([
		new Response("not json", { headers: { "content-type": "application/json" } }),
		new Response("<html>unexpected</html>", { headers: { "content-type": "text/html" } }),
	])("rejects malformed JSON and unexpected response content types", async (response) => {
		await expect(execute(tavilyTool({ fetch: async () => response }))).rejects.toThrow(/invalid output/);
	});

	it("honors Retry-After before a 429 retry", async () => {
		const times: number[] = [];
		const fetch = vi.fn(async () => {
			times.push(Date.now());
			return times.length === 1
				? new Response("rate limited", { status: 429, headers: { "retry-after": "0.3" } })
				: Response.json({ results: [tavilyResult] });
		});
		expect((await execute(tavilyTool({ fetch }))).details?.results).toHaveLength(1);
		expect(times[1] - times[0]).toBeGreaterThanOrEqual(280);
	});

	it("accepts numeric and HTTP-date Retry-After values", () => {
		expect(parseSearchRetryAfter("1.5")).toBe(1_500);
		vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-01-01T00:00:00Z"));
		expect(parseSearchRetryAfter("Thu, 01 Jan 2026 00:00:02 GMT")).toBe(2_000);
		expect(parseSearchRetryAfter("bad header")).toBe(0);
	});

	it("fails explicitly when Retry-After exceeds the unified budget", async () => {
		const fetch = vi.fn(async () => new Response("secret body", { status: 429, headers: { "retry-after": "120" } }));
		await expect(execute(tavilyTool({ fetch }))).rejects.toThrow(/retry delay exceeds.*total time budget/);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("retries transient connection failures with bounded exponential backoff", async () => {
		const times: number[] = [];
		const fetch = vi.fn(async () => {
			times.push(Date.now());
			if (times.length < 3) throw new TypeError("secret upstream URL");
			return Response.json({ results: [] });
		});
		await execute(tavilyTool({ fetch }));
		expect(fetch).toHaveBeenCalledTimes(3);
		expect(times[1] - times[0]).toBeGreaterThanOrEqual(230);
		expect(times[2] - times[1]).toBeGreaterThanOrEqual(480);
	});

	it("stops after three HTTP attempts without leaking response bodies or credentials", async () => {
		const fetch = vi.fn(
			async () => new Response("test-tavily-key https://private.example.test/path", { status: 429 }),
		);
		await expect(execute(tavilyTool({ fetch }))).rejects.toThrow("Tavily web search HTTP 429 (rate limited).");
		expect(fetch).toHaveBeenCalledTimes(3);
	});

	it.each([400, 401, 403])("does not retry HTTP %i and suppresses unsafe error content", async (status) => {
		const fetch = vi.fn(async () => new Response("test-tavily-key unsafe provider detail", { status }));
		const error = await execute(tavilyTool({ fetch })).catch((reason: Error) => reason);
		expect(error).toBeInstanceOf(Error);
		expect(String(error)).toContain(`HTTP ${status}`);
		expect(String(error)).not.toMatch(/test-tavily-key|unsafe provider detail/);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("caps the total deadline at 25 seconds even when a larger timeout is requested", async () => {
		const realNow = Date.now();
		const now = vi.spyOn(Date, "now").mockReturnValue(realNow);
		const fetch = vi.fn(async () => {
			now.mockReturnValue(realNow + 25_001);
			return Response.json({ results: [] });
		});
		await expect(execute(tavilyTool({ fetch, timeoutMs: 60_000 }))).rejects.toThrow(/total time budget/);
	});

	it("times out a fetch that ignores cancellation and aborts its request signal", async () => {
		let signal: AbortSignal | null | undefined;
		const fetch = vi.fn((_url, init) => {
			signal = init?.signal;
			return new Promise<Response>(() => {});
		});
		await expect(execute(tavilyTool({ fetch, timeoutMs: 20 }))).rejects.toThrow(/total time budget/);
		expect(signal?.aborted).toBe(true);
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("cancels a running response read", async () => {
		const controller = new AbortController();
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		const call = execute(
			tavilyTool({ fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }) }),
			undefined,
			controller.signal,
		);
		await new Promise((resolve) => setTimeout(resolve, 10));
		controller.abort(new Error("cancelled search"));
		await expect(call).rejects.toThrow("cancelled search");
		expect(cancelled).toBe(true);
	});

	it("includes a stalled response body in the same total timeout", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		await expect(
			execute(
				tavilyTool({
					timeoutMs: 20,
					fetch: async () => new Response(body, { headers: { "content-type": "application/json" } }),
				}),
			),
		).rejects.toThrow(/total time budget/);
		expect(cancelled).toBe(true);
	});

	it("cancels during retry backoff without a second request", async () => {
		const controller = new AbortController();
		const fetch = vi.fn(async () => {
			setTimeout(() => controller.abort(new Error("cancelled retry")), 10);
			return new Response(null, { status: 429 });
		});
		await expect(execute(tavilyTool({ fetch }), undefined, controller.signal)).rejects.toThrow("cancelled retry");
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("does not resolve credentials or fetch for an already-aborted search", async () => {
		const resolver = vi.spyOn(configValues, "resolveConfigValueOrThrow");
		const fetch = vi.fn();
		await expect(
			execute(tavilyTool({ fetch }), undefined, AbortSignal.abort(new Error("cancelled"))),
		).rejects.toThrow("cancelled");
		expect(resolver).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("bounds chunked response reads and cancels an oversized body", async () => {
		const stream = oversizedStream();
		await expect(
			execute(
				tavilyTool({
					fetch: async () => new Response(stream.body, { headers: { "content-type": "application/json" } }),
				}),
			),
		).rejects.toThrow(/2 MB size limit/);
		expect(stream.cancelled()).toBe(true);
		expect(stream.chunks()).toBeLessThanOrEqual(WEB_SEARCH_MAX_RESPONSE_BYTES / (64 * 1024) + 2);
	});

	it("rejects oversized Content-Length before reading a response body", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		await expect(
			execute(
				tavilyTool({
					fetch: async () =>
						new Response(body, { headers: { "content-length": String(WEB_SEARCH_MAX_RESPONSE_BYTES + 1) } }),
				}),
			),
		).rejects.toThrow(/2 MB size limit/);
		expect(cancelled).toBe(true);
	});

	it("bounds every excerpt and total content/details while preserving every source identity", async () => {
		const results = Array.from({ length: 20 }, (_, index) => ({
			title: `Result ${index}`,
			url: `https://example.com/${index}`,
			content: "文😀\n".repeat(5_000),
		}));
		const result = await execute(tavilyTool({ fetch: async () => Response.json({ results }), maxBytes: 12_000 }), {
			query: "docs",
			num_results: 20,
		});
		expect(Buffer.byteLength(result.content[0].type === "text" ? result.content[0].text : "")).toBeLessThanOrEqual(
			12_000,
		);
		expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThanOrEqual(12_000);
		expect(result.details?.results.map(({ title, url }) => ({ title, url }))).toEqual(
			results.map(({ title, url }) => ({ title, url })),
		);
		expect(result.details?.results.every((result) => Buffer.byteLength(result.highlights ?? "") <= 4_096)).toBe(true);
		expect(JSON.stringify(result.details)).not.toContain("�");
		expect(result.details?.truncation?.truncated).toBe(true);
	});

	it("does not let a single huge excerpt hide subsequent URLs", async () => {
		const results = [
			{ ...tavilyResult, content: "x".repeat(80_000) },
			{ title: "Second", url: "https://example.com/second", content: "Second excerpt" },
		];
		const result = await execute(tavilyTool({ fetch: async () => Response.json({ results }) }));
		expect(result.details?.results[0].highlights?.length).toBeLessThanOrEqual(4_096);
		expect(result.content[0]).toMatchObject({ text: expect.stringContaining("https://example.com/second") });
	});

	it("reports an output budget too small for intact titles/URLs rather than cutting links", async () => {
		await expect(
			execute(tavilyTool({ fetch: async () => Response.json({ results: [tavilyResult] }), maxBytes: 20 })),
		).rejects.toThrow(/source titles\/URLs exceed/);
	});

	it.each([1.5, 0, 21, Number.NaN])(
		"rejects invalid result counts %s before making a request",
		async (num_results) => {
			const fetch = vi.fn();
			await expect(execute(tavilyTool({ fetch }), { query: "docs", num_results })).rejects.toThrow(
				/integer from 1 to 20/,
			);
			expect(fetch).not.toHaveBeenCalled();
		},
	);

	it.each([
		"https://search.example.test/search?api_key=test-key",
		"https://user:password@search.example.test/search",
		"file:///search",
	])("rejects credential-bearing or invalid endpoints without exposing them", async (endpoint) => {
		const fetch = vi.fn();
		const error = await execute(tavilyTool({ fetch, endpoint })).catch((reason: Error) => reason);
		expect(String(error)).toMatch(/endpoint/);
		expect(String(error)).not.toMatch(/test-key|password/);
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe("web_search explicit Exa", () => {
	it.each(["\n", "\r\n"])("parses Exa blocks with %j line endings", (newline) => {
		expect(parseWebSearchResults(text.replaceAll("\n", newline))).toEqual([
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

	it("distinguishes recognized empty results from unrecognized or partially malformed output", () => {
		expect(parseWebSearchResults("No search results found.")).toEqual([]);
		for (const malformed of [
			"",
			"Unexpected response",
			`${text}\n---\nMalformed result`,
			"Title: X\nURL: file:///bad",
		])
			expect(() => parseWebSearchResults(malformed)).toThrow(/invalid output/);
	});

	it("connects lazily once, reuses the client, and pushes filters to the advanced tool", async () => {
		let connects = 0;
		const fixture = server();
		const tool = exaTool({
			createTransport: (endpoint) => {
				const url = new URL(endpoint);
				expect(url.origin + url.pathname).toBe("https://mcp.exa.ai/mcp");
				expect(url.searchParams.get("tools")).toContain("web_search_advanced_exa");
				connects++;
				return fixture.transport;
			},
		});
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
			name: "web_search_advanced_exa",
			arguments: {
				query: "current docs",
				objective: "official docs",
				numResults: 3,
				includeDomains: ["example.com"],
				excludeDomains: ["blocked.test"],
			},
		});
		// The provider owns native filtering. This fixture deliberately returns both records.
		expect(result.details?.results).toHaveLength(2);
	});

	it("keeps shared initialization alive when one concurrent waiter cancels", async () => {
		const fixture = server();
		const send = fixture.transport.send.bind(fixture.transport);
		fixture.transport.send = async (message) => {
			if ("method" in message && message.method === "initialize")
				await new Promise((resolve) => setTimeout(resolve, 30));
			return send(message);
		};
		const createTransport = vi.fn(() => fixture.transport);
		const tool = exaTool({ createTransport });
		const controller = new AbortController();
		const first = execute(tool, undefined, controller.signal);
		const second = execute(tool);
		controller.abort(new Error("cancelled first waiter"));
		await expect(first).rejects.toThrow("cancelled first waiter");
		expect((await second).details?.results).toHaveLength(2);
		expect(createTransport).toHaveBeenCalledTimes(1);
	});

	it("keeps explicit Exa keyless and never consumes Tavily credentials", async () => {
		vi.stubEnv("TAVILY_API_KEY", "test-tavily-only-key");
		await execute(
			exaTool({
				createTransport: (_url, headers) => {
					expect(headers).toEqual({});
					return server().transport;
				},
			}),
		);
	});

	it("passes a lazily resolved Exa key only in x-api-key headers", async () => {
		const tool = exaTool({
			apiKey: "$TEST_EXA_KEY",
			fetch: async (url, init) => {
				expect(String(url)).not.toMatch(/test-exa-key|exaApiKey/);
				expect(new Headers(init?.headers).get("x-api-key")).toBe("test-exa-key");
				return mcpResponse(JSON.parse(String(init?.body)));
			},
		});
		vi.stubEnv("TEST_EXA_KEY", "test-exa-key");
		expect((await execute(tool)).details?.results).toHaveLength(2);
	});

	it.each(["json", "sse"] as const)("uses bounded Streamable HTTP for %s responses offline", async (format) => {
		const methods: string[] = [];
		const tool = exaTool({
			fetch: async (_url, init) => {
				const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
				methods.push(request.method);
				const response = mcpResponse(request);
				if (format === "json" || response.status === 202) return response;
				return new Response(`event: message\r\ndata: ${await response.text()}\r\n\r\n`, {
					headers: { "Content-Type": "text/event-stream" },
				});
			},
		});
		expect((await execute(tool)).details?.results).toHaveLength(2);
		await execute(tool);
		expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/call"]);
	});

	it("accepts structured MCP search results", async () => {
		const result = await execute(
			exaTool({
				createTransport: () =>
					server({
						result: {
							content: [],
							structuredContent: {
								results: [{ title: "Structured", url: "https://example.com", highlights: ["One", "Two"] }],
							},
						},
					}).transport,
			}),
		);
		expect(result.details?.results).toEqual([
			{ title: "Structured", url: "https://example.com", highlights: "One\nTwo" },
		]);
	});

	it.each(["session", "transport"] as const)("reconnects once after a %s failure", async (kind) => {
		let connects = 0;
		const tool = exaTool({
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

	it("reconnects after a real HTTP MCP session-expiry response", async () => {
		let initializes = 0;
		let searches = 0;
		let deletes = 0;
		const tool = exaTool({
			fetch: async (_url, init) => {
				if (init?.method === "DELETE") {
					deletes++;
					return new Response(null, { status: 204 });
				}
				const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
				if (request.method === "initialize") initializes++;
				if (request.method === "tools/call" && ++searches === 1)
					return new Response("unsafe error body", { status: 404 });
				const response = mcpResponse(request);
				if (request.method === "initialize") response.headers.set("mcp-session-id", `test-session-${initializes}`);
				return response;
			},
		});
		expect((await execute(tool)).details?.results).toHaveLength(2);
		expect(initializes).toBe(2);
		expect(searches).toBe(2);
		expect(deletes).toBe(1);
	});

	it("does not reconnect more than once", async () => {
		let connects = 0;
		await expect(
			execute(
				exaTool({
					createTransport: () => {
						connects++;
						return server({ fail: () => new McpSessionExpiredError() }).transport;
					},
				}),
			),
		).rejects.toThrow("connection failed");
		expect(connects).toBe(2);
	});

	it("honors 429 Retry-After without a new MCP handshake", async () => {
		const methods: string[] = [];
		const calls: number[] = [];
		const tool = exaTool({
			fetch: async (_url, init) => {
				const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
				methods.push(request.method);
				if (request.method === "tools/call") {
					calls.push(Date.now());
					if (calls.length === 1)
						return new Response("test-exa-key", { status: 429, headers: { "retry-after": "0.3" } });
				}
				return mcpResponse(request);
			},
		});
		await execute(tool);
		expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/call"]);
		expect(calls[1] - calls[0]).toBeGreaterThanOrEqual(280);
	});

	it("honors Retry-After from an injected MCP transport without reconnecting", async () => {
		let connects = 0;
		let calls = 0;
		const tool = exaTool({
			timeoutMs: 200,
			createTransport: () => {
				connects++;
				return server({
					fail: () => {
						calls++;
						return new McpHttpError(429, "rate limited", "", { "retry-after": "60" });
					},
				}).transport;
			},
		});
		await expect(execute(tool)).rejects.toThrow(/retry delay exceeds.*total time budget/);
		expect(connects).toBe(1);
		expect(calls).toBe(1);
	});

	it("does not rebuild MCP after exhausting HTTP 429 retries", async () => {
		const methods: string[] = [];
		const tool = exaTool({
			fetch: async (_url, init) => {
				const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
				methods.push(request.method);
				return request.method === "tools/call"
					? new Response("unsafe body", { status: 429 })
					: mcpResponse(request);
			},
		});
		await expect(execute(tool)).rejects.toThrow("Exa web search HTTP 429 (rate limited).");
		expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/call", "tools/call"]);
	});

	it("reports an Exa Retry-After that exceeds the budget without reconnecting", async () => {
		const methods: string[] = [];
		const tool = exaTool({
			fetch: async (_url, init) => {
				const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
				methods.push(request.method);
				return request.method === "tools/call"
					? new Response(null, { status: 429, headers: { "retry-after": "120" } })
					: mcpResponse(request);
			},
		});
		await expect(execute(tool)).rejects.toThrow(/retry delay exceeds.*total time budget/);
		expect(methods).toEqual(["initialize", "notifications/initialized", "tools/call"]);
	});

	it("does not reconnect or retry tool errors, ordinary HTTP errors, or malformed output", async () => {
		for (const fixture of [
			{ fail: () => new McpHttpError(400, "unsafe secret error") },
			{ result: { content: [{ type: "text" as const, text: "unsafe secret error" }], isError: true } },
			{ result: { content: [{ type: "text" as const, text: "Unknown output" }] } },
		]) {
			let connects = 0;
			const tool = exaTool({
				createTransport: () => {
					connects++;
					return server(fixture).transport;
				},
			});
			await expect(execute(tool)).rejects.toThrow(/HTTP 400|invalid output/);
			expect(connects).toBe(1);
		}
	});

	it.each([{ content: [null] }, { content: [{ type: "text", text: 123 }] }])(
		"rejects malformed MCP content blocks without reconnecting: %j",
		async ({ content }) => {
			let connects = 0;
			const tool = exaTool({
				createTransport: () => {
					connects++;
					return server({ result: { content } as unknown as CallToolResult }).transport;
				},
			});
			await expect(execute(tool)).rejects.toThrow(/invalid output/);
			expect(connects).toBe(1);
		},
	);

	it.each(["initialize", "tools/call"] as const)("honors the total timeout while waiting for %s", async (hang) => {
		let connects = 0;
		const tool = exaTool({
			timeoutMs: 20,
			createTransport: () => {
				connects++;
				return server({ hang }).transport;
			},
		});
		await expect(execute(tool)).rejects.toThrow(/time budget|timeout|aborted/i);
		expect(connects).toBe(1);
	});

	it("cancels an actual running MCP HTTP request and retains the healthy connection", async () => {
		let signal: AbortSignal | null | undefined;
		let calls = 0;
		let initializes = 0;
		const tool = exaTool({
			fetch: async (_url, init) => {
				const request = JSON.parse(String(init?.body)) as JsonRpcRequest;
				if (request.method === "initialize") initializes++;
				if (request.method === "tools/call" && ++calls === 1) {
					signal = init?.signal;
					return new Promise<Response>(() => {});
				}
				return mcpResponse(request);
			},
		});
		const controller = new AbortController();
		const call = execute(tool, undefined, controller.signal);
		await vi.waitFor(() => expect(signal).toBeDefined());
		controller.abort(new Error("cancelled"));
		await expect(call).rejects.toThrow(/cancelled|aborted/i);
		expect(signal?.aborted).toBe(true);
		expect((await execute(tool)).details?.results).toHaveLength(2);
		expect(initializes).toBe(1);
	});

	it("does not connect for an already-aborted call", async () => {
		const createTransport = vi.fn(() => server().transport);
		await expect(
			execute(exaTool({ createTransport }), undefined, AbortSignal.abort(new Error("cancelled"))),
		).rejects.toThrow("cancelled");
		expect(createTransport).not.toHaveBeenCalled();
	});

	it("bounds MCP JSON responses before the transport reads them", async () => {
		const stream = oversizedStream();
		await expect(
			execute(
				exaTool({
					fetch: async () => new Response(stream.body, { headers: { "content-type": "application/json" } }),
				}),
			),
		).rejects.toThrow(/2 MB size limit/);
		expect(stream.cancelled()).toBe(true);
	});

	it("bounds highlights in Exa renderer details as well as model content", async () => {
		const result = await execute(
			exaTool({
				maxBytes: 8_000,
				createTransport: () =>
					server({
						result: {
							content: [
								{
									type: "text",
									text: `Title: Source\nURL: https://example.com\nHighlights:\n${"x".repeat(50_000)}`,
								},
							],
						},
					}).transport,
			}),
		);
		expect(Buffer.byteLength(JSON.stringify(result.details))).toBeLessThanOrEqual(8_000);
		expect(result.details?.results[0]).toMatchObject({ title: "Source", url: "https://example.com" });
		expect(result.details?.truncation?.truncated).toBe(true);
	});
});
