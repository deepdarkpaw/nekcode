/**
 * Project trust commands: the stored decision plus the project resources that need trust.
 *
 * `set_project_trust` writes the same store as `/trust` (`<agentDir>/trust.json`), so a decision made from the
 * GUI applies to the terminal and vice versa.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "../../../config.ts";
import { ProjectTrustStore } from "../../../core/trust-manager.ts";
import { canonicalizePath, resolvePath } from "../../../utils/paths.ts";
import type { GuiContext } from "./context.ts";
import type { RpcProjectTrust, RpcProjectTrustResource } from "./protocol.ts";

/** Project entries whose presence makes the project need a trust decision. */
const TRUST_RESOURCES: ReadonlyArray<{ name: string; kind: RpcProjectTrustResource["kind"]; directory?: boolean }> = [
	{ name: "settings.json", kind: "settings" },
	{ name: "mcp.json", kind: "mcp" },
	{ name: "extensions", kind: "extensions", directory: true },
	{ name: "skills", kind: "skills", directory: true },
	{ name: "prompts", kind: "prompts", directory: true },
	{ name: "themes", kind: "themes", directory: true },
	{ name: "agents", kind: "agents", directory: true },
	{ name: "SYSTEM.md", kind: "system_prompt" },
	{ name: "APPEND_SYSTEM.md", kind: "system_prompt" },
];

/** `.agents/skills` directories from `cwd` upwards, excluding the user-level one that needs no trust. */
function agentsSkillsDirs(cwd: string): string[] {
	const home = canonicalizePath(resolvePath(process.env.HOME || homedir()));
	const userSkills = join(home, ".agents", "skills");
	const dirs: string[] = [];
	let current = canonicalizePath(resolvePath(cwd));
	for (;;) {
		const path = join(current, ".agents", "skills");
		if (path !== userSkills && existsSync(path)) dirs.push(path);
		const parent = dirname(current);
		if (parent === current) return dirs;
		current = parent;
	}
}

/** Project resources that exist for `cwd`; `.agents/skills` in the project and its ancestors counts as skills. */
export function listTrustResources(cwd: string): RpcProjectTrustResource[] {
	const resources: RpcProjectTrustResource[] = [];
	const configDir = join(canonicalizePath(resolvePath(cwd)), CONFIG_DIR_NAME);
	for (const entry of TRUST_RESOURCES) {
		const path = join(configDir, entry.name);
		if (existsSync(path)) resources.push({ kind: entry.kind, path });
	}
	for (const path of agentsSkillsDirs(cwd)) resources.push({ kind: "skills", path });
	return resources;
}

/** Decision, fallback policy, and existing project resources for one directory. */
export function getProjectTrust(ctx: GuiContext, cwd: string): RpcProjectTrust {
	const resolved = resolvePath(cwd);
	return {
		cwd: resolved,
		trusted: new ProjectTrustStore(ctx.agentDir).get(resolved),
		defaultProjectTrust: ctx.settingsManager.getDefaultProjectTrust(),
		resources: listTrustResources(resolved),
	};
}

/** Store a trust decision for a directory, as `/trust` does. */
export function setProjectTrust(ctx: GuiContext, cwd: string, trusted: boolean): void {
	new ProjectTrustStore(ctx.agentDir).set(resolvePath(cwd), trusted);
}
