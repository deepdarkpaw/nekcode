import type { CommandDefinition } from "./registry.ts";

export const reloadCommand: CommandDefinition = {
	name: "reload",
	acceptsArgs: false,
	clearEditor: "before",
	run: async (ctx) => {
		await ctx.reload();
	},
};
