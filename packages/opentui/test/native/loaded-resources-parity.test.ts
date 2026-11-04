import { beforeAll, describe, expect, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent/core/agent-session";
import { createSyntheticSourceInfo } from "@earendil-works/pi-coding-agent/core/source-info";
import { InteractiveMode } from "@earendil-works/pi-coding-agent/modes/interactive/interactive-mode";
import { initTheme } from "@earendil-works/pi-coding-agent/modes/interactive/theme/theme";
import { Container } from "@earendil-works/pi-tui";
import { renderLoadedResources } from "../../src/mode/loaded-resources.ts";

beforeAll(() => initTheme("dark", false));

describe("native resource listing parity", () => {
	for (const expanded of [false, true])
		test(`preserves listing and diagnostics with expanded=${expanded}`, () => {
			const sourceInfo = createSyntheticSourceInfo("/workspace/node_modules/example", {
				source: "npm:example",
				scope: "project",
				baseDir: "/workspace/node_modules/example",
			});
			const session = {
				sessionManager: { getCwd: () => "/workspace" },
				promptTemplates: [{ name: "review", filePath: "/workspace/review.md" }],
				extensionRunner: {
					getRegisteredCommands: () => [],
					getCommandDiagnostics: () => [],
					getShortcutDiagnostics: () => [],
				},
				resourceLoader: {
					getSystemPromptSource: () => undefined,
					getAppendSystemPromptSources: () => [],
					getAgentsFiles: () => ({ agentsFiles: [{ path: "/workspace/AGENTS.md" }] }),
					getSkills: () => ({
						skills: [{ name: "check", filePath: "/workspace/skills/check.md" }],
						diagnostics: [],
					}),
					getPrompts: () => ({
						prompts: [],
						diagnostics: [{ type: "warning", message: "example warning", path: "/workspace/review.md" }],
					}),
					getThemes: () => ({ themes: [], diagnostics: [] }),
					getExtensions: () => ({
						extensions: [{ path: "/workspace/node_modules/example/extensions/index.ts", sourceInfo }],
						errors: [],
					}),
				},
			} as unknown as AgentSession;
			const legacy = Object.setPrototypeOf(
				{
					session,
					sessionManager: session.sessionManager,
					settingsManager: { getQuietStartup: () => false },
					options: { verbose: false },
					toolOutputExpanded: expanded,
					loadedResourcesContainer: new Container(),
				},
				InteractiveMode.prototype,
			);
			Reflect.get(InteractiveMode.prototype, "showLoadedResources").call(legacy);
			const native = new Container();
			renderLoadedResources(native, {
				session,
				showListing: true,
				showDiagnostics: true,
				expanded,
				extraExtensionDiagnostics: [],
			});
			expect(native.render(160)).toEqual(legacy.loadedResourcesContainer.render(160));
			expect(native.render(32)).toEqual(legacy.loadedResourcesContainer.render(32));
		});
});
