import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from "@earendil-works/pi-ai/compat";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "@earendil-works/pi-coding-agent/core/agent-session-runtime";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent/core/extensions/types";
import { SessionManager } from "@earendil-works/pi-coding-agent/core/session-manager";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { BUILTIN_COMMANDS, matchBuiltinCommand } from "../../src/commands/registry.ts";
import { OpenTuiMode } from "../../src/mode/opentui-mode.ts";
import { RendererHost } from "../../src/mode/renderer-host.ts";
import "./helpers.ts";

interface ModeFixture {
	mode: OpenTuiMode;
	setup: TestRendererSetup;
	runtime: AgentSessionRuntime;
	faux: FauxProviderRegistration;
	cleanup(): Promise<void>;
}

let fixture: ModeFixture | undefined;

afterEach(async () => {
	await fixture?.cleanup();
	fixture = undefined;
});

async function createFixture(): Promise<ModeFixture> {
	const dir = join(tmpdir(), `nek-opentui-mode-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	const faux = registerFauxProvider({ models: [{ id: "faux-1" }] });
	const model = faux.getModel();
	const registerFaux = (pi: ExtensionAPI) => {
		pi.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((entry) => ({
				id: entry.id,
				name: entry.name,
				api: entry.api,
				reasoning: entry.reasoning,
				input: entry.input,
				cost: entry.cost,
				contextWindow: entry.contextWindow,
				maxTokens: entry.maxTokens,
			})),
		});
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
		const services = await createAgentSessionServices({
			cwd,
			agentDir: dir,
			resourceLoaderOptions: {
				extensionFactories: [registerFaux],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model });
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: dir,
		agentDir: dir,
		sessionManager: SessionManager.inMemory(dir),
	});
	let setup: TestRendererSetup | undefined;
	const rendererHost = new RendererHost({
		create: async () => {
			setup = await createTestRenderer({ width: 80, height: 24, exitOnCtrlC: false });
			return setup.renderer;
		},
	});
	const mode = new OpenTuiMode(runtime, {}, rendererHost);
	await mode.init();
	if (!setup) throw new Error("renderer was not created");
	const testSetup = setup;
	return {
		mode,
		setup: testSetup,
		runtime,
		faux,
		cleanup: async () => {
			mode.stop();
			await runtime.dispose();
			faux.unregister();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

async function frame(f: ModeFixture): Promise<string> {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await f.setup.renderOnce();
	await f.setup.renderOnce();
	return f.setup.captureCharFrame();
}

async function waitForFrame(f: ModeFixture, predicate: (text: string) => boolean): Promise<string> {
	let last = "";
	for (let attempt = 0; attempt < 100; attempt++) {
		last = await frame(f);
		if (predicate(last)) return last;
	}
	throw new Error(`frame never matched:\n${last}`);
}

describe("OpenTuiMode", () => {
	test("lays out transcript, editor, and footer", async () => {
		fixture = await createFixture();
		const text = await frame(fixture);
		expect(text).toContain("╭");
		expect(text).toContain("faux-1");
		expect(fixture.mode.editor.isFocused).toBe(true);
	});

	test("a typed prompt streams the assistant reply and tool rows into the transcript", async () => {
		fixture = await createFixture();
		const f = fixture;
		f.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: "missing.txt" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("Hello from the faux model"),
		]);
		const run = f.mode.run();
		await frame(f);
		await f.setup.mockInput.typeText("hi there");
		f.setup.mockInput.pressEnter();
		const text = await waitForFrame(f, (value) => value.includes("Hello from the faux model"));
		expect(text).toContain("hi there");
		expect(text).toContain("missing.txt");
		expect(text).not.toContain("not found");
		expect(f.mode.editor.getText()).toBe("");
		expect(f.mode.editor.historyEntries).toEqual(["hi there"]);
		f.mode.stop();
		await run;
	});

	test("built-in commands dispatch through the registry and clear the editor", async () => {
		fixture = await createFixture();
		const f = fixture;
		f.mode.editor.setText("/session");
		f.setup.mockInput.pressEnter();
		const text = await waitForFrame(f, (value) => value.includes("/session is not implemented"));
		expect(text).toContain("Warning:");
		expect(f.mode.editor.getText()).toBe("");
		expect(f.runtime.session.messages).toHaveLength(0);
	});

	test("app.clear clears the editor", async () => {
		fixture = await createFixture();
		const f = fixture;
		f.mode.editor.setText("draft");
		f.setup.mockInput.pressCtrlC();
		await frame(f);
		expect(f.mode.editor.getText()).toBe("");
	});
});

describe("command registry", () => {
	test("every built-in slash command has exactly one handler module", () => {
		const names = BUILTIN_COMMANDS.map((command) => command.name);
		expect(new Set(names).size).toBe(names.length);
		for (const name of [
			"settings",
			"model",
			"tree",
			"thinking",
			"scoped-models",
			"export",
			"import",
			"share",
			"copy",
			"name",
			"session",
			"changelog",
			"hotkeys",
			"fork",
			"clone",
			"trust",
			"login",
			"logout",
			"new",
			"compact",
			"resume",
			"reload",
			"quit",
			"debug",
			"arminsayshi",
			"dementedelves",
		]) {
			expect(names).toContain(name);
		}
	});

	test("matching follows the interactive mode", () => {
		expect(matchBuiltinCommand("/model")?.invocation).toEqual({ name: "model", args: undefined, text: "/model" });
		expect(matchBuiltinCommand("/model claude opus")?.invocation.args).toBe("claude opus");
		expect(matchBuiltinCommand("/session extra")).toBeUndefined();
		expect(matchBuiltinCommand("/unknown")).toBeUndefined();
		expect(matchBuiltinCommand("hello /model")).toBeUndefined();
	});
});
