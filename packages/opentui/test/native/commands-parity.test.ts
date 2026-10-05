import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	BUILTIN_COMMANDS,
	findKeyAction,
	getBuiltinCommand,
	matchBuiltinCommand,
} from "../../src/commands/registry.ts";
import type { ModeContext } from "../../src/mode/mode-context.ts";
import { modelArgumentCompletions } from "../../src/selectors/model.ts";
import { MODE_STARTUP_FLOWS } from "../../src/startup/index.ts";

const model = { provider: "faux", id: "faux-1", name: "Faux One" } as unknown as Model<Api>;

function contextWithModels(): ModeContext {
	return {
		session: { scopedModels: [], modelRuntime: { getAvailableSnapshot: () => [model] } },
	} as unknown as ModeContext;
}

describe("native command contracts", () => {
	test("registers every built-in command without a stub", () => {
		expect(BUILTIN_COMMANDS).toHaveLength(26);
		expect(
			BUILTIN_COMMANDS.every((command) => command.run.toString().includes("reportNotImplemented") === false),
		).toBe(true);
	});

	test("preserves argument matching and completions", () => {
		expect(matchBuiltinCommand("/thinking high")?.invocation.args).toBe("high");
		expect(getBuiltinCommand("model")?.getArgumentCompletions?.(contextWithModels(), "faux")).toEqual([
			{ value: "faux/faux-1", label: "faux-1", description: "faux" },
		]);
		expect(modelArgumentCompletions(contextWithModels(), "faux")).toHaveLength(1);
	});
});

describe("native command-owned keys and startup", () => {
	test("matches configurable cycling keys", () => {
		const keybindings = { matches: (_data: string, id: string) => id === "app.thinking.cycle" };
		expect(findKeyAction(keybindings, "configured-cycle")?.id).toBe("app.thinking.cycle");
	});

	test("contains required startup flows", () => {
		const ids = new Set(MODE_STARTUP_FLOWS.map((flow) => flow.id));
		for (const id of [
			"changelog",
			"startup-diagnostics",
			"model-catalog-refresh",
			"tmux-keyboard-check",
			"model-auth-warning",
		]) {
			expect(ids.has(id)).toBe(true);
		}
	});
});
