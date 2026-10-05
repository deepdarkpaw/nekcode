import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { modelArgumentCompletions, modelSelector } from "../selectors/model.ts";
import type { CommandDefinition } from "./registry.ts";

export const modelCommand: CommandDefinition = {
	name: "model",
	acceptsArgs: true,
	clearEditor: "before",
	getArgumentCompletions: (ctx, prefix): AutocompleteItem[] | null => modelArgumentCompletions(ctx, prefix),
	run: async (ctx, invocation) => {
		const model = await modelSelector.open(ctx, { search: invocation.args });
		if (!model) return;
		try {
			await ctx.session.setModel(model, { persist: false });
			ctx.refreshChrome();
			ctx.showStatus(`Model: ${model.id}`);
			void ctx.maybeWarnAboutAnthropicSubscriptionAuth(model);
		} catch (error) {
			ctx.showError(error instanceof Error ? error.message : String(error));
		}
	},
};
