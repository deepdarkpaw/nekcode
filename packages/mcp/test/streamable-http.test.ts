import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	LATEST_PROTOCOL_VERSION,
	type McpAuthRequiredError,
	McpClient,
	type McpFetch,
	McpHttpError,
	McpSessionExpiredError,
	StreamableHttpTransport,
} from "../src/index.ts";
import { consumeSseStream, type SseEvent } from "../src/transports/streamable-http.ts";
import { closeServers, listen, readBody } from "./helpers.ts";

interface RecordedRequest {
	method: string;
	headers: IncomingMessage["headers"];
	message?: Record<string, unknown>;
}

async function startServer(
	handler: (request: IncomingMessage, response: ServerResponse, requests: RecordedRequest[]) => Promise<void>,
): Promise<{ url: string; requests: RecordedRequest[] }> {
	const requests: RecordedRequest[] = [];
	const origin = await listen((request, response) => handler(request, response, requests));
	return { url: `${origin}/mcp`, requests };
}

async function protocolHandler(
	request: IncomingMessage,
	response: ServerResponse,
	requests: RecordedRequest[],
	body?: Record<string, unknown>,
): Promise<void> {
	if (request.method === "GET") {
		requests.push({ method: "GET", headers: request.headers });
		response.statusCode = 405;
		response.end();
		return;
	}
	if (request.method === "DELETE") {
		requests.push({ method: "DELETE", headers: request.headers });
		response.statusCode = 200;
		response.end();
		return;
	}
	const message = body ?? (JSON.parse(await readBody(request)) as Record<string, unknown>);
	requests.push({ method: request.method ?? "", headers: request.headers, message });
	if (!("id" in message)) {
		response.statusCode = 202;
		response.end();
		return;
	}
	if (message.method === "initialize") {
		response.writeHead(200, {
			"content-type": "application/json",
			"mcp-session-id": "session-1",
		});
		response.end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result: {
					protocolVersion: LATEST_PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "http-fixture", version: "1.0.0" },
				},
			}),
		);
		return;
	}
	if (message.method === "tools/list") {
		response.setHeader("content-type", "application/json");
		response.end(
			JSON.stringify({
				jsonrpc: "2.0",
				id: message.id,
				result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
			}),
		);
		return;
	}
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.write("id: tool-result\n");
	response.end(
		`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "hello" }] } })}\n\n`,
	);
}

/** Exercise response consumption with a mocked fetch, without connecting to any server. */
async function receiveResponse(response: Response, maxMessageBytes?: number): Promise<unknown[]> {
	const transport = new StreamableHttpTransport({
		url: "http://127.0.0.1/mcp",
		maxMessageBytes,
		openGetStream: false,
		fetch: async () => response,
	});
	const messages: unknown[] = [];
	transport.onMessage((message) => messages.push(message));
	await transport.start();
	try {
		await transport.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
		return messages;
	} finally {
		await transport.close();
	}
}

afterEach(closeServers);

