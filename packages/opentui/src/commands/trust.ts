import { trustSelector } from "../selectors/trust.ts";
import type { CommandDefinition } from "./registry.ts";

export const trustCommand: CommandDefinition = {
	name: "trust",
	acceptsArgs: false,
	clearEditor: "after",
	run: async (ctx) => {
		const selection = await trustSelector.open(ctx, undefined);
		if (selection)
			ctx.showStatus(
				`Saved trust decision: ${selection.trusted ? "trusted" : "untrusted"}. Restart nek for this to take effect.`,
			);
	},
};
