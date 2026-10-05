import type { CommandDefinition } from "./registry.ts";

export const newCommand: CommandDefinition = {
	name: "new",
	acceptsArgs: false,
	clearEditor: "before",
	run: async (ctx) => {
		try {
			const result = await ctx.runtimeHost.newSession();
			if (result.cancelled) return;
			ctx.transcript.clear();
			ctx.transcript.rebuildFromSession();
			ctx.editor.setText("");
			ctx.showStatus("New session started");
		} catch (error) {
			await ctx.handleFatalRuntimeError("Failed to create session", error);
		}
	},
};
