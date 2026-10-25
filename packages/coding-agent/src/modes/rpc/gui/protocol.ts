/**
 * GUI RPC protocol (nek side of `nekcode-gui`'s `gui-rpc.ts` contract).
 *
 * The shapes here are the JSON shapes the desktop GUI consumes. Names carry an `Rpc` prefix to follow
 * this package's RPC naming style; the wire format must stay identical to the shared contract.
 */

import type { McpServerConfig } from "../../../core/mcp-servers.ts";

/** Protocol version: bump on any incompatible change. The GUI requires the exact value. */
export const NEK_GUI_PROTOCOL_VERSION = 1;

/** Thinking levels of a model, matching `ModelThinkingLevel` in pi-ai. */
export const NEK_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type RpcThinkingLevel = (typeof NEK_THINKING_LEVELS)[number];

/** Endpoint APIs the settings UI can create. */
export const NEK_ENDPOINT_APIS = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
	"google-generative-ai",
] as const;

export type RpcEndpointApi = (typeof NEK_ENDPOINT_APIS)[number];

// ============================================================================
// Process and launch
// ============================================================================

/** Output of `nek gui-info --json`. */
export interface RpcGuiInfo {
	protocolVersion: number;
	/** nek version from package.json `nekConfig.version`, e.g. "0.4.0". */
	nekVersion: string;
	/** Base pi version, e.g. "1.0.2". */
	piVersion: string;
	node: { path: string; version: string };
	/** Arguments before the nek arguments: source runs preload the source resolver and the cli entry. */
	launch: { args: string[] };
	/** Source install directory (the one holding `.nek-install-state.json`), omitted when unknown. */
	installDir?: string;
	agentDir: string;
	sessionDir: string;
	platform: string;
	arch: string;
}

/**
 * Two RPC processes:
 * - session process: `nek --mode rpc [--session <path>] ...`
 * - control process: `nek --mode rpc --control`, which creates no session and loads no extensions or MCP servers.
 */
export type RpcProcessMode = "session" | "control";

// ============================================================================
// Commands (stdin)
// ============================================================================

export interface RpcProviderDraft {
	api: RpcEndpointApi;
	baseUrl: string;
	/** Literal, `$ENV`/`${ENV}`, or `!command`, resolved like a models.json value. */
	apiKey?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
}

export type RpcGuiCommand =
	// ---- runtime [session + control] ----
	| { id?: string; type: "get_info" }
	| { id?: string; type: "reload" }
	| { id?: string; type: "validate_config"; cwd?: string }
	| { id?: string; type: "get_changelog"; sinceVersion?: string }
	// ---- session catalog [session + control] ----
	| { id?: string; type: "list_sessions"; cwd?: string; all?: boolean; limit?: number }
	| { id?: string; type: "delete_session"; sessionPath: string }
	| { id?: string; type: "rename_session"; sessionPath: string; name: string }
	| { id?: string; type: "read_session_snapshot"; sessionPath: string }
	| { id?: string; type: "import_session"; inputPath: string; cwd: string }
	// ---- current session [session] ----
	| { id?: string; type: "export_session"; format: "html" | "jsonl"; outputPath?: string }
	| { id?: string; type: "share_session" }
	| {
			id?: string;
			type: "navigate_tree";
			entryId: string;
			summarize?: boolean;
			customInstructions?: string;
			replaceInstructions?: boolean;
			label?: string;
	  }
	| { id?: string; type: "set_entry_label"; entryId: string; label?: string }
	// ---- auth [session + control] ----
	| { id?: string; type: "auth_status" }
	| { id?: string; type: "auth_login"; provider: string; method?: "oauth" | "api_key" }
	| { id?: string; type: "auth_logout"; provider: string }
	// ---- models [session + control] ----
	| { id?: string; type: "get_model_catalog"; provider?: string; ids?: string[] }
	| { id?: string; type: "fetch_provider_models"; provider?: string; draft?: RpcProviderDraft }
	| { id?: string; type: "test_provider"; modelId: string; provider?: string; draft?: RpcProviderDraft }
	// ---- project trust [session + control] ----
	| { id?: string; type: "get_project_trust"; cwd: string }
	| { id?: string; type: "set_project_trust"; cwd: string; trusted: boolean }
	// ---- web and MCP probes [session + control] ----
	| { id?: string; type: "test_web_search"; query: string }
	| { id?: string; type: "mcp_test"; name?: string; config?: McpServerConfig; cwd?: string }
	// ---- extension channel [session] ----
	| { id?: string; type: "extension_call"; method: string; params?: unknown };

