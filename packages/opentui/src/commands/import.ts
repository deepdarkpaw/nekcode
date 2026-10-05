import { SessionImportFileNotFoundError } from "@earendil-works/pi-coding-agent/core/agent-session-runtime";
import { MissingSessionCwdError } from "@earendil-works/pi-coding-agent/core/session-cwd";
import { firstPathArgument } from "./common.ts";
import type { CommandDefinition } from "./registry.ts";

export const importCommand: CommandDefinition = {
	name: "import",
	acceptsArgs: true,
	clearEditor: "after",
	run: async (ctx, invocation) => {
		const inputPath = firstPathArgument(invocation.args);
		if (!inputPath) {
			ctx.showError("Usage: /import <path.jsonl>");
			return;
		}
		if (
			!(await ctx.dialogs.confirm({
				title: "Import session",
				message: `Replace current session with ${inputPath}?`,
			}))
		) {
			ctx.showStatus("Import cancelled");
			return;
		}
		try {
			const result = await ctx.runtimeHost.importFromJsonl(inputPath);
			if (!result.cancelled) ctx.showStatus(`Session imported from: ${inputPath}`);
		} catch (error) {
			if (error instanceof MissingSessionCwdError) {
				const cwd = await ctx.dialogs.input({
					title: "Session directory is missing",
					initialValue: ctx.sessionManager.getCwd(),
				});
				if (!cwd) {
					ctx.showStatus("Import cancelled");
					return;
				}
				const result = await ctx.runtimeHost.importFromJsonl(inputPath, cwd);
				if (!result.cancelled) ctx.showStatus(`Session imported from: ${inputPath}`);
				return;
			}
			if (error instanceof SessionImportFileNotFoundError) {
				ctx.showError(`Failed to import session: ${error.message}`);
				return;
			}
			await ctx.handleFatalRuntimeError("Failed to import session", error);
		}
	},
};
