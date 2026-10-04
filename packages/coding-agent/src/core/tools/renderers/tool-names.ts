/**
 * Display names for tool rows.
 *
 * Tool rows never show snake_case function names. This module has no imports so that every
 * presentation (the built-in TUI, extension renderers, and the OpenTUI frontend) can share one table.
 */

/** Display names of tools with a fixed name in the UI. */
export const TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
	todo_write: "Todos",
	switch_mode: "Mode",
	ask_question: "Question",
	create_plan: "Plan",
	update_plan: "Plan update",
	await: "Waiting",
	subagent: "Subagent",
	web_search: "Web Search",
	tool_search: "Tool Search",
	ast_grep: "AST Search",
	grep: "Search",
	find: "Find",
	ls: "List",
	read: "Read",
	edit: "Edit",
	write: "Write",
	bash: "Bash",
	powershell: "PowerShell",
	read_mcp_resource: "MCP Resource",
};

/** Separator between an MCP server and its tool, as in `github › create_issue`. */
export const MCP_NAME_SEPARATOR = " › ";

const MCP_PREFIX = "mcp__";

/** `my_tool`, `my-tool`, or `myTool` turned into `My Tool`. */
export function toTitleCase(name: string): string {
	return name
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.split(/[_\-\s]+/)
		.filter((word) => word.length > 0)
		.map((word) => word[0].toUpperCase() + word.slice(1))
		.join(" ");
}

/** Whether a string looks like a function identifier (`my_tool`, `mytool`) rather than a display label. */
function isIdentifierLike(value: string): boolean {
	return /^[a-z][a-z0-9]*([_-][a-z0-9]+)*$/.test(value);
}

/** `server › tool` for an MCP tool label (`server/tool`) or generated name (`mcp__server__tool`). */
export function formatMcpToolName(server: string, tool: string): string {
	return `${server}${MCP_NAME_SEPARATOR}${tool}`;
}

function mcpNameFromGenerated(name: string): string | undefined {
	if (!name.startsWith(MCP_PREFIX)) return undefined;
	const rest = name.slice(MCP_PREFIX.length);
	const split = rest.indexOf("__");
	if (split <= 0 || split === rest.length - 2) return undefined;
	return formatMcpToolName(rest.slice(0, split), rest.slice(split + 2));
}

/**
 * Display name of a tool row: the fixed table entry, then the MCP `server › tool` form, then the
 * definition label when it is a real label, else the name in Title Case.
 */
export function getToolDisplayName(name: string, label?: string): string {
	const fixed = TOOL_DISPLAY_NAMES[name];
	if (fixed) return fixed;
	const mcp = mcpNameFromGenerated(name);
	if (mcp) return mcp;
	const source = label && label !== name ? label : name;
	return isIdentifierLike(source) ? toTitleCase(source) : source;
}
