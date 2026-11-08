import { afterEach, describe, expect, it, vi } from "vitest";
import * as configValues from "../src/core/resolve-config-value.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import * as webSearch from "../src/core/tools/web-search.ts";
import { testWebSearch } from "../src/modes/rpc/gui/probes.ts";

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("web search settings", () => {
	it("leaves unconfigured settings undefined so the tool selects its Tavily default", () => {
		expect(SettingsManager.inMemory().getWebSearchSettings()).toBeUndefined();
	});

	it.each([{ apiKey: "legacy-exa-secret" }, { endpoint: "https://mcp.exa.ai/mcp" }])(
		"requires a provider for legacy explicit endpoints or credentials before resolving them",
		(webSearch) => {
			const resolve = vi.spyOn(configValues, "resolveConfigValueOrThrow");
			const settings = SettingsManager.inMemory({ webSearch });
			expect(() => settings.getWebSearchSettings()).toThrow(/select provider tavily or exa explicitly/);
			expect(resolve).not.toHaveBeenCalled();
		},
	);

	it.each(["tavily", "exa"] as const)(
		"preserves explicit %s configuration without resolving credentials",
		(provider) => {
			const resolve = vi.spyOn(configValues, "resolveConfigValueOrThrow");
			const settings = {
				provider,
				endpoint: "https://search.example.test/search",
				apiKey: "!credential-command",
				numResults: 12,
			};
			const manager = SettingsManager.inMemory({ webSearch: settings });
			const returned = manager.getWebSearchSettings();
			expect(returned).toEqual(settings);
			expect(returned).not.toBe(settings);
			if (returned) returned.provider = provider === "exa" ? "tavily" : "exa";
			expect(manager.getWebSearchSettings()?.provider).toBe(provider);
			expect(resolve).not.toHaveBeenCalled();
		},
	);

	it.each([
		null,
		[],
		"bad",
		{ provider: "unknown-secret" },
		{ endpoint: 42 },
		{ endpoint: "" },
		{ apiKey: 42 },
		{ apiKey: "" },
		{ numResults: 1.5 },
		{ numResults: 0 },
		{ numResults: 21 },
	])("validates malformed settings without printing credential values: %j", (webSearch) => {
		const settings = SettingsManager.inMemory({ webSearch } as unknown as Settings);
		expect(() => settings.getWebSearchSettings()).toThrow(/Invalid webSearch/);
		try {
			settings.getWebSearchSettings();
		} catch (error) {
			expect(String(error)).not.toContain("unknown-secret");
		}
	});
});

describe("GUI web search probe", () => {
	it("forwards provider, endpoint, credentials, and count through the shared tool", async () => {
		const execute = vi.fn(async () => ({ content: [], details: { query: "docs", results: [] } }));
		const createTool = vi.spyOn(webSearch, "createWebSearchToolDefinition").mockReturnValue({ execute } as never);
		const settingsManager = SettingsManager.inMemory({
			webSearch: {
				provider: "exa",
				endpoint: "https://search.example.test/mcp",
				apiKey: "$TEST_EXA_KEY",
				numResults: 4,
			},
		});
		expect(await testWebSearch({ settingsManager } as never, "docs")).toMatchObject({ ok: true, resultCount: 0 });
		expect(createTool).toHaveBeenCalledWith({
			provider: "exa",
			endpoint: "https://search.example.test/mcp",
			apiKey: "$TEST_EXA_KEY",
			defaultResults: 4,
			timeoutMs: 25_000,
		});
		expect(execute).toHaveBeenCalledWith("gui-test-web-search", { query: "docs" }, undefined, undefined, undefined);
	});

	it("returns a data error for missing Tavily credentials without network access", async () => {
		vi.stubEnv("TAVILY_API_KEY", "");
		const fetch = vi.spyOn(globalThis, "fetch");
		const settingsManager = SettingsManager.inMemory();
		expect(await testWebSearch({ settingsManager } as never, "docs")).toMatchObject({
			ok: false,
			message: expect.stringContaining("Tavily web search requires an API key"),
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it("reports invalid provider settings as data instead of throwing an RPC error", async () => {
		const settingsManager = SettingsManager.inMemory({ webSearch: { provider: "invalid" } } as unknown as Settings);
		expect(await testWebSearch({ settingsManager } as never, "docs")).toEqual({
			ok: false,
			message: "Invalid webSearch.provider setting: expected tavily or exa.",
		});
	});
});
