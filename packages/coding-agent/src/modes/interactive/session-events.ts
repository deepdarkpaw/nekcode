import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall, Usage } from "@earendil-works/pi-ai";
import type { CompactionResult } from "../../core/compaction/index.ts";
import { createCompactionSummaryMessage } from "../../core/messages.ts";
import { type SessionEntry, sessionEntryToContextMessages } from "../../core/session-entries.ts";

export type CompactionCostNotice = { type: "compaction_cost"; kind: "compaction" | "branch_summary"; usage: Usage };
export type RenderSessionItem =
	| AgentMessage
	| Extract<SessionEntry, { type: "custom" | "usage" }>
	| CompactionCostNotice;
export function isCustomSessionEntry(item: RenderSessionItem): item is Extract<SessionEntry, { type: "custom" }> {
	return "type" in item && item.type === "custom";
}
export function isUsageSessionEntry(item: RenderSessionItem): item is Extract<SessionEntry, { type: "usage" }> {
	return "type" in item && item.type === "usage";
}
export function isCompactionCostNotice(item: RenderSessionItem): item is CompactionCostNotice {
	return "type" in item && item.type === "compaction_cost";
}

/** Shared transcript projection, with summary billing adjacent to its summary. */
export function buildRenderSessionItems(entries: readonly SessionEntry[]): RenderSessionItem[] {
	return entries.flatMap((entry): RenderSessionItem[] => {
		if (entry.type === "custom" || (entry.type === "usage" && entry.kind === "cache_warm")) return [entry];
		const messages = sessionEntryToContextMessages(entry);
		return (entry.type === "compaction" || entry.type === "branch_summary") && entry.usage && messages.length > 0
			? [...messages, { type: "compaction_cost", kind: entry.type, usage: entry.usage }]
			: messages;
	});
}

export interface CompactionRenderPlan {
	kind: "boundary" | "completed";
	before: SessionEntry[];
	summary: ReturnType<typeof createCompactionSummaryMessage>;
	cost?: CompactionCostNotice;
	after: SessionEntry[];
	rememberIds: ReadonlySet<string>;
}

/** Boundary compactions render at their historical position, then suppress their already-rendered following entries. */
export function planBoundaryCompaction(
	entry: Extract<SessionEntry, { type: "compaction" }>,
	entries: readonly SessionEntry[],
	getBranch: () => readonly SessionEntry[],
): CompactionRenderPlan | undefined {
	if (entries[0]?.id !== entry.id) return undefined;
	const branch = getBranch();
	const index = branch.findIndex((candidate) => candidate.id === entry.id);
	const rememberIds = new Set(branch.slice(index + 1).map((candidate) => candidate.id));
	const retained = entries.slice(1);
	return {
		kind: "boundary",
		before: retained.filter((candidate) => !rememberIds.has(candidate.id)),
		summary: createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp),
		cost: entry.usage ? { type: "compaction_cost", kind: "compaction", usage: entry.usage } : undefined,
		after: retained.filter((candidate) => rememberIds.has(candidate.id)),
		rememberIds,
	};
}

export function planCompletedCompaction(
	entries: readonly SessionEntry[],
	result: CompactionResult,
	timestamp: string,
): CompactionRenderPlan {
	if (entries[0]?.type !== "compaction") throw new Error("Completed compaction is missing from the session context");
	return {
		kind: "completed",
		before: entries.slice(1),
		summary: createCompactionSummaryMessage(result.summary, result.tokensBefore, timestamp),
		cost: result.usage ? { type: "compaction_cost", kind: "compaction", usage: result.usage } : undefined,
		after: [],
		rememberIds: new Set(),
	};
}

export interface CompactionRenderTarget {
	entries(entries: SessionEntry[]): void;
	message(message: AgentMessage): void;
	cost(notice: CompactionCostNotice): void;
}

/** Preserve common event order; containers, clear/repaint policy and boundary suppression remain UI-owned. */
export function renderCompactionPlan(plan: CompactionRenderPlan, target: CompactionRenderTarget): void {
	target.entries(plan.before);
	target.message(plan.summary);
	if (plan.cost) target.cost(plan.cost);
	if (plan.kind === "boundary") target.entries(plan.after);
}

/** A live map plus a component-construction port avoids duplicate tool components on repeated deltas. */
export function syncStreamingTools<T extends { updateArgs(args: ToolCall["arguments"]): void }>(
	message: AssistantMessage,
	pending: Map<string, T>,
	create: (call: ToolCall) => T,
): void {
	for (const content of message.content) {
		if (content.type !== "toolCall") continue;
		const current = pending.get(content.id);
		if (current) current.updateArgs(content.arguments);
		else pending.set(content.id, create(content));
	}
}

/** Pure finish policy, reused for live completion and replay. */
export function assistantFinishError(message: AssistantMessage, retryAttempt: number): string | undefined {
	if (message.stopReason === "aborted")
		return retryAttempt > 0
			? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
			: "Operation aborted";
	return message.stopReason === "error" ? message.errorMessage || "Error" : undefined;
}

interface PendingToolView {
	setArgsComplete(): void;
	updateResult(result: { content: Array<{ type: "text"; text: string }>; isError: true }): void;
}

export function finishPendingTools<T extends PendingToolView>(
	pending: Map<string, T>,
	errorMessage: string | undefined,
): void {
	for (const tool of pending.values()) {
		if (errorMessage === undefined) tool.setArgsComplete();
		else tool.updateResult({ content: [{ type: "text", text: errorMessage }], isError: true });
	}
	if (errorMessage !== undefined) pending.clear();
}
