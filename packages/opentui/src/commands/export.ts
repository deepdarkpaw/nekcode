import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { existingPathCompletion, firstPathArgument } from "./common.ts";
import type { CommandDefinition } from "./registry.ts";

export const exportCommand: CommandDefinition = {
	name: "export",
	acceptsArgs: true,
	clearEditor: "after",
	getArgumentCompletions: (_ctx, prefix): AutocompleteItem[] | null => existingPathCompletion(prefix),
	run: async (ctx, invocation) => {
		const outputPath = firstPathArgument(invocation.args);
		try {
			if (outputPath?.endsWith(".jsonl")) {
				ctx.showStatus(`Session exported to: ${ctx.session.exportToJsonl(outputPath)}`);
			} else {
				const themeSetting = ctx.theme.getThemeSelection();
				const path = await ctx.session.exportToHtml(outputPath, {
					themeName: themeSetting?.includes("/") ? undefined : themeSetting,
				});
				ctx.showStatus(`Session exported to: ${path}`);
			}
		} catch (error) {
			ctx.showError(`Failed to export session: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
	},
};
