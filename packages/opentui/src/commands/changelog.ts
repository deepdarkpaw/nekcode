import {
	getChangelogPath,
	normalizeChangelogLinks,
	parseChangelog,
} from "@earendil-works/pi-coding-agent/utils/changelog";
import type { CommandDefinition } from "./registry.ts";

export const changelogCommand: CommandDefinition = {
	name: "changelog",
	acceptsArgs: false,
	clearEditor: "after",
	run: (ctx) => {
		const entries = parseChangelog(getChangelogPath());
		const markdown =
			entries.length > 0
				? [...entries]
						.reverse()
						.map((entry) => normalizeChangelogLinks(entry.content, entry))
						.join("\n\n")
				: "No changelog entries found.";
		ctx.transcript.appendMarkdown(markdown, { title: "What's New", bordered: true });
	},
};
