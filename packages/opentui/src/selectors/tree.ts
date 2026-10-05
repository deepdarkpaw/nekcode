import { TreeSelectorComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/tree-selector";
import { copyToClipboard } from "@earendil-works/pi-coding-agent/utils/clipboard";
import { openHosted } from "./hosted.ts";
import { defineSelector } from "./types.ts";

export const treeSelector = defineSelector<{ initialSelectedId?: string }, string>({
	id: "tree",
	open(ctx, args) {
		const tree = ctx.sessionManager.getTree();
		const leafId = ctx.sessionManager.getLeafId();
		return openHosted<string>(ctx, (done) => {
			const component = new TreeSelectorComponent(
				tree,
				leafId,
				ctx.renderer.height,
				(entryId) => done(entryId),
				() => done(undefined),
				(entryId, label) => {
					ctx.sessionManager.appendLabelChange(entryId, label);
					ctx.requestRender();
				},
				args.initialSelectedId,
				ctx.settingsManager.getTreeFilterMode(),
			);
			component.onCopy = async (text) => {
				if (!text) {
					ctx.showError("Selected entry has no text to copy");
					return;
				}
				try {
					await copyToClipboard(text);
					ctx.showStatus("Copied selected message to clipboard");
				} catch (error) {
					ctx.showError(error instanceof Error ? error.message : String(error));
				}
			};
			return component;
		});
	},
});