export type RpcGuiCommandType = RpcGuiCommand["type"];

/** Commands the control process accepts. `get_available_models` is the one pre-existing command that needs no session. */
export const NEK_CONTROL_COMMANDS: readonly string[] = [
	"get_info",
	"reload",
	"validate_config",
	"get_changelog",
	"list_sessions",
	"delete_session",
	"rename_session",
	"read_session_snapshot",
	"import_session",
	"auth_status",
	"auth_login",
	"auth_logout",
	"get_model_catalog",
	"fetch_provider_models",
	"test_provider",
	"get_project_trust",
	"set_project_trust",
	"test_web_search",
	"mcp_test",
	"get_available_models",
];

// ============================================================================
// Response data (`response.data`)
// ============================================================================

export interface RpcInfo {
	protocolVersion: number;
	nekVersion: string;
	piVersion: string;
	mode: RpcProcessMode;
	agentDir: string;
	sessionDir: string;
	cwd: string;
	platform: string;
	nodeVersion: string;
}

export interface RpcConfigDiagnostic {
	/** Absolute path. */
	file: string;
	severity: "error" | "warning";
	message: string;
}

export interface RpcReloadResult {
	/** true: a turn was in flight and the reload runs after `agent_settled`. */
	deferred: boolean;
	diagnostics: RpcConfigDiagnostic[];
}

export interface RpcSessionSummary {
	path: string;
	id: string;
	/** Session working directory; old sessions may have an empty string. */
	cwd: string;
	name?: string;
	parentSessionPath?: string;
	/** ISO 8601. */
	createdAt: string;
	/** ISO 8601. */
	modifiedAt: string;
	messageCount: number;
	/** First user message, truncated to 200 characters. */
	firstMessage: string;
	/** The session lock is held by a live process. */
	locked: boolean;
}

export interface RpcSessionSnapshot {
	session: RpcSessionSummary;
	/** Same shape as `get_entries` (a nek SessionEntry as JSON). */
	entries: unknown[];
	leafId: string | null;
	/** Same shape as `get_messages` (an AgentMessage as JSON) on the current leaf branch. */
	messages: unknown[];
}

export interface RpcAuthProviderStatus {
	provider: string;
	/** Display name, e.g. "Anthropic (Claude Pro/Max)". */
	name: string;
	kind: "oauth" | "api_key" | "env" | "none";
	loginMethods: Array<"oauth" | "api_key">;
	/** OAuth access-token expiry (ISO 8601); nek refreshes automatically. */
	expiresAt?: string;
}