describe("consumeSseStream", () => {
	it("parses chunked CRLF events, comments, IDs, and multiline data", async () => {
		const encoder = new TextEncoder();
		const chunks = [': keepalive\r\nid: 7\r\ndata: {"one":\r\n', "data: 1}\r\n\r\n"];
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		});
		const events: SseEvent[] = [];
		await consumeSseStream(stream, { onEvent: (event) => events.push(event) });
		expect(events).toEqual([{ id: "7", data: '{"one":\n1}' }]);
	});

	it("rejects events whose data lines exceed the limit without a blank line", async () => {
		const encoder = new TextEncoder();
		let sent = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				// Never sends a blank line, so the event is never dispatched.
				if (sent++ > 1000) controller.close();
				else controller.enqueue(encoder.encode("data: xxxxxxxxxxxxxxxx\n"));
			},
		});
		await expect(consumeSseStream(stream, { maxEventBytes: 256, onEvent: () => {} })).rejects.toThrow(
			"MCP SSE event exceeds 256 bytes",
		);
		expect(sent).toBeLessThan(100);
	});

	it.each([false, true])("cancels oversized SSE (cancel fails: %s)", async (failCancel) => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				// Leave the body open after the oversized event, just as a server sending heartbeats would.
				controller.enqueue(new TextEncoder().encode(`data: ${"x".repeat(512)}\n\n`));
			},
			cancel() {
				cancelled = true;
				if (failCancel) throw new Error("cancel failed");
			},
		});
		await expect(consumeSseStream(stream, { maxEventBytes: 128, onEvent: () => {} })).rejects.toThrow(
			"MCP SSE event exceeds 128 bytes",
		);
		expect(cancelled).toBe(true);
		expect(stream.locked).toBe(false);
	});

	it("cancels a stream when its event handler throws", async () => {
		const failure = new Error("invalid event");
		const cancel = vi.fn();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("data: invalid\n\n"));
			},
			cancel,
		});
		await expect(
			consumeSseStream(stream, {
				onEvent: () => {
					throw failure;
				},
			}),
		).rejects.toBe(failure);
		expect(cancel).toHaveBeenCalledOnce();
	});
});

describe("McpHttpError Retry-After", () => {
	it("keeps the original three constructor parameters compatible", () => {
		const error = new McpHttpError(400, "failure", "body");
		expect(error).toMatchObject({ status: 400, message: "failure", body: "body", retryAfter: null });
		expect(error.retryAfterMs).toBeUndefined();
	});

	it.each([
		["0", 0],
		["2", 2_000],
		["0002", 2_000],
		[" 12 ", 12_000],
	])("parses delay-seconds %s", (value, delay) => {
		expect(new McpHttpError(429, "rate limited", "", { "Retry-After": value }).retryAfterMs).toBe(delay);
	});

	it("parses an HTTP date relative to now and clamps past dates to zero", () => {
		const now = Date.UTC(2026, 10, 5, 12);
		const clock = vi.spyOn(Date, "now").mockReturnValue(now);
		try {
			const future = new Date(now + 45_000).toUTCString();
			const past = new Date(now - 45_000).toUTCString();
			expect(new McpHttpError(503, "busy", "", { "retry-after": future }).retryAfterMs).toBe(45_000);
			expect(new McpHttpError(503, "busy", "", { "retry-after": past }).retryAfterMs).toBe(0);
		} finally {
			clock.mockRestore();
		}
	});

	it.each([
		"",
		"not a date",
		"-1",
		"+1",
		"1.5",
		"1e3",
		"Infinity",
		"999999999999999999999999999999999999",
		"Fri, 30 Feb 2026 12:00:00 GMT",
		"2026-11-05T12:00:00Z",
	])("ignores invalid Retry-After %s", (value) => {
		expect(new McpHttpError(429, "rate limited", "", { "retry-after": value }).retryAfterMs).toBeUndefined();
	});
});

