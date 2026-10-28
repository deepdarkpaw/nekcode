/**
 * `auth_status`: the credential state added on top of the existing kind/login fields.
 *
 * The state is read from the stored credential of `auth.json`, so a dated OAuth token that is past its expiry
 * reports `expired` and everything else reports `ok`. The test pins both the new field and the existing ones, so
 * the addition stays backward compatible.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Provider } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { AuthStatus } from "../src/core/provider-composer.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { authStatus } from "../src/modes/rpc/gui/auth.ts";
import { createGuiContext, type GuiContext } from "../src/modes/rpc/gui/context.ts";

/** One provider as `auth_status` reads it: an id, a display name, and the auth methods it offers. */
function provider(id: string, name: string, methods: { oauth?: boolean; apiKey?: boolean }): Provider {
	return {
		id,
		name,
		auth: {
			...(methods.oauth ? { oauth: { name: `${name} (OAuth)`, toAuth: async () => ({}) } } : {}),
			...(methods.apiKey ? { apiKey: { name: `${name} (API key)` } } : {}),
		},
		getModels: () => [],
	} as unknown as Provider;
}

/** A model runtime that reports the given providers and answers auth status from a fixed table. */
function stubModelRuntime(providers: Provider[], statuses: Record<string, AuthStatus> = {}): ModelRuntime {
	return {
		getProviders: () => providers,
		getProviderAuthStatus: (providerId: string) =>
			statuses[providerId] ?? ({ configured: false } satisfies AuthStatus),
	} as unknown as ModelRuntime;
}

describe("auth_status", () => {
	let root: string;
	let agentDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "nek-gui-auth-"));
		agentDir = join(root, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function context(providers: Provider[], statuses: Record<string, AuthStatus> = {}): GuiContext {
		return createGuiContext({
			mode: "control",
			cwd: root,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			modelRuntime: stubModelRuntime(providers, statuses),
			emit: () => {},
		});
	}

	function writeAuthFile(credentials: Record<string, unknown>): void {
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify(credentials));
	}

	it("reports a dated OAuth credential that is still valid as ok", () => {
		const expires = Date.now() + 60 * 60 * 1000;
		writeAuthFile({ anthropic: { type: "oauth", access: "token", refresh: "refresh", expires } });

		const [status] = authStatus(context([provider("anthropic", "Anthropic", { oauth: true })]));

		expect(status.state).toBe("ok");
		expect(status.expiresAt).toBe(new Date(expires).toISOString());
	});

	it("reports a dated OAuth credential past its expiry as expired, keeping expiresAt", () => {
		const expires = Date.now() - 60_000;
		writeAuthFile({ anthropic: { type: "oauth", access: "token", refresh: "refresh", expires } });

		const [status] = authStatus(context([provider("anthropic", "Anthropic", { oauth: true })]));

		expect(status.state).toBe("expired");
		expect(status.expiresAt).toBe(new Date(expires).toISOString());
		expect(status.kind).toBe("oauth");
	});

	it("reports an OAuth credential without a numeric expiry as ok", () => {
		writeAuthFile({ anthropic: { type: "oauth", access: "token", refresh: "refresh" } });

		const [status] = authStatus(context([provider("anthropic", "Anthropic", { oauth: true })]));

		expect(status.state).toBe("ok");
		expect(status.expiresAt).toBeUndefined();
	});

	it("reports a stored API key as ok", () => {
		writeAuthFile({ openai: { type: "api_key", key: "sk-test" } });

		const [status] = authStatus(context([provider("openai", "OpenAI", { apiKey: true })]));

		expect(status).toMatchObject({ provider: "openai", kind: "api_key", state: "ok" });
		expect(status.expiresAt).toBeUndefined();
	});

	it("reports an ambient key and a missing credential as ok", () => {
		const providers = [
			provider("openai", "OpenAI", { apiKey: true }),
			provider("google", "Google", { apiKey: true }),
		];

		const [ambient, missing] = authStatus(
			context(providers, { openai: { configured: true, source: "environment", label: "OPENAI_API_KEY" } }),
		);

		expect(ambient).toMatchObject({ kind: "env", state: "ok" });
		expect(missing).toMatchObject({ kind: "none", state: "ok" });
	});

	it("keeps the existing fields of every row", () => {
		writeAuthFile({ anthropic: { type: "oauth", access: "token", refresh: "refresh", expires: Date.now() } });

		const [status] = authStatus(context([provider("anthropic", "Anthropic", { oauth: true })]));

		expect(status).toEqual({
			provider: "anthropic",
			name: "Anthropic (OAuth)",
			kind: "oauth",
			loginMethods: ["oauth"],
			state: "expired",
			expiresAt: expect.any(String),
		});
	});
});
