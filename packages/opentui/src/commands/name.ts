import type { CommandDefinition } from "./registry.ts";

export const nameCommand: CommandDefinition = {
	name: "name",
	acceptsArgs: true,
	clearEditor: "after",
	run: async (ctx, invocation) => {
		const name = invocation.args?.trim();
		if (!name) {
			const current = ctx.sessionManager.getSessionName();
			if (current) ctx.showStatus(`Session name: ${current}`);
			else ctx.showWarning("Usage: /name <name>");
			return;
		}
		ctx.session.setSessionName(name);
		const normalized = ctx.sessionManager.getSessionName() ?? name;
		if (normalized !== name)
			ctx.showWarning(`Session name was normalized from ${JSON.stringify(name)} to ${JSON.stringify(normalized)}`);
		ctx.showStatus(`Session name set: ${normalized}`);
		ctx.refreshChrome();
	},
};
