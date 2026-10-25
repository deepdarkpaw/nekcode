import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AutocompleteProvider, CombinedAutocompleteProvider } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import type { AutocompleteProviderFactory, ExtensionUIContext } from "../../src/core/extensions/index.ts";
import { DEFAULT_NEK_CONFIG } from "../../src/extensions/nek/config.ts";
import { createNekExtension } from "../../src/extensions/nek/index.ts";
import { SUBAGENT_DESCRIPTION } from "../../src/extensions/nek/prompts/subagent.ts";
import { initTheme, type Theme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./harness.ts";

/** UI context that only records the autocomplete wrappers an extension adds. */
function createUiContext(factories: AutocompleteProviderFactory[]): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => undefined as T,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: (factory) => {
			factories.push(factory);
		},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: (_theme: string | Theme) => ({ success: false, error: "Theme switching not available in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

describe("nek @agent mentions", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark", false);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		while (harnesses.length > 0) {
			const harness = harnesses.pop()!;
			await harness.session.dispose();
			harness.cleanup();
		}
	});

	it("offers built-in and custom subagent types after @ once the session starts", async () => {
		const harness = await createHarness({
			extensionFactories: [createNekExtension({ role: "root", config: DEFAULT_NEK_CONFIG })],
		});
		harnesses.push(harness);
		const agentDir = join(harness.tempDir, "agent-home");
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		writeFileSync(join(agentDir, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews diffs\n---\n");
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		const factories: AutocompleteProviderFactory[] = [];

		await harness.session.bindExtensions({ uiContext: createUiContext(factories), mode: "tui" });

		expect(factories).toHaveLength(1);
		let provider: AutocompleteProvider = new CombinedAutocompleteProvider([], tmpdir(), null);
		for (const wrap of factories) provider = wrap(provider);
		const suggestions = await provider.getSuggestions(["@"], 0, 1, { signal: new AbortController().signal });
		expect(suggestions?.items.map((item) => item.value)).toEqual([
			"@agent:generalPurpose",
			"@agent:explorer",
			"@agent:reviewer",
		]);
		expect(suggestions?.items[2]?.description).toBe("Reviews diffs");
	});

	it("tells the model that @agent:<type> asks for that subagent type", () => {
		expect(SUBAGENT_DESCRIPTION).toContain(
			"@agent:<type> in the user's message means the user wants that type invoked",
		);
	});
});
