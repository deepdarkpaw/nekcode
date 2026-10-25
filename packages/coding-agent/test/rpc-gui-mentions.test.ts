/**
 * `get_mention_targets`: `@agent:<type>` and `@skill:<name>` completion targets of a session and of a directory.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { isControlCommand } from "../src/modes/rpc/control-mode.ts";
import { createGuiContext, type GuiContext } from "../src/modes/rpc/gui/context.ts";
import { createGuiDeps, handleGuiCommand } from "../src/modes/rpc/gui/handlers.ts";
import { getMentionTargets } from "../src/modes/rpc/gui/mentions.ts";

function stubModelRuntime(): ModelRuntime {
	return {} as unknown as ModelRuntime;
}

const deps = createGuiDeps(
	() => {
		throw new Error("reload is not part of these tests");
	},
	() => false,
);

describe("get_mention_targets", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "nek-mentions-rpc-"));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	/** An agent preset file: frontmatter with name and description. */
	function writeAgent(path: string, name: string, description: string): void {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`);
	}

	/** A skill directory with a SKILL.md. */
	function writeSkill(dir: string, name: string, description: string): string {
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "SKILL.md");
		writeFileSync(path, `---\nname: ${name}\ndescription: ${description}\n---\n\nBody.\n`);
		return path;
	}

	function controlContext(): GuiContext {
		return createGuiContext({
			mode: "control",
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory({ sessionDir: join(root, "sessions") }),
			modelRuntime: stubModelRuntime(),
			emit: () => {},
		});
	}

	function trust(trusted: boolean): void {
		new ProjectTrustStore(agentDir).set(cwd, trusted);
	}

	it("lists subagent types in the subagents-section order, then skills", () => {
		writeAgent(join(agentDir, "agents", "user-agent.md"), "user-agent", "A user preset");
		writeAgent(join(cwd, ".nek", "agents", "project-agent.md"), "project-agent", "A project preset");
		const userSkill = writeSkill(join(agentDir, "skills", "user-skill"), "user-skill", "A user skill");
		const projectSkill = writeSkill(join(cwd, ".nek", "skills", "project-skill"), "project-skill", "A project skill");
		trust(true);

		const targets = getMentionTargets(controlContext());

		expect(targets.filter((target) => target.kind === "agent").map((target) => target.name)).toEqual([
			"generalPurpose",
			"explorer",
			"user-agent",
			"project-agent",
		]);
		expect(targets.slice(0, 2)).toEqual([
			{ kind: "agent", name: "generalPurpose", description: expect.any(String) },
			{ kind: "agent", name: "explorer", description: expect.any(String) },
		]);
		expect(targets.filter((target) => target.kind === "skill")).toEqual([
			{ kind: "skill", name: "user-skill", description: "A user skill", location: userSkill },
			{ kind: "skill", name: "project-skill", description: "A project skill", location: projectSkill },
		]);
	});

	it("leaves out project resources of an untrusted project", () => {
		writeAgent(join(agentDir, "agents", "user-agent.md"), "user-agent", "A user preset");
		writeAgent(join(cwd, ".nek", "agents", "project-agent.md"), "project-agent", "A project preset");
		writeSkill(join(agentDir, "skills", "user-skill"), "user-skill", "A user skill");
		writeSkill(join(cwd, ".nek", "skills", "project-skill"), "project-skill", "A project skill");
		trust(false);

		const targets = getMentionTargets(controlContext());

		expect(targets.map((target) => target.name)).toEqual(["generalPurpose", "explorer", "user-agent", "user-skill"]);
	});

	it("answers from the live session resources", () => {
		writeAgent(join(cwd, ".nek", "agents", "project-agent.md"), "project-agent", "A project preset");
		const session = {
			sessionManager: { getCwd: () => cwd },
			settingsManager: { isProjectTrusted: () => true },
			resourceLoader: {
				getSkills: () => ({
					skills: [
						{
							name: "session-skill",
							description: "From the loader",
							filePath: join(cwd, "extension-skills", "session-skill", "SKILL.md"),
							baseDir: join(cwd, "extension-skills", "session-skill"),
							sourceInfo: createSyntheticSourceInfo(join(cwd, "extension-skills", "session-skill", "SKILL.md"), {
								source: "local",
							}),
							disableModelInvocation: false,
						},
					],
					diagnostics: [],
				}),
			},
		} as unknown as AgentSession;
		const ctx = createGuiContext({
			mode: "session",
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			modelRuntime: stubModelRuntime(),
			session,
			emit: () => {},
		});

		const targets = getMentionTargets(ctx);

		expect(targets.filter((target) => target.kind === "skill")).toEqual([
			{
				kind: "skill",
				name: "session-skill",
				description: "From the loader",
				location: join(cwd, "extension-skills", "session-skill", "SKILL.md"),
			},
		]);
		expect(targets.filter((target) => target.kind === "agent").map((target) => target.name)).toEqual([
			"generalPurpose",
			"explorer",
			"project-agent",
		]);
	});

	it("answers for the requested cwd instead of the session directory", () => {
		const otherCwd = join(root, "other-project");
		writeAgent(join(otherCwd, ".nek", "agents", "other-agent.md"), "other-agent", "Another project preset");
		writeSkill(join(otherCwd, ".nek", "skills", "other-skill"), "other-skill", "Another project skill");
		const session = {
			sessionManager: { getCwd: () => cwd },
			settingsManager: { isProjectTrusted: () => true },
			resourceLoader: { getSkills: () => ({ skills: [], diagnostics: [] }) },
		} as unknown as AgentSession;
		const ctx = createGuiContext({
			mode: "session",
			cwd,
			agentDir,
			settingsManager: SettingsManager.inMemory(),
			modelRuntime: stubModelRuntime(),
			session,
			emit: () => {},
		});

		expect(getMentionTargets(ctx).map((target) => target.name)).toEqual(["generalPurpose", "explorer"]);
		expect(getMentionTargets(ctx, cwd).map((target) => target.name)).toEqual(["generalPurpose", "explorer"]);
		// The other directory has trust-requiring project resources and no decision, so only built-ins apply.
		expect(getMentionTargets(ctx, otherCwd).map((target) => target.name)).toEqual(["generalPurpose", "explorer"]);
		new ProjectTrustStore(agentDir).set(otherCwd, true);
		expect(getMentionTargets(ctx, otherCwd).map((target) => target.name)).toEqual([
			"generalPurpose",
			"explorer",
			"other-agent",
			"other-skill",
		]);
	});

	it("is a control command and answers through the dispatcher", async () => {
		expect(isControlCommand("get_mention_targets")).toBe(true);

		const response = (await handleGuiCommand({ id: "m1", type: "get_mention_targets" }, controlContext(), deps)) as {
			command: string;
			success: boolean;
			data: { targets: Array<{ kind: string; name: string }> };
		};

		expect(response.command).toBe("get_mention_targets");
		expect(response.success).toBe(true);
		expect(response.data.targets.map((target) => target.name)).toEqual(["generalPurpose", "explorer"]);
	});
});
