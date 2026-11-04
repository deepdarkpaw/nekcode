import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/core/session-entries.ts";
import {
	applyPlanArtifact,
	createSessionState,
	NEK_PLAN_SNAPSHOT_ENTRY_TYPE,
	replayBranch,
} from "../src/extensions/nek/state/session-state.ts";
import type { PlanData } from "../src/extensions/nek/types.ts";

function artifact(path: string, revision: number): PlanData {
	return {
		plan: { path, revision, name: "plan", overview: "overview", todos: [{ id: "a", content: "step" }] },
		markdown: `# Revision ${revision}`,
	};
}

describe("shared plan artifact transform", () => {
	it("matches replay at every prefix and replaces in place without losing other plans", () => {
		const events = [artifact("/plans/a.md", 1), artifact("/plans/b.md", 1), artifact("/plans/a.md", 2)];
		const live = createSessionState();
		const entries: SessionEntry[] = [];
		for (const [index, data] of events.entries()) {
			applyPlanArtifact(live, data);
			entries.push({
				type: "custom",
				id: String(index),
				parentId: null,
				timestamp: "2026-11-03T00:00:00.000Z",
				customType: NEK_PLAN_SNAPSHOT_ENTRY_TYPE,
				data,
			});
			expect(live).toEqual(replayBranch(entries));
		}
		expect(live.plans.map(({ plan }) => [plan.path, plan.revision])).toEqual([
			["/plans/a.md", 2],
			["/plans/b.md", 1],
		]);
	});
	it("owns the stored plan and todo snapshot", () => {
		const input = artifact("/plans/a.md", 1);
		const state = createSessionState();
		applyPlanArtifact(state, input);
		input.plan.todos[0].content = "mutated";
		input.plan.name = "mutated";
		input.markdown = "mutated";
		expect(state.plans[0]).toEqual(artifact("/plans/a.md", 1));
		expect(state.planStatus).toBe("ready");
	});
});
