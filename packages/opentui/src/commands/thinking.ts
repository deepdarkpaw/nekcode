import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { thinkingSelector } from "../selectors/thinking.ts";
import type { CommandDefinition } from "./registry.ts";

export const thinkingCommand: CommandDefinition = {
	name: "thinking",
	acceptsArgs: true,
	clearEditor: "before",
	getArgumentCompletions: (ctx, prefix): AutocompleteItem[] | null =>
		fuzzyFilter(ctx.session.getAvailableThinkingLevels(), prefix, (level) => level).map((level) => ({
			value: level,
			label: level,
		})),
	run: async (ctx, invocation) => {
		const level = invocation.args?.trim().toLowerCase() as ThinkingLevel | undefined;
		const selected = level
			? (ctx.session.getAvailableThinkingLevels().find((candidate) => candidate === level) as
					| ThinkingLevel
					| undefined)
			: await thinkingSelector.open(ctx, undefined);
		if (!selected) {
			if (level)
				ctx.showError(
					`Unknown thinking level "${invocation.args}". Available levels: ${ctx.session.getAvailableThinkingLevels().join(", ")}.`,
				);
			return;
		}
		try {
			ctx.session.setThinkingLevel(selected, { persist: false });
			ctx.refreshChrome();
			ctx.showStatus(`Thinking level: ${selected}`);
		} catch (error) {
			ctx.showError(error instanceof Error ? error.message : String(error));
		}
	},
};
