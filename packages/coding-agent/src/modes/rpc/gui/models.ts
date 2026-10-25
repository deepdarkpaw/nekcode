/**
 * Model commands: the model catalog, remote model discovery per API, and a real request test.
 *
 * Discovery uses the same URL and header rules as the requests nek sends: an OpenAI-compatible base URL
 * serves `/models`, an Anthropic base URL serves `/v1/models` (the SDK adds `/v1/messages`), and a Google
 * base URL already carries its version, so it serves `/models`. Failures are data, not RPC errors, so the GUI
 * can show 401/403/404.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { AuthStorage } from "../../../core/auth-storage.ts";
import { ModelRuntime } from "../../../core/model-runtime.ts";
import { InMemoryCodingAgentModelsStore } from "../../../core/models-store.ts";
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "../../../core/resolve-config-value.ts";
import type { GuiContext } from "./context.ts";
import type {
	RpcCatalogModel,
	RpcFetchModelsResult,
	RpcProviderDraft,
	RpcRemoteModel,
	RpcTestProviderResult,
	RpcThinkingLevel,
} from "./protocol.ts";
import { errorMessage } from "./response.ts";

const LIST_TIMEOUT_MS = 15_000;
const TEST_TIMEOUT_MS = 30_000;
const MAX_PAGES = 20;
const MAX_MODELS = 2000;
const PAGE_SIZE = 1000;

/** Provider id of the temporary runtime that tests a draft endpoint. */
const DRAFT_PROVIDER_ID = "gui-draft";

/** Remote list path per API, matching where the request path puts `/messages` or `/models`. */
function modelsPathFor(api: string): string | undefined {
	switch (api) {
		case "openai-completions":
		case "openai-responses":
		case "google-generative-ai":
			return "/models";
		case "anthropic-messages":
			return "/v1/models";
		default:
			return undefined;
	}
}

function trimTrailingSlashes(value: string): string {
	return value.replace(/\/+$/u, "");
}

/** The catalog nek knows about: built-in models plus models.json entries, with their thinking levels. */
export function getModelCatalog(ctx: GuiContext, provider?: string, ids?: string[]): RpcCatalogModel[] {
	const wanted = ids === undefined ? undefined : new Set(ids);
	return ctx.modelRuntime
		.getModels(provider)
		.filter((model) => wanted === undefined || wanted.has(model.id))
		.map((model) => {
			const entry: RpcCatalogModel = {
				provider: model.provider,
				id: model.id,
				name: model.name,
				api: model.api,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				reasoning: model.reasoning,
				thinkingLevels: getSupportedThinkingLevels(model) as RpcThinkingLevel[],
				input: [...model.input],
			};
			return {
				...entry,
				...(model.thinkingLevelMap === undefined
					? {}
					: { thinkingLevelMap: model.thinkingLevelMap as RpcCatalogModel["thinkingLevelMap"] }),
				...(model.cost === undefined ? {} : { cost: { ...model.cost } }),
			};
		});
}

/** Everything needed to call an endpoint's model list. */
interface ResolvedEndpoint {
	api: string;
	baseUrl: string;
	apiKey?: string;
	headers: Record<string, string>;
	/** Whether the API key becomes an Authorization header (OpenAI-compatible APIs). */
	authHeader: boolean;
}

function resolveDraft(draft: RpcProviderDraft): ResolvedEndpoint {
	const baseUrl = draft.baseUrl.trim();
	if (!URL.canParse(baseUrl)) throw new Error(`Invalid base URL: ${draft.baseUrl}`);
	const endpoint: ResolvedEndpoint = {
		api: draft.api,
		baseUrl,
		headers: resolveHeadersOrThrow(draft.headers, "Provider") ?? {},
		authHeader: draft.authHeader ?? true,
	};
	if (draft.apiKey === undefined || draft.apiKey === "") return endpoint;
	return { ...endpoint, apiKey: resolveConfigValueOrThrow(draft.apiKey, "API key") };
}

