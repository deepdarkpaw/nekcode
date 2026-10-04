import type { Component, TUI } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, test } from "vitest";
import type { ToolRenderContext } from "../src/core/extensions/types.ts";
import { createAllToolRenderers } from "../src/core/tools/renderers/index.ts";
import { getToolDisplayName, toTitleCase } from "../src/core/tools/renderers/tool-names.ts";
import { formatResultDomain, webSearchRenderers } from "../src/core/tools/renderers/web-search.ts";
import type { WebSearchToolDetails } from "../src/core/tools/web-search.ts";
import { createMcpToolDefinition } from "../src/extensions/mcp/tools.ts";
import { createToolSearchToolDefinition } from "../src/extensions/tool-search/tool.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function context(args: unknown, overrides: Partial<ToolRenderContext> = {}): ToolRenderContext {
	return {
		args,
		toolCallId: "call-1",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		...overrides,
	};
}

function text(component: Component, width = 120): string {
	return component
		.render(width)
		.map((line) => stripAnsi(line).trimEnd())
		.join("\n");
}

describe("tool row display names", () => {
	test("uses the shared table, the MCP form, then labels, then Title Case", () => {
		expect(getToolDisplayName("todo_write")).toBe("Todos");
		expect(getToolDisplayName("update_plan")).toBe("Plan update");
		expect(getToolDisplayName("await")).toBe("Waiting");
		expect(getToolDisplayName("ast_grep")).toBe("AST Search");
		expect(getToolDisplayName("grep")).toBe("Search");
		expect(getToolDisplayName("ls")).toBe("List");
		expect(getToolDisplayName("powershell")).toBe("PowerShell");
		expect(getToolDisplayName("mcp__linear__list_issues")).toBe("linear › list_issues");
		expect(getToolDisplayName("custom_tool", "Fancy Tool")).toBe("Fancy Tool");
		expect(getToolDisplayName("custom_tool", "custom_tool")).toBe("Custom Tool");
		expect(getToolDisplayName("custom_tool", "other_name")).toBe("Other Name");
		expect(toTitleCase("fetchPageTitle")).toBe("Fetch Page Title");
	});
});

describe("tool row headers", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	test("core renderers put the display name before the argument and muted metadata", () => {
		const renderers = createAllToolRenderers();
		const grep = renderers.grep.renderCall!(
			{ pattern: "TODO", path: "src", glob: "*.ts", limit: 5 },
			theme,
			context({}),
		);
		expect(text(grep)).toBe("Search /TODO/ in src · *.ts · limit 5");
		const find = renderers.find.renderCall!({ pattern: "*.md" }, theme, context({}));
		expect(text(find)).toBe("Find *.md in .");
		const ls = renderers.ls.renderCall!({ path: "docs", limit: 10 }, theme, context({}));
		expect(text(ls)).toBe("List docs limit 10");
		const ast = renderers.ast_grep.renderCall!({ pattern: "foo($A)", lang: "ts" }, theme, context({}));
		expect(text(ast)).toBe("AST Search foo($A) in . · ts");
		const bash = renderers.bash.renderCall!({ command: "npm run check", timeout: 60 }, theme, context({}));
		expect(text(bash)).toBe("Bash npm run check timeout 60s");
		const powershell = renderers.powershell.renderCall!({ command: "Get-ChildItem" }, theme, context({}));
		expect(text(powershell)).toBe("PowerShell Get-ChildItem");
	});

	test("MCP rows read server › tool", () => {
		const definition = createMcpToolDefinition({
			server: "github",
			tool: { name: "create_issue", inputSchema: { type: "object" } },
			name: "mcp__github__create_issue",
			exposure: "direct",
			namespace: { name: "github" },
			timeoutMs: 1000,
			getClient: async () => {
				throw new Error("not used");
			},
		});
		expect(definition.label).toBe("github › create_issue");
		const call = definition.renderCall!({ title: "Bug" }, theme, context({ title: "Bug" }));
		expect(text(call)).toBe('github › create_issue title="Bug"');
	});

	test("Tool Search rows show the query and the loaded tools by display name", () => {
		const definition = createToolSearchToolDefinition();
		expect(definition.label).toBe("Tool Search");
		const call = definition.renderCall!({ query: "issues", limit: 3 }, theme, context({}));
		expect(text(call)).toBe("Tool Search issues limit 3");
		const result = definition.renderResult!(
			{ content: [{ type: "text", text: "Loaded 1 tool." }], details: { loaded: ["mcp__linear__list_issues"] } },
			{ expanded: false, isPartial: false },
			theme,
			context({}),
		);
		expect(text(result).trim()).toBe("Loaded 1 tool linear › list_issues");
	});
});

describe("Web Search rows", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	const details: WebSearchToolDetails = {
		query: "opentui",
		results: Array.from({ length: 7 }, (_, index) => ({
			title: `Result ${index + 1}`,
			url: `https://www.example${index + 1}.com/path?q=${index}`,
		})),
	};

	test("the call row reads Web Search and the query, in blue", () => {
		const call = webSearchRenderers.renderCall!({ query: "opentui scrollbox" }, theme, context({}));
		const rendered = call.render(120).join("\n");
		expect(stripAnsi(rendered).trimEnd()).toBe("Web Search opentui scrollbox");
		expect(rendered).toContain(theme.getFgAnsi("mdLink"));
	});

	test("collapsed results show a muted count, the top five titles, and hostnames only", () => {
		const result = webSearchRenderers.renderResult!(
			{ content: [{ type: "text", text: "model text" }], details },
			{ expanded: false, isPartial: false },
			theme,
			context({ query: "opentui" }),
		);
		const lines = text(result).split("\n");
		expect(lines[1]).toBe("7 results");
		expect(lines[2]).toBe("1. Result 1 example1.com");
		expect(lines).toContain("5. Result 5 example5.com");
		expect(lines.join("\n")).not.toContain("Result 6");
		expect(lines.join("\n")).not.toContain("https://");
		expect(lines.join("\n")).toContain("2 more");
	});

	test("expanded results show every result", () => {
		const result = webSearchRenderers.renderResult!(
			{ content: [{ type: "text", text: "model text" }], details },
			{ expanded: true, isPartial: false },
			theme,
			context({ query: "opentui" }, { expanded: true }),
		);
		expect(text(result)).toContain("7. Result 7 example7.com");
		expect(text(result)).not.toContain("more");
	});

	test("errors keep the full message, wrapped", () => {
		const message = `Exa web search failed: ${"quota exceeded ".repeat(10)}`;
		const result = webSearchRenderers.renderResult!(
			{ content: [{ type: "text", text: message }], details: undefined as unknown as WebSearchToolDetails },
			{ expanded: false, isPartial: false },
			theme,
			context({ query: "x" }, { isError: true }),
		);
		expect(text(result, 40).replace(/\s+/g, " ").trim()).toBe(message.trim());
	});

	test("hostnames drop www and fall back to the raw value", () => {
		expect(formatResultDomain("https://www.bun.sh/docs")).toBe("bun.sh");
		expect(formatResultDomain("not a url")).toBe("not a url");
	});

	test("the web search row renders through ToolExecutionComponent", () => {
		const component = new ToolExecutionComponent(
			"web_search",
			"tool-web",
			{ query: "nekcode" },
			{},
			createAllToolRenderers().web_search,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "model text" }], details, isError: false });
		const rendered = text(component);
		expect(rendered).toContain("Web Search nekcode");
		expect(rendered).toContain("1. Result 1 example1.com");
		expect(rendered).not.toContain("web_search");
	});
});
