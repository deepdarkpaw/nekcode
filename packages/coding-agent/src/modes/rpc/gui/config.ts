/**
 * `validate_config` and `reload`.
 *
 * Validation reuses the loaders the CLI uses (settings, models.json, mcp.json, nek.yaml, agent files), so a
 * diagnostic here means the same thing it means at startup. A reload refreshes settings, models.json, auth,
 * and MCP configuration; during a turn it is queued and applied when the run settles.
 */

import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../../config.ts";
import { ModelConfig } from "../../../core/model-config.ts";
import { SettingsManager } from "../../../core/settings-manager.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "../../../core/trust-manager.ts";
import { loadMcpConfig } from "../../../extensions/mcp/config.ts";
import { loadNekConfig } from "../../../extensions/nek/config.ts";
import { discoverAgentTypes } from "../../../extensions/nek/services/agent-types.ts";
import { resolvePath } from "../../../utils/paths.ts";
import type { GuiContext } from "./context.ts";
import type { RpcConfigDiagnostic, RpcReloadResult } from "./protocol.ts";
import { errorMessage } from "./response.ts";

const MODELS_FILE = "models.json";
const SETTINGS_FILE = "settings.json";

/** Whether project-local resources may be read for `cwd`, mirroring startup trust resolution. */
export function isProjectTrusted(ctx: GuiContext, cwd: string): boolean {
	if (!hasTrustRequiringProjectResources(cwd)) return true;
	const trusted = new ProjectTrustStore(ctx.agentDir).get(cwd);
	if (trusted !== null) return trusted;
	return ctx.settingsManager.getDefaultProjectTrust() === "always";
}

/** Split `"<path>: message"` diagnostics produced by the loaders, keeping absolute Windows paths intact. */
function splitPathMessage(message: string): { file: string; message: string } | undefined {
	const separator = message.indexOf(": ");
	if (separator <= 1) return undefined;
	return { file: resolvePath(message.slice(0, separator)), message: message.slice(separator + 2) };
}

function diagnostic(file: string, message: string, severity: "error" | "warning" = "error"): RpcConfigDiagnostic {
	return { file: resolvePath(file), severity, message };
}

/** A loader message that starts with the file it came from, attributed to that file. */
function fromLoaderMessage(message: string, fallbackFile: string): RpcConfigDiagnostic {
	const split = splitPathMessage(message);
	return split === undefined ? diagnostic(fallbackFile, message) : diagnostic(split.file, split.message);
}

/** `models.json` parse and schema errors, as reported by the config loader. */
async function validateModelsJson(agentDir: string): Promise<RpcConfigDiagnostic[]> {
	const path = join(agentDir, MODELS_FILE);
	const error = (await ModelConfig.load(path)).getError();
	return error === undefined ? [] : [diagnostic(path, error)];
}

/** Settings files, parsed and merged the way startup does; parse errors carry their scope and path. */
function validateSettings(cwd: string, agentDir: string): RpcConfigDiagnostic[] {
	const manager = SettingsManager.create(cwd, agentDir);
	const diagnostics = manager
		.drainErrors()
		.map(({ scope, path, error }) =>
			diagnostic(
				path ?? join(scope === "global" ? agentDir : join(cwd, CONFIG_DIR_NAME), SETTINGS_FILE),
				error.message,
			),
		);
	const unknownTools = manager.getUnknownDefaultTools();
	if (unknownTools.length > 0) {
		diagnostics.push(
			diagnostic(
				join(agentDir, SETTINGS_FILE),
				`defaultTools: unknown tool ${unknownTools.map((n) => `"${n}"`).join(", ")}`,
				"warning",
			),
		);
	}
	return diagnostics;
}

function validateMcp(cwd: string, agentDir: string, projectTrusted: boolean): RpcConfigDiagnostic[] {
	return loadMcpConfig({ agentDir, cwd, projectTrusted }).errors.map((message) =>
		fromLoaderMessage(message, join(agentDir, "mcp.json")),
	);
}

