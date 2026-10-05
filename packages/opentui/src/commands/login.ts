import type { AuthEvent, AuthPrompt } from "@earendil-works/pi-ai";
import { openBrowser } from "@earendil-works/pi-coding-agent/utils/open-browser";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import type { ModeContext } from "../mode/mode-context.ts";
import { type AuthProviderOption, authSelector } from "../selectors/auth.ts";
import type { CommandDefinition } from "./registry.ts";

function options(ctx: ModeContext): AuthProviderOption[] {
	const result: AuthProviderOption[] = [];
	for (const provider of ctx.session.modelRuntime.getProviders()) {
		const auth = provider.auth;
		const status = ctx.session.modelRuntime.getProviderAuthStatus(provider.id);
		const configured = status.configured
			? {
					type: ctx.session.modelRuntime.isUsingOAuth(provider.id) ? ("oauth" as const) : ("api_key" as const),
					source: status.label ?? status.source,
				}
			: undefined;
		if (auth.oauth)
			result.push({
				id: provider.id,
				name: provider.name,
				authType: "oauth",
				method: auth.oauth,
				status: configured,
			});
		if (auth.apiKey)
			result.push({
				id: provider.id,
				name: provider.name,
				authType: "api_key",
				method: auth.apiKey,
				status: configured,
			});
	}
	return result.sort((a, b) => a.name.localeCompare(b.name));
}

async function prompt(ctx: ModeContext, request: AuthPrompt): Promise<string> {
	if (request.type === "select") {
		const value = await ctx.dialogs.select({
			title: request.message,
			items: request.options.map((option) => ({
				value: option.id,
				label: option.label,
				description: option.description,
			})),
			signal: request.signal,
		});
		if (value === undefined) throw new Error("Login cancelled");
		return value;
	}
	const value = await ctx.dialogs.input({
		title: request.message,
		placeholder: request.placeholder,
		signal: request.signal,
	});
	if (value === undefined) throw new Error("Login cancelled");
	return value;
}

function notify(ctx: ModeContext, event: AuthEvent): void {
	if (event.type === "auth_url") {
		ctx.showStatus(`${event.instructions ?? "Open this URL to authenticate:"} ${event.url}`);
		openBrowser(event.url);
	} else if (event.type === "device_code")
		ctx.showStatus(`Open ${event.verificationUri} and enter code ${event.userCode}`);
	else if (event.type === "info")
		ctx.showStatus(
			event.links?.length ? `${event.message} ${event.links.map((link) => link.url).join(" ")}` : event.message,
		);
	else ctx.showStatus(event.message);
}

export const loginCommand: CommandDefinition = {
	name: "login",
	acceptsArgs: true,
	clearEditor: "before",
	getArgumentCompletions: (ctx, prefix): AutocompleteItem[] | null =>
		fuzzyFilter(options(ctx), prefix, (option) => `${option.id} ${option.name}`).map((option) => ({
			value: option.id,
			label: option.id,
			description: option.name,
		})),
	run: async (ctx, invocation) => {
		const providerOptions = options(ctx);
		const ref = invocation.args?.trim().toLowerCase();
		const matches = ref
			? providerOptions.filter((option) => option.id.toLowerCase() === ref || option.name.toLowerCase() === ref)
			: providerOptions;
		if (matches.length === 0) {
			ctx.showStatus("No login providers available.");
			return;
		}
		const selected =
			matches.length === 1
				? matches[0]
				: await authSelector.open(ctx, { mode: "login", options: matches, search: invocation.args });
		if (!selected) return;
		const controller = new AbortController();
		const releaseEscape = ctx.pushEscapeHandler(() => controller.abort());
		try {
			await ctx.session.modelRuntime.login(selected.id, selected.authType, {
				signal: controller.signal,
				prompt: (request) => prompt(ctx, request),
				notify: (event) => notify(ctx, event),
			});
			ctx.showStatus(`${selected.authType === "oauth" ? "Logged in to" : "Saved API key for"} ${selected.name}`);
			await ctx.session.modelRuntime.refresh({ providers: [selected.id], signal: AbortSignal.timeout(15_000) });
			ctx.refreshChrome();
		} catch (error) {
			if (controller.signal.aborted || (error instanceof Error && error.message === "Login cancelled")) return;
			ctx.showError(
				`Failed to login to ${selected.name}: ${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			releaseEscape();
		}
	},
};
