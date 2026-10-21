import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../src/config.ts";
import {
	BUILTIN_AGENT_TYPES,
	DEFAULT_CUSTOM_TOOL_NAMES,
	describeAgentTypes,
	discoverAgentTypes,
	findAgentType,
	READ_ONLY_TOOL_NAMES,
} from "../src/extensions/nek/services/agent-types.ts";

describe("discoverAgentTypes", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "nek-agent-types-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		mkdirSync(join(cwd, CONFIG_DIR_NAME, "agents"), { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function writeAgent(dir: string, file: string, content: string): void {
		writeFileSync(join(dir, file), content);
	}

	it("ships a writable generalPurpose and a read-only explorer without provider or model presets", () => {
		const { types, errors } = discoverAgentTypes(agentDir, cwd, true);
		expect(errors).toEqual([]);
		expect(types.map((type) => type.name)).toEqual(["generalPurpose", "explorer"]);
		const general = findAgentType(types, "generalPurpose");
		expect(general).toMatchObject({ source: "builtin", readonly: false, autonomous: false });
		expect(general?.tools).toEqual([...DEFAULT_CUSTOM_TOOL_NAMES]);
		const explorer = findAgentType(types, "explorer");
		expect(explorer).toMatchObject({ source: "builtin", readonly: true, autonomous: true });
		expect(explorer?.tools).toEqual([...READ_ONLY_TOOL_NAMES]);
		for (const type of [general, explorer]) {
			expect(type?.model).toBeUndefined();
			expect(type?.thinking).toBeUndefined();
			expect(type?.contextWindow).toBeUndefined();
		}
	});

	it("gives writable custom types the default tools without a provider or model preset", () => {
		writeAgent(join(agentDir, "agents"), "worker.md", "---\nname: worker\ndescription: Writes code\n---\n");
		const worker = findAgentType(discoverAgentTypes(agentDir, cwd, false).types, "worker");
		expect(worker?.readonly).toBe(false);
		expect(worker?.tools).toEqual([...DEFAULT_CUSTOM_TOOL_NAMES]);
		expect(worker?.model).toBeUndefined();
		expect(worker?.thinking).toBeUndefined();
	});

	it("reads user types and lets project types override user and built-in types", () => {
		writeAgent(
			join(agentDir, "agents"),
			"reviewer.md",
			"---\nname: reviewer\ndescription: Reviews diffs\nmodel: faux/faux-1\ntools: read, grep\nis_background: true\n---\nReview carefully.\n",
		);
		writeAgent(join(agentDir, "agents"), "explorer.md", "---\nname: explorer\ndescription: user explore\n---\n");
		writeAgent(
			join(cwd, CONFIG_DIR_NAME, "agents"),
			"explorer.md",
			"---\nname: explorer\ndescription: project explore\nreadonly: true\n---\nProject notes\n",
		);

		const { types, errors } = discoverAgentTypes(agentDir, cwd, true);

		expect(errors).toEqual([]);
		const reviewer = findAgentType(types, "reviewer");
		expect(reviewer).toMatchObject({
			source: "user",
			model: "faux/faux-1",
			tools: ["read", "grep"],
			background: true,
			readonly: false,
			instructions: "Review carefully.",
		});
		const explorer = findAgentType(types, "explorer");
		expect(explorer).toMatchObject({
			source: "project",
			description: "project explore",
			instructions: "Project notes",
		});
		expect(explorer?.tools).toEqual([...READ_ONLY_TOOL_NAMES]);
		expect(types.filter((type) => type.name === "explorer")).toHaveLength(1);
	});

	it("readonly types get the read-only tool set even when tools are listed", () => {
		writeAgent(
			join(agentDir, "agents"),
			"auditor.md",
			"---\nname: auditor\ndescription: Audits\nreadonly: true\ntools: [bash, edit]\n---\n",
		);
		const auditor = findAgentType(discoverAgentTypes(agentDir, cwd, false).types, "auditor");
		expect(auditor?.tools).toEqual([...READ_ONLY_TOOL_NAMES]);
	});

	it("reads thinking, context, and denied tools from a preset", () => {
		writeAgent(
			join(agentDir, "agents"),
			"explorer.md",
			"---\nname: explorer\ndescription: Researches code and web\nthinking: low\ncontext_window: 500000\ntools: read, web_search, bash\ndisallowed_tools: bash\n---\n",
		);
		const result = discoverAgentTypes(agentDir, cwd, false);
		const explorer = findAgentType(result.types, "explorer");
		expect(result.errors).toEqual([]);
		expect(explorer).toMatchObject({ thinking: "low", contextWindow: 500000, disallowedTools: ["bash"] });
		expect(explorer?.tools).toEqual(["read", "web_search"]);
	});

	it("only explorer and presets that opt in with autonomous: true are autonomous", () => {
		writeAgent(
			join(agentDir, "agents"),
			"researcher.md",
			"---\nname: researcher\ndescription: Researches code\nreadonly: true\nautonomous: true\n---\n",
		);
		writeAgent(join(agentDir, "agents"), "worker.md", "---\nname: worker\ndescription: Writes code\n---\n");
		const types = discoverAgentTypes(agentDir, cwd, false).types;
		const autonomous = types.filter((type) => type.autonomous).map((type) => type.name);
		expect(autonomous).toEqual(["explorer", "researcher"]);
		const text = describeAgentTypes(types);
		expect(text).toContain("- explorer [autonomous]: ");
		expect(text).toContain("- researcher [autonomous]: ");
		expect(text).toContain("- worker: ");
	});

	it("reports invalid thinking and context values", () => {
		writeAgent(
			join(agentDir, "agents"),
			"broken-values.md",
			"---\nname: broken\ndescription: Invalid\nthinking: intense\ncontext_window: -1\n---\n",
		);
		const result = discoverAgentTypes(agentDir, cwd, false);
		expect(result.types.some((type) => type.name === "broken")).toBe(false);
		expect(result.errors.join("\\n")).toContain("thinking");
	});

	it("collects bad files as errors and keeps the good ones", () => {
		writeAgent(join(agentDir, "agents"), "broken.md", "---\nname: [unclosed\n---\n");
		writeAgent(join(agentDir, "agents"), "nameless.md", "---\ndescription: no name\n---\n");
		writeAgent(join(agentDir, "agents"), "good.md", "---\nname: good\ndescription: fine\n---\n");
		writeAgent(join(agentDir, "agents"), "notes.txt", "ignored");

		const { types, errors } = discoverAgentTypes(agentDir, cwd, true);

		expect(findAgentType(types, "good")).toBeDefined();
		expect(errors).toHaveLength(2);
		expect(errors.some((error) => error.includes("broken.md"))).toBe(true);
		expect(errors.some((error) => error.includes("nameless.md") && error.includes('"name"'))).toBe(true);
	});

	it("does not read project agents when the project is not trusted", () => {
		writeAgent(
			join(cwd, CONFIG_DIR_NAME, "agents"),
			"local.md",
			"---\nname: local\ndescription: project only\n---\n",
		);
		expect(findAgentType(discoverAgentTypes(agentDir, cwd, false).types, "local")).toBeUndefined();
		expect(findAgentType(discoverAgentTypes(agentDir, cwd, true).types, "local")).toBeDefined();
	});

	it("describes the available types for the subagent description", () => {
		const text = describeAgentTypes(BUILTIN_AGENT_TYPES);
		expect(text.startsWith("Available subagent_type values\n\n- generalPurpose: ")).toBe(true);
		expect(text).toContain("\n- explorer [autonomous]: ");
		expect(text.split("\n- ")).toHaveLength(3);
		expect(text).toContain("model: inherit; thinking: inherit");
		expect(text).not.toContain("(preset)");
	});
});
