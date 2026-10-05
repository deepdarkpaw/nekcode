import { SessionManager } from "@earendil-works/pi-coding-agent/core/session-manager";
import { SessionSelectorComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/session-selector";
import { openHosted } from "./hosted.ts";
import { defineSelector } from "./types.ts";

export const sessionSelector = defineSelector<void, string>({
	id: "session",
	open(ctx) {
		const currentLoader = (onProgress: Parameters<typeof SessionManager.list>[2], signal?: AbortSignal) =>
			SessionManager.list(ctx.sessionManager.getCwd(), ctx.sessionManager.getSessionDir(), onProgress, signal);
		const allLoader = (onProgress: Parameters<typeof SessionManager.listAll>[1], signal?: AbortSignal) =>
			ctx.sessionManager.usesDefaultSessionDir()
				? SessionManager.listAll(onProgress, signal)
				: SessionManager.listAll(ctx.sessionManager.getSessionDir(), onProgress, signal);
		return openHosted<string>(
			ctx,
			(done) =>
				new SessionSelectorComponent(
					currentLoader,
					allLoader,
					(path) => done(path),
					() => done(undefined),
					() => {
						void ctx.shutdown();
					},
					() => ctx.requestRender(),
					{
						renameSession: async (sessionPath, name) => {
							const next = (name ?? "").trim();
							if (next) SessionManager.open(sessionPath).appendSessionInfo(next);
						},
						showRenameHint: true,
						keybindings: ctx.keybindings,
					},
					ctx.sessionManager.getSessionFile(),
				),
		);
	},
});
