/**
 * Dispatch for the GUI commands.
 *
 * Returns `undefined` for a command this module does not own, so the caller can fall through to the
 * pre-existing RPC commands. Both RPC process modes share this table; the control process rejects the
 * session-only commands before they reach it.
 */

import type { RpcResponse } from "../rpc-types.ts";
import { authLogin, authLogout, authStatus } from "./auth.ts";
import { createReloadScheduler, validateConfig } from "./config.ts";
import { type GuiContext, requireSession } from "./context.ts";
import { getChangelog, getInfo } from "./info.ts";
import { getMentionTargets } from "./mentions.ts";
import { fetchProviderModels, getModelCatalog, testProvider } from "./models.ts";
import { mcpTest, testWebSearch } from "./probes.ts";
import type { RpcGuiCommand, RpcReloadResult } from "./protocol.ts";
import { guiError, guiSuccess } from "./response.ts";
import { exportSession, navigateTree, setEntryLabel, shareSession } from "./session-current.ts";
import { deleteSession, importSession, listSessions, readSessionSnapshotFor, renameSession } from "./sessions.ts";
import { getProjectTrust, setProjectTrust } from "./trust.ts";

/** Hooks the RPC mode supplies, because they depend on the process rather than on a command. */
export interface GuiDeps {
	/** Run (or queue) a configuration reload and report its diagnostics. */
	reload: () => Promise<RpcReloadResult>;
}

/** Types of the commands this module handles. */
export const GUI_COMMAND_TYPES: ReadonlySet<string> = new Set<RpcGuiCommand["type"]>([
	"get_info",
	"reload",
	"validate_config",
	"get_changelog",
	"get_mention_targets",
	"list_sessions",
	"delete_session",
	"rename_session",
	"read_session_snapshot",
	"import_session",
	"export_session",
	"share_session",
	"navigate_tree",
	"set_entry_label",
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
	"extension_call",
]);

/** Build the reload hook of a process mode. */
export function createGuiDeps(getContext: () => GuiContext, isBusy: () => boolean): GuiDeps {
	return { reload: createReloadScheduler(getContext, isBusy) };
}

/** Handle one GUI command, or return `undefined` when the type belongs to another handler. */
export async function handleGuiCommand(
	command: { id?: string; type: string },
	ctx: GuiContext,
	deps: GuiDeps,
): Promise<RpcResponse | undefined> {
	if (!GUI_COMMAND_TYPES.has(command.type)) return undefined;
	const id = command.id;
	const cmd = command as RpcGuiCommand;
	try {
		switch (cmd.type) {
			case "get_info":
				return guiSuccess(id, "get_info", getInfo(ctx));
			case "reload":
				return guiSuccess(id, "reload", await deps.reload());
			case "validate_config":
				return guiSuccess(id, "validate_config", { diagnostics: await validateConfig(ctx, cmd.cwd) });
			case "get_changelog":
				return guiSuccess(id, "get_changelog", getChangelog(cmd.sinceVersion));
			case "get_mention_targets":
				return guiSuccess(id, "get_mention_targets", { targets: getMentionTargets(ctx, cmd.cwd) });
			case "list_sessions":
				return guiSuccess(id, "list_sessions", { sessions: await listSessions(ctx, cmd) });
			case "delete_session":
				deleteSession(ctx, cmd.sessionPath);
				return guiSuccess(id, "delete_session", {});
			case "rename_session":
				await renameSession(cmd.sessionPath, cmd.name);
				return guiSuccess(id, "rename_session", {});
			case "read_session_snapshot":
				return guiSuccess(id, "read_session_snapshot", readSessionSnapshotFor(cmd.sessionPath));
			case "import_session":
				return guiSuccess(id, "import_session", { sessionPath: importSession(ctx, cmd.inputPath, cmd.cwd) });
			case "export_session":
				return guiSuccess(id, "export_session", { path: await exportSession(ctx, cmd.format, cmd.outputPath) });
			case "share_session":
				return guiSuccess(id, "share_session", { url: await shareSession(ctx) });
			case "navigate_tree":
				return guiSuccess(id, "navigate_tree", await navigateTree(ctx, cmd));
			case "set_entry_label":
				setEntryLabel(ctx, cmd.entryId, cmd.label);
				return guiSuccess(id, "set_entry_label", {});
			case "auth_status":
				return guiSuccess(id, "auth_status", { providers: authStatus(ctx) });
			case "auth_login":
				await authLogin(ctx, cmd.provider, cmd.method);
				return guiSuccess(id, "auth_login", { provider: cmd.provider });
			case "auth_logout":
				await authLogout(ctx, cmd.provider);
				return guiSuccess(id, "auth_logout", {});
			case "get_model_catalog":
				return guiSuccess(id, "get_model_catalog", { models: getModelCatalog(ctx, cmd.provider, cmd.ids) });
			case "fetch_provider_models":
				return guiSuccess(id, "fetch_provider_models", await fetchProviderModels(ctx, cmd));
			case "test_provider":
				return guiSuccess(id, "test_provider", await testProvider(ctx, cmd));
			case "get_project_trust":
				return guiSuccess(id, "get_project_trust", getProjectTrust(ctx, cmd.cwd));
			case "set_project_trust":
				setProjectTrust(ctx, cmd.cwd, cmd.trusted);
				return guiSuccess(id, "set_project_trust", {});
			case "test_web_search":
				return guiSuccess(id, "test_web_search", await testWebSearch(ctx, cmd.query));
			case "mcp_test":
				return guiSuccess(id, "mcp_test", await mcpTest(ctx, cmd));
			case "extension_call": {
				const session = requireSession(ctx, "extension_call");
				return guiSuccess(id, "extension_call", {
					result: await session.extensionRunner.callRpcHandler(cmd.method, cmd.params),
				});
			}
			default:
				return undefined;
		}
	} catch (error: unknown) {
		return guiError(id, cmd.type, error);
	}
}
