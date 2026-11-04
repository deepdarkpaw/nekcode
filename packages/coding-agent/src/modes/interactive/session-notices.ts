import type { AssistantMessage } from "@earendil-works/pi-ai";
import { CACHE_TTL_MS, type CacheMiss } from "../../core/cache-stats.ts";
import type { SessionEntry } from "../../core/session-entries.ts";
import { formatTokens } from "../../utils/format-tokens.ts";
import type { CompactionCostNotice } from "./session-events.ts";

export const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
	"Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage. Disable this warning in /settings.";
export function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
	return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}

export function formatCompactionCostNotice(notice: CompactionCostNotice): string {
	const { usage } = notice;
	const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
	const cost = usage.cost.total >= 0.01 ? ` (~$${usage.cost.total.toFixed(2)})` : "";
	return `${notice.kind === "compaction" ? "Compaction" : "Branch summary"}: ${formatTokens(tokens)} tokens billed${cost}`;
}

export function countDroppedThinkingBlocks(message: AssistantMessage): number {
	let count = 0;
	for (const diagnostic of message.diagnostics ?? []) {
		if (diagnostic.type !== "anthropic_input_transformations") continue;
		const transformations = diagnostic.details?.transformations;
		if (!Array.isArray(transformations)) continue;
		count += transformations.filter(
			(item) =>
				typeof item === "object" && item !== null && (item as Record<string, unknown>).type === "thinking_dropped",
		).length;
	}
	return count;
}

/** Keep the current predecessor-selection rule; the caller supplies the same branch it previously inspected. */
export function thinkingDropNotice(
	message: AssistantMessage,
	getBranch: () => readonly SessionEntry[],
): string | undefined {
	const dropped = countDroppedThinkingBlocks(message);
	if (dropped === 0) return undefined;
	const branch = getBranch();
	let previous = 0;
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		previous = countDroppedThinkingBlocks(entry.message);
		break;
	}
	if (dropped <= previous) return undefined;
	return `Anthropic dropped ${dropped} ${dropped === 1 ? "thinking block" : "thinking blocks"} (details in session)`;
}

export function cacheMissNotice(miss: CacheMiss): string | undefined {
	if (miss.missedTokens < 20_000 && miss.missedCost < 0.1) return undefined;
	const cost = miss.missedCost >= 0.01 ? ` (~$${miss.missedCost.toFixed(2)})` : "";
	let label = "Cache miss";
	if (miss.modelChanged) label = "Cache miss after model switch";
	else if (miss.idleMs >= CACHE_TTL_MS) label = `Cache miss after ${Math.round(miss.idleMs / 60_000)}m idle`;
	return `${label}: ${formatTokens(miss.missedTokens)} tokens re-billed${cost}`;
}

export function retryFailureNotice(attempt: number, finalError?: string): string {
	return `Retry failed after ${attempt} attempts: ${finalError || "Unknown error"}`;
}
