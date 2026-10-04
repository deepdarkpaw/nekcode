import { relative } from "node:path";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../../../core/extensions/types.ts";
import { CREATE_PLAN } from "../prompts/tool-descriptions.ts";
import { planId, planName, planPath, writePlanFile } from "../services/plan-store.ts";
import { CREATE_PLAN_TOOL_NAME } from "../state/session-state.ts";
import type { Mode, PlanData, PlanRecord } from "../types.ts";
import { createPlanRenderers, formatPlanDocument } from "../ui/renderers.ts";

const createPlanSchema = Type.Object({
	plan_id: Type.Optional(
		Type.String({
			description:
				"Stable id of an existing plan to rewrite. Omit this field to always create a new plan. Rewriting keeps the existing path and name and increments its revision.",
		}),
	),
	name: Type.Optional(
		Type.String({
			description: "A short 3-4 word name for a new plan. Omit when rewriting an existing plan with plan_id.",
		}),
	),
	overview: Type.String({
		description: "A 1-2 sentence high-level description of the plan that summarizes what will be accomplished",
	}),
	plan: Type.String({ description: "A detailed, concrete plan for accomplishing the user's request" }),
	todos: Type.Optional(
		Type.Array(
			Type.Object({
				content: Type.String({ description: "Description of the todo task" }),
				id: Type.String({ description: "Unique identifier for the todo" }),
			}),
			{ description: "Array of implementation todos" },
		),
	),
});

/** Validated create_plan arguments. */
export type CreatePlanToolInput = Static<typeof createPlanSchema>;

/** Access to plan mode and the saved plan snapshots of the branch. */
export interface CreatePlanToolOptions {
	getMode(): Mode;
	getPlans(): readonly PlanData[];
	/** Plan directory relative to cwd (config `plan.dir`). */
	getPlanDir(): string;
	/** Store the written plan as the current plan of the branch. */
	setPlan(plan: PlanRecord, markdown: string, ctx: ExtensionContext): void;
}

function nextPlanRecord(options: CreatePlanToolOptions, params: CreatePlanToolInput, cwd: string): PlanRecord {
	const todos = (params.todos ?? []).map((todo) => ({ id: todo.id, content: todo.content }));
	if (params.plan_id !== undefined) {
		const existing = options.getPlans().find((snapshot) => planId(snapshot.plan) === params.plan_id);
		if (!existing) throw new Error(`Unknown plan_id "${params.plan_id}". Choose an id from the saved plans list.`);
		return {
			...existing.plan,
			revision: existing.plan.revision + 1,
			overview: params.overview,
			todos,
		};
	}
	const name = planName(params.name, params.overview);
	return { name, path: planPath(cwd, options.getPlanDir(), name), revision: 1, overview: params.overview, todos };
}

/**
 * Create a new plan when `plan_id` is omitted, or rewrite the identified plan in place when it is supplied. The result
 * ends the run so the user can review the saved revision; details restores its metadata and immutable body snapshot.
 */
export function createCreatePlanToolDefinition(
	options: CreatePlanToolOptions,
): ToolDefinition<typeof createPlanSchema, PlanData> {
	return {
		name: CREATE_PLAN_TOOL_NAME,
		label: "Plan",
		description: CREATE_PLAN,
		parameters: createPlanSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params: CreatePlanToolInput, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			if (options.getMode() !== "plan") throw new Error("create_plan is only available in plan mode.");
			const markdown = params.plan.trim();
			if (!markdown) throw new Error("The plan body must not be empty.");
			const record = nextPlanRecord(options, params, ctx.cwd);
			writePlanFile(record, markdown);
			options.setPlan(record, markdown, ctx);
			const shownPath = relative(ctx.cwd, record.path).replaceAll("\\", "/");
			const text = `Plan saved to ${shownPath} (revision ${record.revision}). Review the plan before implementation.\n\n${formatPlanDocument({ plan: record, markdown })}`;
			return { content: [{ type: "text", text }], details: { plan: record, markdown }, terminate: true };
		},
		...createPlanRenderers,
	};
}
