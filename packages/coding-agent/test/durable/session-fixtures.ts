import { copyFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { JsonlSessionManager } from "../../src/core/session-manager-jsonl.ts";

/** JSONL session fixtures for durable parity tests: the repository fixtures plus synthetic ones covering every entry type. */
export type JsonlFixture = { readonly name: string; readonly path: string };

const FIXTURE_DIR = new URL("../fixtures/", import.meta.url);

/** Every `.jsonl` file under `packages/coding-agent/test`. */
export const REPOSITORY_FIXTURES = ["before-compaction.jsonl", "large-session.jsonl"];

let clock = Date.parse("2026-01-01T00:00:00Z");
function tick(): number {
	clock += 1000;
	return clock;
}

export function assistant(text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "faux",
		provider: "faux",
		model: "faux-1",
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: tick(),
		...extra,
	};
}

function toolCallAssistant(id: string, path: string): AssistantMessage {
	return assistant("", {
		content: [{ type: "toolCall", id, name: "read", arguments: { path } }],
		stopReason: "toolUse",
	});
}

function toolResult(id: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: id,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: tick(),
	};
}

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: tick() };
}

function system(sections: Record<string, string>) {
	return { role: "system" as const, content: "", sections, timestamp: tick() };
}

/** A branched session with every entry type the session manager writes. */
function everyEntryType(dir: string): string {
	const sm = JsonlSessionManager.create("/work/project", dir);
	sm.appendMessage(system({ base: "You are nek." }));
	sm.appendModelChange("faux", "faux-1");
	sm.appendThinkingLevelChange("medium");
	const first = sm.appendMessage(user("first question"));
	sm.appendMessage(toolCallAssistant("call-1", "src/a.ts"));
	sm.appendMessage(toolResult("call-1", "file a"));
	const answer = sm.appendMessage(assistant("first answer"));
	sm.appendLabelChange(first, "start");
	sm.appendCustomEntry("nek-state", { todos: ["one"] });
	sm.appendCustomMessageEntry("nek-note", "hidden note", false, { kind: "note" });
	sm.appendCustomMessageEntry("nek-shown", [{ type: "text", text: "shown note" }], true);
	sm.appendMessage({
		role: "bashExecution",
		command: "ls",
		output: "a.ts",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: tick(),
	});
	sm.appendMessage({
		role: "bashExecution",
		command: "secret",
		output: "x",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		excludeFromContext: true,
		timestamp: tick(),
	});
	sm.appendUsage("cache_warm", "faux", "faux-1", assistant("").usage, "warm");
	sm.appendSessionInfo("Named session");
	const second = sm.appendMessage(user("second question"));
	const editable = sm.appendMessage(assistant("verbose answer"));
	sm.appendContextEdit(editable, { content: "short answer" });
	sm.appendMessage(user("third question"));
	const omitted = sm.appendMessage(assistant("omit me"));
	sm.appendContextEdit(omitted, null);
	sm.appendMessage(assistant("aborted", { stopReason: "aborted" }));
	sm.appendCompaction("## Goal\nSummary one", second, 1234, { readFiles: ["src/a.ts"], modifiedFiles: [] }, false);
	sm.appendMessage(system({ base: "You are nek.", extra: "More." }));
	sm.appendMessage(user("after compaction"));
	sm.appendMessage(assistant("after compaction answer"));
	sm.appendLabelChange(first, undefined);
	sm.appendLabelChange(answer, "answer");

	// A branch from the first answer with a summary, then another branch from the root.
	sm.branchWithSummary(answer, "Abandoned path summary", { files: 1 });
	sm.appendMessage(user("branch question"));
	sm.appendMessage(assistant("branch answer"));
	sm.appendCompaction("Self compaction", null, 99, undefined, true);
	sm.appendMessage(user("after self compaction"));
	sm.branch(first);
	sm.appendMessage(assistant("alternative first answer"));
	sm.resetLeaf();
	sm.appendMessage(user("second root"));
	sm.appendSessionInfo("");
	return sm.getSessionFile()!;
}

