import {
	fauxAssistantMessage,
	fauxToolCall,
	getCurrentSystemPrompt,
	getCurrentTools,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { DEFAULT_NEK_CONFIG } from "../../src/extensions/nek/config.ts";
import { createNekExtension } from "../../src/extensions/nek/index.ts";
import { BUILTIN_AGENT_TYPES } from "../../src/extensions/nek/services/agent-types.ts";
import { childToolNames } from "../../src/extensions/nek/services/child-session.ts";
import { createToolSearchExtension } from "../../src/extensions/tool-search/index.ts";
import type { ExtensionAPI, ExtensionFactory, ToolDefinition, ToolResultEventResult } from "../../src/index.ts";
import { createHarness } from "./harness.ts";

function registerDeferredAndHiddenTools(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "deferred_docs",
		label: "Deferred docs",
		description: "Search project documents and documentation",
		promptSnippet: "Search project documents",
		exposure: "deferred",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "docs" }], details: {} }),
	});
	pi.registerTool({
		name: "hidden_secret",
		label: "Hidden secret",
		description: "A secret tool that must never be declared",
		exposure: "hidden",
		promptSnippet: "Secret metadata must never appear",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "secret" }], details: {} }),
	});
}

function toolNames(context: TranscriptContext): string[] {
	return getCurrentTools(context.messages).map((tool) => tool.name);
}

