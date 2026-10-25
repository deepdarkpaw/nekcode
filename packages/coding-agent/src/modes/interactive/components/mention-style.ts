import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getCapabilities, hyperlink } from "@earendil-works/pi-tui";
import { findAllMentions } from "../../../core/mentions.ts";
import { theme } from "../theme/theme.ts";

/** What mentions link to: a skill's SKILL.md, or an `@path` relative to the working directory. */
export interface MentionLinks {
	cwd: string;
	skillFile(name: string): string | undefined;
}

/** Mention links of a session: its working directory and its loaded skills. */
export function sessionMentionLinks(cwd: string, skills: readonly { name: string; filePath: string }[]): MentionLinks {
	return { cwd, skillFile: (name) => skills.find((skill) => skill.name === name)?.filePath };
}

/** One styled span `[start, end)` of plain text and the file it links to, if any. */
interface StyledSpan {
	start: number;
	end: number;
	file?: string;
}

/**
 * `@path` or `@"path with spaces"` at a token boundary, like the editor's file completion inserts. An unquoted path
 * ends at whitespace, quotes, or CJK and full-width punctuation, which file completion also treats as separators.
 */
const PATH_MENTION_REGEX =
	/(?<![\w.@/-])@(?:"([^"\n]+)"|([^\s"'`@\u3000-\u303f\uff01-\uff0f\uff1a-\uff20\uff3b-\uff40\uff5b-\uff65]+))/g;
/** Sentence punctuation after an unquoted path is not part of it. */
const TRAILING_PUNCTUATION_REGEX = /[.,;:!?)\]}>]+$/;
/** One escape sequence: CSI (colors, the editor cursor), or OSC/APC/DCS/PM ended by BEL or ST (links, cursor marker). */
const ESCAPE_REGEX = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]_P^][^\x07\x1b]*(?:\x07|\x1b\\))/y;

function mentionStyle(text: string): string {
	return theme.fg("mdLink", text);
}

function expandHome(path: string): string {
	return path === "~" || path.startsWith("~/") ? join(homedir(), path.slice(1)) : path;
}

/** Existing file or directory an `@path` names; `@agent:`/`@skill:` are not paths. */
function resolveMentionedPath(path: string, cwd: string): string | undefined {
	if (/^(agent|skill):/.test(path)) return undefined;
	const expanded = expandHome(path);
	const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded);
	return existsSync(absolute) ? absolute : undefined;
}

/** Spans of `@agent:`/`@skill:` mentions, and of `@path` mentions of existing files when links are known. */
function findStyledSpans(
	text: string,
	links: MentionLinks | undefined,
	resolvePath: (path: string) => string | undefined,
) {
	const spans: StyledSpan[] = findAllMentions(text).map((mention) => ({
		start: mention.start,
		end: mention.end,
		file: mention.kind === "skill" ? links?.skillFile(mention.name) : undefined,
	}));
	if (!links) return spans;
	for (const match of text.matchAll(PATH_MENTION_REGEX)) {
		const path = match[1] ?? match[2]!.replace(TRAILING_PUNCTUATION_REGEX, "");
		const file = path ? resolvePath(path) : undefined;
		if (!file) continue;
		const end = match.index + (match[1] !== undefined ? match[0].length : path.length + 1);
		spans.push({ start: match.index, end, file });
	}
	return spans.sort((a, b) => a.start - b.start);
}

/**
 * Text styler for user messages: plain text keeps `styleText`, mentions use the link color. With OSC 8 hyperlinks,
 * skill mentions open their SKILL.md and `@path` mentions of existing files open the file. Path lookups are cached
 * for the styler's lifetime, one user message.
 */
export function createMentionStyler(
	styleText: (text: string) => string,
	links: MentionLinks | undefined,
): (text: string) => string {
	const resolved = new Map<string, string | undefined>();
	const resolvePath = (path: string): string | undefined => {
		if (!links) return undefined;
		if (!resolved.has(path)) resolved.set(path, resolveMentionedPath(path, links.cwd));
		return resolved.get(path);
	};
	const plain = (text: string): string => (text ? styleText(text) : "");
	return (text) => {
		if (!text.includes("@")) return styleText(text);
		let result = "";
		let last = 0;
		for (const span of findStyledSpans(text, links, resolvePath)) {
			if (span.start < last) continue;
			const label = mentionStyle(text.slice(span.start, span.end));
			const linked =
				span.file && getCapabilities().hyperlinks
					? hyperlink(theme.underline(label), pathToFileURL(span.file).href)
					: label;
			result += plain(text.slice(last, span.start)) + linked;
			last = span.end;
		}
		return result + plain(text.slice(last));
	};
}

/**
 * Color the `@agent:`/`@skill:` mentions of one rendered editor line, which may already contain escape sequences
 * (the cursor). Mentions are found in the visible text; each run of a mention between escape sequences is colored on
 * its own, so the cursor inside a mention keeps it colored.
 */
export function styleMentionsInLine(line: string): string {
	if (!line.includes("@")) return line;
	let plain = "";
	const offsets: number[] = [];
	for (let index = 0; index < line.length; ) {
		ESCAPE_REGEX.lastIndex = index;
		const sequence = ESCAPE_REGEX.exec(line);
		if (sequence) {
			index += sequence[0].length;
			continue;
		}
		offsets.push(index);
		plain += line[index];
		index++;
	}
	let result = "";
	let last = 0;
	for (const mention of findAllMentions(plain)) {
		for (let start = mention.start; start < mention.end; ) {
			let end = start + 1;
			while (end < mention.end && offsets[end] === offsets[end - 1]! + 1) end++;
			const from = offsets[start]!;
			const to = offsets[end - 1]! + 1;
			result += line.slice(last, from) + mentionStyle(line.slice(from, to));
			last = to;
			start = end;
		}
	}
	return result + line.slice(last);
}
