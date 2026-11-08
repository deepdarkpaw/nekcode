import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import {
	type CallToolResult,
	McpClient,
	McpConnectionClosedError,
	McpHttpError,
	McpSessionExpiredError,
	StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import { APP_NAME, VERSION } from "../../config.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import { getShellConfig } from "../../utils/shell.ts";
import { resolveConfigValueOrThrow } from "../resolve-config-value.ts";
import type { WebSearchResult, WebSearchToolInput, WebSearchToolOptions } from "./web-search.ts";
import {
	createSearchBudget,
	fetchSearchResponse,
	remainingSearchTime,
	type SearchBudget,
	SearchBudgetError,
	SearchConnectionError,
	SearchHttpError,
	SearchResponseError,
	WEB_SEARCH_MAX_RESPONSE_BYTES,
	waitForSearchRetry,
} from "./web-search-http.ts";

export type WebSearchProvider = "tavily" | "exa";
export const WEB_SEARCH_ENDPOINTS: Readonly<Record<WebSearchProvider, string>> = {
	tavily: "https://api.tavily.com/search",
	exa: "https://mcp.exa.ai/mcp",
};
const requestBudgets = new AsyncLocalStorage<SearchBudget>();

class SearchConfigError extends Error {}

export class SearchOutputError extends Error {
	constructor(provider: string, reason: string) {
		super(`${provider} web search returned invalid output: ${reason}.`);
		this.name = "SearchOutputError";
	}
}

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function resultString(value: unknown, field: string, provider: string, maxBytes: number): string {
	if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > maxBytes) {
		throw new SearchOutputError(provider, `invalid ${field}`);
	}
	return value;
}

/** Keep complete source identities; reject oversized or non-HTTP source URLs rather than cutting them. */
function resultIdentity(value: unknown, provider: string): WebSearchResult {
	if (!record(value)) throw new SearchOutputError(provider, "expected a result object");
	const title = resultString(value.title, "result title", provider, 2_048);
	const url = resultString(value.url, "result URL", provider, 8_192);
	if (!URL.canParse(url) || !["https:", "http:"].includes(new URL(url).protocol)) {
		throw new SearchOutputError(provider, "invalid result URL");
	}
	return { title, url };
}

function optionalString(value: unknown, field: string, provider: string): string | undefined {
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") throw new SearchOutputError(provider, `invalid ${field}`);
	return value || undefined;
}

function parseJsonResults(value: unknown, provider: WebSearchProvider): WebSearchResult[] {
	const name = provider === "tavily" ? "Tavily" : "Exa";
	if (!record(value) || !Array.isArray(value.results)) throw new SearchOutputError(name, "expected a results array");
	if (value.error !== undefined && value.error !== null)
		throw new SearchOutputError(name, "the provider reported an error");
	if (value.results.length > 20) throw new SearchOutputError(name, "too many results");
	return value.results.map((item: unknown) => {
		const identity = resultIdentity(item, name);
		if (!record(item)) throw new SearchOutputError(name, "expected a result object");
		const published = optionalString(item.published_date ?? item.publishedDate, "published date", name);
		const author = optionalString(item.author, "author", name);
		let highlights: string | undefined;
		if (provider === "tavily") {
			if (typeof item.content !== "string") throw new SearchOutputError(name, "expected result content");
			highlights = item.content;
		} else if (Array.isArray(item.highlights)) {
			if (!item.highlights.every((highlight: unknown) => typeof highlight === "string")) {
				throw new SearchOutputError(name, "invalid highlights");
			}
			highlights = item.highlights.join("\n");
		} else {
			highlights = optionalString(item.highlights ?? item.text, "highlights", name);
		}
		return {
			...identity,
			...(published ? { published } : {}),
			...(author ? { author } : {}),
			...(highlights ? { highlights } : {}),
		};
	});
}

