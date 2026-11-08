import type { AgentTool } from "@earendil-works/pi-agent-core";
import type { McpFetch, McpTransport } from "@earendil-works/pi-mcp";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { webSearchRenderers } from "./renderers/web-search.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { DEFAULT_MAX_BYTES, type TruncationResult } from "./truncate.ts";
import { createSearchBudget, remainingSearchTime, WEB_SEARCH_TIMEOUT_MS } from "./web-search-http.ts";
import { formatWebSearchOutput } from "./web-search-output.ts";
import { createExaSearch, createTavilySearch, type WebSearchProvider } from "./web-search-providers.ts";

export { parseWebSearchResults, type WebSearchProvider } from "./web-search-providers.ts";

const webSearchSchema = Type.Object({
	query: Type.String({ minLength: 1, description: "A natural-language query describing the information to find." }),
	objective: Type.Optional(
		Type.String({ minLength: 1, description: "The goal and preferred sources for this search." }),
	),
	num_results: Type.Optional(
		Type.Integer({ minimum: 1, maximum: 20, description: "Maximum results to return (default: 8)." }),
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
	/** Defaults to Tavily. Exa's hosted MCP service remains an explicit choice. */
	provider?: WebSearchProvider;
	/** Defaults to the selected provider's official search endpoint. */
	endpoint?: string;
	/** Literal, `$ENV`/`${ENV}`, or `!command`. Tavily also defaults to TAVILY_API_KEY when omitted. */
	apiKey?: string;
	/** Result count used when a call does not pass `num_results` (integer, 1-20). */
	defaultResults?: number;
	fetch?: McpFetch;
	/** Exa-only transport factory, including authentication headers. Useful for offline testing. */
	createTransport?: (endpoint: string, headers: Record<string, string>) => McpTransport;
	/** Total budget for a call, including retry delays. At most 25 seconds. */
	timeoutMs?: number;
	/** Limit for model content and serialized renderer details, independently (default: 50 KB). */
	maxBytes?: number;
}

export const webSearchToolSystemPromptContribution = {
	snippet: "Search the public web for current information and cite the returned sources.",
	guidelines: [],
} as const;

function resultCount(value: number): number {
	if (!Number.isInteger(value) || value < 1 || value > 20)
		throw new Error("Web search result count must be an integer from 1 to 20.");
	return value;
}

export function createWebSearchToolDefinition(
	options: WebSearchToolOptions = {},
): ToolDefinition<typeof webSearchSchema, WebSearchToolDetails> {
	const provider = options.provider ?? "tavily";
	if (provider !== "tavily" && provider !== "exa")
		throw new Error("Invalid web search provider; expected tavily or exa.");
	const timeoutMs = Math.min(options.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS, WEB_SEARCH_TIMEOUT_MS);
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
		throw new Error("Web search timeout must be a positive integer.");
	if (!Number.isInteger(maxBytes) || maxBytes <= 0)
		throw new Error("Web search output size limit must be a positive integer.");
	const defaultResults = resultCount(options.defaultResults ?? 8);
	const search = provider === "tavily" ? createTavilySearch(options) : createExaSearch(options, timeoutMs);
	return {
		name: "web_search",
		label: "web_search",
		description:
			"Search the public web for current information. Include a Sources section with links in the final answer.",
		promptSnippet: webSearchToolSystemPromptContribution.snippet,
		exposure: "direct",
		parameters: webSearchSchema,
		async execute(_toolCallId, input, signal) {
			const budget = createSearchBudget(timeoutMs, signal);
			try {
				remainingSearchTime(budget);
				const count = resultCount(input.num_results ?? defaultResults);
				if (
					!input.query.trim() ||
					Buffer.byteLength(input.query) > 8_192 ||
					(input.objective && Buffer.byteLength(input.objective) > 8_192)
				)
					throw new Error("Web search query/objective must be nonempty and at most 8 KB each.");
				const results = await search(input, count, budget);
				remainingSearchTime(budget);
				const output = formatWebSearchOutput(input.query, results, count, maxBytes);
				remainingSearchTime(budget);
				return { content: [{ type: "text", text: output.content }], details: output.details };
			} catch (error) {
				budget.signal.throwIfAborted();
				throw error;
			} finally {
				budget.dispose();
			}
		},
		...webSearchRenderers,
	};
}

export function createWebSearchTool(options?: WebSearchToolOptions): AgentTool<typeof webSearchSchema> {
	return wrapToolDefinition(createWebSearchToolDefinition(options));
}
