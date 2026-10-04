/**
 * Text content of tool rows: the header (display name, primary argument, muted metadata) and the
 * result preview. Pure and Node-compatible; the view only maps segment tones to colors.
 */

import { getToolDisplayName } from "../../../coding-agent/src/core/tools/renderers/tool-names.ts";
import { firstLine, formatArgsInline, urlDomain } from "./format.ts";
import type { ToolBlock } from "./types.ts";

export type Tone = "text" | "output" | "muted" | "dim" | "accent" | "link" | "error" | "success" | "warning";

export interface Segment {
	text: string;
	tone: Tone;
	bold?: boolean;
}

export type Line = Segment[];

export interface ToolHeader {
	name: string;
	/** Web Search is drawn in blue. */
	nameTone: "title" | "link";
	arg: Segment | undefined;
	meta: string[];
}

export interface ToolPreview {
	lines: Line[];
	/** Lines not shown while collapsed. */
	hidden: number;
	/** Where the hidden lines were cut: before the shown lines (shell output keeps its end) or after. */
	hiddenAt?: "start" | "end";
}

const WEB_PREVIEW_RESULTS = 5;
const OUTPUT_PREVIEW_LINES = 6;
const SHELL_PREVIEW_LINES = 5;
const DIFF_PREVIEW_LINES = 12;
/** Collapsed preview lines are cut to this many characters before the view truncates them to the width. */
const PREVIEW_LINE_CHARS = 400;

type Args = Record<string, unknown>;

function asArgs(args: unknown): Args {
	return typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Args) : {};
}