/** Exa MCP also returns text blocks. Accept CRLF, but never confuse unknown output with an empty search. */
export function parseWebSearchResults(text: string): WebSearchResult[] {
	if (Buffer.byteLength(text) > WEB_SEARCH_MAX_RESPONSE_BYTES)
		throw new SearchOutputError("Exa", "response exceeds 2 MB");
	const normalized = text.replace(/\r\n?/g, "\n").trim();
	if (/^No (?:web search |search )?results(?: found)?\.?(?: Please try a different query\.)?$/i.test(normalized))
		return [];
	if (!normalized) throw new SearchOutputError("Exa", "missing search results");
	const blocks = normalized.split(/\n[\t ]*---[\t ]*\n/g);
	if (blocks.length > 20) throw new SearchOutputError("Exa", "too many results");
	return blocks.map((block) => {
		const title = block.match(/^Title:[\t ]*(.+)$/m)?.[1]?.trim();
		const url = block.match(/^URL:[\t ]*(\S+)[\t ]*$/m)?.[1];
		const identity = resultIdentity({ title, url }, "Exa");
		const published = block.match(/^Published(?: Date)?:[\t ]*(.+)$/im)?.[1]?.trim();
		const author = block.match(/^Author:[\t ]*(.+)$/m)?.[1]?.trim();
		const highlights = block.match(/^(?:Highlights|Text|Content):[\t ]*([\s\S]*)$/m)?.[1]?.trim();
		return {
			...identity,
			...(published ? { published } : {}),
			...(author ? { author } : {}),
			...(highlights ? { highlights } : {}),
		};
	});
}

function exaResponse(result: CallToolResult): WebSearchResult[] {
	if (result.isError !== undefined && typeof result.isError !== "boolean")
		throw new SearchOutputError("Exa", "invalid error flag");
	if (result.isError) throw new SearchOutputError("Exa", "the search tool reported an error");
	if (result.structuredContent !== undefined) return parseJsonResults(result.structuredContent, "exa");
	const texts: string[] = [];
	let bytes = 0;
	for (const block of result.content) {
		if (!record(block) || typeof block.type !== "string") throw new SearchOutputError("Exa", "invalid content block");
		if (block.type !== "text") continue;
		if (typeof block.text !== "string") throw new SearchOutputError("Exa", "invalid text block");
		bytes += Buffer.byteLength(block.text) + 1;
		if (bytes > WEB_SEARCH_MAX_RESPONSE_BYTES) throw new SearchOutputError("Exa", "response exceeds 2 MB");
		texts.push(block.text);
	}
	return parseWebSearchResults(texts.join("\n"));
}

/** Match existing !command syntax without blocking cancellation or buffering unlimited credential output. */
async function commandKey(config: string, budget: SearchBudget): Promise<string> {
	const { shell, args, commandTransport } = getShellConfig();
	const command = config.slice(1);
	const fromStdin = commandTransport === "stdin";
	const commandBudget = createSearchBudget(Math.min(10_000, remainingSearchTime(budget)), budget.signal);
	try {
		return await new Promise<string>((resolve, reject) => {
			const child = spawn(shell, fromStdin ? args : [...args, command], {
				signal: commandBudget.signal,
				killSignal: "SIGKILL",
				stdio: [fromStdin ? "pipe" : "ignore", "pipe", "ignore"],
				windowsHide: true,
			});
			let output = "";
			let bytes = 0;
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => {
				bytes += Buffer.byteLength(chunk);
				if (bytes > 8_192) {
					child.kill("SIGKILL");
					reject(new SearchConfigError("Web search credential command output exceeds 8 KB."));
					return;
				}
				output += chunk;
			});
			child.once("error", reject);
			child.once("close", (code) => {
				if (code !== 0 || !output.trim()) {
					reject(new SearchConfigError("Web search credential command failed."));
					return;
				}
				resolve(output.trim());
			});
			child.stdin?.on("error", reject);
			child.stdin?.end(command);
		});
	} finally {
		commandBudget.dispose();
	}
}

