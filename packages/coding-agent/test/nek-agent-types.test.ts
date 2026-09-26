import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	BUILTIN_AGENT_TYPES,
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
		mkdirSync(join(cwd, ".pi", "agents"), { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function writeAgent(dir: string, file: string, content: string): void {
		writeFileSync(join(dir, file), content);
	}

	it("returns the three Cursor built-in types without agent files", () => {
		const { types, errors } = discoverAgentTypes(agentDir, cwd, true);
		expect(errors).toEqual([]);
		expect(types.map((type) => type.name)).toEqual(["generalPurpose", "explore", "shell"]);
		const explore = findAgentType(types, "explore");
		expect(explore?.readonly).toBe(true);
		expect(explore?.tools).toEqual([...READ_ONLY_TOOL_NAMES]);
		expect(findAgentType(types, "generalPurpose")?.tools).toContain("edit");
		expect(findAgentType(types, "shell")?.tools).toEqual(["bash", "read"]);
	});

	it("reads user types and lets project types override user and built-in types", () => {
		writeAgent(
			join(agentDir, "agents"),
			"reviewer.md",
			"---\nname: reviewer\ndescription: Reviews diffs\nmodel: faux/faux-1\ntools: read, grep\nis_background: true\n---\nReview carefully.\n",
		);
		writeAgent(join(agentDir, "agents"), "explore.md", "---\nname: explore\ndescription: user explore\n---\n");
		writeAgent(
			join(cwd, ".pi", "agents"),
			"explore.md",
			"---\nname: explore\ndescription: project explore\nreadonly: true\n---\nProject notes\n",
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
		const explore = findAgentType(types, "explore");
		expect(explore).toMatchObject({
			source: "project",
			description: "project explore",
			instructions: "Project notes",
		});
		expect(explore?.tools).toEqual([...READ_ONLY_TOOL_NAMES]);
		expect(types.filter((type) => type.name === "explore")).toHaveLength(1);
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
		writeAgent(join(cwd, ".pi", "agents"), "local.md", "---\nname: local\ndescription: project only\n---\n");
		expect(findAgentType(discoverAgentTypes(agentDir, cwd, false).types, "local")).toBeUndefined();
		expect(findAgentType(discoverAgentTypes(agentDir, cwd, true).types, "local")).toBeDefined();
	});

	it("describes the available types for the task description", () => {
		const text = describeAgentTypes(BUILTIN_AGENT_TYPES);
		expect(text.startsWith("Available subagent_type values\n\n- generalPurpose: ")).toBe(true);
		expect(text).toContain("- explore: ");
		expect(text).toContain("- shell: ");
	});
});
