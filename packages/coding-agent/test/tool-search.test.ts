import type { AgentTool } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	Bm25Ranker,
	createToolSearchDescription,
	createToolSearchDocument,
	tokenize,
} from "../src/extensions/tool-search/tool.ts";

function tool(name: string, description: string, properties: Record<string, unknown> = {}): AgentTool {
	return {
		name,
		label: name,
		description,
		parameters: Type.Unsafe({ type: "object", properties }),
		execute: async () => ({ content: [], details: undefined }),
	};
}

describe("tokenize", () => {
	it("splits camelCase and snake_case, drops stop words, and folds plurals", () => {
		expect(tokenize("listIssues for the GitHub_repo")).toEqual(["list", "issue", "git", "hub", "repo"]);
		expect(tokenize("searches queries HTTPServer")).toEqual(["search", "query", "http", "server"]);
	});
});

describe("Bm25Ranker", () => {
	const tools = [
		tool("mcp__github__list_issues", "List issues in a repository.", {
			state: { type: "string", description: "open or closed" },
		}),
		tool("mcp__github__create_pull_request", "Open a pull request."),
		tool("mcp__linear__search_issues", "Search Linear issues by text."),
		tool("mcp__docs__search", "Search the documentation."),
	];
	const documents = tools.map((entry) => createToolSearchDocument(entry));

	it("ranks by term relevance and respects the limit", () => {
		const ranker = new Bm25Ranker();
		expect(ranker.rank("issue", documents, 8).map((match) => match.name)).toEqual([
			"mcp__linear__search_issues",
			"mcp__github__list_issues",
		]);
		expect(ranker.rank("pull requests", documents, 8)[0].name).toBe("mcp__github__create_pull_request");
		expect(ranker.rank("search", documents, 1)).toHaveLength(1);
		expect(ranker.rank("closed", documents, 8).map((match) => match.name)).toEqual(["mcp__github__list_issues"]);
	});

	it("returns nothing for unknown or empty queries", () => {
		const ranker = new Bm25Ranker();
		expect(ranker.rank("kubernetes", documents, 8)).toEqual([]);
		expect(ranker.rank("the", documents, 8)).toEqual([]);
		expect(ranker.rank("tickets", documents, 8)).toEqual([]);
	});

	it("includes namespace metadata in the search text", () => {
		const document = createToolSearchDocument(tool("mcp__x__run", "Run it."), {
			name: "mcp__x",
			description: "Kubernetes cluster tools",
		});
		expect(new Bm25Ranker().rank("kubernetes", [document], 8)).toEqual([
			{ name: "mcp__x__run", score: expect.any(Number) },
		]);
	});
});

describe("referenced tool schemas", () => {
	it("indexes referenced descriptions but not unused definitions", () => {
		const document = createToolSearchDocument({
			...tool("mcp__records__inspect", "Inspect records"),
			parameters: Type.Unsafe({
				type: "object",
				properties: { options: { $ref: "#/$defs/options" } },
				$defs: {
					options: { properties: { mode: { description: "reconciliation" } } },
					unused: { description: "unreachableunicorn" },
				},
			}),
		});
		expect(new Bm25Ranker().rank("reconciliation", [document], 8)).toHaveLength(1);
		expect(document.text).toContain("mode");
		expect(document.text).not.toContain("unreachableunicorn");
	});

	it("visits shared recursive definitions once and decodes escaped pointer names", () => {
		const document = createToolSearchDocument({
			...tool("mcp__tree__inspect", "Inspect"),
			parameters: Type.Unsafe({
				properties: {
					first: { $ref: "#/$defs/a~1b~0c%20node" },
					second: { $ref: "#/$defs/a~1b~0c%20node" },
				},
				$defs: {
					"a/b~c node": {
						description: "treebranch",
						properties: { child: { $ref: "#/$defs/a~1b~0c%20node" } },
					},
				},
			}),
		});
		expect(document.text.match(/treebranch/g)).toHaveLength(1);
		expect(document.text).toContain("child");
	});

	it.each(["#/$defs/%E0", "#/$defs/missing", "https://example.com/schema", "#/toString"])(
		"ignores unresolved or malformed references without failing discovery: %s",
		(ref) => {
			const document = createToolSearchDocument({
				...tool("mcp__refs__inspect", "Inspect"),
				parameters: Type.Unsafe({ properties: { options: { $ref: ref, description: "visiblehint" } } }),
			});
			expect(document.text).toContain("visiblehint");
		},
	);
});

describe("tool_search description", () => {
	it("lists the sources", () => {
		expect(
			createToolSearchDescription([{ name: "mcp__docs", description: "Docs server\nmore" }, { name: "mcp__x" }]),
		).toContain("- mcp__docs: Docs server");
		expect(createToolSearchDescription()).toContain("None currently enabled.");
	});
});