/** Credentials are resolved only on a search, never during tool construction or settings inspection. */
async function searchHeaders(
	options: WebSearchToolOptions,
	provider: WebSearchProvider,
	budget: SearchBudget,
): Promise<Record<string, string>> {
	let key: string | undefined;
	try {
		key =
			options.apiKey === undefined
				? provider === "tavily"
					? process.env.TAVILY_API_KEY || undefined
					: undefined
				: options.apiKey.startsWith("!")
					? await commandKey(options.apiKey, budget)
					: resolveConfigValueOrThrow(options.apiKey, "web search API key");
	} catch {
		remainingSearchTime(budget);
		throw new SearchConfigError(
			`Failed to resolve ${provider === "tavily" ? "Tavily" : "Exa"} web search API key; check webSearch.apiKey.`,
		);
	}
	if (key !== undefined && (!key.trim() || Buffer.byteLength(key) > 8_192 || /[\r\n]/.test(key)))
		throw new SearchConfigError("Invalid web search API key; check webSearch.apiKey.");
	if (provider === "tavily") {
		if (!key)
			throw new SearchConfigError(
				"Tavily web search requires an API key. Set webSearch.apiKey or TAVILY_API_KEY; no provider fallback is used.",
			);
		return { Authorization: `Bearer ${key}` };
	}
	return key ? { "x-api-key": key } : {};
}

/** The tools query parameter enables native Exa domain filters; credentials only travel in headers. */
function searchEndpoint(options: WebSearchToolOptions, provider: WebSearchProvider): string {
	let url: URL;
	try {
		url = new URL(options.endpoint ?? WEB_SEARCH_ENDPOINTS[provider]);
	} catch {
		throw new SearchConfigError("Invalid web search endpoint; expected an HTTP(S) URL.");
	}
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
		throw new SearchConfigError("Invalid web search endpoint; expected an HTTP(S) URL without credentials.");
	const other = provider === "tavily" ? "exa" : "tavily";
	if (url.hostname.replace(/\.$/, "") === new URL(WEB_SEARCH_ENDPOINTS[other]).hostname)
		throw new SearchConfigError(
			"Web search provider does not match the configured endpoint; check webSearch.provider and endpoint.",
		);
	for (const key of url.searchParams.keys()) {
		if (/^(?:(?:(?:exa|tavily)[_-]?)?api[_-]?key|key|(?:access[_-]?|auth[_-]?)?token|authorization)$/i.test(key))
			throw new SearchConfigError("Web search endpoint must not contain API keys; use webSearch.apiKey instead.");
	}
	if (provider === "exa") {
		const tools = new Set(url.searchParams.get("tools")?.split(",").filter(Boolean));
		tools.add("web_search_exa");
		tools.add("web_search_advanced_exa");
		url.searchParams.set("tools", [...tools].join(","));
	}
	return url.href;
}

export type SearchProvider = (
	input: WebSearchToolInput,
	count: number,
	budget: SearchBudget,
) => Promise<WebSearchResult[]>;

export function createTavilySearch(options: WebSearchToolOptions): SearchProvider {
	return async (input, count, budget) => {
		const headers = await searchHeaders(options, "tavily", budget);
		remainingSearchTime(budget);
		const response = await fetchSearchResponse(
			options.fetch ?? globalThis.fetch,
			searchEndpoint(options, "tavily"),
			{
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json", Accept: "application/json" },
				body: JSON.stringify({
					query: input.objective ? `${input.query}\n\nSearch objective: ${input.objective}` : input.query,
					max_results: count,
					search_depth: "basic",
					include_answer: false,
					include_raw_content: false,
					...(input.allowed_domains?.length ? { include_domains: input.allowed_domains } : {}),
					...(input.blocked_domains?.length ? { exclude_domains: input.blocked_domains } : {}),
				}),
			},
			budget,
			"Tavily",
		);
		if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json")
			throw new SearchOutputError("Tavily", "expected application/json");
		let value: unknown;
		try {
			value = await response.json();
		} catch {
			throw new SearchOutputError("Tavily", "malformed JSON");
		}
		return parseJsonResults(value, "tavily");
	};
}

function connectionFailure(error: unknown): boolean {
	return (
		error instanceof McpSessionExpiredError ||
		error instanceof McpConnectionClosedError ||
		error instanceof SearchConnectionError ||
		error instanceof TypeError
	);
}

