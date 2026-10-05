import type { CommandDefinition } from "./registry.ts";

export const debugCommand: CommandDefinition = {
	name: "debug",
	acceptsArgs: false,
	clearEditor: "after",
	hidden: true,
	run: (ctx) => {
		ctx.showStatus(`Debug log written: ${ctx.writeDebugLog()}`);
	},
};
