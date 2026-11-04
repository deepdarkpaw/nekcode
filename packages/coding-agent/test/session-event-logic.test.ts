import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import {
	assistantFinishError,
	buildRenderSessionItems,
	finishPendingTools,
	planBoundaryCompaction,
	planCompletedCompaction,
	renderCompactionPlan,
	syncStreamingTools,
} from "../src/modes/interactive/session-events.ts";
import {
	cacheMissNotice,
	formatCompactionCostNotice,
	thinkingDropNotice,
} from "../src/modes/interactive/session-notices.ts";
import { countAvailableProviders } from "../src/modes/interactive/session-statistics.ts";

const timestamp = "2026-11-03T00:00:00.000Z";
const user: SessionEntry = {
	type: "message",
	id: "u",
	parentId: null,
	timestamp,
	message: { role: "user", content: "kept", timestamp: 1 },
};
const custom: SessionEntry = { type: "custom", id: "c", parentId: "s", timestamp, customType: "test", data: {} };
const usage = {
	...fauxAssistantMessage("").usage,
	input: 2000,
	cost: { ...fauxAssistantMessage("").usage.cost, total: 0.02 },
};
const summary: Extract<SessionEntry, { type: "compaction" }> = {
	type: "compaction",
	id: "s",
	parentId: "u",
	timestamp,
	firstKeptEntryId: "u",
	summary: "summary",
	tokensBefore: 100,
	usage,
};

describe("shared session-event derivations", () => {
	it("builds the boundary render order without touching stale-compaction branches", () => {
		const branch = vi.fn(() => [user, summary, custom]);
		expect(planBoundaryCompaction(summary, [user], branch)).toBeUndefined();
		expect(branch).not.toHaveBeenCalled();
		const plan = planBoundaryCompaction(summary, [summary, user, custom], branch)!;
		const trace: string[] = [];
		renderCompactionPlan(plan, {
			entries: (entries) => trace.push(entries.map((entry) => entry.id).join(",")),
			message: () => trace.push("summary"),
			cost: () => trace.push("cost"),
		});
		expect(trace).toEqual(["u", "summary", "cost", "c"]);
		expect([...plan.rememberIds]).toEqual(["c"]);
	});
	it("guards completed compaction and does not add an extra empty render step", () => {
		const result = { summary: "new summary", firstKeptEntryId: "u", tokensBefore: 100 };
		expect(() => planCompletedCompaction([], result, timestamp)).toThrow("missing from the session context");
		const plan = planCompletedCompaction([summary, user], result, timestamp);
		const entries = vi.fn();
		const message = vi.fn();
		const cost = vi.fn();
		renderCompactionPlan(plan, { entries, message, cost });
		expect(entries).toHaveBeenCalledTimes(1);
		expect(message).toHaveBeenCalledWith(
			expect.objectContaining({ role: "compactionSummary", summary: "new summary" }),
		);
		expect(cost).not.toHaveBeenCalled();
	});
	it("projects billing after summaries and retains custom entries", () => {
		const items = buildRenderSessionItems([user, summary, custom]);
		expect(items.map((item) => ("role" in item ? item.role : item.type))).toEqual([
			"user",
			"compactionSummary",
			"compaction_cost",
			"custom",
		]);
		expect(items.at(-1)).toBe(custom);
	});
	it("creates a tool view once and updates duplicate/subsequent argument events", () => {
		const makeTool = () => ({ updateArgs: vi.fn(), setArgsComplete: vi.fn(), updateResult: vi.fn() });
		const tools = new Map<string, ReturnType<typeof makeTool>>();
		const create = vi.fn(makeTool);
		const message = fauxAssistantMessage([
			fauxToolCall("read", { n: 1 }, { id: "call" }),
			fauxToolCall("read", { n: 2 }, { id: "call" }),
		]);
		syncStreamingTools(message, tools, create);
		syncStreamingTools(message, tools, create);
		expect(create).toHaveBeenCalledTimes(1);
		expect(tools.get("call")!.updateArgs).toHaveBeenCalledTimes(3);
		finishPendingTools(tools, undefined);
		expect(tools.get("call")!.setArgsComplete).toHaveBeenCalledTimes(1);
		const tool = tools.get("call")!;
		finishPendingTools(tools, "failed");
		expect(tool.updateResult).toHaveBeenCalledWith({ content: [{ type: "text", text: "failed" }], isError: true });
		expect(tools.size).toBe(0);
	});
	it("keeps abort/retry/error strings separate from successful completion", () => {
		expect(assistantFinishError(fauxAssistantMessage("", { stopReason: "aborted" }), 1)).toBe(
			"Aborted after 1 retry attempt",
		);
		expect(assistantFinishError(fauxAssistantMessage("", { stopReason: "aborted" }), 0)).toBe("Operation aborted");
		expect(assistantFinishError(fauxAssistantMessage("", { stopReason: "error" }), 0)).toBe("Error");
		expect(assistantFinishError(fauxAssistantMessage("", { errorMessage: "stale" }), 0)).toBeUndefined();
	});
});

describe("shared notices and provider counts", () => {
	it("preserves notice thresholds, costs and model-switch precedence", () => {
		const miss = { missedTokens: 19999, missedCost: 0.09, modelChanged: false, idleMs: 0 };
		expect(cacheMissNotice(miss)).toBeUndefined();
		expect(cacheMissNotice({ ...miss, missedTokens: 20000, idleMs: 300000 })).toBe(
			"Cache miss after 5m idle: 20k tokens re-billed (~$0.09)",
		);
		expect(cacheMissNotice({ ...miss, missedCost: 0.1, modelChanged: true, idleMs: 300000 })).toContain(
			"Cache miss after model switch",
		);
		expect(formatCompactionCostNotice({ type: "compaction_cost", kind: "branch_summary", usage })).toBe(
			"Branch summary: 2.0k tokens billed (~$0.02)",
		);
	});
	it("does not read history without thinking-drop diagnostics", () => {
		const branch = vi.fn(() => []);
		expect(thinkingDropNotice(fauxAssistantMessage(""), branch)).toBeUndefined();
		expect(branch).not.toHaveBeenCalled();
		const message: AssistantMessage = {
			...fauxAssistantMessage(""),
			diagnostics: [
				{
					type: "anthropic_input_transformations",
					timestamp: 1,
					details: { transformations: [{ type: "thinking_dropped" }] },
				},
			],
		};
		expect(thinkingDropNotice(message, branch)).toBe("Anthropic dropped 1 thinking block (details in session)");
	});
	it("counts scoped providers without accessing the full catalog", () => {
		const available = vi.fn(() => [{ provider: "a" }, { provider: "b" }]);
		expect(countAvailableProviders([{ model: { provider: "a" } }, { model: { provider: "a" } }], available)).toBe(1);
		expect(available).not.toHaveBeenCalled();
		expect(countAvailableProviders([], available)).toBe(2);
	});
});
