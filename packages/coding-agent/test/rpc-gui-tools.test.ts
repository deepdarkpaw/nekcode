/**
 * `list_builtin_tools`: the built-in tool list a settings page renders.
 *
 * The test asserts the list follows `core/tool-names.ts` (names, order, default selection) and that
 * descriptions come from the tool definitions, so no second list can drift from the first.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { allToolNames, DEFAULT_ACTIVE_TOOL_NAMES } from "../src/core/tool-names.ts";
import { createAllToolDefinitions } from "../src/core/tools/index.ts";
import { createGuiContext, type GuiContext } from "../src/modes/rpc/gui/context.ts";
import type { GuiDeps } from "../src/modes/rpc/gui/handlers.ts";
import { handleGuiCommand } from "../src/modes/rpc/gui/handlers.ts";
import { listBuiltinTools } from "../src/modes/rpc/gui/tools.ts";

/** A model runtime these commands never read. */
function stubModelRuntime(): ModelRuntime {
	return {} as unknown as ModelRuntime;
}

describe("list_builtin_tools", () => {
	let agentDir: string;
	let ctx: GuiContext;
	const deps: GuiDeps = { reload: async () => ({ deferred: false, diagnostics: [] }) };

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "nek-gui-tools-"));
		ctx = createGuiContext({
			mode: "control",
			cwd: agentDir,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			modelRuntime: stubModelRuntime(),
			emit: () => {},
		});
	});

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
	});

	it("lists every built-in tool in enumeration order", () => {
		const tools = listBuiltinTools(ctx);

		expect(tools.map((tool) => tool.name)).toEqual([...allToolNames]);
	});

	it("marks exactly the default active tools", () => {
		const tools = listBuiltinTools(ctx);

		expect(tools.filter((tool) => tool.defaultActive).map((tool) => tool.name)).toEqual([
			...DEFAULT_ACTIVE_TOOL_NAMES,
		]);
		expect(tools.find((tool) => tool.name === "powershell")?.defaultActive).toBe(false);
		expect(tools.find((tool) => tool.name === "read")?.defaultActive).toBe(true);
	});

	it("takes each description from the tool definition", () => {
		const definitions = createAllToolDefinitions(ctx.cwd);

		for (const tool of listBuiltinTools(ctx)) {
			expect(tool.description, tool.name).toBe(definitions[tool.name as keyof typeof definitions].description);
			expect(tool.description?.length ?? 0).toBeGreaterThan(0);
		}
	});

	it("answers the command through the GUI dispatch table", async () => {
		const response = (await handleGuiCommand({ id: "t1", type: "list_builtin_tools" }, ctx, deps)) as {
			id?: string;
			command: string;
			success: boolean;
			data: { tools: Array<{ name: string; description?: string; defaultActive: boolean }> };
		};

		expect(response.id).toBe("t1");
		expect(response.command).toBe("list_builtin_tools");
		expect(response.success).toBe(true);
		expect(response.data.tools).toHaveLength(allToolNames.size);
	});
});
