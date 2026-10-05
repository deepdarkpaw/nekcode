import {
	formatMissingSessionCwdPrompt,
	MissingSessionCwdError,
} from "@earendil-works/pi-coding-agent/core/session-cwd";
import { sessionSelector } from "../selectors/session.ts";
import type { CommandDefinition } from "./registry.ts";

async function switchSession(ctx: Parameters<CommandDefinition["run"]>[0], path: string): Promise<void> {
	try {
		const result = await ctx.runtimeHost.switchSession(path, {
			projectTrustContextFactory: (cwd) => ctx.createProjectTrustContext(cwd),
		});
		if (!result.cancelled) ctx.showStatus("Resumed session");
	} catch (error) {
		if (!(error instanceof MissingSessionCwdError)) throw error;
		const cwd = await ctx.dialogs.input({
			title: formatMissingSessionCwdPrompt(error.issue),
			initialValue: ctx.sessionManager.getCwd(),
		});
		if (!cwd) {
			ctx.showStatus("Resume cancelled");
			return;
		}
		const result = await ctx.runtimeHost.switchSession(path, {
			cwdOverride: cwd,
			projectTrustContextFactory: (value) => ctx.createProjectTrustContext(value),
		});
		if (!result.cancelled) ctx.showStatus("Resumed session in current cwd");
	}
}

export const resumeCommand: CommandDefinition = {
	name: "resume",
	acceptsArgs: false,
	clearEditor: "after",
	run: async (ctx) => {
		const path = await sessionSelector.open(ctx, undefined);
		if (!path) return;
		try {
			await switchSession(ctx, path);
		} catch (error) {
			await ctx.handleFatalRuntimeError("Failed to resume session", error);
		}
	},
};