describe("tool exposure provider declarations", () => {
	it("discovers deferred tools for the next request and never declares hidden tools", async () => {
		const harness = await createHarness({
			tools: [],
			extensionFactories: [createToolSearchExtension(), registerDeferredAndHiddenTools],
		});
		try {
			harness.session.setActiveToolsByName(["tool_search", "hidden_secret"]);
			const providerTools: string[][] = [];
			const providerPrompts: string[] = [];
			harness.setResponses([
				(context) => {
					providerTools.push(toolNames(context));
					providerPrompts.push(getCurrentSystemPrompt(context.messages));
					return fauxAssistantMessage(fauxToolCall("tool_search", { query: "documents" }), {
						stopReason: "toolUse",
					});
				},
				(context) => {
					providerTools.push(toolNames(context));
					providerPrompts.push(getCurrentSystemPrompt(context.messages));
					return fauxAssistantMessage("done");
				},
			]);

			await harness.session.prompt("find the documents");

			expect(providerTools[0]).toEqual(["tool_search"]);
			expect(providerTools[0]).not.toContain("deferred_docs");
			expect(providerTools[0]).not.toContain("hidden_secret");
			expect(providerPrompts[0]).not.toContain("deferred_docs");
			expect(providerPrompts[0]).not.toContain("hidden_secret");
			expect(providerTools[1]).toEqual(["deferred_docs"]);
			expect(providerPrompts[1]).toContain("deferred_docs");
			expect(providerTools[1]).not.toContain("hidden_secret");
			expect(providerPrompts.every((prompt) => !prompt.includes("Secret metadata"))).toBe(true);
		} finally {
			harness.cleanup();
		}
	});

	it("reports web_search as direct and never searches or loads it while inactive", async () => {
		const harness = await createHarness({
			extensionFactories: [
				createToolSearchExtension(),
				(pi) => {
					pi.registerTool({
						name: "lunar_ephemeris",
						label: "Lunar ephemeris",
						description: "Calculate lunar positions",
						exposure: "deferred",
						parameters: Type.Object({}),
						execute: async () => ({ content: [], details: {} }),
					});
				},
			],
		});
		try {
			expect(harness.session.getToolDefinition("web_search")?.exposure).toBe("direct");
			expect(harness.session.getAllTools().find((tool) => tool.name === "web_search")?.exposure).toBe("direct");
			harness.session.setActiveToolsByName(["tool_search"]);
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("tool_search", { query: "web_search" }), { stopReason: "toolUse" }),
				(context) => {
					expect(toolNames(context)).not.toContain("web_search");
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("find a web search tool");
			const results = harness.session.messages.filter((message) => message.role === "toolResult");
			expect(results).toEqual([
				expect.objectContaining({
					toolName: "tool_search",
					details: { loaded: [] },
					content: [{ type: "text", text: "No matching tools found." }],
				}),
			]);
			expect(harness.session.getActiveToolNames()).toEqual(["tool_search"]);
		} finally {
			harness.cleanup();
		}
	});

	it("preserves direct exposure and mode-controlled activation for all nek tools", async () => {
		const harness = await createHarness({
			extensionFactories: [
				createNekExtension({ role: "root", config: DEFAULT_NEK_CONFIG }),
				createToolSearchExtension(),
			],
		});
		try {
			const nekTools = [
				"subagent",
				"await",
				"todo_write",
				"create_plan",
				"update_plan",
				"switch_mode",
				"ask_question",
			];
			expect(harness.session.getActiveToolNames()).toEqual(expect.arrayContaining(nekTools));
			await harness.session.bindExtensions({ mode: "print" });
			const registeredNekTools = harness.session
				.getAllTools()
				.filter((tool) => tool.sourceInfo.path === "<inline:1>");
			expect(registeredNekTools.map((tool) => tool.name).sort()).toEqual([...nekTools].sort());
			expect(registeredNekTools.every((tool) => tool.exposure === "direct")).toBe(true);
			expect(harness.session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["subagent", "await", "todo_write", "switch_mode", "ask_question"]),
			);
			expect(harness.session.getActiveToolNames()).not.toContain("create_plan");
			expect(harness.session.getActiveToolNames()).not.toContain("update_plan");
			expect(harness.session.getActiveToolNames()).not.toContain("tool_search");
			await harness.session.prompt("/plan");
			expect(harness.session.getActiveToolNames()).toEqual(expect.arrayContaining(nekTools));
			await harness.session.prompt("/agent");
			expect(harness.session.getActiveToolNames()).not.toContain("create_plan");
			expect(harness.session.getActiveToolNames()).not.toContain("update_plan");
		} finally {
			harness.cleanup();
		}
	});

	it("keeps nek child-session name-based restrictions intact", async () => {
		const harness = await createHarness({
			extensionFactories: [
				createNekExtension({ role: "subagent", config: DEFAULT_NEK_CONFIG }),
				createToolSearchExtension(),
			],
		});
		try {
			await harness.session.bindExtensions({ mode: "print" });
			const general = BUILTIN_AGENT_TYPES.find((type) => type.name === "generalPurpose");
			if (!general) throw new Error("Missing generalPurpose type");
			for (const readonly of [false, true]) {
				const names = childToolNames(general, readonly);
				harness.session.setActiveToolsByName(names);
				expect(harness.session.getActiveToolNames()).toEqual(names);
				harness.setResponses([
					(context) => {
						expect(toolNames(context)).toEqual(names);
						return fauxAssistantMessage("done");
					},
				]);
				await harness.session.prompt("inspect the files");
			}
			expect(harness.session.getAllTools().find((tool) => tool.name === "todo_write")?.exposure).toBe("direct");
			expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("subagent");
		} finally {
			harness.cleanup();
		}
	});
	it("honors defaultActive, resolves metadata, and treats model-only as direct", async () => {
		const outputSchema = Type.Object({ value: Type.Number() });
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				createToolSearchExtension(),
				(pi) => {
					pi.registerTool({
						name: "optional_direct",
						label: "Optional direct",
						description: "Optional direct tool",
						defaultActive: false,
						parameters: Type.Object({}),
						outputSchema,
						execute: async () => ({ content: [], details: {}, structuredContent: { value: 1 } }),
					});
					pi.registerTool({
						name: "model_only",
						label: "Model only",
						description: "A model-facing tool",
						exposure: "model-only",
						parameters: Type.Object({}),
						execute: async () => ({ content: [], details: {} }),
					});
					registerDeferredAndHiddenTools(pi);
				},
			],
		});
		try {
			expect(harness.session.getActiveToolNames()).toEqual(["model_only", "tool_search"]);
			expect(harness.session.getAllTools().find((tool) => tool.name === "optional_direct")?.exposure).toBe("direct");
			harness.session.setActiveToolsByName(["optional_direct", "model_only", "deferred_docs", "hidden_secret"]);
			expect(harness.session.getActiveToolNames()).toEqual(["optional_direct", "model_only", "deferred_docs"]);
			expect(harness.session.agent.state.tools.find((tool) => tool.name === "optional_direct")?.outputSchema).toBe(
				outputSchema,
			);
		} finally {
			harness.cleanup();
		}
	});

	it("updates discovery immediately after registration, activation, and exposure changes", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				createToolSearchExtension(),
				(pi) => {
					api = pi;
				},
			],
		});
		try {
			if (!api) throw new Error("Extension was not loaded");
			expect(harness.session.getActiveToolNames()).toEqual([]);
			const deferred: ToolDefinition = {
				name: "docs_lookup",
				label: "Docs lookup",
				description: "Find reference documents",
				promptSnippet: "Find reference documents",
				exposure: "deferred",
				defaultActive: true,
				namespace: { name: "docs", description: "Reference documentation" },
				annotations: { readOnlyHint: true },
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: {} }),
			};
			api.registerTool(deferred);
			expect(harness.session.getActiveToolNames()).toEqual(["tool_search"]);
			expect(harness.session.getToolDefinition("tool_search")?.description).toContain(
				"- docs: Reference documentation",
			);
			expect(harness.session.getAllTools().find((tool) => tool.name === deferred.name)).toMatchObject({
				exposure: "deferred",
				namespace: deferred.namespace,
				annotations: deferred.annotations,
			});
			api.setActiveTools(["docs_lookup"]);
			expect(harness.session.getActiveToolNames()).toEqual(["docs_lookup"]);
			api.setActiveTools([]);
			expect(harness.session.getActiveToolNames()).toEqual(["tool_search"]);
			api.registerTool({ ...deferred, exposure: "hidden" });
			expect(harness.session.getActiveToolNames()).toEqual([]);
			api.registerTool({ ...deferred, exposure: "direct" });
			expect(harness.session.getActiveToolNames()).toEqual(["docs_lookup"]);
		} finally {
			harness.cleanup();
		}
	});

	it("never auto-activates a hidden tool named tool_search", async () => {
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				(pi) => {
					registerDeferredAndHiddenTools(pi);
					pi.registerTool({
						name: "tool_search",
						label: "Private search",
						description: "Private search tool",
						exposure: "hidden",
						parameters: Type.Object({}),
						execute: async () => ({ content: [], details: {} }),
					});
				},
			],
		});
		try {
			harness.session.setActiveToolsByName(["tool_search", "hidden_secret"]);
			expect(harness.session.getActiveToolNames()).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("does not auto-activate another extension's direct tool_search replacement", async () => {
		const replacement: ExtensionFactory = (pi) =>
			pi.registerTool({
				name: "tool_search",
				label: "Replacement",
				description: "Custom search",
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: {} }),
			});
		const harness = await createHarness({
			tools: [],
			extensionFactories: [replacement, registerDeferredAndHiddenTools, createToolSearchExtension()],
		});
		try {
			harness.session.setActiveToolsByName([]);
			expect(harness.session.getActiveToolNames()).toEqual([]);
			harness.session.setActiveToolsByName(["tool_search"]);
			expect(harness.session.getActiveToolNames()).toEqual(["tool_search"]);
		} finally {
			harness.cleanup();
		}
	});

	it("keeps the tools allowlist authoritative for discovery and explicit activation", async () => {
		const harness = await createHarness({
			tools: [],
			allowedToolNames: ["tool_search", "hidden_secret"],
			extensionFactories: [createToolSearchExtension(), registerDeferredAndHiddenTools],
		});
		try {
			expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("deferred_docs");
			harness.session.setActiveToolsByName(["deferred_docs", "hidden_secret", "tool_search"]);
			expect(harness.session.getActiveToolNames()).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});
	it("preserves or replaces structured results through tool_result handlers", async () => {
		const patches: ToolResultEventResult[] = [
			{ details: { changed: true } },
			{ structuredContent: { value: "replacement" } },
			{ content: [{ type: "text", text: "redacted" }] },
			{ content: [{ type: "text", text: "new content" }], structuredContent: { value: "both" } },
		];
		const seen: unknown[] = [];
		for (const patch of patches) {
			const harness = await createHarness({
				tools: [],
				extensionFactories: [
					(pi) => {
						pi.registerTool({
							name: "structured",
							label: "Structured",
							description: "Structured output",
							parameters: Type.Object({}),
							outputSchema: Type.Object({ value: Type.String() }),
							execute: async () => ({
								content: [{ type: "text", text: "public" }],
								details: { kept: true },
								structuredContent: { value: "original" },
								isError: true,
							}),
						});
						pi.on("tool_result", (event) => {
							expect(event.structuredContent).toEqual({ value: "original" });
							expect(event.isError).toBe(true);
							return patch;
						});
					},
				],
			});
			try {
				harness.setResponses([
					fauxAssistantMessage(fauxToolCall("structured", {}), { stopReason: "toolUse" }),
					(context) => {
						const result = context.messages.find((message) => message.role === "toolResult");
						expect(result).not.toHaveProperty("structuredContent");
						expect(result).toMatchObject({ isError: true, details: patch.details ?? { kept: true } });
						return fauxAssistantMessage("done");
					},
				]);
				await harness.session.prompt("run the tool");
				const events = harness.eventsOfType("tool_execution_end");
				expect(events).toHaveLength(1);
				seen.push(events[0].result.structuredContent);
			} finally {
				harness.cleanup();
			}
		}
		expect(seen).toEqual([{ value: "original" }, { value: "replacement" }, undefined, { value: "both" }]);
	});
	it("restores discovered tools on tree navigation and filters tools that became hidden", async () => {
		let api: ExtensionAPI | undefined;
		const harness = await createHarness({
			tools: [],
			extensionFactories: [
				createToolSearchExtension(),
				(pi) => {
					api = pi;
					registerDeferredAndHiddenTools(pi);
				},
			],
		});
		try {
			harness.setResponses([
				fauxAssistantMessage(fauxToolCall("tool_search", { query: "documents" }), { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("find the documents");
			const initial = harness.sessionManager
				.getEntries()
				.find((entry) => entry.type === "message" && entry.message.role === "system");
			const loadedLeaf = harness.sessionManager.getLeafId();
			if (!initial || !loadedLeaf || !api) throw new Error("Expected persisted loadout entries");
			await harness.session.navigateTree(initial.id);
			expect(harness.session.getActiveToolNames()).toEqual(["tool_search"]);
			await harness.session.navigateTree(loadedLeaf);
			expect(harness.session.getActiveToolNames()).toEqual(["deferred_docs"]);
			const definition = harness.session.getToolDefinition("deferred_docs");
			if (!definition) throw new Error("Expected deferred tool definition");
			api.registerTool({ ...definition, exposure: "hidden" });
			await harness.session.navigateTree(initial.id);
			await harness.session.navigateTree(loadedLeaf);
			expect(harness.session.getActiveToolNames()).toEqual([]);
			harness.setResponses([
				(context) => {
					expect(toolNames(context)).toEqual([]);
					expect(getCurrentSystemPrompt(context.messages)).not.toContain("deferred_docs");
					return fauxAssistantMessage("done");
				},
			]);
			await harness.session.prompt("continue");
		} finally {
			harness.cleanup();
		}
	});
});
