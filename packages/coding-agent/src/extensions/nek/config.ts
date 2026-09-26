import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { CONFIG_DIR_NAME } from "../../config.ts";
import { stripBom } from "../../utils/text.ts";

/** All configurable values of the nek extension. Every collection limit lives here. */
export interface NekConfig {
	plan: {
		/** Plan file directory, relative to cwd. */
		dir: string;
		/** Keybinding that toggles plan mode. */
		shortcut: string;
	};
	todo: {
		/** Continue the run once when it would end with open todos (Cursor task_management). */
		settleReminder: boolean;
		/** Maximum todo lines shown in the widget above the editor. */
		widgetMaxLines: number;
	};
	subagent: {
		maxConcurrent: number;
		maxRetained: number;
		awaitDefaultMs: number;
		awaitMaxMs: number;
		finalTextMaxBytes: number;
		progressMaxLines: number;
	};
}

/** Defaults (ARD section 7). */
export const DEFAULT_NEK_CONFIG: NekConfig = {
	plan: { dir: ".pi/plans", shortcut: "alt+m" },
	todo: { settleReminder: true, widgetMaxLines: 8 },
	subagent: {
		maxConcurrent: 6,
		maxRetained: 32,
		awaitDefaultMs: 30_000,
		awaitMaxMs: 7_140_000,
		finalTextMaxBytes: 32_768,
		progressMaxLines: 5,
	},
};

/** File name of the nek config in the agent dir and in the project config dir. */
export const NEK_CONFIG_FILE = "nek.yaml";

/**
 * Load `<agentDir>/nek.yaml`, then `<cwd>/.pi/nek.yaml` when the project is trusted, over the defaults.
 * Missing files are skipped. Invalid YAML, unknown keys, and mistyped values throw with the file path.
 */
export function loadNekConfig(agentDir: string, cwd: string, projectTrusted: boolean): NekConfig {
	const paths = [join(agentDir, NEK_CONFIG_FILE)];
	if (projectTrusted) paths.push(join(cwd, CONFIG_DIR_NAME, NEK_CONFIG_FILE));
	let config = DEFAULT_NEK_CONFIG;
	for (const path of paths) {
		const overrides = readConfigFile(path);
		if (overrides) config = mergeNekConfig(config, overrides, path);
	}
	return config;
}

function readConfigFile(path: string): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	let parsed: unknown;
	try {
		parsed = parse(stripBom(readFileSync(path, "utf-8")));
	} catch (error) {
		throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
	}
	if (parsed === null || parsed === undefined) return undefined;
	if (!isRecord(parsed)) throw new Error(`${path}: expected a mapping at the top level`);
	return parsed;
}

/** Overlay one parsed file onto a config. Values must match the type of the default they replace. */
export function mergeNekConfig(base: NekConfig, overrides: Record<string, unknown>, path: string): NekConfig {
	const result = structuredClone(base);
	for (const [sectionName, sectionValue] of Object.entries(overrides)) {
		if (!isNekSection(sectionName)) throw new Error(`${path}: unknown section "${sectionName}"`);
		if (!isRecord(sectionValue)) throw new Error(`${path}: "${sectionName}" must be a mapping`);
		const section: Record<string, unknown> = result[sectionName];
		for (const [key, value] of Object.entries(sectionValue)) {
			const name = `${sectionName}.${key}`;
			if (!Object.hasOwn(section, key)) throw new Error(`${path}: unknown key "${name}"`);
			if (typeof value !== typeof section[key])
				throw new Error(`${path}: "${name}" must be a ${typeof section[key]}`);
			if (typeof value === "number" && !(Number.isFinite(value) && value >= 0)) {
				throw new Error(`${path}: "${name}" must be a non-negative number`);
			}
			section[key] = value;
		}
	}
	return result;
}

function isNekSection(name: string): name is keyof NekConfig {
	return Object.hasOwn(DEFAULT_NEK_CONFIG, name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
