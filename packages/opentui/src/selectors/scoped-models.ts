import { ScopedModelsSelectorComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/scoped-models-selector";
import { refreshModelCatalogs } from "@earendil-works/pi-coding-agent/modes/interactive/model-catalog-refresh";
import { openHosted } from "./hosted.ts";
import { defineSelector } from "./types.ts";

export const scopedModelsSelector = defineSelector<void, void>({
	id: "scoped-models",
	async open(ctx) {
		const configured = ctx.settingsManager.getEnabledModels();
		const initial =
			ctx.session.scopedModels.length > 0
				? ctx.session.scopedModels.map((entry) => `${entry.model.provider}/${entry.model.id}`)
				: configured
					? [...configured]
					: null;
		await openHosted<void>(ctx, (done) => {
			const component = new ScopedModelsSelectorComponent(
				{
					allModels: [...ctx.session.modelRuntime.getAvailableSnapshot()],
					enabledModelIds: initial,
					refreshStatus: "Refreshing model catalogs…",
				},
				{
					onChange: (ids) => {
						if (ids === null) ctx.session.setScopedModels([]);
						else {
							const models = new Map(
								ctx.session.modelRuntime
									.getAvailableSnapshot()
									.map((model) => [`${model.provider}/${model.id}`, model]),
							);
							ctx.session.setScopedModels(
								ids.flatMap((id) => {
									const model = models.get(id);
									return model ? [{ model }] : [];
								}),
							);
						}
						ctx.refreshChrome();
					},
					onPersist: (ids) => {
						ctx.settingsManager.setEnabledModels(ids === null ? undefined : [...ids]);
						ctx.showStatus("Model selection saved to settings");
					},
					onCancel: () => done(undefined),
				},
			);
			void refreshModelCatalogs(ctx.session.modelRuntime, AbortSignal.timeout(15_000))
				.then((result) => {
					component.updateModels([...ctx.session.modelRuntime.getAvailableSnapshot()]);
					component.setRefreshStatus(
						result.errors.size > 0
							? `Could not refresh ${[...result.errors.keys()].join(", ")}; showing cached models.`
							: "Model catalogs refreshed.",
						result.errors.size > 0 ? "warning" : "success",
					);
					ctx.requestRender();
				})
				.catch((error: unknown) =>
					component.setRefreshStatus(
						`Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					),
				);
			return component;
		});
	},
});