async function resolveProviderEndpoint(ctx: GuiContext, providerId: string): Promise<ResolvedEndpoint> {
	const provider = ctx.modelRuntime.getProvider(providerId);
	if (!provider) throw new Error(`Unknown provider: ${providerId}`);
	const api = provider.getModels()[0]?.api;
	if (api === undefined) throw new Error(`Provider ${providerId} does not declare a model API`);
	const auth = await ctx.modelRuntime.getAuth(providerId);
	if (!auth) throw new Error(`Provider ${providerId} has no configured credentials`);
	const baseUrl = auth.auth.baseUrl ?? provider.baseUrl;
	if (baseUrl === undefined) throw new Error(`Provider ${providerId} does not declare a base URL`);
	const endpoint: ResolvedEndpoint = {
		api,
		baseUrl,
		headers: { ...(auth.auth.headers as Record<string, string> | undefined) },
		authHeader: true,
	};
	return auth.auth.apiKey === undefined ? endpoint : { ...endpoint, apiKey: auth.auth.apiKey };
}

/** Request headers of a model list: the API's own auth header plus any configured headers. */
function listHeaders(endpoint: ResolvedEndpoint): Record<string, string> {
	const headers: Record<string, string> = { Accept: "application/json", ...endpoint.headers };
	const hasAuthorization = Object.keys(headers).some((name) => name.toLowerCase() === "authorization");
	if (endpoint.apiKey !== undefined && !hasAuthorization && endpoint.authHeader) {
		if (endpoint.api === "anthropic-messages") headers["x-api-key"] = endpoint.apiKey;
		else if (endpoint.api === "google-generative-ai") headers["x-goog-api-key"] = endpoint.apiKey;
		else headers.Authorization = `Bearer ${endpoint.apiKey}`;
	}
	if (endpoint.api === "anthropic-messages") headers["anthropic-version"] ??= "2023-06-01";
	return headers;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nestedNumber(record: Record<string, unknown>, path: string[]): number | undefined {
	let current: unknown = record;
	for (const key of path) {
		if (!isRecord(current)) return undefined;
		current = current[key];
	}
	return asNumber(current);
}

function firstNumber(record: Record<string, unknown>, paths: string[][]): number | undefined {
	for (const path of paths) {
		const value = nestedNumber(record, path);
		if (value !== undefined) return value;
	}
	return undefined;
}

function hasImageInput(record: Record<string, unknown>): boolean {
	const modalities = record.architecture;
	if (!isRecord(modalities)) return false;
	const input = modalities.input_modalities;
	return Array.isArray(input) && input.includes("image");
}

/** OpenAI-compatible entry: only extension fields can describe limits and capabilities. */
function parseOpenAIModel(record: Record<string, unknown>): RpcRemoteModel | undefined {
	const id = asString(record.id) ?? asString(record.name);
	if (id === undefined) return undefined;
	const reasoning = typeof record.reasoning === "boolean" ? record.reasoning : undefined;
	const model: RpcRemoteModel = { id };
	const name = asString(record.name) ?? asString(record.display_name);
	if (name !== undefined) model.name = name;
	const contextWindow = firstNumber(record, [
		["context_length"],
		["context_window"],
		["max_model_len"],
		["top_provider", "context_length"],
	]);
	if (contextWindow !== undefined) model.contextWindow = contextWindow;
	const maxTokens = firstNumber(record, [
		["max_completion_tokens"],
		["max_output_tokens"],
		["top_provider", "max_completion_tokens"],
	]);
	if (maxTokens !== undefined) model.maxTokens = maxTokens;
	if (reasoning !== undefined) model.reasoning = reasoning;
	if (hasImageInput(record)) model.input = ["text", "image"];
	return model;
}

function capabilitySupported(value: unknown): boolean | undefined {
	return isRecord(value) && typeof value.supported === "boolean" ? value.supported : undefined;
}

/**
 * Anthropic thinking levels from the model's capabilities: effort levels when the model supports them, the
 * plain extended-thinking levels otherwise, and `off` alone when thinking is unsupported.
 */
function anthropicThinkingLevels(capabilities: unknown): RpcThinkingLevel[] {
	if (!isRecord(capabilities) || capabilitySupported(capabilities.thinking) !== true) return ["off"];
	const effort = capabilities.effort;
	if (!isRecord(effort) || effort.supported !== true) return ["off", "low", "medium", "high"];
	const levels: RpcThinkingLevel[] = ["off"];
	for (const level of ["low", "medium", "high", "xhigh", "max"] as const) {
		const supported = effort[level] === undefined ? true : capabilitySupported(effort[level]) !== false;
		if (supported) levels.push(level);
	}
	return levels;
}

/** Anthropic model entry: token limits and thinking/effort capabilities are authoritative. */
function parseAnthropicModel(record: Record<string, unknown>): RpcRemoteModel | undefined {
	const id = asString(record.id);
	if (id === undefined) return undefined;
	const model: RpcRemoteModel = { id, thinkingLevels: anthropicThinkingLevels(record.capabilities) };
	const name = asString(record.display_name);
	if (name !== undefined) model.name = name;
	const contextWindow = asNumber(record.max_input_tokens);
	if (contextWindow !== undefined) model.contextWindow = contextWindow;
	const maxTokens = asNumber(record.max_tokens);
	if (maxTokens !== undefined) model.maxTokens = maxTokens;
	if (isRecord(record.capabilities)) {
		model.reasoning = capabilitySupported(record.capabilities.thinking) === true;
		if (capabilitySupported(record.capabilities.image_input) === true) model.input = ["text", "image"];
	}
	return model;
}

/** Google thinking levels: any level up to `high` when the model thinks, `off` alone otherwise. */
function googleThinkingLevels(thinking: unknown): RpcThinkingLevel[] {
	return thinking === true ? ["off", "low", "medium", "high"] : ["off"];
}

/** Gemini model entry; `name` carries a `models/` prefix that the id does not have. */
function parseGoogleModel(record: Record<string, unknown>): RpcRemoteModel | undefined {
	const name = asString(record.name);
	if (name === undefined) return undefined;
	const methods = record.supportedGenerationMethods;
	if (Array.isArray(methods) && !methods.includes("generateContent")) return undefined;
	const thinking = record.thinking === true;
	const model: RpcRemoteModel = {
		id: name.replace(/^models\//u, ""),
		reasoning: thinking,
		thinkingLevels: googleThinkingLevels(thinking),
	};
	const displayName = asString(record.displayName);
	if (displayName !== undefined) model.name = displayName;
	const contextWindow = asNumber(record.inputTokenLimit);
	if (contextWindow !== undefined) model.contextWindow = contextWindow;
	const maxTokens = asNumber(record.outputTokenLimit);
	if (maxTokens !== undefined) model.maxTokens = maxTokens;
	return model;
}

interface ModelPage {
	models: RpcRemoteModel[];
	/** Cursor of the next page; absent on the last page. */
	next?: string;
}

function parsePage(api: string, body: unknown): ModelPage {
	if (!isRecord(body)) return { models: [] };
	if (api === "google-generative-ai") {
		const list = Array.isArray(body.models) ? body.models : [];
		return {
			models: list.flatMap((entry) => (isRecord(entry) ? (parseGoogleModel(entry) ?? []) : [])),
			next: asString(body.nextPageToken),
		};
	}
	const list = Array.isArray(body.data) ? body.data : [];
	const parse = api === "anthropic-messages" ? parseAnthropicModel : parseOpenAIModel;
	const models = list.flatMap((entry) => (isRecord(entry) ? (parse(entry) ?? []) : []));
	return { models, next: api === "anthropic-messages" && body.has_more === true ? asString(body.last_id) : undefined };
}

/** HTTP status text plus the provider's error message, when it sent one. */
async function httpErrorMessage(response: Response): Promise<string> {
	let detail = "";
	try {
		const text = await response.text();
		const parsed: unknown = text ? JSON.parse(text) : undefined;
		if (isRecord(parsed)) {
			const error = parsed.error;
			if (isRecord(error)) detail = asString(error.message) ?? "";
			else detail = asString(parsed.message) ?? "";
		}
		detail ||= text.slice(0, 300);
	} catch {
		detail = "";
	}
	const status = `${response.status} ${response.statusText}`.trim();
	return detail ? `${status}: ${detail}` : status;
}

/** Fetch the model list of an endpoint, following pagination up to the page and model caps. */
async function fetchModels(api: string, endpoint: ResolvedEndpoint): Promise<RpcFetchModelsResult> {
	const path = modelsPathFor(api);
	const base = trimTrailingSlashes(endpoint.baseUrl);
	if (path === undefined) {
		return { ok: false, endpoint: base, message: `Model listing is not supported for the ${api} API` };
	}
	const url = `${base}${path}`;
	const signal = AbortSignal.timeout(LIST_TIMEOUT_MS);
	const headers = listHeaders(endpoint);
	const models: RpcRemoteModel[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < MAX_PAGES; page++) {
		const pageUrl = new URL(url);
		if (api === "google-generative-ai") {
			pageUrl.searchParams.set("pageSize", String(PAGE_SIZE));
			if (cursor !== undefined) pageUrl.searchParams.set("pageToken", cursor);
		}
		if (api === "anthropic-messages") {
			pageUrl.searchParams.set("limit", String(Math.min(PAGE_SIZE, MAX_MODELS)));
			if (cursor !== undefined) pageUrl.searchParams.set("after_id", cursor);
		}
		let response: Response;
		try {
			response = await fetch(pageUrl, { headers, signal });
		} catch (error: unknown) {
			return { ok: false, endpoint: url, message: errorMessage(error) };
		}
		if (!response.ok) {
			return { ok: false, endpoint: url, status: response.status, message: await httpErrorMessage(response) };
		}
		let body: unknown;
		try {
			body = await response.json();
		} catch (error: unknown) {
			return { ok: false, endpoint: url, status: response.status, message: errorMessage(error) };
		}
		const parsed = parsePage(api, body);
		models.push(...parsed.models);
		if (models.length >= MAX_MODELS) {
			models.length = MAX_MODELS;
			return { ok: true, endpoint: url, models };
		}
		if (parsed.next === undefined || parsed.models.length === 0) return { ok: true, endpoint: url, models };
		cursor = parsed.next;
	}
	return { ok: true, endpoint: url, models };
}

/** Discover the models an endpoint serves, either from a configured provider or from a draft. */
export async function fetchProviderModels(
	ctx: GuiContext,
	command: { provider?: string; draft?: RpcProviderDraft },
): Promise<RpcFetchModelsResult> {
	if (command.draft) return await fetchModels(command.draft.api, resolveDraft(command.draft));
	if (command.provider === undefined) throw new Error("fetch_provider_models needs a provider or a draft");
	const endpoint = await resolveProviderEndpoint(ctx, command.provider);
	return await fetchModels(endpoint.api, endpoint);
}

/** A one-message request that any chat endpoint can answer. */
function testContext(): Context {
	return {
		messages: [{ role: "user", content: [{ type: "text", text: "ping" }], timestamp: Date.now() }],
	};
}

interface TestOutcome {
	status?: number;
	error?: Error;
}

/** Run one minimal completion and report its latency or failure. */
async function runTest(runtime: ModelRuntime, model: Model<Api>): Promise<RpcTestProviderResult> {
	const signal = AbortSignal.timeout(TEST_TIMEOUT_MS);
	const outcome: TestOutcome = {};
	const started = Date.now();
	let message: Awaited<ReturnType<ModelRuntime["complete"]>>;
	try {
		message = await runtime.complete(model, testContext(), {
			signal,
			maxTokens: 1,
			onResponse: (response) => {
				outcome.status = response.status;
			},
		});
	} catch (error: unknown) {
		return { ok: false, status: outcome.status, message: errorMessage(error) };
	}
	if (message.stopReason === "error") {
		return { ok: false, status: outcome.status, message: message.errorMessage ?? "Provider request failed" };
	}
	return { ok: true, latencyMs: Date.now() - started };
}

/** A model object for an id that the catalog does not know. */
function synthesizeModel(provider: string, modelId: string, api: string, baseUrl: string): Model<Api> {
	return {
		id: modelId,
		name: modelId,
		provider,
		api: api as Api,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	};
}

/** Test a model of a configured provider through the live runtime, so its auth and base URL apply. */
async function testConfiguredProvider(
	ctx: GuiContext,
	providerId: string,
	modelId: string,
): Promise<RpcTestProviderResult> {
	const provider = ctx.modelRuntime.getProvider(providerId);
	if (!provider) throw new Error(`Unknown provider: ${providerId}`);
	const known = ctx.modelRuntime.getModel(providerId, modelId);
	if (known) return await runTest(ctx.modelRuntime, known);
	const api = provider.getModels()[0]?.api;
	if (api === undefined) throw new Error(`Provider ${providerId} does not declare a model API`);
	const baseUrl = provider.baseUrl;
	if (baseUrl === undefined) throw new Error(`Provider ${providerId} does not declare a base URL`);
	return await runTest(ctx.modelRuntime, synthesizeModel(providerId, modelId, api, baseUrl));
}

/**
 * Test a draft endpoint: write it as a models.json provider, load a throwaway runtime, and send one request.
 * The draft's `apiKey` reaches nek's `$ENV`/`!cmd` resolution exactly as it would from models.json.
 */
async function testDraft(draft: RpcProviderDraft, modelId: string): Promise<RpcTestProviderResult> {
	if (!URL.canParse(draft.baseUrl)) throw new Error(`Invalid base URL: ${draft.baseUrl}`);
	const directory = mkdtempSync(join(tmpdir(), "nek-gui-test-"));
	const modelsPath = join(directory, "models.json");
	const provider: Record<string, unknown> = {
		name: "GUI test endpoint",
		baseUrl: draft.baseUrl,
		api: draft.api,
		models: [
			{
				id: modelId,
				name: modelId,
				contextWindow: 128_000,
				maxTokens: 4096,
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		],
	};
	if (draft.apiKey !== undefined && draft.apiKey !== "") provider.apiKey = draft.apiKey;
	if (draft.headers !== undefined) provider.headers = draft.headers;
	if (draft.authHeader !== undefined) provider.authHeader = draft.authHeader;
	writeFileSync(modelsPath, JSON.stringify({ providers: { [DRAFT_PROVIDER_ID]: provider } }));
	try {
		const runtime = await ModelRuntime.create({
			credentials: AuthStorage.inMemory(),
			modelsPath,
			modelsStore: new InMemoryCodingAgentModelsStore(),
			refreshOnCreate: false,
		});
		const model = runtime.getModel(DRAFT_PROVIDER_ID, modelId);
		if (!model) return { ok: false, message: `Draft endpoint did not produce model ${modelId}` };
		return await runTest(runtime, model);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

/** Send one minimal request to a provider or draft endpoint. */
export async function testProvider(
	ctx: GuiContext,
	command: { modelId: string; provider?: string; draft?: RpcProviderDraft },
): Promise<RpcTestProviderResult> {
	if (command.draft) return await testDraft(command.draft, command.modelId);
	if (command.provider === undefined) throw new Error("test_provider needs a provider or a draft");
	return await testConfiguredProvider(ctx, command.provider, command.modelId);
}
