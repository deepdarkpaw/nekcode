import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import { DEFAULT_NEK_CONFIG, loadNekConfig } from "../src/extensions/nek/config.ts";

describe("loadNekConfig", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "nek-config-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, CONFIG_DIR_NAME), { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("returns defaults when no file exists", () => {
		expect(loadNekConfig(agentDir, cwd, true)).toEqual(DEFAULT_NEK_CONFIG);
	});

	it("overlays user then trusted project values", () => {
		writeFileSync(join(agentDir, "nek.yaml"), "subagent:\n  maxConcurrent: 3\nplan:\n  shortcut: alt+p\n");
		writeFileSync(join(cwd, CONFIG_DIR_NAME, "nek.yaml"), "subagent:\n  maxConcurrent: 2\n");

		const config = loadNekConfig(agentDir, cwd, true);

		expect(config.subagent.maxConcurrent).toBe(2);
		expect(config.plan.shortcut).toBe("alt+p");
		expect(config.subagent.maxRetained).toBe(DEFAULT_NEK_CONFIG.subagent.maxRetained);
		expect(DEFAULT_NEK_CONFIG.subagent.maxConcurrent).toBe(6);
	});

	it("ignores the project file when the project is untrusted", () => {
		writeFileSync(join(cwd, CONFIG_DIR_NAME, "nek.yaml"), "subagent:\n  maxConcurrent: 2\n");
		expect(loadNekConfig(agentDir, cwd, false).subagent.maxConcurrent).toBe(6);
	});

	it("rejects unknown keys, wrong types, and invalid YAML with the file path", () => {
		const path = join(agentDir, "nek.yaml");
		writeFileSync(path, "subagent:\n  maxThreads: 3\n");
		expect(() => loadNekConfig(agentDir, cwd, true)).toThrow(`${path}: unknown key "subagent.maxThreads"`);

		writeFileSync(path, "todo:\n  settleReminder: yes please\n");
		expect(() => loadNekConfig(agentDir, cwd, true)).toThrow('"todo.settleReminder" must be a boolean');

		writeFileSync(path, "subagent: [1, 2\n");
		expect(() => loadNekConfig(agentDir, cwd, true)).toThrow(path);
	});
});
