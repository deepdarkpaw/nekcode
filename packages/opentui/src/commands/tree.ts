import { treeSelector } from "../selectors/tree.ts";
import type { CommandDefinition } from "./registry.ts";

export const treeCommand: CommandDefinition = {
	name: "tree",
	acceptsArgs: false,
	clearEditor: "after",
	run: async (ctx) => {
		const entryId = await treeSelector.open(ctx, {});
		if (!entryId || entryId === ctx.sessionManager.getLeafId()) {
			if (entryId) ctx.showStatus("Already at this point");
			return;
		}
		let summarize = false;
		let customInstructions: string | undefined;
		if (!ctx.settingsManager.getBranchSummarySkipPrompt()) {
			const choice = await ctx.dialogs.select({
				title: "Summarize branch?",
				items: [
					{ value: "none", label: "No summary" },
					{ value: "summary", label: "Summarize" },
					{ value: "custom", label: "Summarize with custom prompt" },
				],
			});
			if (!choice) return;
			summarize = choice !== "none";
			if (choice === "custom") {
				customInstructions = await ctx.dialogs.editor({ title: "Custom summarization instructions" });
				if (customInstructions === undefined) return;
			}
		}
		if (ctx.session.isStreaming) {
			ctx.restoreQueuedMessagesToEditor();
			await ctx.session.abort();
		}
		if (ctx.session.isCompacting) {
			ctx.showError(
				"Wait for the current compaction or tree navigation to finish before navigating the session tree.",
			);
			return;
		}
		const releaseEscape = summarize ? ctx.pushEscapeHandler(() => ctx.session.abortBranchSummary()) : undefined;
		if (summarize) ctx.showStatusIndicator({ kind: "branchSummary" });
		try {
			const result = await ctx.session.navigateTree(entryId, { summarize, customInstructions });
			if (result.aborted) {
				ctx.showStatus("Branch summarization cancelled");
				return;
			}
			if (result.cancelled) {
				ctx.showStatus("Navigation cancelled");
				return;
			}
			ctx.transcript.rebuildFromSession();
			if (result.editorText && !ctx.editor.getText().trim()) ctx.editor.setText(result.editorText);
			ctx.showStatus("Navigated to selected point");
			await ctx.flushCompactionQueue({ willRetry: false });
		} catch (error) {
			ctx.showError(error instanceof Error ? error.message : String(error));
		} finally {
			releaseEscape?.();
			if (summarize) ctx.clearStatusIndicator("branchSummary");
		}
	},
};