function validateNekConfig(cwd: string, agentDir: string, projectTrusted: boolean): RpcConfigDiagnostic[] {
	try {
		loadNekConfig(agentDir, cwd, projectTrusted);
		return [];
	} catch (error: unknown) {
		return [fromLoaderMessage(errorMessage(error), join(agentDir, "nek.yaml"))];
	}
}

function validateAgentTypes(cwd: string, agentDir: string, projectTrusted: boolean): RpcConfigDiagnostic[] {
	return discoverAgentTypes(agentDir, cwd, projectTrusted).errors.map((message) =>
		fromLoaderMessage(message, join(agentDir, "agents")),
	);
}

/** Global diagnostics plus, when `cwd` is given, the project-level files of that directory. */
export async function validateConfig(ctx: GuiContext, cwd: string | undefined): Promise<RpcConfigDiagnostic[]> {
	const diagnostics = await validateModelsJson(ctx.agentDir);
	diagnostics.push(...validateSettings(cwd ?? ctx.cwd, ctx.agentDir));
	if (cwd === undefined) {
		diagnostics.push(...validateMcp(ctx.cwd, ctx.agentDir, false));
		diagnostics.push(...validateNekConfig(ctx.cwd, ctx.agentDir, false));
		diagnostics.push(...validateAgentTypes(ctx.cwd, ctx.agentDir, false));
		return diagnostics;
	}
	const projectTrusted = isProjectTrusted(ctx, cwd);
	diagnostics.push(...validateMcp(cwd, ctx.agentDir, projectTrusted));
	diagnostics.push(...validateNekConfig(cwd, ctx.agentDir, projectTrusted));
	diagnostics.push(...validateAgentTypes(cwd, ctx.agentDir, projectTrusted));
	return diagnostics;
}

/** Diagnostics the runtime reports after a reload: settings parse errors and models.json errors. */
function runtimeDiagnostics(ctx: GuiContext): RpcConfigDiagnostic[] {
	const diagnostics = ctx.settingsManager
		.drainErrors()
		.map(({ scope, path, error }) =>
			diagnostic(
				path ?? join(scope === "global" ? ctx.agentDir : join(ctx.cwd, ".nek"), SETTINGS_FILE),
				error.message,
			),
		);
	const modelsError = ctx.modelRuntime.getError();
	if (modelsError) diagnostics.push(diagnostic(join(ctx.agentDir, MODELS_FILE), modelsError));
	return diagnostics;
}

/**
 * Reload settings, models.json, credentials, and MCP configuration.
 *
 * The session process reloads through the session, which also re-reads extensions, skills, prompts, and MCP
 * servers. The control process refreshes settings and the model runtime only.
 */
export async function reloadRuntime(ctx: GuiContext): Promise<RpcConfigDiagnostic[]> {
	if (ctx.session) await ctx.session.reload();
	else await ctx.settingsManager.reload();
	await ctx.modelRuntime.refresh({ allowNetwork: false });
	return runtimeDiagnostics(ctx);
}

/**
 * Run a reload now, or queue it for `agent_settled` when a turn is in flight. A queued request is answered
 * immediately with a validation pass; the reload itself runs once the run settles.
 */
export function createReloadScheduler(
	getContext: () => GuiContext,
	isBusy: () => boolean,
): () => Promise<RpcReloadResult> {
	const state: { queued?: Promise<RpcConfigDiagnostic[]> } = {};
	const run = async (): Promise<RpcConfigDiagnostic[]> => {
		try {
			return await reloadRuntime(getContext());
		} finally {
			state.queued = undefined;
		}
	};
	/** One reload waits for the settle of the current run; later requests during it reuse that promise. */
	const queue = (): Promise<RpcConfigDiagnostic[]> =>
		new Promise<RpcConfigDiagnostic[]>((resolve, reject) => {
			const session = getContext().session;
			if (!session) {
				void run().then(resolve, reject);
				return;
			}
			const unsubscribe = session.subscribe((event) => {
				if (event.type !== "agent_settled") return;
				unsubscribe();
				void run().then(resolve, reject);
			});
		});

	return async () => {
		if (!isBusy()) return { deferred: false, diagnostics: await run() };
		state.queued ??= queue();
		return { deferred: true, diagnostics: await validateConfig(getContext(), undefined) };
	};
}