/** A linear session whose leaf is in the middle of its last branch point. */
function deepBranches(dir: string): string {
	const sm = JsonlSessionManager.create("/work/project", dir);
	const ids: string[] = [];
	for (let index = 0; index < 6; index++) {
		ids.push(sm.appendMessage(user(`q${index}`)));
		ids.push(sm.appendMessage(assistant(`a${index}`)));
	}
	for (let branch = 0; branch < 4; branch++) {
		sm.branch(ids[branch * 2 + 1]!);
		sm.appendMessage(user(`branch ${branch}`));
		sm.appendMessage(assistant(`branch answer ${branch}`));
		sm.appendLabelChange(ids[branch]!, `label ${branch}`);
	}
	sm.branch(ids[3]!);
	sm.appendMessage(user("last"));
	return sm.getSessionFile()!;
}

/** A session forked from another, with `parentSession` set. */
function forked(dir: string, parent: string): string {
	const sm = JsonlSessionManager.create("/work/project", dir, { parentSession: parent });
	sm.appendMessage(user("forked question"));
	sm.appendMessage(assistant("forked answer"));
	return sm.getSessionFile()!;
}

/** A version 1 session: no ids, an index-based compaction, and a hookMessage role. */
function versionOne(dir: string): string {
	const path = join(dir, "2025-01-01T00-00-00-000Z_v1-session.jsonl");
	const lines = [
		{ type: "session", id: "v1-session", timestamp: "2025-01-01T00:00:00.000Z", cwd: "/work/old" },
		{ type: "message", timestamp: "2025-01-01T00:00:01.000Z", message: user("old question") },
		{ type: "message", timestamp: "2025-01-01T00:00:02.000Z", message: assistant("old answer") },
		{
			type: "message",
			timestamp: "2025-01-01T00:00:03.000Z",
			message: { role: "hookMessage", customType: "hook", content: "hook text", display: true, timestamp: tick() },
		},
		{ type: "message", timestamp: "2025-01-01T00:00:04.000Z", message: user("next") },
		{
			type: "compaction",
			timestamp: "2025-01-01T00:00:05.000Z",
			summary: "Old summary",
			firstKeptEntryIndex: 4,
			tokensBefore: 50,
		},
		{ type: "message", timestamp: "2025-01-01T00:00:06.000Z", message: assistant("after old compaction") },
	];
	writeFileSync(path, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
	return path;
}

/** A version 2 session with a hookMessage role and an unterminated last line. */
function versionTwo(dir: string): string {
	const path = join(dir, "2025-02-01T00-00-00-000Z_v2-session.jsonl");
	const lines = [
		{ type: "session", version: 2, id: "v2-session", timestamp: "2025-02-01T00:00:00.000Z", cwd: "/work/old" },
		{ type: "message", id: "a1", parentId: null, timestamp: "2025-02-01T00:00:01.000Z", message: user("v2 q") },
		{
			type: "message",
			id: "a2",
			parentId: "a1",
			timestamp: "2025-02-01T00:00:02.000Z",
			message: { role: "hookMessage", customType: "hook", content: "hook", display: false, timestamp: tick() },
		},
		{ type: "message", id: "a3", parentId: "a2", timestamp: "2025-02-01T00:00:03.000Z", message: assistant("v2 a") },
	];
	writeFileSync(path, lines.map((line) => JSON.stringify(line)).join("\n"));
	return path;
}

/** Copy the repository fixtures and generate the synthetic ones into `dir`. */
export function writeFixtures(dir: string): JsonlFixture[] {
	const fixtures: JsonlFixture[] = REPOSITORY_FIXTURES.map((name) => {
		const path = join(dir, name);
		copyFileSync(new URL(name, FIXTURE_DIR), path);
		return { name, path };
	});
	const every = everyEntryType(dir);
	fixtures.push({ name: "synthetic: every entry type", path: every });
	fixtures.push({ name: "synthetic: deep branches", path: deepBranches(dir) });
	fixtures.push({ name: "synthetic: forked (parentSession)", path: forked(dir, every) });
	fixtures.push({ name: "synthetic: version 1", path: versionOne(dir) });
	fixtures.push({ name: "synthetic: version 2, unterminated", path: versionTwo(dir) });
	return fixtures.map((fixture) => ({ ...fixture, name: `${fixture.name} (${basename(fixture.path)})` }));
}
