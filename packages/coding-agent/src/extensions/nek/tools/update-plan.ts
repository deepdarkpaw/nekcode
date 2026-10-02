import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { type Static, Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "../../../core/extensions/types.ts";
import { generateDiffString } from "../../../core/tools/edit-diff.ts";
import { parseFrontmatter } from "../../../utils/frontmatter.ts";
import { UPDATE_PLAN } from "../prompts/tool-descriptions.ts";
import type { Mode, PlanData, PlanRecord } from "../types.ts";
import { formatPlanDocument, updatePlanRenderers } from "../ui/renderers.ts";

/** Tool name used to submit an edited current plan for review. */
export const UPDATE_PLAN_TOOL_NAME = "update_plan";

const updatePlanSchema = Type.Object({
	explanation: Type.Optional(
		Type.String({ description: "One sentence explaining what changed in this plan revision" }),
	),
});

/** Validated update_plan arguments. */
export type UpdatePlanToolInput = Static<typeof updatePlanSchema>;

/** update_plan details add the generated document diff to the replayable plan snapshot. */
interface UpdatePlanDetails extends PlanData {
	diff: string;
}

/** Access to plan mode, the current plan snapshot, and the shared plan lifecycle callback. */
export interface UpdatePlanToolOptions {
	getMode(): Mode;
	getPlan(): PlanRecord | undefined;
	getPlanMarkdown(): string | undefined;
	setPlan(plan: PlanRecord, markdown: string, ctx: ExtensionContext): void;
}

type PlanFrontmatter = Record<string, unknown>;
type PlanTodo = PlanRecord["todos"][number];

function readTodos(frontmatter: PlanFrontmatter): PlanTodo[] {
	if (frontmatter.todos === undefined) return [];
	if (!Array.isArray(frontmatter.todos) || !frontmatter.todos.every(isPlanTodo)) {
		throw new Error(
			"The plan frontmatter todos must be an array of objects with string id and content. Fix todos before calling update_plan.",
		);
	}
	return frontmatter.todos.map((todo) => ({ id: todo.id, content: todo.content }));
}

function isPlanTodo(value: unknown): value is PlanTodo {
	if (typeof value !== "object" || value === null) return false;
	const todo = value as Record<string, unknown>;
	return typeof todo.id === "string" && typeof todo.content === "string";
}

function nextPlanRecord(
	current: PlanRecord,
	overview: string,
	todos: PlanTodo[],
	oldDocument: string,
	newDocument: string,
): PlanRecord {
	return {
		...current,
		revision: oldDocument === newDocument ? current.revision : current.revision + 1,
		overview,
		todos,
	};
}

/** Submit the plan file after the model has made exact incremental edits with read and edit. */
export function createUpdatePlanToolDefinition(
	options: UpdatePlanToolOptions,
): ToolDefinition<typeof updatePlanSchema, UpdatePlanDetails> {
	return {
		name: UPDATE_PLAN_TOOL_NAME,
		label: "update_plan",
		description: UPDATE_PLAN,
		parameters: updatePlanSchema,
		executionMode: "sequential",
		async execute(_toolCallId, _params: UpdatePlanToolInput, signal, _onUpdate, ctx) {
			signal?.throwIfAborted();
			if (options.getMode() !== "plan") throw new Error("update_plan is only available in plan mode.");
			const current = options.getPlan();
			if (!current) throw new Error("No current plan. Call create_plan first.");

			const source = await readFile(current.path, "utf8");
			signal?.throwIfAborted();
			const parsed = parseFrontmatter(source);
			if (typeof parsed.frontmatter.overview !== "string") {
				throw new Error(
					"The plan frontmatter overview must be a string. Fix overview in the plan file before calling update_plan.",
				);
			}
			const todos = readTodos(parsed.frontmatter);
			const markdown = parsed.body.trim();
			if (!markdown)
				throw new Error("The plan body must not be empty. Add plan content before calling update_plan.");

			const oldMarkdown = options.getPlanMarkdown() ?? "";
			const oldDocument = formatPlanDocument({ plan: current, markdown: oldMarkdown });
			const newDocument = formatPlanDocument({
				plan: { ...current, overview: parsed.frontmatter.overview, todos },
				markdown,
			});
			const record = nextPlanRecord(current, parsed.frontmatter.overview, todos, oldDocument, newDocument);
			const diff = generateDiffString(oldDocument, newDocument).diff;
			options.setPlan(record, markdown, ctx);

			const shownPath = relative(ctx.cwd, record.path).replaceAll("\\", "/");
			const resultText = [
				diff || "No changes to the plan.",
				`Plan saved to ${shownPath} (revision ${record.revision}). Review the plan before implementation.`,
			].join("\n\n");
			return {
				content: [{ type: "text", text: resultText }],
				details: { plan: record, markdown, diff },
				terminate: true,
			};
		},
		...updatePlanRenderers,
	};
}
