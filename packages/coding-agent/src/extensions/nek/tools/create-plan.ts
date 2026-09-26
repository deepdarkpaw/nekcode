import { relative } from "node:path";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../../../core/extensions/types.ts";
import { CREATE_PLAN } from "../prompts/tool-descriptions.ts";
import { planName, planPath, writePlanFile } from "../services/plan-store.ts";
import { CREATE_PLAN_TOOL_NAME } from "../state/session-state.ts";
import type { Mode, PlanData, PlanRecord } from "../types.ts";

const createPlanSchema = Type.Object({
	name: Type.Optional(
		Type.String({
			description:
				"A short 3-4 word name for the plan. IMPORTANT: Provide this only on the first create_plan call when no current plan exists. If a current plan already exists, omit this field entirely; do not use it to rename or create a separate plan.",
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

/** Access to the mode and current plan owned by the extension. */
export interface CreatePlanToolOptions {
	getMode(): Mode;
	getPlan(): PlanRecord | undefined;
	/** Plan directory relative to cwd (config `plan.dir`). */
	getPlanDir(): string;
	/** Store the written plan as the current plan of the branch. */
	setPlan(plan: PlanRecord, ctx: ExtensionContext): void;
}

function nextPlanRecord(options: CreatePlanToolOptions, params: CreatePlanToolInput, cwd: string): PlanRecord {
	const todos = (params.todos ?? []).map((todo) => ({ id: todo.id, content: todo.content }));
	const current = options.getPlan();
	if (current) return { ...current, overview: params.overview, todos };
	const name = planName(params.name, params.overview);
	return { name, path: planPath(cwd, options.getPlanDir(), name), overview: params.overview, todos };
}

/**
 * Cursor CreatePlan as `create_plan` (description and schema from reference/cursor/cursor-tools-2026.json). The first
 * call creates `<plan.dir>/<slug>_<id>.plan.md`; later calls revise the same file and ignore `name`. The result ends
 * the run so the user can review the plan; `details.plan` is what replayBranch() restores.
 */
export function createCreatePlanToolDefinition(
	options: CreatePlanToolOptions,
): ToolDefinition<typeof createPlanSchema, PlanData> {
	return {
		name: CREATE_PLAN_TOOL_NAME,
		label: "create_plan",
		description: CREATE_PLAN,
		parameters: createPlanSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params: CreatePlanToolInput, _signal, _onUpdate, ctx) {
			if (options.getMode() !== "plan") throw new Error("create_plan is only available in plan mode.");
			const record = nextPlanRecord(options, params, ctx.cwd);
			writePlanFile(record, params.plan);
			options.setPlan(record, ctx);
			const shownPath = relative(ctx.cwd, record.path).replaceAll("\\", "/");
			const text = `Plan saved to ${shownPath}. The user will be asked to confirm it.`;
			return { content: [{ type: "text", text }], details: { plan: record }, terminate: true };
		},
	};
}
