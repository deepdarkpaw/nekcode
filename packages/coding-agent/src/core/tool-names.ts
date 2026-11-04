/**
 * Built-in tool names and the `defaultTools` selection rules.
 *
 * This module has no imports so settings can resolve the selection without loading the tool implementations.
 */

/** Built-in names in factory order; separate from the mutable public lookup set. */
export const BUILTIN_TOOL_NAMES = [
	"read",
	"bash",
	"powershell",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"ast_grep",
	"web_search",
] as const;

/** Names of the built-in tools. */
export type ToolName = (typeof BUILTIN_TOOL_NAMES)[number];
export const allToolNames: Set<ToolName> = new Set(BUILTIN_TOOL_NAMES);

/** Built-in tools active in a new session when neither settings nor options select tools. */
export const DEFAULT_ACTIVE_TOOL_NAMES: readonly ToolName[] = [
	"read",
	"bash",
	"edit",
	"write",
	"grep",
	"find",
	"ls",
	"ast_grep",
	"web_search",
];

/** Resolved `defaultTools` selection. */
export interface DefaultToolsResolution {
	/** Active built-in tools, in selection order. */
	names: string[];
	/** Entries that name no built-in tool; they are reported as diagnostics and otherwise ignored. */
	unknown: string[];
}

function isKnownTool(name: string, known: ReadonlySet<string>): boolean {
	return known.has(name);
}

/**
 * Resolve `defaultTools` entries.
 *
 * An entry is a tool name, `+name` to add a tool to the base selection, or `-name` to remove one. Entries
 * without a prefix form the base selection; when only prefixed entries are given the base is
 * `DEFAULT_ACTIVE_TOOL_NAMES`, so `["+powershell"]` means "the defaults plus powershell". An empty list keeps
 * its documented meaning: no built-in tools. Additions keep their order and never duplicate an already
 * selected tool; removals that match nothing are ignored.
 */
export function resolveDefaultTools(
	entries: readonly string[],
	known: ReadonlySet<string> = allToolNames,
	defaults: readonly string[] = DEFAULT_ACTIVE_TOOL_NAMES,
): DefaultToolsResolution {
	const unknown: string[] = [];
	const baseEntries: string[] = [];
	const additions: string[] = [];
	const removals: string[] = [];
	for (const raw of entries) {
		const entry = raw.trim();
		if (!entry) continue;
		const prefix = entry.startsWith("+") || entry.startsWith("-") ? entry[0] : undefined;
		const name = prefix === undefined ? entry : entry.slice(1).trim();
		if (!name) {
			unknown.push(entry);
			continue;
		}
		if (!isKnownTool(name, known)) unknown.push(name);
		if (prefix === "+") additions.push(name);
		else if (prefix === "-") removals.push(name);
		else baseEntries.push(name);
	}

	const selected: string[] = [];
	const add = (name: string) => {
		if (!isKnownTool(name, known) || selected.includes(name)) return;
		selected.push(name);
	};
	const base = entries.every((entry) => !entry.trim()) ? [] : baseEntries.length > 0 ? baseEntries : defaults;
	for (const name of base) add(name);
	for (const name of removals) {
		const index = selected.indexOf(name);
		if (index >= 0) selected.splice(index, 1);
	}
	for (const name of additions) add(name);
	return { names: selected, unknown: [...new Set(unknown)] };
}
