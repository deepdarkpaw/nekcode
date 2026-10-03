import { planId } from "../services/plan-store.ts";
import { activePlan } from "../state/session-state.ts";
import type { NekSessionState } from "../types.ts";

function savedPlans(state: NekSessionState): string {
	if (state.plans.length === 0) return "Saved plans: none.";
	const activePath = state.activePlan;
	const rows = state.plans.slice(-10).map((snapshot) => {
		const plan = snapshot.plan;
		const active = plan.path === activePath ? " active" : "";
		return `- ${planId(plan)} | ${plan.name} | ${plan.path} | revision ${plan.revision}${active}`;
	});
	return `Saved plans (last ${rows.length}):\n${rows.join("\n")}`;
}

/** Reentry semantics adapted from Claude Code plan mode reentry, with all saved plans visible to the model. */
export function planWorkflowReminder(state: NekSessionState): string {
	if (state.mode === "plan") {
		const selected = activePlan(state);
		if (!selected)
			return `Current mode: Plan. Research and clarify the latest request, then create_plan for user review. Planning is not execution.\n\n${savedPlans(state)}\n\nTo create a new plan, omit plan_id. To rewrite an existing plan, provide its plan_id.`;
		const plan = selected.plan;
		return `Current mode: Plan. The active plan is ${plan.path} (id ${planId(plan)}, revision ${plan.revision}).\n${savedPlans(state)}\nFirst read the active plan and evaluate the user's current request against it. For the same task, use edit to make incremental changes in the plan file, including its frontmatter overview and todos, then call update_plan (omitting plan_id) to submit it for review. For a different task, call update_plan with the other plan_id, or use create_plan with an existing plan_id to rewrite that plan completely. To create a new plan, omit plan_id.\nTreat re-planning as a fresh planning session. Do not assume the old plan or previous answers still apply. Ask ask_question when a new ambiguity or conflicting decision needs the user's input, then use the appropriate plan tool before requesting approval. Previous execution approval does not authorize this revision.`;
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
