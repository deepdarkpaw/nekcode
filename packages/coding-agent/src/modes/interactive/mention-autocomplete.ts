import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";
import { formatMention, type MentionKind } from "../../core/mentions.ts";

/** One `@kind:name` completion target: a subagent type or a skill. */
export interface MentionTarget {
	kind: MentionKind;
	name: string;
	description?: string;
}

/**
 * The `@` token before the cursor: at the line start, or after whitespace, `=`, `<`, a backtick, or punctuation other
 * than path and address characters. Quoted `@"` paths stay with the wrapped provider.
 */
const MENTION_QUERY_REGEX = /(?:^|[\s=<`]|[^\P{P}@./\\_-])@([^\s"'`@]*)$/u;

/** Query typed after `@` before the cursor, or undefined when the cursor is not in an `@` token. */
export function mentionQuery(textBeforeCursor: string): string | undefined {
	return MENTION_QUERY_REGEX.exec(textBeforeCursor)?.[1];
}

/** Targets matching the query: bare-name matches first, then matches of the full `kind:name` form. */
export function matchMentionTargets(targets: readonly MentionTarget[], query: string): MentionTarget[] {
	const byName = fuzzyFilter([...targets], query, (target) => target.name);
	const matched = new Set(byName);
	const byToken = fuzzyFilter(
		targets.filter((target) => !matched.has(target)),
		query,
		(target) => `${target.kind}:${target.name}`,
	);
	return [...byName, ...byToken];
}

function toAutocompleteItem(target: MentionTarget): AutocompleteItem {
	return {
		value: formatMention(target.kind, target.name),
		label: `${target.kind}:${target.name}`,
		...(target.description ? { description: target.description } : {}),
	};
}

/**
 * Wrap `current` so an `@` token also offers mention targets, listed before the suggestions of `current` for the same
 * token. Selecting one goes through `current.applyCompletion`, which inserts `@kind:name ` like any `@` completion.
 */
export function withMentionCompletions(
	current: AutocompleteProvider,
	getTargets: () => readonly MentionTarget[],
): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const base = await current.getSuggestions(lines, cursorLine, cursorCol, options);
			const query = mentionQuery((lines[cursorLine] ?? "").slice(0, cursorCol));
			if (query === undefined || options.signal.aborted) return base;
			const targets = matchMentionTargets(getTargets(), query);
			if (targets.length === 0) return base;
			const prefix = `@${query}`;
			const rest = base?.prefix === prefix ? base.items : [];
			return { items: [...targets.map(toAutocompleteItem), ...rest], prefix };
		},
		applyCompletion: (lines, cursorLine, cursorCol, item, prefix) =>
			current.applyCompletion(lines, cursorLine, cursorCol, item, prefix),
		shouldTriggerFileCompletion: (lines, cursorLine, cursorCol) =>
			current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true,
	};
}
