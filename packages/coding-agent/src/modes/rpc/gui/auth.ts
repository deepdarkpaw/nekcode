/**
 * Authentication commands.
 *
 * `auth_login` runs the provider's real login flow. Its notifications become `auth_event` records, and its
 * prompts become `auth.prompt` structured interactions answered by the GUI. A cancelled prompt (or an aborted
 * signal) ends the login with an error instead of leaving it waiting.
 */

import { join } from "node:path";
import type { AuthEvent, AuthPrompt, Provider } from "@earendil-works/pi-ai";
import { readStoredCredential } from "../../../core/auth-storage.ts";
import type { GuiContext } from "./context.ts";
import { NEK_STRUCTURED_KINDS, type RpcAuthEventRecord, type RpcAuthProviderStatus } from "./protocol.ts";
import { errorMessage } from "./response.ts";

/** Serialized login flows per provider, so a second `auth_login` cannot interleave with the first. */
const activeLogins = new Map<string, AbortController>();

/** Login methods a provider offers, `"oauth"` first because subscriptions are the preferred default. */
function loginMethods(provider: Provider): Array<"oauth" | "api_key"> {
	const methods: Array<"oauth" | "api_key"> = [];
	if (provider.auth.oauth) methods.push("oauth");
	if (provider.auth.apiKey?.login) methods.push("api_key");
	return methods;
}

/** Display name of a provider's auth, e.g. "Anthropic (Claude Pro/Max)". */
function providerDisplayName(provider: Provider): string {
	return provider.auth.oauth?.name ?? provider.auth.apiKey?.name ?? provider.name;
}

/** Credential kind in effect for a provider: stored OAuth, stored key, ambient key, or nothing. */
function credentialKind(
	ctx: GuiContext,
	provider: Provider,
	storedType: "oauth" | "api_key" | undefined,
): RpcAuthProviderStatus["kind"] {
	if (storedType !== undefined) return storedType;
	const status = ctx.modelRuntime.getProviderAuthStatus(provider.id);
	if (!status.configured) return "none";
	return status.source === "runtime" ? "api_key" : "env";
}

/** One row per known provider with its effective credential kind and login methods. */
export function authStatus(ctx: GuiContext): RpcAuthProviderStatus[] {
	const authPath = join(ctx.agentDir, "auth.json");
	return ctx.modelRuntime.getProviders().map((provider) => {
		const stored = readStoredCredential(provider.id, authPath);
		const status: RpcAuthProviderStatus = {
			provider: provider.id,
			name: providerDisplayName(provider),
			kind: credentialKind(ctx, provider, stored?.type),
			loginMethods: loginMethods(provider),
		};
		if (stored?.type !== "oauth") return status;
		const expires = (stored as { expires?: unknown }).expires;
		return typeof expires === "number" ? { ...status, expiresAt: new Date(expires).toISOString() } : status;
	});
}

/** A provider notification as the GUI record, with read-only link lists made plain. */
function authEventRecord(provider: string, event: AuthEvent): RpcAuthEventRecord {
	if (event.type !== "info") return { type: "auth_event", provider, event };
	return {
		type: "auth_event",
		provider,
		event: { type: "info", message: event.message, links: (event.links ?? []).map((link) => ({ ...link })) },
	};
}

/** The login prompt as the GUI sees it: the abort signal stays on the nek side. */
function promptPayload(provider: string, prompt: AuthPrompt): { provider: string; prompt: Omit<AuthPrompt, "signal"> } {
	const { signal: _signal, ...rest } = prompt;
	return { provider, prompt: rest };
}

/** Answer one login prompt through the GUI, rejecting the login when the client cancels. */
async function askPrompt(ctx: GuiContext, provider: string, prompt: AuthPrompt): Promise<string> {
	if (!ctx.requestStructured) throw new Error("Login prompts need a GUI; this RPC mode has no structured UI");
	const result = await ctx.requestStructured(NEK_STRUCTURED_KINDS.authPrompt, promptPayload(provider, prompt), {
		signal: prompt.signal,
	});
	if (result === undefined) throw new Error("Login cancelled");
	const value = (result as { value?: unknown }).value;
	if (typeof value !== "string") throw new Error("Login prompt returned no value");
	return value;
}

/** Run a login, forwarding notifications and prompts to the GUI. */
export async function authLogin(ctx: GuiContext, providerId: string, method?: "oauth" | "api_key"): Promise<void> {
	const provider = ctx.modelRuntime.getProvider(providerId);
	if (!provider) throw new Error(`Unknown provider: ${providerId}`);
	const methods = loginMethods(provider);
	const type = method ?? methods[0];
	if (type === undefined) throw new Error(`Provider ${providerId} has no interactive login`);
	if (!methods.includes(type)) throw new Error(`Provider ${providerId} does not support ${type} login`);
	if (activeLogins.has(providerId)) throw new Error(`A login for ${providerId} is already in progress`);

	const controller = new AbortController();
	activeLogins.set(providerId, controller);
	try {
		await ctx.modelRuntime.login(providerId, type, {
			signal: controller.signal,
			notify: (event) => ctx.emit(authEventRecord(providerId, event)),
			prompt: (prompt) => askPrompt(ctx, providerId, prompt),
		});
	} catch (error: unknown) {
		throw new Error(`Failed to log in to ${providerId}: ${errorMessage(error)}`);
	} finally {
		activeLogins.delete(providerId);
	}
}

/** Abort in-flight logins, called when the process shuts down. */
export function cancelAuthLogins(): void {
	for (const controller of activeLogins.values()) controller.abort();
	activeLogins.clear();
}

/** Remove the stored credential of a provider. */
export async function authLogout(ctx: GuiContext, providerId: string): Promise<void> {
	await ctx.modelRuntime.logout(providerId);
}
