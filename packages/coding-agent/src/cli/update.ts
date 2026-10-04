import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compare, valid } from "semver";
import { getPackageDir } from "../config.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { spawnProcess, spawnProcessSync, waitForChildProcess } from "../utils/child-process.ts";

export type UpdateChannel = "stable" | "dev";

export const UPDATE_STATE_FILE = ".nek-install-state.json";

export interface UpdateArgs {
	channel?: UpdateChannel;
	check: boolean;
	help: boolean;
}

export interface UpdateCommandContext {
	settingsManager?: SettingsManager;
}

interface InstallState {
	binDir?: string;
	channel?: UpdateChannel;
	branch?: string;
	skipTools?: boolean;
	installBun?: boolean;
}

interface RemoteRef {
	name: string;
	commit: string;
}

/** Compare two semantic versions. */
export function compareVersions(left: string, right: string): number {
	return compare(left, right);
}

/** Select the highest valid semantic version from nek-v tags. */
export function selectHighestStableTag(tags: readonly string[]): string | undefined {
	let selected: { tag: string; version: string } | undefined;
	for (const tag of tags) {
		const match = /^nek-v(.+)$/u.exec(tag);
		if (!match || !valid(match[1])) continue;
		if (!selected || compareVersions(match[1], selected.version) > 0) {
			selected = { tag, version: match[1] };
		}
	}
	return selected?.tag;
}

/** Parse update subcommand arguments without touching the network or filesystem. */
export function parseUpdateArgs(args: readonly string[]): UpdateArgs {
	const result: UpdateArgs = { check: false, help: false };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index];
		if (arg === "--help" || arg === "-h") {
			result.help = true;
			continue;
		}
		if (arg === "--check") {
			result.check = true;
			continue;
		}
		if (arg === "--channel" || arg.startsWith("--channel=")) {
			const value = arg.startsWith("--channel=") ? arg.slice("--channel=".length) : args[++index];
			if (value !== "stable" && value !== "dev") {
				throw new Error("--channel requires stable or dev");
			}
			result.channel = value;
			continue;
		}
		throw new Error(`Unknown update option: ${arg}`);
	}
	return result;
}

