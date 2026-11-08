import type { McpFetch } from "@earendil-works/pi-mcp";
import { describe, expect, it } from "vitest";
import { createWebSearchToolDefinition } from "../src/core/tools/web-search.ts";

/** A Streamable HTTP response may remain open after delivering its JSON-RPC result. */
describe("web search over an open SSE response", () => {
	it("returns the result without waiting for the server to close the response body", async () => {
		let finishResponse = () => {};
		const fetch: McpFetch = async (_url, init) => {
			const request = JSON.parse(String(init?.body));
			if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
			if (request.method === "initialize") {
				return new Response(
					JSON.stringify({
						jsonrpc: "2.0",
						id: request.id,
						result: {
							protocolVersion: "2025-06-18",
							capabilities: { tools: {} },
							serverInfo: { name: "offline-exa", version: "1" },
						},
					}),
					{ headers: { "Content-Type": "application/json" } },
				);
			}
			const payload = JSON.stringify({
				jsonrpc: "2.0",
				id: request.id,
				result: {
					content: [
						{
							type: "text",
							text: "Title: Documentation\nURL: https://docs.example.com/\nHighlights:\nUseful source",
						},
					],
				},
			});
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${payload}\n\n`));
						finishResponse = () => {
							try {
								controller.close();
							} catch {
								/* The caller may have cancelled after receiving the result. */
							}
						};
					},
				}),
				{ headers: { "Content-Type": "text/event-stream" } },
			);
		};
		const options = { provider: "exa" as const, fetch, timeoutMs: 200 };
		const tool = createWebSearchToolDefinition(options);
		try {
			const result = await tool.execute("open-sse", { query: "documentation" }, undefined, undefined, {} as never);
			expect(result.details?.results).toHaveLength(1);
			expect(result.details?.results[0]?.url).toBe("https://docs.example.com/");
		} finally {
			finishResponse();
		}
	});
});