export interface RpcCatalogModel {
	provider: string;
	id: string;
	name: string;
	api: string;
	contextWindow: number;
	maxTokens: number;
	reasoning: boolean;
	thinkingLevels: RpcThinkingLevel[];
	thinkingLevelMap?: Partial<Record<RpcThinkingLevel, string | null>>;
	input: Array<"text" | "image">;
	cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

export interface RpcRemoteModel {
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	thinkingLevels?: RpcThinkingLevel[];
	input?: Array<"text" | "image">;
}

/** A failure is a structured result, not an RPC error, so the GUI can map 401/403/404. */
export type RpcFetchModelsResult =
	| { ok: true; endpoint: string; models: RpcRemoteModel[] }
	| { ok: false; endpoint: string; status?: number; message: string };

export type RpcTestProviderResult = { ok: true; latencyMs: number } | { ok: false; status?: number; message: string };

export interface RpcProjectTrustResource {
	kind: "settings" | "mcp" | "extensions" | "skills" | "prompts" | "themes" | "agents" | "system_prompt" | "other";
	path: string;
}

export interface RpcProjectTrust {
	cwd: string;
	/** null: no stored decision, which needs a prompt when `defaultProjectTrust` is "ask". */
	trusted: boolean | null;
	defaultProjectTrust: "ask" | "always" | "never";
	resources: RpcProjectTrustResource[];
}

export type RpcTestWebSearchResult =
	| { ok: true; latencyMs: number; resultCount: number }
	| { ok: false; message: string };

export type RpcMcpTestResult =
	| { ok: true; latencyMs: number; tools: Array<{ name: string; description?: string }> }
	| { ok: false; message: string };

export interface RpcGuiResponseData {
	get_info: RpcInfo;
	reload: RpcReloadResult;
	validate_config: { diagnostics: RpcConfigDiagnostic[] };
	get_changelog: { markdown: string };
	list_sessions: { sessions: RpcSessionSummary[] };
	delete_session: Record<string, never>;
	rename_session: Record<string, never>;
	read_session_snapshot: RpcSessionSnapshot;
	import_session: { sessionPath: string };
	export_session: { path: string };
	share_session: { url: string };
	navigate_tree: { cancelled: boolean; editorText?: string };
	set_entry_label: Record<string, never>;
	auth_status: { providers: RpcAuthProviderStatus[] };
	auth_login: { provider: string };
	auth_logout: Record<string, never>;
	get_model_catalog: { models: RpcCatalogModel[] };
	fetch_provider_models: RpcFetchModelsResult;
	test_provider: RpcTestProviderResult;
	get_project_trust: RpcProjectTrust;
	set_project_trust: Record<string, never>;
	test_web_search: RpcTestWebSearchResult;
	mcp_test: RpcMcpTestResult;
	extension_call: { result: unknown };
}

// ============================================================================
// Events and extension UI (stdout)
// ============================================================================

/** Sent by an extension through `pi.emitRpcEvent(name, payload)`; RPC mode only. */
export interface RpcExtensionEvent {
	type: "extension_event";
	name: string;
	payload: unknown;
}

/** `auth_login` forwards `AuthInteraction.notify` records to the GUI. */
export interface RpcAuthEventRecord {
	type: "auth_event";
	provider: string;
	event:
		| { type: "info"; message: string; links?: Array<{ url: string; label?: string }> }
		| { type: "auth_url"; url: string; instructions?: string }
		| {
				type: "device_code";
				userCode: string;
				verificationUri: string;
				intervalSeconds?: number;
				expiresInSeconds?: number;
		  }
		| { type: "progress"; message: string };
}

/** A dialog was cancelled on the nek side (signal abort, timeout, turn end); the GUI closes that id. */
export interface RpcExtensionUiCancel {
	type: "extension_ui_cancel";
	id: string;
}

/**
 * Structured interaction request emitted for `ctx.ui.structured(kind, payload, opts)` in RPC mode.
 * The GUI answers with `{ type: "extension_ui_response", id, result }` or `{ ..., cancelled: true }`.
 */
export interface RpcStructuredUiRequest<K extends string = string, P = unknown> {
	type: "extension_ui_request";
	id: string;
	method: "structured";
	kind: K;
	payload: P;
}

export type RpcStructuredUiResponse =
	| { type: "extension_ui_response"; id: string; result: unknown }
	| { type: "extension_ui_response"; id: string; cancelled: true };

/** Structured interaction kinds used by the core (nek extensions add their own). */
export const NEK_STRUCTURED_KINDS = {
	authPrompt: "auth.prompt",
} as const;

/** Payload of the `auth.prompt` structured interaction. result: `{ value: string }`. */
export interface RpcAuthPromptPayload {
	provider: string;
	prompt:
		| { type: "text"; message: string; placeholder?: string }
		| { type: "secret"; message: string; placeholder?: string }
		| { type: "select"; message: string; options: Array<{ id: string; label: string; description?: string }> }
		| { type: "manual_code"; message: string; placeholder?: string };
}
