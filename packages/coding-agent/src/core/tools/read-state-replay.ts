import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "../session-manager.ts";
import { resolveReadPathAsync, resolveToCwd } from "./path-utils.ts";
import { type ReadStateStore, readStateKey } from "./read-state.ts";

interface ReadEvidence {
	path: string;
	timestamp: number;
	offset: number | undefined;
	limit: number | undefined;
}

async function evidenceFor(call: ToolCall, result: ToolResultMessage, cwd: string): Promise<ReadEvidence | undefined> {
	const args = call.arguments;
	let path: string;
	let offset: number | undefined;
	let limit: number | undefined;
	if (call.name === "read") {
		// Image reads never update the live store, including image reads returned as a text-only note.
		if (
			result.content.some(
				(block) => block.type === "image" || (block.type === "text" && block.text.startsWith("Read image file [")),
			)
		)
			return undefined;
		if (typeof args.path !== "string") return undefined;
		path = await resolveReadPathAsync(args.path, cwd);
		offset = typeof args.offset === "number" ? args.offset : undefined;
		limit = typeof args.limit === "number" ? args.limit : undefined;
	} else if (call.name === "edit" || call.name === "write") {
		const argument = call.name === "edit" ? args.file_path : args.path;
		if (typeof argument !== "string") return undefined;
		path = resolveToCwd(argument, cwd);
	} else if (call.name === "bash" || call.name === "powershell") {
		const details = result.details;
		if (details === null || typeof details !== "object" || Array.isArray(details)) return undefined;
		const read = (details as { readState?: unknown }).readState;
		if (read === null || typeof read !== "object" || Array.isArray(read)) return undefined;
		const evidence = read as { path?: unknown; offset?: unknown; limit?: unknown };
		if (typeof evidence.path !== "string" || !isAbsolute(evidence.path)) return undefined;
		path = evidence.path;
		offset = typeof evidence.offset === "number" ? evidence.offset : undefined;
		limit = typeof evidence.limit === "number" ? evidence.limit : undefined;
	} else {
		return undefined;
	}
	return { path: readStateKey(path), timestamp: result.timestamp, offset, limit };
}

/**
 * Rebuild only from successful call/result pairs on the current branch, including history before compaction.
 * Validation here affects restoration only: a live read continues to authorize write even if the file changes.
 * Content is not needed by write's prior-read check, so replay retains small evidence records rather than file bytes.
 */
export async function restoreReadState(
	store: ReadStateStore,
	branch: readonly SessionEntry[],
	cwd: string,
): Promise<void> {
	store.clear();
	const calls = new Map<string, ToolCall>();
	const latest = new Map<string, ReadEvidence>();
	for (const entry of branch) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role === "assistant") {
			for (const block of message.content) {
				if (block.type === "toolCall") calls.set(block.id, block);
			}
			continue;
		}
		if (message.role !== "toolResult") continue;
		const call = calls.get(message.toolCallId);
		calls.delete(message.toolCallId);
		if (
			call === undefined ||
			call.name !== message.toolName ||
			message.isError !== false ||
			!Number.isFinite(message.timestamp)
		)
			continue;
		const evidence = await evidenceFor(call, message, cwd);
		if (evidence === undefined) continue;
		const previous = latest.get(evidence.path);
		if (previous !== undefined && previous.timestamp > evidence.timestamp) continue;
		latest.delete(evidence.path);
		latest.set(evidence.path, evidence);
	}
	for (const evidence of [...latest.values()].sort((left, right) => left.timestamp - right.timestamp)) {
		try {
			const current = await stat(evidence.path);
			if (!current.isFile() || current.mtimeMs > evidence.timestamp) continue;
		} catch (error) {
			if (
				typeof error === "object" &&
				error !== null &&
				"code" in error &&
				(error.code === "ENOENT" || error.code === "ENOTDIR")
			)
				continue;
			throw error;
		}
		store.set(evidence.path, {
			content: "",
			timestamp: evidence.timestamp,
			offset: evidence.offset,
			limit: evidence.limit,
		});
	}
}
