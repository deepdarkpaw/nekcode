import type { Api, Model } from "@earendil-works/pi-ai";
import { resolveModelScopeFromModels } from "@earendil-works/pi-coding-agent/core/model-resolver";
import { ScopedModelsSelectorComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/scoped-models-selector";
import { refreshModelCatalogs } from "@earendil-works/pi-coding-agent/modes/interactive/model-catalog-refresh";
import { openHosted } from "./hosted.ts";
import { defineSelector } from "./types.ts";

const modelId = (model: Model<Api>): string => `${model.provider}/${model.id}`;

/** `/scoped-models`, ported from the interactive mode's `showModelsSelector`. */
export const scopedModelsSelector = defineSelector<void, void>({
	id: "scoped-models",
	async open(ctx) {
		const session = ctx.session;
		let availableModels = [...session.modelRuntime.getAvailableSnapshot()];
		let availableModelIds = new Set(availableModels.map(modelId));
		const configuredPatterns = ctx.settingsManager.getEnabledModels();
		const sessionScopedModels = session.scopedModels;
		const configuredEnabledIds = (models: readonly Model<Api>[]): string[] | null => {
			if (!configuredPatterns?.length) return null;
			const resolved = resolveModelScopeFromModels(configuredPatterns, models);
			const ids = resolved.scopedModels.map((scoped) => modelId(scoped.model));
			for (const diagnostic of resolved.diagnostics) {
				if (diagnostic.code === "no-match" && !ids.includes(diagnostic.pattern)) ids.push(diagnostic.pattern);
			}
			return ids;
		};
		let currentEnabledIds =
			sessionScopedModels.length > 0
				? sessionScopedModels.map((scoped) => modelId(scoped.model))
				: configuredEnabledIds(availableModels);
		let selectionChanged = false;

		const updateSessionModels = (enabledIds: string[] | null): void => {
			currentEnabledIds = enabledIds === null ? null : [...enabledIds];
			const hasEnabledAvailableModel = enabledIds?.some((id) => availableModelIds.has(id)) ?? false;
			const allAvailableModelsEnabled =
				enabledIds !== null && [...availableModelIds].every((id) => enabledIds.includes(id));
			if (enabledIds && hasEnabledAvailableModel && !allAvailableModelsEnabled) {
				const scoped = resolveModelScopeFromModels(enabledIds, availableModels).scopedModels;
				session.setScopedModels(
					scoped.map((entry) => ({ model: entry.model, thinkingLevel: entry.thinkingLevel })),
				);
			} else {
				session.setScopedModels([]);
			}
			ctx.refreshChrome();
		};

		await openHosted<void>(ctx, (done) => {
			let disposed = false;
			let timedOut = false;
			const controller = new AbortController();
			const timeout = setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, 15_000);
			const selector = new ScopedModelsSelectorComponent(
				{
					allModels: availableModels,
					enabledModelIds: currentEnabledIds,
					refreshStatus: "Refreshing model catalogs…",
				},
				{
					onChange: (enabledIds) => {
						selectionChanged = true;
						updateSessionModels(enabledIds);
					},
					onPersist: (enabledIds) => {
						const allEnabled =
							enabledIds !== null &&
							enabledIds.length === availableModels.length &&
							enabledIds.every((id) => availableModelIds.has(id));
						const patterns = enabledIds === null || allEnabled ? undefined : enabledIds;
						ctx.settingsManager.setEnabledModels(patterns ? [...patterns] : undefined);
						ctx.showStatus("Model selection saved to settings");
					},
					onCancel: () => done(undefined),
				},
			);
			void refreshModelCatalogs(session.modelRuntime, controller.signal)
				.then((result) => {
					if (disposed) return;
					availableModels = [...session.modelRuntime.getAvailableSnapshot()];
					availableModelIds = new Set(availableModels.map(modelId));
					if (!selectionChanged && sessionScopedModels.length === 0) {
						currentEnabledIds = configuredEnabledIds(availableModels);
						selector.updateModels(availableModels, currentEnabledIds);
					} else {
						selector.updateModels(availableModels);
					}
					if (currentEnabledIds !== null) updateSessionModels(currentEnabledIds);
					if (result.aborted && timedOut) {
						selector.setRefreshStatus("Model refresh timed out; showing cached models.", "warning");
					} else if (result.errors.size > 0) {
						selector.setRefreshStatus(
							`Could not refresh ${[...result.errors.keys()].join(", ")}; showing cached models.`,
							"warning",
						);
					} else {
						selector.setRefreshStatus("Model catalogs refreshed.", "success");
					}
					ctx.requestRender();
				})
				.catch((error: unknown) => {
					if (disposed) return;
					selector.setRefreshStatus(
						timedOut
							? "Model refresh timed out; showing cached models."
							: `Could not refresh model catalogs: ${error instanceof Error ? error.message : String(error)}`,
						"warning",
					);
					ctx.requestRender();
				})
				.finally(() => clearTimeout(timeout));
			return {
				component: selector,
				dispose: () => {
					disposed = true;
					clearTimeout(timeout);
					controller.abort();
				},
			};
		});
	},
});
