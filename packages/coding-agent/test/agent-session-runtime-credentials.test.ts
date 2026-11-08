import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthCredential, Provider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

/** Disposal uses supplied services; runtime creation and resource loading are outside these tests. */
vi.mock("../src/core/agent-session-services.ts", () => ({
	createAgentSessionFromServices: vi.fn(),
	createAgentSessionServices: vi.fn(),
}));

const providerId = "rotating-oauth";
const expired: OAuthCredential = {
	type: "oauth",
	access: "old-access",
	refresh: "old-refresh",
	expires: 0,
};

function oauthProvider(refresh: (credential: OAuthCredential) => Promise<OAuthCredential>): Provider {
	return {
		id: providerId,
		name: providerId,
		auth: {
			oauth: {
				name: "OAuth",
				login: async () => {
					throw new Error("unused");
				},
				refresh,
				toAuth: async (credential) => ({ apiKey: credential.access }),
			},
		},
		getModels: () => [],
		refreshModels: async () => {},
		stream: () => {
			throw new Error("unused");
		},
		streamSimple: () => {
			throw new Error("unused");
		},
	};
}

function runtimeHost(modelRuntime: ModelRuntime) {
	const shutdown = vi.fn(async () => {});
	const dispose = vi.fn(async () => {});
	const session = {
		extensionRunner: { hasHandlers: () => true, emit: shutdown },
		dispose,
	} as unknown as AgentSession;
	const services = { modelRuntime, diagnostics: [] } as unknown as AgentSessionServices;
	const unusedFactory: CreateAgentSessionRuntimeFactory = async () => {
		throw new Error("runtime replacement is not used in this test");
	};
	return { runtime: new AgentSessionRuntime(session, services, unusedFactory), shutdown, dispose };
}

describe("AgentSessionRuntime credential writes at exit", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it.each([false, true])("waits for a rotated token to reach auth.json (shutdown fails: %s)", async (failShutdown) => {
		const dir = mkdtempSync(join(tmpdir(), "runtime-credential-writes-"));
		tempDirs.push(dir);
		const authPath = join(dir, "auth.json");
		const credentials = AuthStorage.create(authPath);
		await credentials.modify(providerId, async () => expired);
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let respond!: () => void;
		const response = new Promise<void>((resolve) => {
			respond = resolve;
		});
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		modelRuntime.registerNativeProvider(
			oauthProvider(async () => {
				// Mock the token endpoint after it has spent the old single-use refresh token.
				markStarted();
				await response;
				return { type: "oauth", access: "new-access", refresh: "new-refresh", expires: Date.now() + 3_600_000 };
			}),
		);
		await modelRuntime.refresh({ allowNetwork: false, providers: [providerId] });
		const { runtime, shutdown, dispose } = runtimeHost(modelRuntime);
		const shutdownError = new Error("shutdown failed");
		if (failShutdown) shutdown.mockRejectedValueOnce(shutdownError);
		const catalogRefresh = modelRuntime.refresh({ allowNetwork: true, providers: [providerId] });
		await started;
		let disposed = false;
		const outcome = runtime.dispose().then(
			() => {
				disposed = true;
				return undefined;
			},
			(error: unknown) => {
				disposed = true;
				return error;
			},
		);
		try {
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(dispose).toHaveBeenCalledOnce();
			expect(disposed).toBe(false);
			expect(JSON.parse(readFileSync(authPath, "utf8"))[providerId].refresh).toBe("old-refresh");
		} finally {
			respond();
			await catalogRefresh;
		}
		expect(await outcome).toBe(failShutdown ? shutdownError : undefined);
		expect(JSON.parse(readFileSync(authPath, "utf8"))[providerId]).toMatchObject({
			access: "new-access",
			refresh: "new-refresh",
		});
	});

	it("does not start an OAuth refresh on exit", async () => {
		const credentials = AuthStorage.inMemory({ [providerId]: expired });
		const refresh = vi.fn(async () => expired);
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		modelRuntime.registerNativeProvider(oauthProvider(refresh));
		await modelRuntime.refresh({ allowNetwork: false, providers: [providerId] });

		await runtimeHost(modelRuntime).runtime.dispose();

		expect(refresh).not.toHaveBeenCalled();
		expect(await credentials.read(providerId)).toEqual(expired);
	});

	it("aggregates every cleanup failure, including credential settlement", async () => {
		const shutdownError = new Error("shutdown failed");
		const invalidateError = new Error("UI teardown failed");
		const disposeError = new Error("session disposal failed");
		const credentialError = new Error("credential settlement failed");
		const settleCredentialWrites = vi.fn(async () => {
			throw credentialError;
		});
		const { runtime, shutdown, dispose } = runtimeHost({ settleCredentialWrites } as unknown as ModelRuntime);
		shutdown.mockRejectedValueOnce(shutdownError);
		runtime.setBeforeSessionInvalidate(() => {
			throw invalidateError;
		});
		dispose.mockRejectedValueOnce(disposeError);

		const error = await runtime.dispose().catch((error: unknown) => error);

		expect(error).toBeInstanceOf(AggregateError);
		expect((error as AggregateError).errors).toEqual([shutdownError, invalidateError, disposeError, credentialError]);
		expect(settleCredentialWrites).toHaveBeenCalledOnce();
	});

	it("propagates a lone credential settlement error unchanged", async () => {
		const failure = new Error("credential settlement failed");
		const { runtime } = runtimeHost({
			settleCredentialWrites: async () => {
				throw failure;
			},
		} as unknown as ModelRuntime);

		await expect(runtime.dispose()).rejects.toBe(failure);
	});
});
