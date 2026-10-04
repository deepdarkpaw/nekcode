/**
 * `nek --ui opentui`: start the OpenTUI frontend.
 *
 * OpenTUI needs Bun, so the frontend runs as a separate Bun process with the terminal (inherited
 * stdio). It starts the agent itself as `nek --mode rpc` on Node, using the command passed in
 * `NEK_OPENTUI_BACKEND`, and talks JSONL RPC to it.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { getAgentDir, getCustomThemesDir, getPackageDir, getThemesDir } from "../config.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { detectTerminalBackgroundFromEnv, resolveThemeSetting } from "../modes/interactive/theme/theme.ts";

/** Environment variable with the backend command as a JSON string array. */
export const OPENTUI_BACKEND_ENV = "NEK_OPENTUI_BACKEND";
/** Environment variable with the theme JSON path for the frontend palette. */
export const OPENTUI_THEME_ENV = "NEK_OPENTUI_THEME_PATH";
/** Environment variable with initial messages from the command line, as a JSON string array. */
export const OPENTUI_MESSAGES_ENV = "NEK_OPENTUI_INITIAL_MESSAGES";

/** Frontend flag for a non-interactive check: render one frame after the RPC handshake, then exit. */
export const SMOKE_FLAG = "--smoke";

export type UiFrontend = "tui" | "opentui";

export interface BunLookup {
	env: NodeJS.ProcessEnv;
	platform: NodeJS.Platform;
	home: string;
	exists: (path: string) => boolean;
}

/** Bun executable: `NEK_BUN`, then PATH, then `~/.bun/bin/bun(.exe)`. */
export function findBun(lookup: BunLookup): string | undefined {
	const explicit = lookup.env.NEK_BUN?.trim();
	if (explicit) return lookup.exists(explicit) ? explicit : undefined;
	const names = lookup.platform === "win32" ? ["bun.exe", "bun.cmd", "bun"] : ["bun"];
	const pathValue = lookup.env.PATH ?? lookup.env.Path ?? "";
	const separator = lookup.platform === "win32" ? ";" : ":";
	for (const dir of pathValue.split(separator)) {
		if (!dir) continue;
		for (const name of names) {
			const candidate = join(dir, name);
			if (lookup.exists(candidate)) return candidate;
		}
	}
	const fallback = join(lookup.home, ".bun", "bin", lookup.platform === "win32" ? "bun.exe" : "bun");
	return lookup.exists(fallback) ? fallback : undefined;
}

/** Arguments without `--ui <name>` / `--ui=<name>`. */
export function stripUiFlag(args: readonly string[]): string[] {
	const result: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") {
			result.push(...args.slice(i));
			break;
		}
		if (arg === "--ui") {
			i++;
			continue;
		}
		if (arg.startsWith("--ui=")) continue;
		result.push(arg);
	}
	return result;
}

/** `[node, ...execArgv, cli, "--mode", "rpc", ...args]`; execArgv carries the source resolver import. */
export function buildBackendCommand(
	args: readonly string[],
	execPath: string,
	execArgv: readonly string[],
	cliPath: string | undefined,
): string[] {
	return [execPath, ...execArgv, ...(cliPath ? [cliPath] : []), "--mode", "rpc", ...stripUiFlag(args)];
}

/** Path of the frontend entry in a source checkout. */
export function getOpenTuiEntryPath(): string {
	return join(getPackageDir(), "..", "opentui", "src", "main.ts");
}

/** Theme JSON for the frontend palette: `--use-theme`, else the settings theme, else by terminal background. */
function resolveThemePath(useTheme: string | undefined): string | undefined {
	const setting = useTheme ?? SettingsManager.create(process.cwd(), getAgentDir()).getTheme();
	const detected = detectTerminalBackgroundFromEnv().theme;
	const name = resolveThemeSetting(setting, detected) ?? detected;
	for (const dir of [getCustomThemesDir(), getThemesDir()]) {
		const path = join(dir, `${name}.json`);
		if (existsSync(path)) return path;
	}
	return join(getThemesDir(), `${detected}.json`);
}

const BUN_MISSING_MESSAGE = `The OpenTUI frontend needs Bun 1.3 or newer, and Bun was not found.
Install it from https://bun.sh, or rerun the nek installer with NEK_INSTALL_BUN=1.
Set NEK_BUN to the Bun executable if it is installed somewhere else.`;

/**
 * Start the frontend and wait for it. Resolves with its exit code. `messages` are the positional
 * messages from the command line; the frontend sends them once the backend is ready.
 */
export async function launchOpenTui(
	args: readonly string[],
	options: { messages: readonly string[]; fileArgs: readonly string[]; useTheme?: string },
): Promise<number> {
	if (options.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported with --ui opentui"));
		return 1;
	}
	const entry = getOpenTuiEntryPath();
	if (!existsSync(entry)) {
		console.error(chalk.red(`Error: the OpenTUI frontend is not installed (${entry} is missing).`));
		console.error("It is available when nek runs from a source checkout, such as the one the nek installer creates.");
		return 1;
	}
	const bun = findBun({ env: process.env, platform: process.platform, home: homedir(), exists: existsSync });
	if (!bun) {
		console.error(chalk.red(BUN_MISSING_MESSAGE));
		return 1;
	}
	const smoke = args.includes(SMOKE_FLAG);
	const backendArgs = args.filter((arg) => arg !== SMOKE_FLAG);
	const backend = buildBackendCommand(backendArgs, process.execPath, process.execArgv, process.argv[1]);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		[OPENTUI_BACKEND_ENV]: JSON.stringify(backend),
		[OPENTUI_MESSAGES_ENV]: JSON.stringify(options.messages),
	};
	const themePath = resolveThemePath(options.useTheme);
	if (themePath) env[OPENTUI_THEME_ENV] = themePath;

	const child = spawn(bun, [entry, ...(smoke ? [SMOKE_FLAG] : [])], {
		stdio: "inherit",
		env,
	});
	// The frontend owns the terminal; Ctrl+C reaches it as a key. Ignore signals meant for the group.
	const ignore = () => {};
	process.on("SIGINT", ignore);
	try {
		return await new Promise<number>((resolve) => {
			child.once("error", (error) => {
				console.error(chalk.red(`Error: failed to start Bun (${bun}): ${error.message}`));
				resolve(1);
			});
			child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
		});
	} finally {
		process.off("SIGINT", ignore);
	}
}