export function createExaSearch(options: WebSearchToolOptions, timeoutMs: number): SearchProvider {
	let client: McpClient | undefined;
	let opening: { client: McpClient; ready: Promise<McpClient>; waiters: number; cancel(): void } | undefined;
	const getClient = async (budget: SearchBudget): Promise<McpClient> => {
		remainingSearchTime(budget);
		if (client?.connectionState === "connected") return client;
		if (!opening) {
			const connectionBudget = createSearchBudget(remainingSearchTime(budget));
			const next = new McpClient({ name: APP_NAME, version: VERSION, requestTimeoutMs: timeoutMs });
			const state = { client: next, ready: Promise.resolve(next), waiters: 0, cancel: connectionBudget.cancel };
			state.ready = requestBudgets
				.run(connectionBudget, async () => {
					const headers = await searchHeaders(options, "exa", connectionBudget);
					remainingSearchTime(connectionBudget);
					const endpoint = searchEndpoint(options, "exa");
					const transport =
						options.createTransport?.(endpoint, headers) ??
						new StreamableHttpTransport({
							url: endpoint,
							headers,
							openGetStream: false,
							reconnect: { maxRetries: 0 },
							maxMessageBytes: WEB_SEARCH_MAX_RESPONSE_BYTES,
							fetch: (url, init) =>
								fetchSearchResponse(
									options.fetch ?? globalThis.fetch,
									url,
									init ?? {},
									requestBudgets.getStore() ?? connectionBudget,
									"Exa",
								),
						});
					// MCP's HTTP transport otherwise uses only its connection signal, not the request's cancellation.
					const send = transport.send.bind(transport);
					transport.send = (message, sendOptions) => {
						const current = requestBudgets.getStore() ?? connectionBudget;
						const signal = sendOptions?.signal
							? AbortSignal.any([current.signal, sendOptions.signal])
							: current.signal;
						return requestBudgets.run({ ...current, signal }, () => send(message, sendOptions));
					};
					await next.connect(transport);
					if (opening === state) client = next;
					return next;
				})
				.finally(() => {
					connectionBudget.dispose();
					if (opening === state) opening = undefined;
				});
			opening = state;
		}
		const state = opening;
		state.waiters++;
		try {
			return await raceWithAbortSignal(state.ready, budget.signal);
		} finally {
			state.waiters--;
			if (budget.signal.aborted && state.waiters === 0 && opening === state) {
				opening = undefined;
				state.cancel();
				void state.client.close();
			}
		}
	};
	return (input, count, budget) =>
		requestBudgets.run(budget, async () => {
			for (let attempt = 0; ; attempt++) {
				let current: McpClient | undefined;
				try {
					current = await getClient(budget);
					const filtered = Boolean(input.allowed_domains?.length || input.blocked_domains?.length);
					const result = await current.callTool(
						filtered ? "web_search_advanced_exa" : "web_search_exa",
						{
							query: input.query,
							objective: input.objective ?? input.query,
							numResults: count,
							...(input.allowed_domains?.length ? { includeDomains: input.allowed_domains } : {}),
							...(input.blocked_domains?.length ? { excludeDomains: input.blocked_domains } : {}),
						},
						{ signal: budget.signal, timeoutMs: remainingSearchTime(budget) },
					);
					return exaResponse(result);
				} catch (error) {
					remainingSearchTime(budget);
					// Real HTTP 429s are retried by fetchSearchResponse without rebuilding the MCP session.
					if (error instanceof McpHttpError && !(error instanceof McpSessionExpiredError)) {
						if (error.status === 429 && attempt < 2) {
							await waitForSearchRetry(budget, attempt, error.retryAfterMs ?? 0);
							continue;
						}
						throw new SearchHttpError("Exa", error.status);
					}
					if (attempt < 1 && connectionFailure(error)) {
						if (current) {
							if (client === current) client = undefined;
							await raceWithAbortSignal(current.close(), budget.signal);
						}
						await waitForSearchRetry(budget, attempt);
						continue;
					}
					if (
						error instanceof SearchOutputError ||
						error instanceof SearchHttpError ||
						error instanceof SearchConnectionError ||
						error instanceof SearchResponseError ||
						error instanceof SearchBudgetError ||
						error instanceof SearchConfigError
					)
						throw error;
					if (connectionFailure(error)) throw new SearchConnectionError("Exa");
					throw new SearchOutputError("Exa", "MCP request or response failed");
				}
			}
		});
}
