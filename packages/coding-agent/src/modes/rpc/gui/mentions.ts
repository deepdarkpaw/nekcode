/**
 * `get_mention_targets`: what `@agent:<type>` and `@skill:<name>` can complete to.
 *
 * A session answers from its live resources, so extension-provided skills and the session's trust decision apply. The
 * control process has no session, so it discovers the same kinds of targets for its working directory from the files
 * that carry them.
 */

import { isAbsolute, join, relative, resolve } from "node:path";
import { CONFIG_DIR_NAME } from "../../../config.ts";
import { loadSkills, type Skill } from "../../../core/skills.ts";
import { discoverAgentTypes } from "../../../extensions/nek/services/agent-types.ts";
import { resolvePath } from "../../../utils/paths.ts";
import { isProjectTrusted } from "./config.ts";
import type { GuiContext } from "./context.ts";
import type { RpcMentionTarget } from "./protocol.ts";

/** Whether `target` is `root` or below it. */
function isUnder(root: string, target: string): boolean {
	const path = relative(resolve(root), resolve(target));
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** One `@skill:<name>` target; `location` is the skill's `SKILL.md`. */
function skillTarget(skill: Skill): RpcMentionTarget {
	return { kind: "skill", name: skill.name, description: skill.description, location: skill.filePath };
}

/** Skills a project directory offers without a session: the user directory, plus the project directory when trusted. */
function loadSkillsForCwd(ctx: GuiContext, cwd: string, projectTrusted: boolean): Skill[] {
	const { skills } = loadSkills({ cwd, agentDir: ctx.agentDir, skillPaths: [], includeDefaults: true });
	if (projectTrusted) return skills;
	const projectSkillsDir = join(resolve(cwd), CONFIG_DIR_NAME, "skills");
	return skills.filter((skill) => !isUnder(projectSkillsDir, skill.filePath));
}

/**
 * Mention targets in the order the model sees them: the subagent types of the `subagents` section, then the skills of
 * the session (or of the named working directory).
 *
 * `cwd` names the directory to describe. Without it, a session answers for its own directory from its live resources.
 * A session asked about a different directory answers from that directory's files instead, because its loaded skills
 * and agents belong to its own project.
 */
export function getMentionTargets(ctx: GuiContext, cwd?: string): RpcMentionTarget[] {
	const session = ctx.session;
	const requested = cwd === undefined ? undefined : resolvePath(cwd);
	const sessionCwd = session === undefined ? undefined : resolvePath(session.sessionManager.getCwd());
	const fromSession = session !== undefined && (requested === undefined || sessionCwd === requested);
	const directory = requested ?? sessionCwd ?? ctx.cwd;
	const projectTrusted = fromSession ? session.settingsManager.isProjectTrusted() : isProjectTrusted(ctx, directory);
	const agents: RpcMentionTarget[] = discoverAgentTypes(ctx.agentDir, directory, projectTrusted).types.map((type) => ({
		kind: "agent",
		name: type.name,
		description: type.description,
	}));
	const skills = fromSession
		? session.resourceLoader.getSkills().skills
		: loadSkillsForCwd(ctx, directory, projectTrusted);
	return [...agents, ...skills.map(skillTarget)];
}
