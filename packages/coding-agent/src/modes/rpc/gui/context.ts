/**
 * What a GUI command handler may use: the runtime pieces both RPC process modes share.
 *
 * The session process provides a live session; the control process has none, so handlers that need
 * one reject with their own message instead of running against a half-built session.
 */

import { join } from "node:path";
import { ENV_SESSION_DIR, expandTildePath, getAgentDir } from "../../../config.ts";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ModelRuntime } from "../../../core/model-runtime.ts";
import type { SettingsManager } from "../../../core/settings-manager.ts";
import type { RpcProcessMode } from "./protocol.ts";

export interface GuiContext {
	readonly mode: RpcProcessMode;
	/** Working directory of the process, used when a command carries no cwd. */
	readonly cwd: string;
	readonly agentDir: string;
	/** Session storage root: the configured directory, or `<agentDir>/sessions`. */
	readonly sessionDir: string;
	/** Configured session directory, `undefined` when the default root applies. */
	readonly configuredSessionDir: string | undefined;
	readonly settingsManager: SettingsManager;
	readonly modelRuntime: ModelRuntime;
	/** The live session; only the session process has one. */
	readonly session: AgentSession | undefined;
	/** Write one record to the process stdout. */
	emit(record: object): void;
	/**
	 * Ask the client a structured question and resolve with its `result`.
	 * Resolves `undefined` when the client cancels or the request times out.
	 */
	requestStructured?(
		kind: string,
		payload: unknown,
		options?: { signal?: AbortSignal; timeout?: number },
	): Promise<unknown>;
}

/** The configured session directory, resolved like `--session-dir` and `NEK_CODING_AGENT_SESSION_DIR`. */
export function resolveConfiguredSessionDir(settingsManager: SettingsManager): string | undefined {
	const fromEnv = process.env[ENV_SESSION_DIR];
	if (fromEnv) return expandTildePath(fromEnv);
	return settingsManager.getSessionDir();
}

/** Session storage root used by `list_sessions` and `get_info`. */
export function resolveSessionDir(settingsManager: SettingsManager, agentDir: string): string {
	return resolveConfiguredSessionDir(settingsManager) ?? join(agentDir, "sessions");
}

/** The live session, or an error explaining that this command needs one. */
export function requireSession(ctx: GuiContext, command: string): AgentSession {
	if (!ctx.session) throw new Error(`${command} requires a session; start RPC mode without --control`);
	return ctx.session;
}

/** Build a context value with the session directory fields derived from the settings. */
export function createGuiContext(options: {
	mode: RpcProcessMode;
	cwd: string;
	agentDir?: string;
	settingsManager: SettingsManager;
	modelRuntime: ModelRuntime;
	session?: AgentSession;
	emit: (record: object) => void;
	requestStructured?: GuiContext["requestStructured"];
}): GuiContext {
	const agentDir = options.agentDir ?? getAgentDir();
	const configuredSessionDir = resolveConfiguredSessionDir(options.settingsManager);
	return {
		mode: options.mode,
		cwd: options.cwd,
		agentDir,
		configuredSessionDir,
		sessionDir: configuredSessionDir ?? join(agentDir, "sessions"),
		settingsManager: options.settingsManager,
		modelRuntime: options.modelRuntime,
		session: options.session,
		emit: options.emit,
		requestStructured: options.requestStructured,
	};
}
