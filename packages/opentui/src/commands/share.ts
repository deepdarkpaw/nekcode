import { shareSessionHeadless } from "@earendil-works/pi-coding-agent/modes/interactive/session-share-native";
import type { CommandDefinition } from "./registry.ts";

export const shareCommand: CommandDefinition = {
	name: "share",
	acceptsArgs: false,
	clearEditor: "after",
	run: async (ctx) => {
		try {
			const url = await ctx.runExternal(() => shareSessionHeadless(ctx.session, ctx.theme.getThemeSelection()));
			ctx.showStatus(`Share URL: ${url}`);
		} catch (error) {
			ctx.showError(`Failed to share session: ${error instanceof Error ? error.message : String(error)}`);
		}
	},
};
