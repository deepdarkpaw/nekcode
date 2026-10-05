import { type AuthProviderOption, authSelector } from "../selectors/auth.ts";
import type { CommandDefinition } from "./registry.ts";

export const logoutCommand: CommandDefinition = {
	name: "logout",
	acceptsArgs: false,
	clearEditor: "after",
	run: async (ctx) => {
		let credentials: readonly { providerId: string; type: "oauth" | "api_key" }[];
		try {
			credentials = await ctx.session.modelRuntime.listCredentials({ signal: AbortSignal.timeout(15_000) });
		} catch (error) {
			ctx.showError(`Could not read stored credentials: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const options: AuthProviderOption[] = credentials.map((credential) => ({
			id: credential.providerId,
			name: ctx.session.modelRuntime.getProvider(credential.providerId)?.name ?? credential.providerId,
			authType: credential.type,
			status: { type: credential.type, source: "stored credential" },
		}));
		const selected = await authSelector.open(ctx, { mode: "logout", options });
		if (!selected) return;
		try {
			await ctx.session.modelRuntime.logout(selected.id, { signal: AbortSignal.timeout(15_000) });
			ctx.showStatus(
				selected.authType === "oauth"
					? `Logged out of ${selected.name}`
					: `Removed stored API key for ${selected.name}. Environment variables and models.json config are unchanged.`,
			);
			ctx.refreshChrome();
		} catch (error) {
			ctx.showError(`Logout failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	},
};
