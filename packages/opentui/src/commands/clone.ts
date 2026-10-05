import type { CommandDefinition } from "./registry.ts";

export const cloneCommand: CommandDefinition = {
	name: "clone",
	acceptsArgs: false,
	clearEditor: "before",
	run: async (ctx) => {
		const leafId = ctx.sessionManager.getLeafId();
		if (!leafId) {
			ctx.showStatus("Nothing to clone yet");
			return;
		}
		try {
			const result = await ctx.runtimeHost.fork(leafId, { position: "at" });
			if (!result.cancelled) {
				ctx.editor.setText("");
				ctx.showStatus("Cloned to new session");
			}
		} catch (error) {
			ctx.showError(error instanceof Error ? error.message : String(error));
		}
	},
};
