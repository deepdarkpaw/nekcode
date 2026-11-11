import type { SessionEntry } from "../../../core/session-manager.ts";
import type { SubagentRecord } from "../types.ts";

/** Only persisted runtime records identify a child; model-written tool arguments are not authoritative. */
function readRecord(value: unknown, id: string): SubagentRecord | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Partial<SubagentRecord>;
	if (
		record.id !== id ||
		typeof record.type !== "string" ||
		typeof record.description !== "string" ||
		typeof record.background !== "boolean" ||
		typeof record.startedAt !== "number" ||
		!Number.isFinite(record.startedAt) ||
		!["running", "completed", "errored", "aborted"].includes(record.status ?? "")
	) {
		return undefined;
	}
	return record as SubagentRecord;
}

/** Latest saved child snapshot on this branch, including await/stop results and completion notices. */
export function findBranchSubagentRecord(entries: readonly SessionEntry[], id: string): SubagentRecord | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "toolResult") {
			if (!["subagent", "await", "stop_subagent"].includes(message.toolName)) continue;
		} else if (message.role !== "custom" || message.customType !== "nek.subagent_notice") {
			continue;
		}
		if (typeof message.details !== "object" || message.details === null) continue;
		const details = message.details as { subagent?: unknown; subagents?: unknown; running?: unknown };
		const candidates = [
			details.subagent,
			...(Array.isArray(details.subagents) ? details.subagents : []),
			...(Array.isArray(details.running) ? details.running : []),
		];
		for (const candidate of candidates) {
			const record = readRecord(candidate, id);
			if (record) return record;
		}
	}
	return undefined;
}
