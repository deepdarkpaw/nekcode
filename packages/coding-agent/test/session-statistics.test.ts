import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { getSessionUsageDisplay } from "../src/modes/interactive/session-statistics.ts";

describe("common session usage display", () => {
	it("uses full prompt volume and retains the highest-cost response-model group", () => {
		const entries: SessionEntry[] = [1, 3].map((cost) => ({
			type: "message",
			id: String(cost),
			parentId: null,
			timestamp: "2026-11-03T00:00:00.000Z",
			message: {
				...fauxAssistantMessage("done"),
				responseModel: `resolved-${cost}`,
				usage: {
					input: 10,
					cacheRead: 20,
					cacheWrite: 10,
					output: 5,
					totalTokens: 45,
					cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
				},
			},
		}));
		const result = getSessionUsageDisplay(
			{ input: 20, cacheRead: 40, cacheWrite: 20, output: 10, total: 90 },
			entries,
			{ getModel: () => undefined },
		);
		expect(result.promptTokens).toBe(80);
		expect(result.uncachedTokens).toBe(40);
		expect(result.cacheHitPercent).toBe(50);
		expect(result.usageBreakdown.map((group) => group.cost)).toEqual([3, 1]);
		expect(result.usageBreakdown[0].key).toContain("resolved-3");
	});
	it("has finite zero-valued statistics for an empty session", () => {
		const result = getSessionUsageDisplay({ input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 }, [], {
			getModel: () => undefined,
		});
		expect(result).toEqual({
			promptTokens: 0,
			uncachedTokens: 0,
			cacheHitPercent: 0,
			usageBreakdown: [],
			cacheWaste: { missedTokens: 0, missedCost: 0, missCount: 0 },
		});
	});
});
