import { fauxAssistantMessage, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createEventBus } from "../../src/core/event-bus.ts";
import type { ExtensionAPI } from "../../src/core/extensions/types.ts";
import { createToolSearchExtension } from "../../src/extensions/tool-search/index.ts";
import {
	getPendingDeferredSources,
	registerPendingDeferredSource,
	waitForDeferredSources,
} from "../../src/extensions/tool-search/pending.ts";
import { createHarness, getMessageText, getToolResult } from "./harness.ts";

async function setup(sourceWaitMs = 1000) {
	let api: ExtensionAPI | undefined;
	const harness = await createHarness({
		tools: [],
		extensionFactories: [
			createToolSearchExtension({ sourceWaitMs }),
			(pi) => {
				api = pi;
			},
		],
	});
	if (!api) throw new Error("Missing API");
	let ready: () => void = () => {};
	const promise = new Promise<void>((resolve) => {
		ready = resolve;
	});
	const remove = registerPendingDeferredSource(api.events, {
		namespace: { name: "reference", description: "Reference documentation" },
		ready: promise,
	});
	const finish = () => {
		api?.registerTool({
			name: "lookup_docs",
			label: "Lookup docs",
			description: "Search the reference documentation",
			exposure: "deferred",
			namespace: { name: "reference" },
			parameters: Type.Object({}),
			execute: async () => ({ content: [{ type: "text", text: "found" }], details: undefined }),
		});
		ready();
		remove();
	};
	return { harness, finish, remove };
}

describe("pending deferred tool sources", () => {
	it("uses bounded listener counts and cleans up all sources on runtime invalidation", () => {
		const events = createEventBus();
		const on = vi.spyOn(events, "on");
		const removals = Array.from({ length: 20 }, (_, index) =>
			registerPendingDeferredSource(events, {
				namespace: { name: `source_${index}` },
				ready: new Promise<void>(() => {}),
			}),
		);
		expect(on).toHaveBeenCalledTimes(2);
		expect(getPendingDeferredSources(events)).toHaveLength(20);
		removals[0]();
		expect(getPendingDeferredSources(events)).toHaveLength(19);
		events.emit("runtime_invalidated", undefined);
		expect(getPendingDeferredSources(events)).toEqual([]);
		for (const remove of removals) remove();
		events.clear();
	});

	it("cancels a pending wait without dropping the source", async () => {
		const events = createEventBus();
		const remove = registerPendingDeferredSource(events, {
			namespace: { name: "slow" },
			ready: new Promise<void>(() => {}),
		});
		const controller = new AbortController();
		const wait = waitForDeferredSources(events, 10_000, controller.signal);
		controller.abort(new Error("cancelled"));
		await expect(wait).rejects.toThrow("cancelled");
		expect(getPendingDeferredSources(events)).toHaveLength(1);
		remove();
		events.clear();
	});

	it("finishes waiting when a source rejects", async () => {
		const events = createEventBus();
		const remove = registerPendingDeferredSource(events, {
			namespace: { name: "failed" },
			ready: Promise.reject(new Error("connection failed")),
		});
		await waitForDeferredSources(events, 10_000);
		remove();
		expect(getPendingDeferredSources(events)).toEqual([]);
		events.clear();
	});

	it("declares tool_search to the model while no source tools have been registered", async () => {
		const { harness, remove } = await setup();
		try {
			expect(harness.session.getActiveToolNames()).toEqual(["tool_search"]);
			expect(harness.session.getToolDefinition("tool_search")?.description).toContain(
				"reference: Reference documentation",
			);
			harness.setResponses([
				(context) => {
					expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["tool_search"]);
					return fauxAssistantMessage("ready");
				},
			]);
			await harness.session.prompt("start");
			remove();
			expect(harness.session.getActiveToolNames()).toEqual([]);
		} finally {
			remove();
			harness.cleanup();
		}
	});

	it("waits for sources before searching and activates tools registered during the wait", async () => {
		const { harness, finish, remove } = await setup();
		try {
			harness.setResponses([
				() => {
					setTimeout(finish, 30);
					return fauxAssistantMessage(fauxToolCall("tool_search", { query: "reference docs" }), {
						stopReason: "toolUse",
					});
				},
				(context) => {
					expect(getCurrentTools(context.messages).map((tool) => tool.name)).toEqual(["lookup_docs"]);
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("find docs");
			expect(getToolResult(harness, "tool_search").details).toEqual({ loaded: ["lookup_docs"] });
		} finally {
			remove();
			harness.cleanup();
		}
	});

	it("bounds the wait and leaves a hanging source discoverable for a later call", async () => {
		const { harness, finish, remove } = await setup(20);
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("tool_search", { query: "docs" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("find docs");
			expect(getMessageText(getToolResult(harness, "tool_search"))).toBe("No matching tools found.");
			expect(harness.session.getActiveToolNames()).toEqual(["tool_search"]);
			finish();
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("tool_search", { query: "docs" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("find docs again");
			expect(harness.session.getActiveToolNames()).toEqual(["lookup_docs"]);
		} finally {
			remove();
			harness.cleanup();
		}
	});
});
