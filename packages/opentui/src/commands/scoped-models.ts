import { scopedModelsSelector } from "../selectors/scoped-models.ts";
import type { CommandDefinition } from "./registry.ts";

export const scopedModelsCommand: CommandDefinition = {
	name: "scoped-models",
	acceptsArgs: false,
	clearEditor: "before",
	run: async (ctx) => {
		await scopedModelsSelector.open(ctx, undefined);
	},
};
