import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText } from "@earendil-works/pi-ai";
import type { CompactionEntry, ProjectedSessionEntry } from "../session-entries.ts";
import { type CompactionContentSettings, foldToolResult } from "./content-policy.ts";

/** A replacement is committed with its compaction, not written back into the original tool message. */
export interface CompactionToolResultEdit {
	targetId: string;
	toolCallId: string;
	text: string;
}

const FOLDED_PREFIX = "[Tool output folded at compaction;";
const FOLDABLE_TOOLS = new Set(["read", "grep", "find", "ls", "ast_grep", "bash", "powershell"]);

/** Select only old, successful text observations. Recent batches, errors, images and unknown tools remain intact. */
export function prepareToolResultEdits(
	entries: readonly ProjectedSessionEntry[],
	settings: CompactionContentSettings,
	estimate: (message: AgentMessage) => number,
): CompactionToolResultEdit[] {
	if (!settings.pruneToolResults) return [];
	let recentTokens = 0;
	let resultCount = 0;
	let latestToolBatch = -1;
	for (let i = entries.length - 1; i >= 0; i--) {
		if (
			entries[i].messages.some(
				(message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall"),
			)
		) {
			latestToolBatch = i;
			break;
		}
	}
	const edits: CompactionToolResultEdit[] = [];
	for (let i = entries.length - 1; i >= 0; i--) {
		const { sourceEntry, messages } = entries[i];
		const protectedByTokens = recentTokens < settings.protectedRecentTokens;
		for (const message of messages) recentTokens += estimate(message);
		for (const message of messages) {
			if (message.role !== "toolResult") continue;
			resultCount++;
			if (protectedByTokens || resultCount <= settings.protectedToolResults || i >= latestToolBatch) continue;
			if (sourceEntry.type !== "message" || message.isError || !FOLDABLE_TOOLS.has(message.toolName)) continue;
			if (message.content.some((block) => block.type !== "text")) continue;
			const text = contentText(message.content, "\n");
			if (text.startsWith(FOLDED_PREFIX)) continue;
			const prefix = `${FOLDED_PREFIX} original entry ${sourceEntry.id} remains in session history.]\n`;
			const available = Math.max(256, text.length - prefix.length - 1);
			const folded = foldToolResult(message, text, {
				...settings,
				toolResultMaxChars: Math.min(settings.toolResultMaxChars, available),
				toolErrorMaxChars: Math.min(settings.toolErrorMaxChars, available),
			});
			if (folded === text) continue;
			const replacement = `${prefix}${folded}`;
			if (replacement.length >= text.length) continue;
			edits.push({ targetId: sourceEntry.id, toolCallId: message.toolCallId, text: replacement });
		}
	}
	return edits.reverse();
}

/** Only core-generated compactions own this details field; extensions retain control over their own data. */
export function compactionToolResultEdits(entry: CompactionEntry): CompactionToolResultEdit[] {
	if (entry.fromHook || !entry.details || typeof entry.details !== "object" || !("toolResultEdits" in entry.details))
		return [];
	const edits: unknown = entry.details.toolResultEdits;
	if (
		!Array.isArray(edits) ||
		!edits.every(
			(edit: unknown) =>
				typeof edit === "object" &&
				edit !== null &&
				"targetId" in edit &&
				typeof edit.targetId === "string" &&
				"toolCallId" in edit &&
				typeof edit.toolCallId === "string" &&
				"text" in edit &&
				typeof edit.text === "string",
		)
	)
		throw new Error(`Invalid toolResultEdits in compaction ${entry.id}`);
	return edits as CompactionToolResultEdit[];
}
