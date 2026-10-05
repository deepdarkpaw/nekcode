/** Drives the real OpenTUI mode on an offscreen renderer with a faux provider. */

import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxProviderRegistration, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "@earendil-works/pi-coding-agent/core/agent-session-runtime";
import type { ExtensionAPI, ExtensionUIContext } from "@earendil-works/pi-coding-agent/core/extensions/types";
import { SessionManager } from "@earendil-works/pi-coding-agent/core/session-manager";
import type { Component } from "@earendil-works/pi-tui";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { OpenTuiMode } from "../../src/mode/opentui-mode.ts";
import { RendererHost } from "../../src/mode/renderer-host.ts";
import "./helpers.ts";

export interface ModeFixture {
	mode: OpenTuiMode;
	setup: TestRendererSetup;
	runtime: AgentSessionRuntime;
	faux: FauxProviderRegistration;
	/** Extension UI context captured at `session_start`. */
	ui: () => ExtensionUIContext;
	cleanup(): Promise<void>;
}

export interface FixtureOptions {
	tokensPerSecond?: number;
	height?: number;
	/** Add entries to the session before the mode starts. */
	seed?: (sessionManager: SessionManager) => void;
}

export async function createFixture(options: FixtureOptions = {}): Promise<ModeFixture> {
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
	const sessionManager = SessionManager.inMemory(dir);
	options.seed?.(sessionManager);
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd: dir, agentDir: dir, sessionManager });
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

export async function frame(f: ModeFixture): Promise<string> {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await f.setup.renderOnce();
	await f.setup.renderOnce();
	return f.setup.captureCharFrame();
}

export async function waitForFrame(f: ModeFixture, predicate: (text: string) => boolean): Promise<string> {
	let last = "";
	for (let attempt = 0; attempt < 150; attempt++) {
		last = await frame(f);
		if (predicate(last)) return last;
	}
	throw new Error(`frame never matched:\n${last}`);
}

export function isFocused(component: Component): boolean {
	return "focused" in component && component.focused === true;
}
