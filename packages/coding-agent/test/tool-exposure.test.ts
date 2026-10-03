import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createToolSearchExtension } from "../src/extensions/tool-search/index.ts";

function tool(name: string, exposure: "deferred" | "hidden") {
	return {
		name,
		label: name,
		description: `${name} tool for searching documents`,
		promptSnippet: `Use ${name} for document searches`,
		parameters: Type.Object({}),
		exposure,
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
	};
}

describe("tool exposure", () => {
	let tempDir: string;
	let agentDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-tool-exposure-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		agentDir = join(tempDir, "agent");
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
	});

	it("keeps deferred tools out of the initial loadout, exposes tool_search, and loads matches", async () => {
		const settingsManager = SettingsManager.create(tempDir, agentDir);
		const resourceLoader = new DefaultResourceLoader({
			cwd: tempDir,
			agentDir,
			settingsManager,
			extensionFactories: [
				createToolSearchExtension(),
				(pi) => {
					pi.registerTool(tool("deferred_docs", "deferred"));
					pi.registerTool(tool("secret_tool", "hidden"));
				},
			],
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: SessionManager.inMemory(tempDir),
			resourceLoader,
		});

		const allTools = session.getAllTools();
		expect(allTools.find((entry) => entry.name === "web_search")?.exposure).toBe("direct");
		expect(allTools.find((entry) => entry.name === "deferred_docs")?.exposure).toBe("deferred");
		expect(session.getActiveToolNames()).toContain("tool_search");
		expect(session.getActiveToolNames()).not.toContain("deferred_docs");
		expect(session.getActiveToolNames()).not.toContain("secret_tool");
		expect(session.systemPrompt).not.toContain("deferred_docs");
		expect(session.systemPrompt).not.toContain("secret_tool");

		const search = session.agent.state.tools.find((entry) => entry.name === "tool_search");
		expect(search).toBeDefined();
		if (!search) return;
		const searchResult = await search.execute("search-1", { query: "documents", limit: 1 });
		expect(searchResult.details.loaded).not.toContain("web_search");
		expect(session.getActiveToolNames()).toContain("deferred_docs");
		expect(session.getActiveToolNames()).not.toContain("tool_search");
		expect(session.systemPrompt).toContain("deferred_docs");
		session.dispose();
	});
});
