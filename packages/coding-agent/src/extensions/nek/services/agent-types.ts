import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../../../config.ts";
import { parseFrontmatter } from "../../../utils/frontmatter.ts";
import { EXPLORE_INSTRUCTIONS } from "../prompts/subagent.ts";
import type { AgentType } from "../types.ts";

/** Read-only tool allowlist of the built-in explore type (plan.md section 7.3). */
export const READ_ONLY_TOOL_NAMES = ["read", "grep", "find", "ls", "ast_grep"] as const;

/** Tool allowlist of the built-in generalPurpose type (plan.md section 7.3). */
export const GENERAL_TOOL_NAMES = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"ast_grep",
	"todo_write",
] as const;

/** Tool allowlist of the built-in shell type (plan.md section 7.3). */
export const SHELL_TOOL_NAMES = ["bash", "read"] as const;

/** Built-in subagent types, in Cursor's order (reference/cursor/cursor-tools-2026.json line 679). */
export const BUILTIN_AGENT_TYPES: readonly AgentType[] = [
	{
		name: "generalPurpose",
		description:
			"handles substantial, clearly bounded general work that has already been determined suitable for delegation. Uncertain search results alone are not enough reason to use it.",
		source: "builtin",
		readonly: false,
		background: false,
		tools: [...GENERAL_TOOL_NAMES],
	},
	{
		name: "explore",
		description:
			"handles clearly bounded, substantial codebase exploration that has already been determined suitable for delegation. It can find files by patterns, search keywords, or map code structure. State the scope and desired depth: quick, medium, or very thorough.",
		source: "builtin",
		readonly: true,
		background: false,
		instructions: EXPLORE_INSTRUCTIONS,
		tools: [...READ_ONLY_TOOL_NAMES],
	},
	{
		name: "shell",
		description:
			"executes commands, Git operations, and other terminal work. Use it only when that work itself forms an independently delegable workflow.",
		source: "builtin",
		readonly: false,
		background: false,
		tools: [...SHELL_TOOL_NAMES],
	},
];

/** Subagent types plus the diagnostics of the files that could not be read; a bad file never fails the discovery. */
export interface AgentTypeDiscovery {
	types: AgentType[];
	errors: string[];
}

/** Directory of custom agent files below the agent dir (user) and the project config dir (project). */
export const AGENTS_DIR_NAME = "agents";

/**
 * Built-in types overlaid with `<agentDir>/agents/*.md` (user) and `<cwd>/.pi/agents/*.md` (project, trusted only).
 * A later source replaces the same name: project > user > builtin.
 */
export function discoverAgentTypes(agentDir: string, cwd: string, projectTrusted: boolean): AgentTypeDiscovery {
	const scans = [scanAgentDir(join(agentDir, AGENTS_DIR_NAME), "user")];
	if (projectTrusted) scans.push(scanAgentDir(join(cwd, CONFIG_DIR_NAME, AGENTS_DIR_NAME), "project"));
	const byName = new Map(BUILTIN_AGENT_TYPES.map((type) => [type.name, type]));
	const errors: string[] = [];
	for (const scan of scans) {
		for (const type of scan.types) byName.set(type.name, type);
		errors.push(...scan.errors);
	}
	return { types: [...byName.values()], errors };
}

/** Read every `*.md` in one agents directory. Missing directories yield nothing. */
function scanAgentDir(dir: string, source: "user" | "project"): AgentTypeDiscovery {
	if (!existsSync(dir)) return { types: [], errors: [] };
	const types: AgentType[] = [];
	const errors: string[] = [];
	for (const entry of readDirNames(dir, errors)) {
		const parsed = readAgentFile(join(dir, entry), source);
		if (typeof parsed === "string") errors.push(parsed);
		else types.push(parsed);
	}
	return { types, errors };
}

function readDirNames(dir: string, errors: string[]): string[] {
	try {
		return readdirSync(dir).filter((name) => name.endsWith(".md"));
	} catch (error) {
		errors.push(`${dir}: ${errorText(error)}`);
		return [];
	}
}

/** One agent file: the type, or an error string when the file is unreadable, invalid YAML, or lacks name/description. */
function readAgentFile(path: string, source: "user" | "project"): AgentType | string {
	let frontmatter: unknown;
	let body: string;
	try {
		const parsed = parseFrontmatter<Record<string, unknown>>(readFileSync(path, "utf-8"));
		frontmatter = parsed.frontmatter;
		body = parsed.body;
	} catch (error) {
		return `${path}: ${errorText(error)}`;
	}
	if (typeof frontmatter !== "object" || frontmatter === null) return `${path}: frontmatter must be a mapping`;
	const fields = frontmatter as Record<string, unknown>;
	const name = readString(fields.name);
	const description = readString(fields.description);
	if (!name || !description) return `${path}: frontmatter needs both "name" and "description"`;
	const readonly = fields.readonly === true;
	return {
		name,
		description,
		source,
		readonly,
		background: fields.is_background === true,
		model: readString(fields.model),
		instructions: body.trim() || undefined,
		tools: readonly ? [...READ_ONLY_TOOL_NAMES] : (readToolList(fields.tools) ?? [...GENERAL_TOOL_NAMES]),
	};
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** `tools` accepts both `a, b` and `[a, b]`; anything else is ignored rather than failing the file. */
function readToolList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const tools = raw.filter((item): item is string => typeof item === "string").map((item) => item.trim());
	const names = tools.filter((item) => item !== "");
	return names.length > 0 ? names : undefined;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Find one type by name; the lookup is case-sensitive like Cursor's subagent_type values. */
export function findAgentType(types: readonly AgentType[], name: string): AgentType | undefined {
	return types.find((type) => type.name === name);
}

/** Render the "Available subagent_type values" block of the task description. */
export function describeAgentTypes(types: readonly AgentType[]): string {
	const lines = types.map((type) => `- ${type.name}: ${type.description}`);
	return `Available subagent_type values\n\n${lines.join("\n")}`;
}
