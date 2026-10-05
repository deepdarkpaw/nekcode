import { forkSelector } from "../selectors/fork.ts";
import type { CommandDefinition } from "./registry.ts";

export const forkCommand: CommandDefinition = {
	name: "fork",
	acceptsArgs: false,
	clearEditor: "after",
	run: async (ctx) => {
		const entryId = await forkSelector.open(ctx, undefined);
		if (!entryId) return;
		try {
			const result = await ctx.runtimeHost.fork(entryId);
			if (!result.cancelled) {
				ctx.editor.setText(result.selectedText ?? "");
				ctx.showStatus("Forked to new session");
			}
		} catch (error) {
			ctx.showError(error instanceof Error ? error.message : String(error));
		}
	},
};
