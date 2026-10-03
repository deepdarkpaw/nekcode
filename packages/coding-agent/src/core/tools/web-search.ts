import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
	type CallToolResult,
	McpClient,
	McpConnectionClosedError,
	type McpFetch,
	McpHttpError,
	McpSessionExpiredError,
	type McpTransport,
	StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import { type Static, Type } from "typebox";
import { APP_NAME, VERSION } from "../../config.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";
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
	fetch?: McpFetch;
	/** New transport for each connection, including a retry. Useful for offline testing. */
	createTransport?: (endpoint: string) => McpTransport;
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

function responseText(result: CallToolResult): string {
	const text = result.content
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("\n");
	if (result.isError) throw new Error(text || "Exa web search failed.");
	if (!text) throw new Error("Exa web search returned no results.");
	return text;
}

function isConnectionFailure(error: unknown, client: McpClient | undefined): boolean {
	if (error instanceof McpConnectionClosedError || error instanceof McpSessionExpiredError) return true;
	if (error instanceof McpHttpError) return error.status === 408 || error.status === 429 || error.status >= 500;
	if (error instanceof TypeError) return true;
	return client?.connectionState === "closed";
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
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const createTransport =
		options.createTransport ??
		((url: string) => new StreamableHttpTransport({ url, fetch: options.fetch, openGetStream: false }));
	let client: McpClient | undefined;
	let opening: { client: McpClient; ready: Promise<McpClient>; waiters: number } | undefined;
	const getClient = async (signal: AbortSignal): Promise<McpClient> => {
		signal.throwIfAborted();
		if (client?.connectionState === "connected") return client;
		if (!opening) {
			const next = new McpClient({ name: APP_NAME, version: VERSION, requestTimeoutMs: timeoutMs });
			const state = { client: next, ready: Promise.resolve(next), waiters: 0 };
			state.ready = next
				.connect(createTransport(endpoint))
				.then(() => {
					if (opening === state) client = next;
					return next;
				})
				.finally(() => {
					if (opening === state) opening = undefined;
				});
			opening = state;
		}
		const state = opening;
		state.waiters++;
		try {
			return await raceWithAbortSignal(state.ready, signal);
		} finally {
			state.waiters--;
			if (signal.aborted && state.waiters === 0 && opening === state) {
				opening = undefined;
				void state.client.close();
			}
		}
	};
	return {
		name: "web_search",
		label: "web_search",
		description:
			"Search the public web for current information. Include a Sources section with links in the final answer.",
		promptSnippet: webSearchToolSystemPromptContribution.snippet,
		exposure: "direct",
		parameters: webSearchSchema,
		async execute(_toolCallId, input, signal) {
			const combinedSignal = signal
				? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
				: AbortSignal.timeout(timeoutMs);
			let raw = "";
			for (let attempt = 0; ; attempt++) {
				let current: McpClient | undefined;
				try {
					current = await getClient(combinedSignal);
					const result = await current.callTool(
						"web_search_exa",
						{
							query: input.query,
							objective: input.objective ?? input.query,
							numResults: input.num_results ?? DEFAULT_RESULTS,
						},
						{ signal: combinedSignal, timeoutMs },
					);
					raw = responseText(result);
					break;
				} catch (error) {
					combinedSignal.throwIfAborted();
					if (attempt > 0 || !isConnectionFailure(error, current)) throw error;
					if (current) {
						if (client === current) client = undefined;
						await raceWithAbortSignal(current.close(), combinedSignal);
					}
				}
			}
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
