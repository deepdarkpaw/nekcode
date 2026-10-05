import type { ApiKeyAuth, AuthCheck, OAuthAuth } from "@earendil-works/pi-ai";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { defineSelector } from "./types.ts";

export type AuthProviderOption = {
	id: string;
	name: string;
	authType: "oauth" | "api_key";
	method?: ApiKeyAuth | OAuthAuth;
	status?: AuthCheck;
};

export const authSelector = defineSelector<
	{ mode: "login" | "logout"; options: AuthProviderOption[]; search?: string },
	AuthProviderOption
>({
	id: "auth",
	async open(ctx, args) {
		const filtered = args.search
			? fuzzyFilter(args.options, args.search, (option) => `${option.id} ${option.name} ${option.authType}`)
			: args.options;
		return ctx.dialogs.select({
			title: args.mode === "login" ? "Select provider to configure" : "Select provider to logout",
			filter: true,
			items: filtered.map((option) => ({
				value: option,
				label: `${option.name} [${option.authType === "oauth" ? "subscription" : "API key"}]${option.status ? " · configured" : ""}`,
			})),
		});
	},
});
