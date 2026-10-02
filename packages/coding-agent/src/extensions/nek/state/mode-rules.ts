import { extname } from "node:path";
import type { Mode } from "../types.ts";
import { CREATE_PLAN_TOOL_NAME, SWITCH_MODE_TOOL_NAME, UPDATE_PLAN_TOOL_NAME } from "./session-state.ts";

/** File-editing tools that plan mode restricts to markdown targets (Cursor `<plan_mode_guardrails>`). */
export const PLAN_MODE_EDIT_TOOLS: readonly string[] = ["edit", "write"];

const MARKDOWN_EXTENSIONS: readonly string[] = [".md", ".markdown"];

/** Whether a path names a markdown file (`.md` or `.markdown`, case-insensitive). */
export function isMarkdownPath(path: string): boolean {
	return MARKDOWN_EXTENSIONS.includes(extname(path.trim()).toLowerCase());
}

/** Keep the approval-gated mode switch available in both modes; only Plan exposes plan authoring tools. */
export function modeToolNames(active: readonly string[], mode: Mode): string[] {
	const planTools = [CREATE_PLAN_TOOL_NAME, UPDATE_PLAN_TOOL_NAME];
	const next = mode === "agent" ? active.filter((name) => !planTools.includes(name)) : [...active];
	if (!next.includes(SWITCH_MODE_TOOL_NAME)) next.push(SWITCH_MODE_TOOL_NAME);
	if (mode === "plan") {
		for (const toolName of planTools) if (!next.includes(toolName)) next.push(toolName);
	}
	return next;
}

/** Target path of an edit (`file_path`, Claude Code schema) or write (`path`) call; empty when absent. */
function targetPath(input: Record<string, unknown>): string {
	if (typeof input.file_path === "string") return input.file_path;
	return typeof input.path === "string" ? input.path : "";
}

/**
 * Reason to block a tool call in the given mode, or undefined when it is allowed. In plan mode, edit and write may
 * only target markdown files; every other call is allowed.
 */
export function checkModeToolCall(mode: Mode, toolName: string, input: Record<string, unknown>): string | undefined {
	if (mode !== "plan" || !PLAN_MODE_EDIT_TOOLS.includes(toolName)) return undefined;
	const path = targetPath(input);
	if (isMarkdownPath(path)) return undefined;
	return `Plan mode: only markdown files can be edited. Call switch_mode with target_mode_id="agent" (requires user approval) before editing ${path}.`;
}
