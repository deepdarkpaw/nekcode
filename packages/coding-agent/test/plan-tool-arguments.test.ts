import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JsonObject, validateToolArguments } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { convertResponsesTools } from "../../ai/src/api/openai-responses-shared.ts";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { planId } from "../src/extensions/nek/services/plan-store.ts";
import { createCreatePlanToolDefinition } from "../src/extensions/nek/tools/create-plan.ts";
import { createUpdatePlanToolDefinition } from "../src/extensions/nek/tools/update-plan.ts";
import type { PlanData } from "../src/extensions/nek/types.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
	const cwd = mkdtempSync(join(tmpdir(), "nek-plan-arguments-"));
	roots.push(cwd);
	const plans: PlanData[] = [];
	const options = {
		getMode: () => "plan" as const,
		getPlans: () => plans,
		getPlanDir: () => ".plans",
		getActivePlanId: () => plans[0] && planId(plans[0].plan),
		setPlan: (plan: PlanData["plan"], markdown: string) => {
			plans.splice(0, plans.length, { plan, markdown });
		},
	};
	return {
		cwd,
		plans,
		create: createCreatePlanToolDefinition(options),
		update: createUpdatePlanToolDefinition(options),
		ctx: { cwd } as ExtensionContext,
	};
}

function argumentsFor(
	tool: ReturnType<typeof createCreatePlanToolDefinition> | ReturnType<typeof createUpdatePlanToolDefinition>,
	args: JsonObject,
) {
	return validateToolArguments(tool, { type: "toolCall", id: "test", name: tool.name, arguments: args });
}

const body = { overview: "Test plan", plan: "# Test plan\n\nImplement the fix." };

describe("Plan optional argument transport", () => {
	it.each([undefined, null])("creates and updates a plan with plan_id=%s", async (id) => {
		const { create, update, plans, ctx } = setup();
		const declaration = convertResponsesTools([create], { supportsStrictMode: false })[0];
		expect(declaration).toMatchObject({ strict: false, parameters: { required: ["overview", "plan"] } });
		const strict = convertResponsesTools([
			{ ...create, constrainedSampling: { type: "json_schema", strict: "require" } },
		])[0];
		expect(strict).toMatchObject({
			strict: true,
			parameters: { properties: { plan_id: { anyOf: [{ type: "string" }, { type: "null" }] } } },
		});
		const params = argumentsFor(create, { ...body, ...(id === undefined ? {} : { plan_id: id }) });
		const created = await create.execute("test", params, undefined, undefined, ctx);
		expect(created.terminate).toBe(true);
		expect(plans[0].plan.revision).toBe(1);
		await update.execute("test", argumentsFor(update, { plan_id: null }), undefined, undefined, ctx);
		expect(plans[0].plan.revision).toBe(1);
		await create.execute(
			"test",
			argumentsFor(create, { ...body, plan_id: planId(plans[0].plan) }),
			undefined,
			undefined,
			ctx,
		);
		expect(plans[0].plan.revision).toBe(2);
	});

	it.each(["", "  "])("rejects empty ID %j without saving a plan", async (plan_id) => {
		const { cwd, create, update, plans, ctx } = setup();
		await expect(
			create.execute("test", argumentsFor(create, { ...body, plan_id }), undefined, undefined, ctx),
		).rejects.toThrow("Omit plan_id to create");
		await expect(update.execute("test", { plan_id }, undefined, undefined, ctx)).rejects.toThrow(
			"Omit plan_id to update",
		);
		expect(plans).toEqual([]);
		expect(readdirSync(cwd)).toEqual([]);
	});

	it("does not reinterpret an unknown ID as a new plan", async () => {
		const { cwd, create, ctx } = setup();
		await expect(create.execute("test", { ...body, plan_id: "unknown" }, undefined, undefined, ctx)).rejects.toThrow(
			'Unknown plan_id "unknown"',
		);
		expect(readdirSync(cwd)).toEqual([]);
	});
});
