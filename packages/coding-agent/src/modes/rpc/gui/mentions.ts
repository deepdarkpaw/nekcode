/**
 * `get_mention_targets`: what `@agent:<type>` and `@skill:<name>` can complete to.
 *
 * A session answers from its live resources, so extension-provided skills and the session's trust decision apply. The
 * control process has no session, so it discovers the same kinds of targets for its working directory from the files
 * that carry them.
 */

import type { Skill } from "../../../core/skills.ts";
import { discoverAgentTypes } from "../../../extensions/nek/services/agent-types.ts";
import { resolveGuiWorkspace } from "./config.ts";
import type { GuiContext } from "./context.ts";
import type { RpcMentionTarget } from "./protocol.ts";
import { loadWorkspaceSkills } from "./resources.ts";

/** One `@skill:<name>` target; `location` is the skill's `SKILL.md`. */
function skillTarget(skill: Skill): RpcMentionTarget {
	return { kind: "skill", name: skill.name, description: skill.description, location: skill.filePath };
}

/**
 * Mention targets in the order the model sees them: the subagent types of the `subagents` section, then the skills of
 * the session (or of the named working directory).
 *
 * `cwd` names the directory to describe. Without it, a session answers for its own directory from its live resources.
 * A session asked about a different directory answers from that directory's files instead, because its loaded skills
 * and agents belong to its own project.
 */
export async function getMentionTargets(ctx: GuiContext, cwd?: string): Promise<RpcMentionTarget[]> {
	const workspace = resolveGuiWorkspace(ctx, cwd);
	const projectTrusted = workspace.settingsManager.isProjectTrusted();
	const agents: RpcMentionTarget[] = discoverAgentTypes(ctx.agentDir, workspace.cwd, projectTrusted).types.map(
		(type) => ({
			kind: "agent",
			name: type.name,
			description: type.description,
		}),
	);
	const skills = workspace.session?.resourceLoader.getSkills().skills ?? (await loadWorkspaceSkills(workspace));
	return [...agents, ...skills.map(skillTarget)];
}