function s(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function n(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Path relative to cwd when inside it, with forward slashes. */
export function displayPath(path: string, cwd: string): string {
	const normalized = path.replace(/\\/g, "/");
	const base = cwd.replace(/\\/g, "/").replace(/\/$/, "");
	if (base && normalized.toLowerCase().startsWith(`${base.toLowerCase()}/`)) return normalized.slice(base.length + 1);
	return normalized;
}

function limitMeta(args: Args): string | undefined {
	const limit = n(args.limit);
	return limit !== undefined ? `limit ${limit}` : undefined;
}

function compact(parts: Array<string | undefined>): string[] {
	return parts.filter((part): part is string => part !== undefined && part.length > 0);
}

/** Header of a tool row following `<name> <argument> <muted metadata>`. */
export function describeToolCall(name: string, rawArgs: unknown, cwd: string): ToolHeader {
	const args = asArgs(rawArgs);
	const header = (arg: Segment | undefined, meta: Array<string | undefined> = []): ToolHeader => ({
		name: getToolDisplayName(name),
		nameTone: name === "web_search" ? "link" : "title",
		arg,
		meta: compact(meta),
	});
	const path = s(args.file_path) ?? s(args.path);
	switch (name) {
		case "read": {
			const offset = n(args.offset);
			const limit = n(args.limit);
			const range =
				offset !== undefined || limit !== undefined
					? `lines ${offset ?? 1}${limit !== undefined ? `-${(offset ?? 1) + limit - 1}` : "+"}`
					: undefined;
			return header(path ? { text: displayPath(path, cwd), tone: "accent" } : undefined, [range]);
		}
		case "edit":
			return header(path ? { text: displayPath(path, cwd), tone: "accent" } : undefined, [
				args.replace_all === true ? "replace all" : undefined,
			]);
		case "write": {
			const content = typeof args.content === "string" ? args.content : undefined;
			const lines = content ? content.replace(/\n+$/, "").split("\n").length : 0;
			return header(path ? { text: displayPath(path, cwd), tone: "accent" } : undefined, [
				lines > 0 ? `${lines} line${lines === 1 ? "" : "s"}` : undefined,
			]);
		}
		case "grep":
			return header(s(args.pattern) ? { text: `/${args.pattern}/`, tone: "accent" } : undefined, [
				`in ${path ? displayPath(path, cwd) : "."}`,
				s(args.glob),
				limitMeta(args),
			]);
		case "find":
			return header(s(args.pattern) ? { text: String(args.pattern), tone: "accent" } : undefined, [
				`in ${path ? displayPath(path, cwd) : "."}`,
				limitMeta(args),
			]);
		case "ls":
			return header({ text: path ? displayPath(path, cwd) : ".", tone: "accent" }, [limitMeta(args)]);
		case "ast_grep":
			return header(s(args.pattern) ? { text: String(args.pattern), tone: "accent" } : undefined, [
				`in ${path ? displayPath(path, cwd) : "."}`,
				s(args.lang),
				limitMeta(args),
			]);
		case "bash":
		case "powershell": {
			const command = s(args.command);
			const multiline = command?.includes("\n") ?? false;
			const timeout = n(args.timeout);
			return header(
				command ? { text: firstLine(command, 200) + (multiline ? " …" : ""), tone: "text" } : undefined,
				[timeout ? `timeout ${timeout}s` : undefined],
			);
		}
		case "web_search":
			return header(s(args.query) ? { text: String(args.query), tone: "text" } : undefined);
		case "tool_search":
			return header(s(args.query) ? { text: String(args.query), tone: "accent" } : undefined, [limitMeta(args)]);
		case "todo_write": {
			const todos = Array.isArray(args.todos) ? args.todos.length : 0;
			return header(undefined, [
				todos > 0 ? `${todos} item${todos === 1 ? "" : "s"}` : undefined,
				args.merge === true ? "merge" : undefined,
			]);
		}
		case "switch_mode":
			return header(s(args.target_mode_id) ? { text: String(args.target_mode_id), tone: "accent" } : undefined);
		case "ask_question":
			return header(s(args.title) ? { text: String(args.title), tone: "text" } : undefined);
		case "create_plan":
		case "update_plan":
			return header(s(args.name) ? { text: String(args.name), tone: "text" } : undefined);
		case "subagent":
			return header(
				s(args.description) ? { text: firstLine(String(args.description), 120), tone: "text" } : undefined,
				[s(args.subagent_type) ?? s(args.type)],
			);
		default:
			return header(undefined, [formatArgsInline(rawArgs, 120) || undefined]);
	}
}

function textLines(text: string, tone: Tone): Line[] {
	return text
		.replace(/\r/g, "")
		.replace(/\t/g, "   ")
		.split("\n")
		.map((line) => [
			{ text: line.length > PREVIEW_LINE_CHARS ? `${line.slice(0, PREVIEW_LINE_CHARS)}…` : line, tone },
		]);
}

function trimTrailingEmpty(lines: Line[]): Line[] {
	let end = lines.length;
	while (end > 0 && lines[end - 1].every((segment) => segment.text.trim() === "")) end--;
	return lines.slice(0, end);
}

function window(lines: Line[], expanded: boolean, max: number, keep: "start" | "end"): ToolPreview {
	if (expanded || lines.length <= max) return { lines, hidden: 0 };
	const hidden = lines.length - max;
	return keep === "start"
		? { lines: lines.slice(0, max), hidden, hiddenAt: "end" }
		: { lines: lines.slice(-max), hidden, hiddenAt: "start" };
}

interface WebResult {
	title: string;
	url: string;
}

function webResults(details: unknown): WebResult[] | undefined {
	const results = (details as { results?: unknown } | undefined)?.results;
	if (!Array.isArray(results)) return undefined;
	return results
		.map((entry) => entry as { title?: unknown; url?: unknown })
		.filter((entry): entry is WebResult => typeof entry.title === "string" && typeof entry.url === "string");
}

/** Web Search results: a muted count, then `N. title domain` with the title in blue. */
export function webSearchPreview(results: readonly WebResult[], expanded: boolean): ToolPreview {
	if (results.length === 0) return { lines: [[{ text: "No results", tone: "muted" }]], hidden: 0 };
	const visible = expanded ? results : results.slice(0, WEB_PREVIEW_RESULTS);
	const width = String(visible.length).length;
	const lines: Line[] = [[{ text: `${results.length} result${results.length === 1 ? "" : "s"}`, tone: "muted" }]];
	for (const [index, result] of visible.entries()) {
		lines.push([
			{ text: `${String(index + 1).padStart(width)}. `, tone: "dim" },
			{ text: result.title.replace(/\s+/g, " ").trim(), tone: "link" },
			{ text: ` ${urlDomain(result.url)}`, tone: "muted" },
		]);
	}
	return { lines, hidden: results.length - visible.length };
}

function diffPreview(diff: string, expanded: boolean): ToolPreview {
	const lines = diff.split("\n").map((line): Line => {
		const tone: Tone = line.startsWith("+") ? "success" : line.startsWith("-") ? "error" : "dim";
		return [{ text: line.replace(/\t/g, "   "), tone }];
	});
	return window(trimTrailingEmpty(lines), expanded, DIFF_PREVIEW_LINES, "start");
}

/** Result preview of a tool row; collapsed previews keep a few lines, expanded show all. */
export function describeToolResult(block: ToolBlock, expanded: boolean): ToolPreview {
	const result = block.result;
	if (!result) return { lines: [], hidden: 0 };
	if (block.status === "error") {
		return window(trimTrailingEmpty(textLines(result.text, "error")), expanded, OUTPUT_PREVIEW_LINES, "start");
	}
	switch (block.name) {
		case "web_search": {
			const results = webResults(result.details);
			if (results) return webSearchPreview(results, expanded);
			break;
		}
		case "todo_write":
		case "switch_mode":
			// The todo panel and the mode badge show these results.
			return { lines: [], hidden: 0 };
		case "read":
			if (!expanded) return { lines: [], hidden: 0 };
			break;
		case "write":
			return { lines: [], hidden: 0 };
		case "edit": {
			const diff = (result.details as { diff?: unknown } | undefined)?.diff;
			if (typeof diff === "string") return diffPreview(diff, expanded);
			return { lines: [], hidden: 0 };
		}
		case "bash":
		case "powershell":
			return window(trimTrailingEmpty(textLines(result.text, "output")), expanded, SHELL_PREVIEW_LINES, "end");
	}
	return window(trimTrailingEmpty(textLines(result.text, "output")), expanded, OUTPUT_PREVIEW_LINES, "start");
}
