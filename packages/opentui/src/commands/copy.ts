import { copyToClipboard } from "@earendil-works/pi-coding-agent/utils/clipboard";
import type { CommandDefinition } from "./registry.ts";

export const copyCommand: CommandDefinition = {
	name: "copy",
	acceptsArgs: false,
	clearEditor: "after",
	run: async (ctx) => {
		const text = ctx.session.getLastAssistantText();
		if (!text) {
			ctx.showError("No agent messages to copy yet.");
			return;
		}
		try {
			await copyToClipboard(text);
			ctx.flash("Copied!");
		} catch (error) {
			ctx.showError(error instanceof Error ? error.message : String(error));
		}
	},
};
