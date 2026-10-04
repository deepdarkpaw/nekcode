/**
 * Install and verify the external search tools nek uses: fd (find), rg (grep), and ast-grep (ast_grep, read outline).
 *
 * Reuses nek's own tools manager, so a tool already on PATH is used as is, and a missing one is downloaded into
 * `~/.nek/agent/bin` (or `$NEK_CODING_AGENT_DIR/bin`), exactly where nek looks at runtime. Each tool is then run with
 * `--version` to prove the binary works on this system. Exit code 1 when any tool is unavailable.
 *
 * Run from a checkout through the source resolver, as the install scripts do:
 *   node --import ./packages/coding-agent/src/experimental/source-resolver.ts scripts/setup-tools.ts
 */

import { spawnSync } from "node:child_process";
import { platform } from "node:os";
import { ensureTool, type ToolBinary } from "../packages/coding-agent/src/utils/tools-manager.ts";

/** Tool, the nek features that need it, and how to install it by hand when the automatic download cannot work. */
interface ToolSpec {
	tool: ToolBinary;
	usedBy: string;
	manualInstall: string;
}

const TOOLS: readonly ToolSpec[] = [
	{
		tool: "fd",
		usedBy: "find",
		manualInstall: "apt install fd-find | dnf install fd-find | brew install fd | winget install sharkdp.fd",
	},
	{
		tool: "rg",
		usedBy: "grep",
		manualInstall:
			"apt install ripgrep | dnf install ripgrep | brew install ripgrep | winget install BurntSushi.ripgrep.MSVC",
	},
	{
		tool: "ast-grep",
		usedBy: "ast_grep, read outline",
		manualInstall: "npm install -g @ast-grep/cli | cargo install ast-grep --locked | brew install ast-grep",
	},
];

/** First output line of `<path> --version`, or undefined when the binary cannot run here. */
function probeVersion(path: string): string | undefined {
	const result = spawnSync(path, ["--version"], { encoding: "utf8" });
	if (result.error || result.status !== 0) return undefined;
	return result.stdout.trim().split("\n")[0] || "unknown version";
}

/** Platform-specific reason a downloaded binary may fail, shown only after a failure. */
function failureHint(tool: ToolBinary): string | undefined {
	if (tool !== "ast-grep" || platform() !== "linux") return undefined;
	return "the downloaded ast-grep is a glibc build that needs glibc >= 2.34 and `unzip` to extract; on older or musl (Alpine) systems install it manually";
}

async function setupTool(spec: ToolSpec): Promise<boolean> {
	const path = await ensureTool(spec.tool, (status) => console.log(`  ${status.message}`));
	const version = path ? probeVersion(path) : undefined;
	if (path && version) {
		console.log(`  ok  ${spec.tool.padEnd(8)} ${version}  (${path})`);
		return true;
	}
	console.log(`  !!  ${spec.tool.padEnd(8)} unavailable; nek features affected: ${spec.usedBy}`);
	// nek prefers its own bin dir over PATH, so a broken download would shadow a manually installed binary.
	if (path) console.log(`      ${path} does not run on this system; delete it so nek uses the one on PATH`);
	const hint = failureHint(spec.tool);
	if (hint) console.log(`      note: ${hint}`);
	console.log(`      install manually: ${spec.manualInstall}`);
	return false;
}

async function main(): Promise<void> {
	console.log("Setting up search tools (fd, rg, ast-grep)...");
	let allOk = true;
	for (const spec of TOOLS) {
		if (!(await setupTool(spec))) allOk = false;
	}
	process.exitCode = allOk ? 0 : 1;
}

await main();
