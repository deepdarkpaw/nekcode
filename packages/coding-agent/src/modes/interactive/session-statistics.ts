import type { SessionStats } from "../../core/agent-session.ts";
import { computeCacheWaste, type ModelPriceSource } from "../../core/cache-stats.ts";
import type { SessionEntry } from "../../core/session-manager.ts";
import { getUsageCostBreakdown } from "../../core/usage-totals.ts";

/** A scoped selection avoids even reading the full catalog snapshot. */
export function countAvailableProviders(
	scoped: readonly { model: { provider: string } }[],
	available: () => readonly { provider: string }[],
): number {
	const models = scoped.length > 0 ? scoped.map((entry) => entry.model) : available();
	return new Set(models.map((model) => model.provider)).size;
}

/** Common numbers only; each frontend retains its own sections, labels and rendering. */
export function getSessionUsageDisplay(
	tokens: SessionStats["tokens"],
	entries: SessionEntry[],
	models: ModelPriceSource,
) {
	const promptTokens = tokens.input + tokens.cacheRead + tokens.cacheWrite;
	return {
		promptTokens,
		uncachedTokens: tokens.input + tokens.cacheWrite,
		cacheHitPercent: promptTokens > 0 ? (tokens.cacheRead / promptTokens) * 100 : 0,
		cacheWaste: computeCacheWaste(entries, models),
		usageBreakdown: getUsageCostBreakdown(entries),
	};
}
