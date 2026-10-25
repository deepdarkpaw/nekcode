import { tmpdir } from "node:os";
import { type AutocompleteProvider, CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { findMentions } from "../src/core/mentions.ts";
import {
	type MentionTarget,
	mentionQuery,
	withMentionCompletions,
} from "../src/modes/interactive/mention-autocomplete.ts";

const agents: MentionTarget[] = [
	{ kind: "agent", name: "generalPurpose", description: "writable" },
	{ kind: "agent", name: "explorer", description: "read-only" },
];
const skills: MentionTarget[] = [{ kind: "skill", name: "pdf", description: "PDF files" }];

function suggest(provider: AutocompleteProvider, line: string) {
	return provider.getSuggestions([line], 0, line.length, { signal: new AbortController().signal });
}

/** Base without fd: it offers no `@` file suggestions, like a project with no matching file. */
function fileProvider(): AutocompleteProvider {
	return new CombinedAutocompleteProvider([], tmpdir(), null);
}

describe("findMentions", () => {
	it("finds agent and skill mentions only at token boundaries", () => {
		const text =
			"用 @agent:explorer 看看，然后（@skill:pdf）处理 @skill:pdf. 邮箱 user@skill:mail 和 a/@agent:x 不算";
		expect(findMentions(text, "agent")).toEqual(["explorer"]);
		expect(findMentions(text, "skill")).toEqual(["pdf"]);
	});

	it("keeps dots inside a name but not trailing punctuation", () => {
		expect(findMentions("ask @agent:gpt-6.1-sol-worker.", "agent")).toEqual(["gpt-6.1-sol-worker"]);
	});
});

describe("mentionQuery", () => {
	it("reads the @ token before the cursor", () => {
		expect(mentionQuery("@")).toBe("");
		expect(mentionQuery("see @exp")).toBe("exp");
		expect(mentionQuery("看（@agent:ex")).toBe("agent:ex");
	});

	it("ignores addresses, path segments, and quoted paths", () => {
		expect(mentionQuery("user@ag")).toBeUndefined();
		expect(mentionQuery("src/@ag")).toBeUndefined();
		expect(mentionQuery('@"src/fo')).toBeUndefined();
	});
});

describe("withMentionCompletions", () => {
	it("offers subagents and skills for a bare @ and filters them by name or kind", async () => {
		const provider = withMentionCompletions(
			withMentionCompletions(fileProvider(), () => skills),
			() => agents,
		);

		const all = await suggest(provider, "@");
		expect(all?.prefix).toBe("@");
		expect(all?.items.map((item) => item.value)).toEqual(["@agent:generalPurpose", "@agent:explorer", "@skill:pdf"]);

		const byName = await suggest(provider, "use @exp");
		expect(byName?.items[0]).toEqual({ value: "@agent:explorer", label: "agent:explorer", description: "read-only" });

		const byKind = await suggest(provider, "@skill:");
		expect(byKind?.items.map((item) => item.value)).toEqual(["@skill:pdf"]);
	});

	it("lists mention targets before the file suggestions of the same token", async () => {
		const files: AutocompleteProvider = {
			getSuggestions: async () => ({ items: [{ value: "@explorer.md", label: "explorer.md" }], prefix: "@exp" }),
			applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }),
		};

		const result = await suggest(
			withMentionCompletions(files, () => agents),
			"@exp",
		);

		expect(result?.items.map((item) => item.value)).toEqual(["@agent:explorer", "@explorer.md"]);
	});

	it("inserts the mention with a trailing space and leaves other input to the wrapped provider", async () => {
		const provider = withMentionCompletions(fileProvider(), () => agents);
		const line = "ask @exp";
		const suggestions = await suggest(provider, line);
		const item = suggestions?.items[0];
		if (!suggestions || !item) throw new Error("expected an agent suggestion");

		const result = provider.applyCompletion([line], 0, line.length, item, suggestions.prefix);

		expect(result.lines).toEqual(["ask @agent:explorer "]);
		expect(result.cursorCol).toBe("ask @agent:explorer ".length);
		expect(await suggest(provider, "hello")).toBeNull();
		expect(await suggest(provider, "@zzz")).toBeNull();
	});
});
