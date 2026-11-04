import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	allToolNames,
	createAllToolDefinitions,
	createAllTools,
	createCodingToolDefinitions,
	createCodingTools,
	createReadOnlyToolDefinitions,
	createReadOnlyTools,
	createTool,
	createToolDefinition,
} from "../src/core/tools/index.ts";

describe("definition-first tool factories", () => {
	it("preserves declarations, tool order and shell prompt metadata", () => {
		const cwd = process.cwd();
		const definitions = createAllToolDefinitions(cwd);
		const tools = createAllTools(cwd);
		expect(Object.keys(definitions)).toEqual([...allToolNames]);
		expect(Object.keys(tools)).toEqual([...allToolNames]);
		for (const name of allToolNames) {
			for (const field of [
				"name",
				"label",
				"description",
				"parameters",
				"outputSchema",
				"constrainedSampling",
				"executionMode",
				"replay",
			] as const) {
				expect(createTool(name, cwd)[field]).toEqual(definitions[name][field]);
				expect(tools[name][field]).toEqual(createToolDefinition(name, cwd)[field]);
			}
			if (name !== "bash" && name !== "powershell") continue;
			expect(tools[name]).toMatchObject({
				promptSnippet: definitions[name].promptSnippet,
				promptGuidelines: definitions[name].promptGuidelines,
			});
			expect(createTool(name, cwd, { [name]: { exposeSessionEnvironment: false } })).toHaveProperty(
				"promptGuidelines",
				undefined,
			);
		}
		const coding = ["read", "bash", "edit", "write", "web_search"];
		const readonly = ["read", "grep", "find", "ls", "ast_grep", "web_search"];
		expect(createCodingTools(cwd).map((tool) => tool.name)).toEqual(coding);
		expect(createCodingToolDefinitions(cwd).map((tool) => tool.name)).toEqual(coding);
		expect(createReadOnlyTools(cwd).map((tool) => tool.name)).toEqual(readonly);
		expect(createReadOnlyToolDefinitions(cwd).map((tool) => tool.name)).toEqual(readonly);
	});
	it("shares read-before-write state inside a set and isolates independently created sets", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "factory-parity-"));
		try {
			const path = join(cwd, "file.txt");
			writeFileSync(path, "before");
			const readFile = vi.fn(async () => Buffer.from("before"));
			const tools = createAllTools(cwd, { read: { operations: { access: async () => {}, readFile } } });
			await expect(tools.write.execute("w", { path, content: "after" })).rejects.toThrow("not been read");
			await tools.read.execute("r", { path });
			await tools.write.execute("w", { path, content: "after" });
			expect(readFile).toHaveBeenCalledOnce();
			expect(readFileSync(path, "utf8")).toBe("after");
			await expect(createAllTools(cwd).write.execute("w", { path, content: "unread" })).rejects.toThrow(
				"not been read",
			);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
