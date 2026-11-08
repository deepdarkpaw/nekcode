import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { getApiProvider, type ToolResultMessage } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assistantMsg, userMsg } from "../../utilities.ts";
import { createHarness, getMessageText, type Harness } from "../harness.ts";

function deferred() {
	return Promise.withResolvers<void>();
}

describe("issue #9221: core reload admission", () => {
	const harnesses: Harness[] = [];
	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			await harness.session.dispose();
			harness.cleanup();
		}
		vi.restoreAllMocks();
	});

	it.each(["command", "direct"] as const)(
		"rejects %s reload without invalidating an awaited tool context",
		async (source) => {
			const started = deferred();
			const released = deferred();
			const shutdown = vi.fn();
			const errors: string[] = [];
			let providerResults: ToolResultMessage[] = [];
			const harness = await createHarness({
				extensionFactories: [
					(pi) => {
						pi.on("session_shutdown", shutdown);
						pi.registerCommand("reload-runtime", { handler: async (_args, ctx) => ctx.reload() });
						pi.registerTool({
							name: "wait_then_succeed",
							label: "Wait then succeed",
							description: "Use the context after an await",
							parameters: Type.Object({}),
							execute: async (_id, _params, _signal, _update, ctx) => {
								started.resolve();
								await released.promise;
								ctx.getSystemPrompt();
								return { content: [{ type: "text", text: "tool succeeded" }], details: {} };
							},
						});
					},
				],
			});
			harnesses.push(harness);
			await harness.session.bindExtensions({
				mode: "rpc",
				onError: (error) => errors.push(error.error),
				commandContextActions: {
					waitForIdle: () => harness.session.waitForIdle(),
					newSession: async () => ({ cancelled: true }),
					fork: async () => ({ cancelled: true }),
					navigateTree: (targetId, options) => harness.session.navigateTree(targetId, options),
					switchSession: async () => ({ cancelled: true }),
					reload: () => harness.session.reload(),
				},
			});
			const runner = harness.session.extensionRunner;
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("wait_then_succeed", {}), { stopReason: "toolUse" }),
				(context) => {
					providerResults = context.messages.filter((message) => message.role === "toolResult");
					return fauxAssistantMessage("done");
				},
			]);
			const prompt = harness.session.prompt("run the tool");
			await started.promise;
			try {
				if (source === "command") await harness.session.prompt("/reload-runtime", { source: "rpc" });
				else
					await expect(harness.session.reload()).rejects.toThrow(
						"Wait for the current response to finish before reloading.",
					);
			} finally {
				released.resolve();
			}
			await prompt;
			const persistedResults = harness.sessionManager
				.getEntries()
				.flatMap((entry) =>
					entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
				);
			expect(persistedResults).toHaveLength(1);
			expect(persistedResults[0]).toMatchObject({ isError: false });
			expect(getMessageText(persistedResults[0])).toBe("tool succeeded");
			expect(providerResults).toEqual(persistedResults);
			expect(errors).toEqual(
				source === "command" ? ["Wait for the current response to finish before reloading."] : [],
			);
			expect(shutdown).not.toHaveBeenCalled();
			expect(harness.session.extensionRunner).toBe(runner);
			expect(runner.getActiveTools()).toContain("wait_then_succeed");
		},
	);

	it("prevents input and maintenance from entering an ongoing reload, but permits the new session_start prompt", async () => {
		const started = deferred();
		const released = deferred();
		const errors: string[] = [];
		const shutdown = vi.fn();
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_shutdown", shutdown);
					pi.on("session_start", async (event) => {
						if (event.reason === "reload") await harness.session.prompt("new runtime input");
					});
				},
			],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ onError: (error) => errors.push(error.error) });
		harness.sessionManager.appendMessage(userMsg("first user"));
		const target = harness.sessionManager.appendMessage(assistantMsg("first assistant"));
		harness.sessionManager.appendMessage(userMsg("second user"));
		harness.sessionManager.appendMessage(assistantMsg("second assistant"));
		harness.session.refreshContext();
		const runner = harness.session.extensionRunner;
		vi.spyOn(harness.session.resourceLoader, "reload").mockImplementationOnce(async () => {
			started.resolve();
			await released.promise;
		});
		// Reload intentionally resets registered APIs; the SDK streamFn retains this offline faux provider.
		harness.session.agent.streamFunction = getApiProvider(harness.faux.api)!.streamSimple;
		harness.setResponses([fauxAssistantMessage("new runtime response")]);
		const reload = harness.session.reload();
		await started.promise;
		try {
			expect(harness.session.isIdle).toBe(false);
			await expect(harness.session.prompt("must wait")).rejects.toThrow("current reload to finish");
			await expect(harness.session.steer("must wait")).rejects.toThrow("current reload to finish");
			await expect(harness.session.followUp("must wait")).rejects.toThrow("current reload to finish");
			await expect(harness.session.navigateTree(target)).rejects.toThrow("current reload to finish");
			await expect(harness.session.compact()).rejects.toThrow("current reload to finish");
			await expect(harness.session.reload()).rejects.toThrow("current reload to finish");
			expect(harness.faux.state.callCount).toBe(0);
		} finally {
			released.resolve();
		}
		await reload;
		expect(errors).toEqual([]);
		expect(shutdown).toHaveBeenCalledOnce();
		expect(harness.session.extensionRunner).not.toBe(runner);
		expect(() => runner.getActiveTools()).toThrow("stale");
		expect(harness.session.getLastAssistantText()).toBe("new runtime response");
		expect(harness.session.isIdle).toBe(true);
	});

	it("releases a failed reload reservation so callers can explicitly retry reload", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const resourceReload = vi.spyOn(harness.session.resourceLoader, "reload");
		resourceReload.mockRejectedValueOnce(new Error("resource reload failed"));
		await expect(harness.session.reload()).rejects.toThrow("resource reload failed");
		expect(harness.session.isIdle).toBe(true);
		await harness.session.reload();
		expect(resourceReload).toHaveBeenCalledTimes(2);
		expect(harness.session.isIdle).toBe(true);
	});
});
