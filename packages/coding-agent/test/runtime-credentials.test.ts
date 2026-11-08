import type { CredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { RuntimeCredentials } from "../src/core/runtime-credentials.ts";

describe("RuntimeCredentials", () => {
	test("runtime overrides mask stored credentials without persisting", async () => {
		const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "stored-key" } });
		const credentials = new RuntimeCredentials(storage);

		credentials.setRuntimeApiKey("anthropic", "runtime-key");
		expect(await credentials.read("anthropic")).toEqual({ type: "api_key", key: "runtime-key" });
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "stored-key" });

		credentials.removeRuntimeApiKey("anthropic");
		expect(await credentials.read("anthropic")).toEqual({ type: "api_key", key: "stored-key" });
	});

	test("enumeration merges overrides without exposing keys", async () => {
		const storage = AuthStorage.inMemory({
			anthropic: { type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 },
		});
		const credentials = new RuntimeCredentials(storage);
		credentials.setRuntimeApiKey("anthropic", "runtime-key");
		credentials.setRuntimeApiKey("openai", "other-runtime-key");

		expect(await credentials.list()).toEqual([
			{ providerId: "anthropic", type: "api_key" },
			{ providerId: "openai", type: "api_key" },
		]);
	});

	test("forwards operation signals to the persistent store", async () => {
		const controller = new AbortController();
		const received: AbortSignal[] = [];
		const storage: CredentialStore = {
			read: async (_providerId, options) => {
				received.push(options?.signal as AbortSignal);
				return undefined;
			},
			list: async (options) => {
				received.push(options?.signal as AbortSignal);
				return [];
			},
			modify: async (_providerId, _fn, options) => {
				received.push(options?.signal as AbortSignal);
				return undefined;
			},
			delete: async (_providerId, options) => {
				received.push(options?.signal as AbortSignal);
			},
		};
		const credentials = new RuntimeCredentials(storage);

		await credentials.read("anthropic", { signal: controller.signal });
		await credentials.list({ signal: controller.signal });
		await credentials.modify("anthropic", async () => undefined, { signal: controller.signal });
		await credentials.delete("anthropic", { signal: controller.signal });

		expect(received).toEqual([controller.signal, controller.signal, controller.signal, controller.signal]);
	});

	test("keeps a runtime override when persistent deletion is cancelled", async () => {
		const aborted = new Error("cancelled");
		aborted.name = "AbortError";
		const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "stored-key" } });
		const deleteSpy = vi.spyOn(storage, "delete").mockRejectedValueOnce(aborted);
		const credentials = new RuntimeCredentials(storage);
		credentials.setRuntimeApiKey("anthropic", "runtime-key");

		await expect(credentials.delete("anthropic", { signal: new AbortController().signal })).rejects.toBe(aborted);
		expect(deleteSpy).toHaveBeenCalledTimes(1);
		expect(await credentials.read("anthropic")).toEqual({ type: "api_key", key: "runtime-key" });
	});

	test("settled waits until a pending modification has been persisted", async () => {
		const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "old" } });
		const credentials = new RuntimeCredentials(storage);
		let respond!: () => void;
		const response = new Promise<void>((resolve) => {
			respond = resolve;
		});
		const modification = credentials.modify("anthropic", async () => {
			await response;
			return { type: "api_key", key: "rotated" };
		});
		let settled = false;
		const settling = credentials.settled().then(() => {
			settled = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).toBe(false);

		respond();
		await settling;
		expect(await storage.read("anthropic")).toEqual({ type: "api_key", key: "rotated" });
		await modification;
	});

	test("settled observes failures without rejecting early or creating unhandled rejections", async () => {
		const storage = AuthStorage.inMemory();
		const credentials = new RuntimeCredentials(storage);
		const failure = new Error("invalid_grant");
		let fail!: () => void;
		const failedResponse = new Promise<void>((_resolve, reject) => {
			fail = () => reject(failure);
		});
		let respond!: () => void;
		const response = new Promise<void>((resolve) => {
			respond = resolve;
		});
		const failed = credentials.modify("anthropic", async () => {
			await failedResponse;
			return undefined;
		});
		const written = credentials.modify("openai", async () => {
			await response;
			return { type: "api_key", key: "rotated" };
		});
		let settled = false;
		const settling = credentials.settled().then(() => {
			settled = true;
		});
		fail();
		// Deliberately attach the caller's rejection handler later; tracking must already observe it.
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(settled).toBe(false);
		await expect(failed).rejects.toBe(failure);

		respond();
		await settling;
		await written;
		expect(await storage.read("openai")).toEqual({ type: "api_key", key: "rotated" });
		await credentials.settled();
	});

	test("settled does not initiate credential operations", async () => {
		const storage = AuthStorage.inMemory();
		const modify = vi.spyOn(storage, "modify");
		const credentials = new RuntimeCredentials(storage);

		await credentials.settled();
		expect(modify).not.toHaveBeenCalled();
	});

	test("delete clears both the override and persisted credential", async () => {
		const storage = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "stored-key" } });
		const credentials = new RuntimeCredentials(storage);
		credentials.setRuntimeApiKey("anthropic", "runtime-key");

		await credentials.delete("anthropic");

		expect(await credentials.read("anthropic")).toBeUndefined();
		expect(await credentials.list()).toEqual([]);
	});
});
