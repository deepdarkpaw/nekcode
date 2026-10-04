/**
 * `nek --ui opentui`: start the OpenTUI frontend.
 *
 * OpenTUI needs Bun. Node relaunches the CLI under Bun through the OpenTUI entry with the same
 * arguments and the terminal (inherited stdio). The Bun entry calls this package's `main()` with an
 * interactive-mode factory, so the agent and the UI run in that one Bun process.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import chalk from "chalk";
import { getPackageDir } from "../config.ts";

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

/** Path of the frontend entry in a source checkout. */
export function getOpenTuiEntryPath(): string {
	return join(getPackageDir(), "..", "opentui", "src", "main.ts");
}

/** `bun <entry> ...args`: the CLI arguments are forwarded unchanged. */
export function buildBunArgs(entry: string, args: readonly string[]): string[] {
	return [entry, ...args];
}

const BUN_MISSING_MESSAGE = `The OpenTUI frontend needs Bun 1.3 or newer, and Bun was not found.
Install it from https://bun.sh, or rerun the nek installer with NEK_INSTALL_BUN=1.
Set NEK_BUN to the Bun executable if it is installed somewhere else.`;

/** Run the CLI under Bun with the OpenTUI frontend and wait for it. Resolves with its exit code. */
export async function launchOpenTui(args: readonly string[]): Promise<number> {
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
	const child = spawn(bun, buildBunArgs(entry, args), { stdio: "inherit", env: process.env });
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
