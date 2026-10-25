/**
 * The extension RPC channel: `pi.registerRpcHandler`, `pi.emitRpcEvent`, and the client dialog plumbing that
 * structured interactions and cancelled dialogs use.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import type { ExtensionError, ExtensionFactory } from "../src/core/extensions/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createUiRequester } from "../src/modes/rpc/gui/ui-requests.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

describe("extension RPC channel", () => {
	let cwd: string;

	beforeEach(() => {
		cwd = mkdtempSync(join(tmpdir(), "nek-rpc-ext-"));
	});

	afterEach(() => {
		rmSync(cwd, { recursive: true, force: true });
	});

	async function loadRunner(factorories: ExtensionFactory[]): Promise<ExtensionRunner> {
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		const extensions = [];
		for (const [index, factory] of factorories.entries()) {
			extensions.push(await loadExtensionFromFactory(factory, cwd, eventBus, runtime, `<test-${index}>`));
		}
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		return new ExtensionRunner(extensions, runtime, cwd, SessionManager.inMemory(cwd), modelRegistry);
	}

	it("invokes a registered handler through extension_call", async () => {
		const runner = await loadRunner([
			(pi) => {
				pi.registerRpcHandler("test.add", (params) => {
					const { a, b } = params as { a: number; b: number };
					return a + b;
				});
			},
		]);

		await expect(runner.callRpcHandler("test.add", { a: 2, b: 3 })).resolves.toBe(5);
	});

	it("reports an unknown method", async () => {
		const runner = await loadRunner([() => {}]);

		await expect(runner.callRpcHandler("test.missing", undefined)).rejects.toThrow(
			"No RPC handler registered for method: test.missing",
		);
	});

	it("keeps the first registration of a method and reports the conflict", async () => {
		const errors: ExtensionError[] = [];
		const runner = await loadRunner([
			(pi) => pi.registerRpcHandler("test.same", () => "first"),
			(pi) => pi.registerRpcHandler("test.same", () => "second"),
		]);
		runner.onError((error) => errors.push(error));

		await expect(runner.callRpcHandler("test.same", undefined)).resolves.toBe("first");
		expect(errors.map((error) => error.event)).toEqual(["register_rpc_handler"]);
		expect(errors[0].error).toContain('RPC method "test.same" is already registered');
	});

	it("forwards emitRpcEvent only when a mode listens", async () => {
		const records: Array<[string, unknown]> = [];
		const runtime = createExtensionRuntime();
		const eventBus = createEventBus();
		const extension = await loadExtensionFromFactory(
			(pi) => {
				// Loading happens before any mode binds a sink, so this emit must not throw.
				pi.emitRpcEvent("nek.state", { early: true });
				pi.registerRpcHandler("test.emit", () => {
					pi.emitRpcEvent("nek.state", { late: true });
					return "ok";
				});
			},
			cwd,
			eventBus,
			runtime,
			"<test-emit>",
		);
		const modelRegistry = await createInMemoryModelRegistry(AuthStorage.inMemory());
		const runner = new ExtensionRunner([extension], runtime, cwd, SessionManager.inMemory(cwd), modelRegistry);

		expect(records).toEqual([]);
		runtime.emitRpcEvent = (name, payload) => records.push([name, payload]);
		await runner.callRpcHandler("test.emit", undefined);

		expect(records).toEqual([["nek.state", { late: true }]]);
	});
});

describe("client dialogs", () => {
	/** Records what the RPC mode writes and lets the test answer like a client. */
	function createHarness() {
		const emitted: Array<Record<string, unknown>> = [];
		const ui = createUiRequester((record) => emitted.push(record as Record<string, unknown>));
		return { ui, emitted };
	}

	it("round-trips a structured request", async () => {
		const { ui, emitted } = createHarness();

		const pending = ui.requestStructured("auth.prompt", { provider: "anthropic", prompt: { type: "secret" } });
		const request = emitted[0];

		expect(request.type).toBe("extension_ui_request");
		expect(request.method).toBe("structured");
		expect(request.kind).toBe("auth.prompt");
		expect(request.payload).toEqual({ provider: "anthropic", prompt: { type: "secret" } });

		ui.respond({ type: "extension_ui_response", id: request.id as string, result: { value: "sk-test" } });
		await expect(pending).resolves.toEqual({ value: "sk-test" });
	});

	it("resolves undefined when the client cancels a structured request", async () => {
		const { ui, emitted } = createHarness();

		const pending = ui.requestStructured("nek.plan_review", { path: "x" });
		ui.respond({ type: "extension_ui_response", id: emitted[0].id as string, cancelled: true });

		await expect(pending).resolves.toBeUndefined();
	});

	it("emits extension_ui_cancel when a dialog is aborted", async () => {
		const { ui, emitted } = createHarness();
		const controller = new AbortController();

		const pending = ui.request(
			undefined,
			{ method: "select", title: "Pick" },
			(response) => ("value" in response ? response.value : undefined),
			{ signal: controller.signal },
		);
		const request = emitted[0];
		controller.abort();

		await expect(pending).resolves.toBeUndefined();
		expect(emitted[1]).toEqual({ type: "extension_ui_cancel", id: request.id });
	});

	it("emits extension_ui_cancel when a dialog times out", async () => {
		const { ui, emitted } = createHarness();

		const pending = ui.requestStructured("auth.prompt", { provider: "x" }, { timeout: 5 });
		const request = emitted[0];

		await expect(pending).resolves.toBeUndefined();
		expect(emitted[1]).toEqual({ type: "extension_ui_cancel", id: request.id });
	});

	it("answers a select dialog with the client's value", async () => {
		const { ui, emitted } = createHarness();

		const pending = ui.request(undefined, { method: "select", title: "Pick", options: ["a", "b"] }, (response) =>
			"value" in response ? response.value : undefined,
		);
		ui.respond({ type: "extension_ui_response", id: emitted[0].id as string, value: "b" });

		await expect(pending).resolves.toBe("b");
	});

	it("ignores a response for an unknown id", () => {
		const { ui } = createHarness();

		expect(() => ui.respond({ type: "extension_ui_response", id: "unknown", cancelled: true })).not.toThrow();
	});
});
