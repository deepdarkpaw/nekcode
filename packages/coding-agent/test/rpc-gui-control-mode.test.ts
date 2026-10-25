/**
 * Control RPC mode: the command allowlist, the refusal message, and a control-mode command round trip.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { controlModeError, handleControlCommand, isControlCommand } from "../src/modes/rpc/control-mode.ts";
import { createGuiContext, type GuiContext } from "../src/modes/rpc/gui/context.ts";
import type { GuiDeps } from "../src/modes/rpc/gui/handlers.ts";
import { NEK_CONTROL_COMMANDS, NEK_GUI_PROTOCOL_VERSION } from "../src/modes/rpc/gui/protocol.ts";

/** A model runtime that answers only the calls a control command makes without a network. */
function stubModelRuntime(): ModelRuntime {
	return { getAvailableSnapshot: () => [], getModels: () => [] } as unknown as ModelRuntime;
}

describe("control RPC mode", () => {
	let agentDir: string;
	let ctx: GuiContext;
	const deps: GuiDeps = { reload: async () => ({ deferred: false, diagnostics: [] }) };

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "nek-control-"));
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

	it("accepts exactly the documented control commands", () => {
		for (const type of NEK_CONTROL_COMMANDS) {
			expect(isControlCommand(type), type).toBe(true);
		}
		for (const type of [
			"prompt",
			"abort",
			"get_state",
			"get_entries",
			"get_messages",
			"set_model",
			"fork",
			"clone",
			"extension_call",
			"export_session",
			"share_session",
			"navigate_tree",
			"set_entry_label",
		]) {
			expect(isControlCommand(type), type).toBe(false);
		}
	});

	it("refuses other commands with the documented message", async () => {
		const response = (await handleControlCommand({ id: "r1", type: "prompt" }, ctx, deps)) as {
			id?: string;
			command: string;
			success: boolean;
			error?: string;
		};

		expect(response.success).toBe(false);
		expect(response.id).toBe("r1");
		expect(response.command).toBe("prompt");
		expect(response.error).toBe("Command not available in control mode: prompt");
		expect(controlModeError("get_state")).toBe("Command not available in control mode: get_state");
	});

	it("answers get_info without a session", async () => {
		const response = (await handleControlCommand({ type: "get_info" }, ctx, deps)) as {
			success: boolean;
			data: { mode: string; protocolVersion: number; agentDir: string; cwd: string; sessionDir: string };
		};

		expect(response.success).toBe(true);
		expect(response.data.mode).toBe("control");
		expect(response.data.protocolVersion).toBe(NEK_GUI_PROTOCOL_VERSION);
		expect(response.data.agentDir).toBe(agentDir);
		expect(response.data.sessionDir).toBe(join(agentDir, "sessions"));
	});

	it("answers get_available_models without a session", async () => {
		const response = (await handleControlCommand({ id: "m1", type: "get_available_models" }, ctx, deps)) as {
			command: string;
			success: boolean;
			data: { models: unknown[] };
		};

		expect(response.command).toBe("get_available_models");
		expect(response.success).toBe(true);
		expect(response.data.models).toEqual([]);
	});

	it("answers get_changelog and validate_config", async () => {
		const changelog = (await handleControlCommand({ type: "get_changelog" }, ctx, deps)) as {
			data: { markdown: string };
		};
		expect(typeof changelog.data.markdown).toBe("string");
		expect(changelog.data.markdown.length).toBeGreaterThan(0);

		const config = (await handleControlCommand({ type: "validate_config" }, ctx, deps)) as {
			success: boolean;
			data: { diagnostics: unknown[] };
		};
		expect(config.success).toBe(true);
		expect(Array.isArray(config.data.diagnostics)).toBe(true);
	});
});
