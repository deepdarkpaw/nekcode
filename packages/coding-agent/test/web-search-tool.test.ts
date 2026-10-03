import { describe, expect, it, vi } from "vitest";
import { createWebSearchToolDefinition, parseWebSearchResults } from "../src/core/tools/web-search.ts";

describe("web_search", () => {
	it("parses Exa result blocks", () => {
		const results = parseWebSearchResults(
			"Title: Node docs\nURL: https://nodejs.org/docs\nPublished: today\nAuthor: Node\nHighlights:\nCurrent API\n---\nTitle: Other\nURL: https://example.com/page\nHighlights:\nExample content",
		);
		expect(results).toEqual([
			{
				title: "Node docs",
				url: "https://nodejs.org/docs",
				published: "today",
				author: "Node",
				highlights: "Current API",
			},
			{ title: "Other", url: "https://example.com/page", highlights: "Example content" },
		]);
	});

	it("calls the keyless Exa MCP endpoint and filters domains", async () => {
		const payload = JSON.stringify({
			result: {
				content: [
					{
						type: "text",
						text: "Title: Allowed\nURL: https://docs.example.com/a\nHighlights:\nA\n---\nTitle: Blocked\nURL: https://blocked.test/b\nHighlights:\nB",
					},
				],
			},
		});
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(`event: message\ndata: ${payload}\n`, { status: 200 }),
		);
		const tool = createWebSearchToolDefinition({ fetch, endpoint: "https://mcp.example.test/mcp" });
		const result = await tool.execute(
			"call",
			{ query: "current docs", allowed_domains: ["example.com"] },
			undefined,
			undefined,
			{
				cwd: ".",
			} as never,
		);
		expect(fetch).toHaveBeenCalledWith("https://mcp.example.test/mcp", expect.objectContaining({ method: "POST" }));
		expect(result.details?.results).toHaveLength(1);
		expect(result.details?.results[0]?.title).toBe("Allowed");
		expect(JSON.stringify(result.content)).toContain("https://docs.example.com/a");
	});
});
