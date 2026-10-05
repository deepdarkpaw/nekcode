import { computeCacheWaste } from "@earendil-works/pi-coding-agent/core/cache-stats";
import { formatCacheWarmingStatus } from "@earendil-works/pi-coding-agent/core/cache-warmer";
import { getUsageCostBreakdown } from "@earendil-works/pi-coding-agent/core/usage-totals";
import type { CommandDefinition } from "./registry.ts";

export const sessionCommand: CommandDefinition = {
	name: "session",
	acceptsArgs: false,
	clearEditor: "after",
	run: (ctx) => {
		const stats = ctx.session.getSessionStats();
		const name = ctx.sessionManager.getSessionName();
		const { input, cacheRead, cacheWrite, output, total } = stats.tokens;
		const promptTokens = input + cacheRead + cacheWrite;
		const cacheWaste = computeCacheWaste(ctx.sessionManager.getEntries(), ctx.session.modelRuntime);
		const usageBreakdown = getUsageCostBreakdown(ctx.sessionManager.getEntries());
		const cacheStatus = ctx.session.cacheWarmingStatus;
		const markdown = [
			"## Session Info",
			name ? `**Name:** ${name}` : "",
			`**File:** ${stats.sessionFile ?? "In-memory"}`,
			`**ID:** ${stats.sessionId}`,
			"",
			"## Messages",
			`- Total: ${stats.totalMessages}`,
			`- User: ${stats.userMessages}`,
			`- Assistant: ${stats.assistantMessages}`,
			`- Tools: ${stats.toolCalls} calls, ${stats.toolResults} results`,
			"",
			"## Tokens",
			`- Input: ${promptTokens.toLocaleString()}`,
			`- Cached: ${cacheRead.toLocaleString()}${promptTokens > 0 ? ` (${((cacheRead / promptTokens) * 100).toFixed(1)}%)` : ""}`,
			`- Cache writes: ${cacheWrite.toLocaleString()}`,
			`- Output: ${output.toLocaleString()}`,
			`- Total: ${total.toLocaleString()}`,
			"",
			"## Cache Warming",
			`- Mode: ${ctx.settingsManager.getCacheWarmingMode()}`,
			`- Status: ${cacheStatus ? formatCacheWarmingStatus(cacheStatus) : "Inactive (cache warming unavailable)"}`,
			"",
			"## Cost",
			`- Total: $${stats.cost.toFixed(3)}`,
			...usageBreakdown
				.slice(1)
				.map((entry) => `- ${entry.key}: $${entry.cost.toFixed(3)} (${entry.tokens.toLocaleString()} tokens)`),
			...(cacheWaste.missedTokens > 0
				? [`- Cache re-billed: ${cacheWaste.missedTokens.toLocaleString()} tokens (${cacheWaste.missCount} misses)`]
				: []),
		]
			.filter((line) => line.length > 0)
			.join("\n");
		ctx.transcript.appendMarkdown(markdown, { title: "Session Info", bordered: true });
	},
};
