/**
 * `@kind:name` mentions in user input: `@agent:<type>` names a subagent type and `@skill:<name>` a skill. A plain
 * `@path` stays a file reference.
 */

/** Kinds of `@kind:name` mentions. */
export type MentionKind = "agent" | "skill";

/** One `@kind:name` mention and its span `[start, end)` in the text. */
export interface Mention {
	kind: MentionKind;
	name: string;
	start: number;
	end: number;
}

/**
 * A mention starts at a token boundary, so `user@skill:x` or `a/@skill:x` are not mentions. Names may contain dots and
 * hyphens (`gpt-6.1-sol-worker`) but end with a word character, so trailing sentence punctuation is not part of them.
 */
const MENTION_REGEX = /(?<![\w.@/-])@(agent|skill):([\w.-]*\w)/g;

/** Text form of a mention, e.g. `@skill:pdf`. */
export function formatMention(kind: MentionKind, name: string): string {
	return `@${kind}:${name}`;
}

/** Every `@kind:name` mention in `text`, in order. */
export function findAllMentions(text: string): Mention[] {
	return Array.from(text.matchAll(MENTION_REGEX), (match) => ({
		kind: match[1] as MentionKind,
		name: match[2]!,
		start: match.index,
		end: match.index + match[0].length,
	}));
}

/** Names of one kind mentioned in `text`, in order of first mention, without duplicates. */
export function findMentions(text: string, kind: MentionKind): string[] {
	const names = findAllMentions(text)
		.filter((mention) => mention.kind === kind)
		.map((mention) => mention.name);
	return [...new Set(names)];
}
