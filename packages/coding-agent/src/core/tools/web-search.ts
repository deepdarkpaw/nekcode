import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { webSearchRenderers } from "./renderers/web-search.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, type TruncationResult, truncateHead } from "./truncate.ts";

const webSearchSchema = Type.Object({
	query: Type.String({ minLength: 1, description: "A natural-language query describing the information to find." }),
	objective: Type.Optional(
		Type.String({ minLength: 1, description: "The goal and preferred sources for this search." }),
	),
	num_results: Type.Optional(
		Type.Number({ minimum: 1, maximum: 20, description: "Maximum results to return (default: 8)." }),
	),
	allowed_domains: Type.Optional(
		Type.Array(Type.String(), { description: "Only include results from these domains." }),
	),
	blocked_domains: Type.Optional(Type.Array(Type.String(), { description: "Exclude results from these domains." })),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;

export interface WebSearchResult {
	title: string;
	url: string;
	published?: string;
	author?: string;
	highlights?: string;
}

export interface WebSearchToolDetails {
	query: string;
	results: WebSearchResult[];
	truncation?: TruncationResult;
}

export interface WebSearchToolOptions {
	endpoint?: string;
	fetch?: typeof fetch;
	timeoutMs?: number;
	maxBytes?: number;
}

const DEFAULT_ENDPOINT = "https://mcp.exa.ai/mcp";
const DEFAULT_TIMEOUT_MS = 25_000;
const DEFAULT_RESULTS = 8;

export const webSearchToolSystemPromptContribution = {
	snippet: "Search the public web for current information and cite the returned sources.",
	guidelines: [],
} as const;

interface JsonRpcResponse {
	result?: { content?: Array<{ type?: string; text?: string }> };
	error?: { message?: string };
}

/** Parse the text blocks returned by Exa's hosted MCP tool. */
export function parseWebSearchResults(text: string): WebSearchResult[] {
	return text
		.split(/\n---\n/g)
		.map((block) => {
			const title = block.match(/^Title:\s*(.+)$/m)?.[1]?.trim();
			const url = block.match(/^URL:\s*(https?:\/\/\S+)$/m)?.[1]?.trim();
			if (!title || !url) return undefined;
			const published = block.match(/^Published:\s*(.+)$/m)?.[1]?.trim();
			const author = block.match(/^Author:\s*(.+)$/m)?.[1]?.trim();
			const highlights = block.match(/^Highlights:\s*([\s\S]*)$/m)?.[1]?.trim();
			return {
				title,
				url,
				...(published ? { published } : {}),
				...(author ? { author } : {}),
				...(highlights ? { highlights } : {}),
			};
		})
		.filter((result): result is WebSearchResult => result !== undefined);
}

function hostMatches(url: string, domain: string): boolean {
	try {
		const host = new URL(url).hostname.toLowerCase();
		const normalized = domain.toLowerCase().replace(/^\.+/, "");
		return host === normalized || host.endsWith(`.${normalized}`);
	} catch {
		return false;
	}
}

function filterResults(
	results: WebSearchResult[],
	allowed: string[] | undefined,
	blocked: string[] | undefined,
): WebSearchResult[] {
	return results.filter((result) => {
		if (allowed?.length && !allowed.some((domain) => hostMatches(result.url, domain))) return false;
		return !(blocked?.length && blocked.some((domain) => hostMatches(result.url, domain)));
	});
}

function responseText(body: string): string {
	for (const line of body.split("\n")) {
		if (!line.startsWith("data:")) continue;
		const payload = line.slice(5).trim();
		if (!payload || payload === "[DONE]") continue;
		try {
			const response = JSON.parse(payload) as JsonRpcResponse;
			if (response.error) throw new Error(response.error.message ?? "Exa web search failed.");
			const text = response.result?.content?.find((item) => item.type === "text")?.text;
			if (text) return text;
		} catch (error) {
			if (error instanceof Error && error.message !== "Unexpected end of JSON input") throw error;
		}
	}
	throw new Error("Exa web search returned no results.");
}

function formatResults(results: readonly WebSearchResult[]): string {
	if (results.length === 0) return "No web search results found.";
	return results
		.map((result, index) => {
			const metadata = [result.published, result.author].filter(Boolean).join(" · ");
			return [`${index + 1}. [${result.title}](${result.url})`, metadata, result.highlights]
				.filter(Boolean)
				.join("\n");
		})
		.join("\n\n");
}

export function createWebSearchToolDefinition(
	options: WebSearchToolOptions = {},
): ToolDefinition<typeof webSearchSchema, WebSearchToolDetails> {
	const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
	const fetchImpl = options.fetch ?? globalThis.fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	return {
		name: "web_search",
		label: "web_search",
		description:
			"Search the public web for current information. Include a Sources section with links in the final answer.",
		promptSnippet: webSearchToolSystemPromptContribution.snippet,
		parameters: webSearchSchema,
		async execute(_toolCallId, input, signal) {
			const combinedSignal = signal
				? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
				: AbortSignal.timeout(timeoutMs);
			const response = await fetchImpl(endpoint, {
				method: "POST",
				headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: {
						name: "web_search_exa",
						arguments: {
							query: input.query,
							objective: input.objective ?? input.query,
							numResults: input.num_results ?? DEFAULT_RESULTS,
						},
					},
				}),
				signal: combinedSignal,
			});
			if (!response.ok) throw new Error(`Web search failed with HTTP ${response.status}.`);
			const raw = responseText(await response.text());
			const results = filterResults(parseWebSearchResults(raw), input.allowed_domains, input.blocked_domains);
			const formatted = truncateHead(formatResults(results), { maxBytes, maxLines: Number.MAX_SAFE_INTEGER });
			return {
				content: [{ type: "text", text: formatted.content }],
				details: { query: input.query, results, ...(formatted.truncated ? { truncation: formatted } : {}) },
			};
		},
		...webSearchRenderers,
	};
}

export function createWebSearchTool(options?: WebSearchToolOptions): AgentTool<typeof webSearchSchema> {
	return wrapToolDefinition(createWebSearchToolDefinition(options));
}
