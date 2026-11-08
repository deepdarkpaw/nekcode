import { setTimeout as delay } from "node:timers/promises";
import type { McpFetch } from "@earendil-works/pi-mcp";
import { raceWithAbortSignal } from "../../utils/abort.ts";

export const WEB_SEARCH_TIMEOUT_MS = 25_000;
export const WEB_SEARCH_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_ATTEMPTS = 3;

export interface SearchBudget {
	signal: AbortSignal;
	deadline: number;
}

export class SearchBudgetError extends Error {}
export class SearchResponseError extends Error {}

/** One deadline covers credentials, connection setup, response reads, and all retry delays. */
export function createSearchBudget(
	timeoutMs: number,
	signal?: AbortSignal,
): SearchBudget & { dispose(): void; cancel(): void } {
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new SearchBudgetError("Web search exceeded its total time budget.")),
		timeoutMs,
	);
	timeout.unref();
	return {
		signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
		deadline: Date.now() + timeoutMs,
		dispose: () => clearTimeout(timeout),
		cancel: () => controller.abort(new Error("Web search was cancelled.")),
	};
}

export function remainingSearchTime(budget: SearchBudget): number {
	budget.signal.throwIfAborted();
	const remaining = budget.deadline - Date.now();
	if (remaining <= 0) throw new SearchBudgetError("Web search exceeded its total time budget.");
	return remaining;
}

/** Retry-After is a minimum, never shortened to fit the deadline. */
export async function waitForSearchRetry(budget: SearchBudget, attempt: number, retryAfterMs = 0): Promise<void> {
	const waitMs = Math.max(Math.min(250 * 2 ** attempt, 2_000), retryAfterMs);
	if (waitMs >= remainingSearchTime(budget)) {
		throw new SearchBudgetError("Web search retry delay exceeds its remaining total time budget.");
	}
	await delay(waitMs, undefined, { signal: budget.signal });
}

export function parseSearchRetryAfter(value: string | null): number {
	if (!value) return 0;
	if (/^\s*\d+(?:\.\d+)?\s*$/.test(value)) return Number(value) * 1_000;
	const date = Date.parse(value);
	return Number.isNaN(date) ? 0 : Math.max(0, date - Date.now());
}

/** Fixed messages deliberately exclude provider bodies, endpoint URLs, and fetch error messages. */
export class SearchHttpError extends Error {
	readonly status: number;

	constructor(provider: string, status: number) {
		const hint = status === 429 ? " (rate limited)" : status === 401 || status === 403 ? " (check API key)" : "";
		super(`${provider} web search HTTP ${status}${hint}.`);
		this.name = "SearchHttpError";
		this.status = status;
	}
}

export class SearchConnectionError extends Error {
	constructor(provider: string) {
		super(`${provider} web search connection failed.`);
		this.name = "SearchConnectionError";
	}
}

function discardResponse(response: Response): void {
	void response.body?.cancel().catch(() => {});
}

/** Count decompressed bytes while reading, including chunked responses with no Content-Length. */
async function readSearchBody(response: Response, budget: SearchBudget): Promise<Uint8Array> {
	const length = Number(response.headers.get("content-length"));
	if (length > WEB_SEARCH_MAX_RESPONSE_BYTES) {
		discardResponse(response);
		throw new SearchResponseError("Web search response exceeds the 2 MB size limit.");
	}
	if (!response.body) return new Uint8Array();
	const reader = response.body.getReader();
	const bytes = new Uint8Array(WEB_SEARCH_MAX_RESPONSE_BYTES);
	let size = 0;
	try {
		for (;;) {
			remainingSearchTime(budget);
			const { done, value } = await raceWithAbortSignal(reader.read(), budget.signal);
			if (done) break;
			if (size + value.byteLength > WEB_SEARCH_MAX_RESPONSE_BYTES)
				throw new SearchResponseError("Web search response exceeds the 2 MB size limit.");
			bytes.set(value, size);
			size += value.byteLength;
		}
		return bytes.slice(0, size);
	} finally {
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/** Bounded, cancellable fetch shared by Tavily JSON and the Exa MCP transport. */
export async function fetchSearchResponse(
	fetch: McpFetch,
	url: string | URL,
	init: RequestInit,
	budget: SearchBudget,
	provider: string,
): Promise<Response> {
	const signal = init.signal ? AbortSignal.any([init.signal, budget.signal]) : budget.signal;
	const requestBudget = { ...budget, signal };
	for (let attempt = 0; ; attempt++) {
		remainingSearchTime(requestBudget);
		let response: Response;
		try {
			const pending = fetch(url, { ...init, signal, redirect: "error" });
			// Also dispose a late response from an injected fetch that ignores cancellation.
			void pending.then(
				(late) => {
					if (signal.aborted) discardResponse(late);
				},
				() => {},
			);
			response = await raceWithAbortSignal(pending, signal);
		} catch (error) {
			remainingSearchTime(requestBudget);
			if (!(error instanceof TypeError)) throw new SearchConnectionError(provider);
			if (attempt >= MAX_ATTEMPTS - 1) throw new SearchConnectionError(provider);
			await waitForSearchRetry(requestBudget, attempt);
			continue;
		}
		if (!response.ok) {
			const retryAfterMs = parseSearchRetryAfter(response.headers.get("retry-after"));
			discardResponse(response);
			// Preserve MCP's session-expiry classification, without handing it an unsafe error body.
			if (provider === "Exa" && response.status === 404) {
				return new Response(null, { status: 404, headers: response.headers });
			}
			const retryable = response.status === 429 || response.status === 408 || response.status >= 500;
			if (!retryable || attempt >= MAX_ATTEMPTS - 1) throw new SearchHttpError(provider, response.status);
			await waitForSearchRetry(requestBudget, attempt, retryAfterMs);
			continue;
		}
		const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
		if (provider === "Exa" && mimeType === "text/event-stream") {
			// MCP consumes SSE incrementally and enforces its 2 MB event limit. A completed result must
			// not wait for EOF: Streamable HTTP servers may keep the response open after replying.
			remainingSearchTime(requestBudget);
			return response;
		}
		try {
			const bytes = await readSearchBody(response, requestBudget);
			remainingSearchTime(requestBudget);
			// A bounded in-memory response prevents MCP's response.json() from buffering without a limit.
			return new Response(bytes.byteLength ? bytes : null, {
				status: response.status,
				headers: response.headers,
			});
		} catch (error) {
			remainingSearchTime(requestBudget);
			if (error instanceof SearchResponseError) throw error;
			if (attempt >= MAX_ATTEMPTS - 1) throw new SearchConnectionError(provider);
			await waitForSearchRetry(requestBudget, attempt);
		}
	}
}
