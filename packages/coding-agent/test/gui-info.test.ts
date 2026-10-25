/**
 * `nek gui-info --json`: the launch description the desktop GUI spawns nek with.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildGuiInfo } from "../src/cli/gui-info.ts";
import { NEK_VERSION, VERSION } from "../src/config.ts";
import { NEK_GUI_PROTOCOL_VERSION } from "../src/modes/rpc/gui/protocol.ts";

describe("gui-info", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "nek-gui-info-"));
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	/** A source checkout as the installer leaves it: the state file at the root. */
	function createSourceInstall(): { root: string; entry: string } {
		const entry = join(root, "packages", "coding-agent", "src", "cli.ts");
		mkdirSync(dirname(entry), { recursive: true });
		writeFileSync(entry, "");
		writeFileSync(join(root, ".nek-install-state.json"), "{}\n");
		return { root, entry };
	}

	it("describes a source run with the source resolver preload", () => {
		const install = createSourceInstall();

		const info = buildGuiInfo({ cwd: install.root, agentDir: join(root, "agent"), entryPath: install.entry });

		expect(info.protocolVersion).toBe(NEK_GUI_PROTOCOL_VERSION);
		expect(info.nekVersion).toBe(NEK_VERSION);
		expect(info.piVersion).toBe(VERSION);
		expect(info.node.path).toBe(process.execPath);
		expect(info.node.version).toBe(process.version);
		expect(info.platform).toBe(process.platform);
		expect(info.arch).toBe(process.arch);
		expect(info.installDir).toBe(install.root);
		expect(info.launch.args).toHaveLength(3);
		expect(info.launch.args[0]).toBe("--import");
		expect(info.launch.args[1]).toBe(
			pathToFileURL(join(import.meta.dirname, "..", "src", "experimental", "source-resolver.ts")).href,
		);
		expect(info.launch.args[2]).toBe(install.entry);
	});

	it("describes a built run with the dist entry alone", () => {
		const entry = join(root, "dist", "cli.js");
		mkdirSync(dirname(entry), { recursive: true });
		writeFileSync(entry, "");

		const info = buildGuiInfo({ cwd: root, agentDir: join(root, "agent"), entryPath: entry });

		expect(info.launch.args).toEqual([entry]);
		expect(info.installDir).toBeUndefined();
	});

	it("reports the session root, defaulting to the agent directory", () => {
		const info = buildGuiInfo({ cwd: root, agentDir: join(root, "agent"), entryPath: join(root, "dist", "cli.js") });

		expect(info.agentDir).toBe(join(root, "agent"));
		expect(info.sessionDir).toBe(join(root, "agent", "sessions"));
	});
});
