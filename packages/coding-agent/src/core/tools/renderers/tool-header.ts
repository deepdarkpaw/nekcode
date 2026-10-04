/**
 * Shared tool row header.
 *
 * Every tool row starts with the same three parts, in decreasing visual weight:
 * `<display name: bold, toolTitle> <primary argument> <muted metadata>`.
 * The primary argument is styled by the caller (paths and patterns use accent, commands use text);
 * metadata parts are joined with ` · ` and rendered muted.
 */

import type { Theme, ThemeColor } from "../../../modes/interactive/theme/theme.ts";

export { getToolDisplayName, MCP_NAME_SEPARATOR, TOOL_DISPLAY_NAMES, toTitleCase } from "./tool-names.ts";

export interface ToolHeaderParts {
	/** Display name, see `getToolDisplayName`. Rendered bold. */
	name: string;
	/** Styled primary argument; omitted when empty. */
	arg?: string;
	/** Unstyled metadata parts; empty and undefined parts are dropped. */
	meta?: ReadonlyArray<string | undefined | null | false>;
	/** Already styled suffix appended after the metadata, such as an expand hint. */
	suffix?: string;
	/** Color of the name. Defaults to `toolTitle`; Web Search uses a blue token. */
	nameColor?: ThemeColor;
}

/** Separator between metadata parts. */
export const TOOL_META_SEPARATOR = " · ";

/** Muted metadata parts joined with ` · `, or "" when there are none. */
export function formatToolMeta(theme: Theme, meta: ToolHeaderParts["meta"]): string {
	const parts = (meta ?? []).filter((part): part is string => typeof part === "string" && part.length > 0);
	return parts.length > 0 ? theme.fg("muted", parts.join(TOOL_META_SEPARATOR)) : "";
}

/** One header line following the tool row contract. */
export function formatToolHeader(theme: Theme, parts: ToolHeaderParts): string {
	let text = theme.fg(parts.nameColor ?? "toolTitle", theme.bold(parts.name));
	if (parts.arg) text += ` ${parts.arg}`;
	const meta = formatToolMeta(theme, parts.meta);
	if (meta) text += ` ${meta}`;
	if (parts.suffix) text += parts.suffix;
	return text;
}
