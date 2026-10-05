import { ArminComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/armin";
import type { CommandDefinition } from "./registry.ts";

export const arminsayshiCommand: CommandDefinition = {
	name: "arminsayshi",
	acceptsArgs: false,
	clearEditor: "after",
	hidden: true,
	run: (ctx) => {
		ctx.transcript.appendComponent(new ArminComponent(ctx.tui));
	},
};
