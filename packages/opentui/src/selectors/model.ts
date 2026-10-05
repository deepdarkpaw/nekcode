import type { Api, Model } from "@earendil-works/pi-ai";
import { findExactModelReferenceMatch } from "@earendil-works/pi-coding-agent/core/model-resolver";
import { ModelSelectorComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/model-selector";
import { getModelSearchText } from "@earendil-works/pi-coding-agent/modes/interactive/model-search";
import { type AutocompleteItem, fuzzyFilter } from "@earendil-works/pi-tui";
import type { ModeContext } from "../mode/mode-context.ts";
import { openHosted } from "./hosted.ts";
import { defineSelector } from "./types.ts";

export const modelSelector = defineSelector<{ search?: string }, Model<Api>>({
	id: "model",
	async open(ctx, args) {
		const models =
			ctx.session.scopedModels.length > 0
				? ctx.session.scopedModels.map((entry) => entry.model)
				: [...ctx.session.modelRuntime.getAvailableSnapshot()];
		if (args.search) {
			const exact = findExactModelReferenceMatch(args.search, models);
			if (exact) return exact;
		}
		return openHosted<Model<Api>>(ctx, (done, tui) => {
			const defaultProvider = ctx.settingsManager.getDefaultProvider();
			const defaultModel = ctx.settingsManager.getDefaultModel();
			return new ModelSelectorComponent(
				tui,
				ctx.session.model,
				ctx.session.modelRuntime,
				ctx.session.scopedModels,
				(model) => done(model),
				() => done(undefined),
				args.search,
				(model) => {
					ctx.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
					ctx.showStatus(`Default model: ${model.provider}/${model.id}`);
					ctx.refreshChrome();
					done(undefined);
				},
				defaultProvider && defaultModel ? { provider: defaultProvider, id: defaultModel } : undefined,
			);
		});
	},
});

export function modelArgumentCompletions(ctx: ModeContext, prefix: string): AutocompleteItem[] | null {
	const models =
		ctx.session.scopedModels.length > 0
			? ctx.session.scopedModels.map((entry) => entry.model)
			: [...ctx.session.modelRuntime.getAvailableSnapshot()];
	if (models.length === 0) return null;
	return fuzzyFilter(models, prefix, (model) => getModelSearchText(model)).map((model) => ({
		value: `${model.provider}/${model.id}`,
		label: model.id,
		description: model.provider,
	}));
}
