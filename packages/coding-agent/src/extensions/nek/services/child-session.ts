import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { ExtensionContext, ExtensionFactory } from "../../../core/extensions/types.ts";
import { DefaultResourceLoader } from "../../../core/resource-loader.ts";
import { createAgentSession } from "../../../core/sdk.ts";
import { SessionManager } from "../../../core/session-manager.ts";
import { FileSettingsStorage, SettingsManager, type SettingsStorage } from "../../../core/settings-manager.ts";
import type { AgentType } from "../types.ts";
import { READ_ONLY_TOOL_NAMES } from "./agent-types.ts";

/** Directory of child session files below the parent session directory. */
export const SUBAGENT_SESSION_DIR = "subagents";

/** Everything one in-process child session needs; the caller resolves the model first. */
export interface ChildSessionSpec {
	parentCtx: ExtensionContext;
	type: AgentType;
	/** Undefined when resuming: the child restores the model and thinking level from its session file. */
	model: Model<Api> | undefined;
	thinkingLevel: ThinkingLevel | undefined;
	/** Plan mode and readonly agent types force the explore tool allowlist. */
	forceReadonly: boolean;
	agentDir: string;
	/** The nek extension in subagent role (todo_write and the subagent prompts; never subagent/await). */
	extension: ExtensionFactory;
	/** Session file of a previous child run to continue. */
	resumeFile?: string;
}

/** Tool allowlist of a child: the explore set when read-only is forced, else the type's own tools. */
export function childToolNames(type: AgentType, forceReadonly: boolean): string[] {
	return forceReadonly ? [...READ_ONLY_TOOL_NAMES] : [...type.tools];
}

/**
 * Create one in-process child session (plan.md section 7.4): a read-only settings manager, a resource loader with only
 * the nek subagent extension, and the parent's ModelRuntime so auth is shared. The session gets its own read state, so
 * the parent's read records are not inherited. The registry owns the session's lifetime.
 */
export async function createChildSession(spec: ChildSessionSpec): Promise<AgentSession> {
	const cwd = spec.parentCtx.cwd;
	const projectTrusted = spec.parentCtx.isProjectTrusted();
	const settingsManager = SettingsManager.fromStorage(readOnlySettingsStorage(cwd, spec.agentDir), { projectTrusted });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: spec.agentDir,
		settingsManager,
		noExtensions: true,
		extensionFactories: [{ name: "nek", factory: spec.extension, hidden: true }],
		appendSystemPrompt: [],
	});
	await resourceLoader.reload({ resolveProjectTrust: async () => projectTrusted });
	const { session } = await createAgentSession({
		cwd,
		agentDir: spec.agentDir,
		modelRuntime: spec.parentCtx.modelRegistry.modelRuntime,
		model: spec.model,
		thinkingLevel: spec.thinkingLevel,
		tools: childToolNames(spec.type, spec.forceReadonly),
		resourceLoader,
		sessionManager: createChildSessionManager(spec),
		settingsManager,
	});
	await session.bindExtensions({ mode: "print" });
	return session;
}

/** Resume a child session file, else persist below the parent's session dir, else stay in memory like the parent. */
function createChildSessionManager(spec: ChildSessionSpec): SessionManager {
	const cwd = spec.parentCtx.cwd;
	if (spec.resumeFile) return SessionManager.open(spec.resumeFile);
	const parentFile = spec.parentCtx.sessionManager.getSessionFile();
	if (!parentFile) return SessionManager.inMemory(cwd);
	const dir = join(spec.parentCtx.sessionManager.getSessionDir(), SUBAGENT_SESSION_DIR);
	return SessionManager.create(cwd, dir, { parentSession: parentFile });
}

/** Settings storage that reads the real settings.json but discards every write, so a child cannot persist settings. */
function readOnlySettingsStorage(cwd: string, agentDir: string): SettingsStorage {
	const file = new FileSettingsStorage(cwd, agentDir);
	return {
		withLock: (scope, fn) =>
			file.withLock(scope, (current) => {
				fn(current);
				return undefined;
			}),
	};
}

/** Model reference as the subagent tool and the error messages spell it. */
export function modelRef(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Cursor model rule (plan.md section 7.5): undefined or "inherit" -> the parent model; "provider/id" -> that model when
 * it exists and has configured auth; anything else throws and lists the available models instead of guessing.
 */
export function resolveChildModel(spec: string | undefined, ctx: ExtensionContext): Model<Api> {
	const value = spec?.trim();
	if (!value || value === "inherit") {
		if (!ctx.model) throw new Error("The parent session has no model to inherit.");
		return ctx.model;
	}
	const slash = value.indexOf("/");
	const model = slash > 0 ? ctx.modelRegistry.find(value.slice(0, slash), value.slice(slash + 1)) : undefined;
	if (model && ctx.modelRegistry.hasConfiguredAuth(model)) return model;
	const available = ctx.modelRegistry.getAvailable().map(modelRef);
	const list = available.length > 0 ? available.join(", ") : "none";
	throw new Error(`Model "${value}" is not available. Available models: inherit, ${list}.`);
}