function runGit(checkout: string, args: string[]): string {
	const result = spawnProcessSync("git", ["-C", checkout, ...args], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	if (result.status !== 0) {
		const detail = result.stderr.trim() || result.error?.message || `exit code ${result.status ?? "unknown"}`;
		throw new Error(`git ${args.join(" ")} failed: ${detail}`);
	}
	return result.stdout.trim();
}

function resolveCheckout(): string {
	const packageDir = getPackageDir();
	try {
		return runGit(packageDir, ["rev-parse", "--show-toplevel"]);
	} catch {
		throw new Error(
			`nek update requires a git checkout; no repository contains the running package at ${packageDir}`,
		);
	}
}

function readInstallState(checkout: string): InstallState {
	const path = join(checkout, UPDATE_STATE_FILE);
	if (!existsSync(path)) return {};
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof value !== "object" || value === null || Array.isArray(value)) {
			throw new Error("expected an object");
		}
		const state = value as Record<string, unknown>;
		if (state.channel !== undefined && state.channel !== "stable" && state.channel !== "dev") {
			throw new Error("channel must be stable or dev");
		}
		return {
			binDir: typeof state.binDir === "string" ? state.binDir : undefined,
			channel: state.channel,
			branch: typeof state.branch === "string" ? state.branch : undefined,
			skipTools: typeof state.skipTools === "boolean" ? state.skipTools : undefined,
			installBun: typeof state.installBun === "boolean" ? state.installBun : undefined,
		};
	} catch (error) {
		throw new Error(`Invalid installer state at ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Read ls-remote output, using peeled commits for annotated release tags. */
export function parseRemoteRefs(output: string, prefix: "refs/tags/" | "refs/heads/"): RemoteRef[] {
	const refs = new Map<string, RemoteRef>();
	const lines = output.split("\n").map((line) => line.trim().split(/\s+/u));
	for (const [commit, ref] of lines) {
		if (!commit || !ref?.startsWith(prefix)) continue;
		const name = ref.slice(prefix.length).replace(/\^\{\}$/u, "");
		if (!refs.has(name) || ref.endsWith("^{}")) refs.set(name, { commit, name });
	}
	return [...refs.values()];
}

function readCurrentRef(checkout: string): { commit: string; tag?: string } {
	const commit = runGit(checkout, ["rev-parse", "HEAD"]);
	const tagResult = spawnProcessSync("git", ["-C", checkout, "describe", "--tags", "--exact-match", "HEAD"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return { commit, tag: tagResult.status === 0 ? tagResult.stdout.trim() : undefined };
}

function printCheckResult(
	channel: UpdateChannel,
	current: string,
	target: string,
	available: boolean,
	noStableTags = false,
): void {
	console.log(`Current: ${current}`);
	if (noStableTags) {
		console.log("Target: no nek-v* stable tags found");
		console.log("No stable update is available. Set NEK_CHANNEL=dev or use --channel dev to track the nek branch.");
		return;
	}
	console.log(`Target (${channel}): ${target}`);
	console.log(available ? "Update available." : "Already up to date.");
}

export function updateIsAvailable(
	channel: UpdateChannel,
	current: { commit: string; tag?: string },
	target: RemoteRef,
): boolean {
	if (current.commit === target.commit) return false;
	if (channel === "dev") return true;
	const currentVersion = current.tag?.startsWith("nek-v") ? valid(current.tag.slice("nek-v".length)) : null;
	if (!currentVersion) return true;
	const targetVersion = target.name.slice("nek-v".length);
	return compareVersions(targetVersion, currentVersion) > 0;
}

async function runInstaller(checkout: string, channel: UpdateChannel, state: InstallState): Promise<number> {
	const installer = process.platform === "win32" ? "scripts/install.ps1" : "scripts/install.sh";
	const command = process.platform === "win32" ? "powershell" : "bash";
	const args =
		process.platform === "win32"
			? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(checkout, installer)]
			: [join(checkout, installer)];
	const env = {
		...process.env,
		NEK_INSTALL_DIR: checkout,
		NEK_CHANNEL: channel,
		...(state.binDir ? { NEK_BIN_DIR: state.binDir } : {}),
		...(state.branch ? { NEK_BRANCH: state.branch } : {}),
		...(state.skipTools !== undefined && process.env.NEK_SKIP_TOOLS === undefined
			? { NEK_SKIP_TOOLS: state.skipTools ? "1" : "0" }
			: {}),
		...(state.installBun !== undefined && process.env.NEK_INSTALL_BUN === undefined
			? { NEK_INSTALL_BUN: state.installBun ? "1" : "0" }
			: {}),
	};
	const child = spawnProcess(command, args, { cwd: checkout, env, stdio: "inherit" });
	return (await waitForChildProcess(child)) ?? 1;
}

export function printUpdateHelp(): void {
	console.log(`Usage: nek update [--channel stable|dev] [--check]

Channels:
  stable  Update to the highest nek-v* release tag (default)
  dev     Update to the configured NEK_BRANCH (default: nek)

Options:
  --channel <channel>  Select and persist stable or dev
  --check              Check using git ls-remote without changing files
  --help               Show this help

Exit codes for --check:
  0  Check completed and no update is available (including no stable tags)
  1  The checkout or remote could not be inspected
  2  An update is available`);
}

export async function runUpdateCommand(args: readonly string[], context: UpdateCommandContext = {}): Promise<number> {
	try {
		const parsed = parseUpdateArgs(args);
		if (parsed.help) {
			printUpdateHelp();
			return 0;
		}
		const checkout = resolveCheckout();
		const state = readInstallState(checkout);
		const channel =
			parsed.channel ?? context.settingsManager?.getGlobalSettings().updateChannel ?? state.channel ?? "stable";
		if (parsed.channel && context.settingsManager) {
			context.settingsManager.setUpdateChannel(parsed.channel);
			await context.settingsManager.flush();
			const errors = context.settingsManager.drainErrors();
			if (errors.length > 0) throw errors[0].error;
		}
		const branch = state.branch ?? process.env.NEK_BRANCH ?? "nek";
		const current = readCurrentRef(checkout);

		if (parsed.check) {
			const remoteOutput =
				channel === "stable"
					? runGit(checkout, ["ls-remote", "--tags", "origin", "refs/tags/nek-v*"])
					: runGit(checkout, ["ls-remote", "--heads", "origin", `refs/heads/${branch}`]);
			const refs = parseRemoteRefs(remoteOutput, channel === "stable" ? "refs/tags/" : "refs/heads/");
			if (channel === "stable") {
				const tag = selectHighestStableTag(refs.map((ref) => ref.name));
				if (!tag) {
					printCheckResult(channel, current.tag ?? current.commit.slice(0, 12), "", false, true);
					return 0;
				}
				const target = refs.find((ref) => ref.name === tag);
				if (!target) throw new Error(`Unable to resolve selected stable tag ${tag}`);
				const available = updateIsAvailable(channel, current, target);
				printCheckResult(channel, current.tag ?? current.commit.slice(0, 12), tag, available);
				return available ? 2 : 0;
			}
			const target = refs[0];
			if (!target) throw new Error(`Remote branch ${branch} was not found on origin`);
			const available = updateIsAvailable(channel, current, target);
			printCheckResult(
				channel,
				current.tag ?? current.commit.slice(0, 12),
				`${branch} (${target.commit.slice(0, 12)})`,
				available,
			);
			return available ? 2 : 0;
		}

		return await runInstaller(checkout, channel, state);
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}
