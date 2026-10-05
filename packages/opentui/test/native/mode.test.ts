import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
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
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent/core/extensions/types";
import { SessionManager } from "@earendil-works/pi-coding-agent/core/session-manager";
import { type Component, Text } from "@earendil-works/pi-tui";
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
	/** Extension UI context captured at `session_start`. */
	ui: () => ExtensionUIContext;
	cleanup(): Promise<void>;
}

let fixture: ModeFixture | undefined;

afterEach(async () => {
	await fixture?.cleanup();
	fixture = undefined;
});

async function createFixture(options: { tokensPerSecond?: number; height?: number } = {}): Promise<ModeFixture> {
	const dir = join(tmpdir(), `nek-opentui-mode-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	const faux = registerFauxProvider({ models: [{ id: "faux-1" }], tokensPerSecond: options.tokensPerSecond });
	const model = faux.getModel();
	let capturedUi: ExtensionUIContext | undefined;
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
		pi.on("session_start", (_event, ctx) => {
			capturedUi = ctx.ui;
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
			setup = await createTestRenderer({ width: 80, height: options.height ?? 24, exitOnCtrlC: false });
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
		ui: () => {
			if (!capturedUi) throw new Error("session_start did not run");
			return capturedUi;
		},
		cleanup: async () => {
			mode.stop("resume-hint");
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
	for (let attempt = 0; attempt < 150; attempt++) {
		last = await frame(f);
		if (predicate(last)) return last;
	}
	throw new Error(`frame never matched:\n${last}`);
}

function isFocused(component: Component): boolean {
	return "focused" in component && component.focused === true;
}

describe("OpenTuiMode", () => {
	test("lays out header, editor, and footer with the editor focused", async () => {
		fixture = await createFixture();
		const text = await frame(fixture);
		expect(text).toContain("nek");
		expect(text).toContain("faux-1");
		expect(text).toContain("─");
		expect(isFocused(fixture.mode.editorComponent)).toBe(true);
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
		expect(f.mode.editor.getText()).toBe("");
		// Submitted prompts go into the editor history.
		f.setup.mockInput.pressArrow("up");
		await frame(f);
		expect(f.mode.editor.getText()).toBe("hi there");
		f.mode.stop("resume-hint");
		await run;
	});

	test("slash autocomplete lists matching commands with descriptions", async () => {
		fixture = await createFixture();
		const f = fixture;
		await f.setup.mockInput.typeText("/re");
		const text = await waitForFrame(f, (value) => value.includes("reload") && value.includes("resume"));
		expect(text).toContain("Reload");
	});

	test("built-in commands dispatch through the registry and clear the editor", async () => {
		fixture = await createFixture();
		const f = fixture;
		f.mode.editor.setText("/session");
		f.setup.mockInput.pressEnter();
		await waitForFrame(f, () => f.mode.editor.getText() === "");
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

	test("submitting while streaming queues a steering message", async () => {
		fixture = await createFixture({ tokensPerSecond: 20 });
		const f = fixture;
		f.faux.setResponses([fauxAssistantMessage("a slow reply ".repeat(20)), fauxAssistantMessage("second")]);
		const run = f.mode.run();
		await frame(f);
		await f.setup.mockInput.typeText("first");
		f.setup.mockInput.pressEnter();
		await waitForFrame(f, () => f.runtime.session.isStreaming);
		await f.setup.mockInput.typeText("steer me");
		f.setup.mockInput.pressEnter();
		const text = await waitForFrame(f, (value) => value.includes("Steering: steer me"));
		expect(text).toContain("to edit all queued messages");
		f.mode.restoreQueuedMessagesToEditor({ abort: true });
		expect(f.mode.editor.getText()).toBe("steer me");
		f.mode.stop("resume-hint");
		await run;
	});

	test("PageUp scrolls the transcript and search highlights matches", async () => {
		fixture = await createFixture({ height: 16 });
		const f = fixture;
		for (let index = 0; index < 60; index++) f.mode.transcript.appendText(`line number ${index}`);
		let text = await frame(f);
		expect(text).toContain("line number 59");
		const bottom = f.mode.viewport.maxScrollTop;
		expect(bottom).toBeGreaterThan(0);
		f.setup.mockInput.pressKey("[5~");
		text = await frame(f);
		expect(text).not.toContain("line number 59");
		expect(text).toContain("Jump to latest message");
		f.mode.viewport.toggleSearch();
		await frame(f);
		await f.setup.mockInput.typeText("number 7");
		// One match ("1/1"), scrolled into view.
		text = await waitForFrame(f, (value) => value.includes("1/1"));
		expect(text).toContain("line number 7 ");
		expect(text).not.toContain("line number 59");
		f.setup.mockInput.pressEscape();
		await frame(f);
		expect(f.mode.viewport.isSearchOpen).toBe(false);
		expect(isFocused(f.mode.editorComponent)).toBe(true);
		f.mode.viewport.scrollToBottom();
		text = await frame(f);
		expect(text).toContain("line number 59");
	});

	test("pi-tui overlays show above the shell and give focus back when hidden", async () => {
		fixture = await createFixture();
		const f = fixture;
		const handle = f.mode.tui.showOverlay(new Text("overlay body", 1, 0), { anchor: "top-right", width: 24 });
		let text = await frame(f);
		expect(text).toContain("overlay body");
		handle.hide();
		text = await frame(f);
		expect(text).not.toContain("overlay body");
		await f.setup.mockInput.typeText("typed");
		await frame(f);
		expect(f.mode.editor.getText()).toBe("typed");
	});

	test("extension widgets, statuses, and custom components render through the UI context", async () => {
		fixture = await createFixture();
		const f = fixture;
		const ui = f.ui();
		ui.setWidget("demo", ["widget line"]);
		ui.setStatus("demo", "status text");
		let text = await frame(f);
		expect(text).toContain("widget line");
		expect(text).toContain("status text");
		let finish: ((value: string) => void) | undefined;
		const result = ui.custom<string>((_tui, _theme, _keybindings, done) => {
			finish = done;
			return new Text("custom component body", 1, 0);
		});
		text = await waitForFrame(f, (value) => value.includes("custom component body"));
		finish?.("picked");
		expect(await result).toBe("picked");
		text = await frame(f);
		expect(text).not.toContain("custom component body");
		expect(isFocused(f.mode.editorComponent)).toBe(true);
	});

	test("extension select dialogs resolve the chosen option", async () => {
		fixture = await createFixture();
		const f = fixture;
		const choice = f.ui().select("Pick one", ["alpha", "beta"]);
		await waitForFrame(f, (value) => value.includes("Pick one") && value.includes("beta"));
		f.setup.mockInput.pressArrow("down");
		f.setup.mockInput.pressEnter();
		expect(await choice).toBe("beta");
	});

	test("debug log writes the rendered lines", async () => {
		fixture = await createFixture();
		const f = fixture;
		await frame(f);
		const logPath = f.mode.writeDebugLog();
		const content = readFileSync(logPath, "utf8");
		expect(content).toContain("=== All rendered lines with visible widths ===");
		expect(content).toContain("faux-1");
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