describe("StreamableHttpTransport", () => {
	it("handles JSON and SSE responses with session and protocol headers", async () => {
		const { url, requests } = await startServer(protocolHandler);
		const transport = new StreamableHttpTransport({ url });
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		await client.connect(transport);
		expect(transport.sessionId).toBe("session-1");
		expect(await client.listTools()).toEqual([{ name: "echo", inputSchema: { type: "object" } }]);
		expect(await client.callTool("echo", { text: "hello" })).toEqual({
			content: [{ type: "text", text: "hello" }],
		});
		await client.close();

		const listRequest = requests.find((entry) => entry.message?.method === "tools/list");
		expect(listRequest?.headers["mcp-session-id"]).toBe("session-1");
		expect(listRequest?.headers["mcp-protocol-version"]).toBe(LATEST_PROTOCOL_VERSION);
		expect(requests.some((entry) => entry.method === "GET")).toBe(true);
		expect(requests.some((entry) => entry.method === "DELETE")).toBe(true);
	});

	it("classifies authentication failures", async () => {
		const { url } = await startServer(async (request, response) => {
			await readBody(request);
			response.writeHead(401, { "www-authenticate": 'Bearer resource_metadata="https://example.com/meta"' });
			response.end("login required");
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		await expect(client.connect(new StreamableHttpTransport({ url }))).rejects.toMatchObject({
			name: "McpAuthRequiredError",
			status: 401,
			body: "login required",
			wwwAuthenticate: 'Bearer resource_metadata="https://example.com/meta"',
		} satisfies Partial<McpAuthRequiredError>);
	});

	it("fails only the request whose SSE stream breaks", async () => {
		let releaseSlow = () => {};
		const slowGate = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const { url } = await startServer(async (request, response, requests) => {
			if (request.method !== "POST") return protocolHandler(request, response, requests);
			const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
			const name = (message.params as { name?: string } | undefined)?.name;
			if (name === "broken") {
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end("data: not json\n\n");
				return;
			}
			if (name === "slow") await slowGate;
			await protocolHandler(request, response, requests, message);
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		const errors: Error[] = [];
		client.onError((error) => errors.push(error));
		await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));

		const slow = client.callTool("slow");
		await expect(client.callTool("broken")).rejects.toThrow("MCP response stream failed");
		releaseSlow();
		expect(await slow).toEqual({ content: [{ type: "text", text: "hello" }] });
		expect(errors).toHaveLength(1);
		await client.close();
	});

	it("opens the GET stream after initialization and sends Last-Event-ID only when resuming", async () => {
		const order: string[] = [];
		const { url, requests } = await startServer(async (request, response, requests) => {
			if (request.method === "POST") {
				const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
				order.push(String(message.method));
				return protocolHandler(request, response, requests, message);
			}
			order.push(request.method ?? "");
			return protocolHandler(request, response, requests);
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		await client.connect(new StreamableHttpTransport({ url }));
		await client.callTool("echo");
		await client.listTools();
		await client.close();
		expect(order.indexOf("GET")).toBeGreaterThan(order.indexOf("notifications/initialized"));
		expect(requests.every((entry) => entry.headers["last-event-id"] === undefined)).toBe(true);
	});

	it("resumes a response stream the server closed before answering", async () => {
		const resumeHeaders: (string | undefined)[] = [];
		const { url } = await startServer(async (request, response, requests) => {
			if (request.method === "GET" && request.headers["last-event-id"]) {
				resumeHeaders.push(request.headers["last-event-id"] as string);
				response.writeHead(200, { "content-type": "text/event-stream" });
				response.end(
					`id: 2\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { content: [{ type: "text", text: "resumed" }] } })}\n\n`,
				);
				return;
			}
			if (request.method !== "POST") return protocolHandler(request, response, requests);
			const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
			if (message.method !== "tools/call") return protocolHandler(request, response, requests, message);
			// Priming event (ID, no data) and a retry hint, then the server drops the stream.
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end("id: 1\nretry: 5\ndata:\n\n");
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		const errors: Error[] = [];
		client.onError((error) => errors.push(error));
		await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
		expect(await client.callTool("echo")).toEqual({ content: [{ type: "text", text: "resumed" }] });
		expect(resumeHeaders).toEqual(["1"]);
		expect(errors).toEqual([]);
		await client.close();
	});

	it("fails a request whose response stream ends without an answer", async () => {
		const { url } = await startServer(async (request, response, requests) => {
			if (request.method !== "POST") return protocolHandler(request, response, requests);
			const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
			if (message.method !== "tools/call") return protocolHandler(request, response, requests, message);
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(": nothing here\n\n");
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
		await expect(client.callTool("echo", {}, { timeoutMs: 5_000 })).rejects.toThrow(
			"MCP response stream failed: stream ended without a response",
		);
		await client.close();
	});

	it("reconnects the GET stream after it drops", async () => {
		let gets = 0;
		const lastEventIds: (string | undefined)[] = [];
		const { url } = await startServer(async (request, response, requests) => {
			if (request.method !== "GET") return protocolHandler(request, response, requests);
			gets++;
			lastEventIds.push(request.headers["last-event-id"] as string | undefined);
			response.writeHead(200, { "content-type": "text/event-stream" });
			const notification = { jsonrpc: "2.0", method: "notifications/tools/list_changed" };
			if (gets === 1) {
				response.end(`id: g1\ndata: ${JSON.stringify(notification)}\n\n`);
				return;
			}
			response.write(`id: g2\ndata: ${JSON.stringify(notification)}\n\n`);
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		let changes = 0;
		const secondChange = new Promise<void>((resolve) => {
			client.onNotification("notifications/tools/list_changed", () => {
				if (++changes === 2) resolve();
			});
		});
		await client.connect(new StreamableHttpTransport({ url, reconnect: { initialDelayMs: 1 } }));
		await secondChange;
		expect(lastEventIds).toEqual([undefined, "g1"]);
		await client.close();
	});

	it("rejects a request the server accepts without a response", async () => {
		const { url } = await startServer(async (request, response, requests) => {
			if (request.method !== "POST") return protocolHandler(request, response, requests);
			const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
			if (message.method !== "tools/call") return protocolHandler(request, response, requests, message);
			response.statusCode = 202;
			response.end();
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
		await expect(client.callTool("echo")).rejects.toThrow("without a response");
		await client.close();
	});

	it("applies maxMessageBytes to JSON responses", async () => {
		const response = (length: number) =>
			new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "x".repeat(length) } }), {
				headers: { "content-type": "application/json" },
			});
		expect(await receiveResponse(response(32), 512)).toHaveLength(1);
		await expect(receiveResponse(response(2048), 512)).rejects.toThrow("MCP JSON response exceeds 512 bytes");
	});

	it.each([false, true])("cancels oversized chunked JSON (cancel fails: %s)", async (failCancel) => {
		let cancelled = false;
		let chunks = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				chunks++;
				controller.enqueue(new TextEncoder().encode("x".repeat(128)));
			},
			cancel() {
				cancelled = true;
				if (failCancel) throw new Error("cancel failed");
			},
		});
		const response = new Response(body, { headers: { "content-type": "application/json" } });
		const json = vi.spyOn(response, "json");
		expect(response.headers.has("content-length")).toBe(false);
		await expect(receiveResponse(response, 512)).rejects.toThrow("MCP JSON response exceeds 512 bytes");
		expect(cancelled).toBe(true);
		expect(body.locked).toBe(false);
		expect(chunks).toBeLessThan(8);
		expect(json).not.toHaveBeenCalled();
	});

	it("decodes a split BOM and UTF-8 characters, accepting a body exactly at the byte limit", async () => {
		const message = { jsonrpc: "2.0", id: 1, result: { text: "é€😀" } };
		const bytes = new TextEncoder().encode(`\uFEFF${JSON.stringify(message)}`);
		const response = () => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
					controller.close();
				},
			});
			return new Response(body, { headers: { "content-type": "application/json; charset=utf-8" } });
		};
		expect(await receiveResponse(response(), bytes.byteLength)).toEqual([message]);
		await expect(receiveResponse(response(), bytes.byteLength - 1)).rejects.toThrow(
			`MCP JSON response exceeds ${bytes.byteLength - 1} bytes`,
		);
	});

	it.each([false, true])("caps endless HTTP errors at 8 KB (cancel fails: %s)", async (failCancel) => {
		let cancelled = false;
		let chunks = 0;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				chunks++;
				controller.enqueue(new TextEncoder().encode("x".repeat(1024)));
			},
			cancel() {
				cancelled = true;
				if (failCancel) throw new Error("cancel failed");
			},
		});
		const response = new Response(body, { status: 500 });
		const text = vi.spyOn(response, "text");
		const error = await receiveResponse(response).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(McpHttpError);
		expect((error as McpHttpError).body).toBe("x".repeat(8 * 1024));
		expect(cancelled).toBe(true);
		expect(body.locked).toBe(false);
		expect(chunks).toBeLessThanOrEqual(9);
		expect(text).not.toHaveBeenCalled();
	});

	it("stops immediately at the error excerpt limit without waiting for another chunk", async () => {
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode("x".repeat(8 * 1024)));
				// The server neither ends the response nor sends more data.
			},
			cancel,
		});
		await expect(receiveResponse(new Response(body, { status: 500 }))).rejects.toMatchObject({
			name: "McpHttpError",
			body: "x".repeat(8 * 1024),
		});
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("decodes split UTF-8 error excerpts without keeping a partial character at the boundary", async () => {
		const expected = `é€😀${"x".repeat(8 * 1024 - 13)}`;
		const bytes = new TextEncoder().encode(`\uFEFF${expected}étail`);
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
			},
			cancel,
		});
		const error = await receiveResponse(new Response(body, { status: 500 })).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(McpHttpError);
		expect((error as McpHttpError).body).toBe(expected);
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("exposes only Retry-After response metadata, not tokens or sensitive headers", async () => {
		const response = new Response("busy", {
			status: 429,
			headers: {
				"retry-after": "2",
				authorization: "Bearer sensitive-token",
				"set-cookie": "session=sensitive-cookie",
			},
		});
		const error = await receiveResponse(response).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(McpHttpError);
		expect(error).toMatchObject({ status: 429, body: "busy", retryAfter: "2", retryAfterMs: 2_000 });
		expect(JSON.stringify(error)).not.toContain("sensitive");
		expect(String(error)).not.toContain("sensitive");
	});

	it("includes the response body in HTTP errors", async () => {
		const { url } = await startServer(async (request, response) => {
			await readBody(request);
			response.statusCode = 400;
			response.end("Invalid Accept header");
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		await expect(client.connect(new StreamableHttpTransport({ url }))).rejects.toThrow(
			"MCP HTTP request failed with status 400: Invalid Accept header",
		);
	});

	it("hands 401 and insufficient-scope 403 responses to the auth provider with the rejected token", async () => {
		const seen: { status: number; token?: string }[] = [];
		let token = "old";
		const { url } = await startServer(async (request, response, requests) => {
			if (request.method !== "POST") return protocolHandler(request, response, requests);
			const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
			if (request.headers.authorization === "Bearer old") {
				response.writeHead(401, { "www-authenticate": "Bearer" }).end();
				return;
			}
			if (message.method === "tools/call" && request.headers.authorization === "Bearer new") {
				response.writeHead(403, { "www-authenticate": 'Bearer error="insufficient_scope", scope="admin"' }).end();
				return;
			}
			return protocolHandler(request, response, requests, message);
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		await client.connect(
			new StreamableHttpTransport({
				url,
				openGetStream: false,
				authProvider: {
					token: async () => token,
					onUnauthorized: async ({ response, token: rejected }) => {
						seen.push({ status: response.status, token: rejected });
						if (response.status === 401) token = "new";
						else token = "admin";
					},
				},
			}),
		);
		expect(await client.callTool("echo")).toEqual({ content: [{ type: "text", text: "hello" }] });
		expect(seen).toEqual([
			{ status: 401, token: "old" },
			{ status: 403, token: "new" },
		]);
		await client.close();
	});

	// #10598: a request cancelled or timed out while waiting for a shared refresh must not be retried.
	it("does not retry requests that were cancelled while authorization was recovering", async () => {
		let token = "old";
		const executed: unknown[] = [];
		const { url } = await startServer(async (request, response, requests) => {
			if (request.method !== "POST") return protocolHandler(request, response, requests);
			const message = JSON.parse(await readBody(request)) as Record<string, unknown>;
			if (message.method === "tools/call" && request.headers.authorization === "Bearer old") {
				response.writeHead(401, { "www-authenticate": "Bearer" }).end();
				return;
			}
			if (message.method === "tools/call") executed.push((message.params as { name: string }).name);
			return protocolHandler(request, response, requests, message);
		});
		let releaseRefresh = () => {};
		const refreshGate = new Promise<void>((resolve) => {
			releaseRefresh = resolve;
		});
		let refresh: Promise<void> | undefined;
		let refreshes = 0;
		let waiting = 0;
		let allWaiting = () => {};
		const waitingGate = new Promise<void>((resolve) => {
			allWaiting = resolve;
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		await client.connect(
			new StreamableHttpTransport({
				url,
				openGetStream: false,
				authProvider: {
					token: async () => token,
					onUnauthorized: async () => {
						if (!refresh) {
							refreshes++;
							refresh = refreshGate.then(() => {
								token = "new";
							});
						}
						if (++waiting === 3) allWaiting();
						await refresh;
					},
				},
			}),
		);
		const controller = new AbortController();
		const aborted = client.callTool("aborted", {}, { signal: controller.signal });
		const timedOut = client.callTool("timed-out", {}, { timeoutMs: 200 });
		const kept = client.callTool("kept");
		await waitingGate;
		controller.abort();
		await expect(aborted).rejects.toMatchObject({ name: "AbortError" });
		await expect(timedOut).rejects.toMatchObject({ name: "McpTimeoutError" });
		releaseRefresh();
		expect(await kept).toEqual({ content: [{ type: "text", text: "hello" }] });
		expect(executed).toEqual(["kept"]);
		expect(refreshes).toBe(1);
		await client.close();
	});

	// #10565: the auth provider may refresh over the network, which closing must not wait for.
	it("closes the session with the last request's token, without asking the auth provider", async () => {
		const { url, requests } = await startServer(protocolHandler);
		let calls = 0;
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		await client.connect(
			new StreamableHttpTransport({
				url,
				openGetStream: false,
				authProvider: { token: async () => `token-${++calls}` },
			}),
		);
		const before = calls;
		await client.close();
		expect(calls).toBe(before);
		const deletes = requests.filter((entry) => entry.method === "DELETE");
		expect(deletes.map((entry) => entry.headers.authorization)).toEqual([`Bearer token-${before}`]);
		expect(deletes[0]?.headers["mcp-session-id"]).toBe("session-1");
	});

	// #10188: Cloudflare Workers reject the platform fetch when called with a receiver other than globalThis.
	it("calls fetch without a receiver", async () => {
		const realFetch = globalThis.fetch;
		const strictFetch = function (this: unknown, input: string | URL, init?: RequestInit) {
			if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
			return realFetch(input, init);
		} satisfies McpFetch;
		const { url } = await startServer(async (request, response, requests) => {
			if (request.method === "POST" && request.headers.authorization === undefined) {
				await readBody(request);
				response.writeHead(401, { "www-authenticate": "Bearer" }).end();
				return;
			}
			return protocolHandler(request, response, requests);
		});
		const connect = async (fetch: McpFetch | undefined) => {
			let token: string | undefined;
			const client = new McpClient({ name: "http-test", version: "1.0.0" });
			await client.connect(
				new StreamableHttpTransport({
					url,
					fetch,
					openGetStream: false,
					authProvider: {
						token: async () => token,
						onUnauthorized: async (context) => {
							await (await context.fetch(url)).body?.cancel();
							token = "token";
						},
					},
				}),
			);
			expect(await client.listTools()).toEqual([{ name: "echo", inputSchema: { type: "object" } }]);
			await client.close();
		};

		await connect(strictFetch);
		vi.stubGlobal("fetch", strictFetch);
		try {
			await connect(undefined);
		} finally {
			vi.unstubAllGlobals();
		}
	});

	it("classifies an expired established session", async () => {
		let posts = 0;
		const { url } = await startServer(async (request, response, requests) => {
			if (request.method === "POST" && posts++ >= 2) {
				await readBody(request);
				response.statusCode = 404;
				response.end("gone");
				return;
			}
			await protocolHandler(request, response, requests);
		});
		const client = new McpClient({ name: "http-test", version: "1.0.0" });
		await client.connect(new StreamableHttpTransport({ url, openGetStream: false }));
		await expect(client.listTools()).rejects.toBeInstanceOf(McpSessionExpiredError);
		await client.close();
	});
});
