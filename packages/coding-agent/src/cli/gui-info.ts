/**
 * `nek gui-info --json`: the launch description the desktop GUI needs to spawn nek directly.
 *
 * The output is one JSON object on stdout followed by exit code 0. It must stay free of side effects:
 * it only reads the environment, settings, and the current entry path.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { APP_NAME, ENV_SESSION_DIR, expandTildePath, getAgentDir, NEK_VERSION, VERSION } from "../config.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { NEK_GUI_PROTOCOL_VERSION, type RpcGuiInfo } from "../modes/rpc/gui/protocol.ts";
import { resolvePath } from "../utils/paths.ts";

/** File the source installer writes next to the checkout, naming the install directory. */
const INSTALL_STATE_FILE = ".nek-install-state.json";

/** The CLI entry the running process was started with; `undefined` for in-process hosts and Bun binaries. */
function resolveEntryPath(): string | undefined {
	const entry = process.argv[1];
	return entry ? resolve(entry) : undefined;
}

/** Whether the entry is TypeScript source, which Node cannot run without the source resolver preload. */
function isSourceEntry(entry: string | undefined): entry is string {
	return entry !== undefined && /\.(?:ts|tsx|mts|cts)$/u.test(entry);
}

/** Nearest ancestor directory holding the installer state file. */
function findInstallDir(start: string): string | undefined {
	let current = start;
	for (;;) {
		if (existsSync(join(current, INSTALL_STATE_FILE))) return current;
		const parent = dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
}

/** The source resolver shipped beside this module; it maps workspace aliases to source files. */
function sourceResolverUrl(): string {
	return pathToFileURL(fileURLToPath(new URL("../experimental/source-resolver.ts", import.meta.url))).href;
}

/** Launch arguments the GUI prepends to the nek arguments. */
export function resolveLaunchArgs(entry: string | undefined): string[] {
	if (!isSourceEntry(entry)) {
		return entry === undefined ? [] : [entry];
	}
	return ["--import", sourceResolverUrl(), entry];
}

/** Session storage root, matching how the CLI resolves `--session-dir`, the environment, and settings. */
function resolveSessionDir(cwd: string, agentDir: string): string {
	const fromEnv = process.env[ENV_SESSION_DIR];
	if (fromEnv) return expandTildePath(fromEnv);
	const configured = SettingsManager.create(cwd, agentDir).getSessionDir();
	return configured ? resolvePath(configured) : join(agentDir, "sessions");
}

export interface GuiInfoOptions {
	cwd?: string;
	agentDir?: string;
	entryPath?: string;
}

/** Build the `gui-info` payload. Exported for tests. */
export function buildGuiInfo(options: GuiInfoOptions = {}): RpcGuiInfo {
	const cwd = options.cwd ?? process.cwd();
	const agentDir = options.agentDir ?? getAgentDir();
	const entry = options.entryPath ?? resolveEntryPath();
	const installDir = isSourceEntry(entry) ? findInstallDir(dirname(entry)) : undefined;
	const info: RpcGuiInfo = {
		protocolVersion: NEK_GUI_PROTOCOL_VERSION,
		nekVersion: NEK_VERSION,
		piVersion: VERSION,
		node: { path: process.execPath, version: process.version },
		launch: { args: resolveLaunchArgs(entry) },
		agentDir,
		sessionDir: resolveSessionDir(cwd, agentDir),
		platform: process.platform,
		arch: process.arch,
	};
	return installDir === undefined ? info : { ...info, installDir };
}

/** Handle `nek gui-info [--json]`; returns the process exit code. */
export function runGuiInfoCommand(args: string[]): number {
	const unsupported = args.filter((arg) => arg !== "--json");
	if (unsupported.length > 0) {
		console.error(`Error: ${APP_NAME} gui-info accepts no arguments except --json (got: ${unsupported.join(" ")})`);
		return 1;
	}
	if (!resolveEntryPath()) {
		console.error(`Error: ${APP_NAME} gui-info needs the CLI entry path (process.argv[1]) to describe a launch.`);
		return 1;
	}
	process.stdout.write(`${JSON.stringify(buildGuiInfo())}\n`);
	return 0;
}
