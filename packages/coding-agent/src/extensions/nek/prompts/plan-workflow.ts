import type { NekSessionState } from "../types.ts";

/** Reentry semantics adapted from Claude Code src/utils/messages.ts: plan_mode_reentry. */
export function planWorkflowReminder(state: NekSessionState): string {
	if (state.mode === "plan") {
		if (!state.plan)
			return "Current mode: Plan. Research and clarify the latest request, then create_plan for user review. Planning is not execution.";
		return `Current mode: Plan. The previous plan is ${state.plan.path} (revision ${state.plan.revision}).
First read the existing plan and evaluate the user's current request against it. For the same task, use edit to make incremental changes in the plan file, including its frontmatter overview and todos, then call update_plan to submit it for review. For a different task or when the user explicitly asks for a full rewrite, call create_plan with the complete new plan.
Treat re-planning as a fresh planning session. Do not assume the old plan or previous answers still apply. Ask ask_question when a new ambiguity or conflicting decision needs the user's input, then use the appropriate plan tool before requesting approval. Previous execution approval does not authorize this revision.`;
	}
	if (state.execution?.status === "interrupted") {
		return "Current mode: Agent. Previous plan execution has stopped and its authorization is revoked. The saved plan and old todos are reference only, not an active assignment. Address the latest user request first. Do not resume the previous plan without a new explicit user request.";
	}
	if (state.todoOwner === "planning") {
		return "Current mode: Agent. The user exited Plan without approving execution. The planning todos are reference only; address the latest user request, not the previous plan.";
	}
	return "Current mode: Agent. New user instructions take precedence over previous plans and todos.";
}

/** The approved snapshot is included even when planning happened before a compaction. */
export function approvedPlanMessage(path: string, revision: number, markdown: string): string {
	return `Implement the plan.\n\nApproved plan: ${path} (revision ${revision}). This approval covers this revision only. Follow newer user instructions if they change the task.\n\n${markdown}`;
}
