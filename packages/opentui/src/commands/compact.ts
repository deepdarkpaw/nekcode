import type { CommandDefinition } from "./registry.ts";

export const compactCommand: CommandDefinition = {
	name: "compact",
	acceptsArgs: true,
	clearEditor: "before",
	run: async (ctx, invocation) => {
		ctx.clearStatusIndicator();
		const releaseEscape = ctx.pushEscapeHandler(() => {
			void ctx.session.abort();
		});
		ctx.showStatusIndicator({ kind: "compaction", reason: "manual" });
		try {
			await ctx.session.compact(invocation.args);
		} catch {
			/* The session emits the operation error. */
		} finally {
			releaseEscape();
			ctx.clearStatusIndicator("compaction");
			await ctx.flushCompactionQueue();
		}
	},
};
