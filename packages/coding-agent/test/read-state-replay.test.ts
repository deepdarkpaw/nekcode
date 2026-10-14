import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	type ToolCall,
	type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type SessionEntry, SessionManager } from "../src/core/session-manager.ts";
import { createReadStateStore } from "../src/core/tools/read-state.ts";
import { restoreReadState } from "../src/core/tools/read-state-replay.ts";

function messageEntry(id: string, message: AssistantMessage | ToolResultMessage): SessionEntry {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: new Date().toISOString(),
		message,
	};
}

function call(id: string, name: string, argumentsValue: ToolCall["arguments"]): ToolCall {
	return { type: "toolCall", id, name, arguments: argumentsValue };
}

function assistantEntry(id: string, toolCall: ToolCall): SessionEntry {
	return messageEntry(id, fauxAssistantMessage([toolCall], { stopReason: "toolUse" }));
}

function readResult(toolCallId: string, timestamp: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "read",
		content: [{ type: "text", text: "read output" }],
		isError: false,
		timestamp,
	};
}

describe("read state replay", () => {
	const directories: string[] = [];

	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("uses the latest successful evidence and preserves ranged read metadata", async () => {
		const directory = mkdtempSync(join(tmpdir(), "read-replay-"));
		directories.push(directory);
		const path = join(directory, "latest.txt");
		writeFileSync(path, "one\ntwo\nthree\n");
		const timestamp = Math.ceil(statSync(path).mtimeMs) + 1000;
		const branch: SessionEntry[] = [
			assistantEntry("call-1", call("call-1", "read", { path, offset: 1, limit: 1 })),
			messageEntry("result-1", readResult("call-1", timestamp)),
			assistantEntry("call-2", call("call-2", "read", { path, offset: 2, limit: 2 })),
			messageEntry("result-2", readResult("call-2", timestamp + 1)),
			assistantEntry("call-3", call("call-3", "read", { path, offset: 1, limit: 1 })),
			messageEntry("result-3", readResult("call-3", timestamp)),
			assistantEntry("call-4", call("call-4", "read", { path })),
			messageEntry("result-4", { ...readResult("call-4", timestamp + 2), isError: true }),
		];
		const store = createReadStateStore();

		await restoreReadState(store, branch, directory);

		expect(store.get(path)).toMatchObject({ timestamp: timestamp + 1, offset: 2, limit: 2 });
	});

	it("ignores failed and unmatched calls", async () => {
		const directory = mkdtempSync(join(tmpdir(), "read-replay-"));
		directories.push(directory);
		const path = join(directory, "failed.txt");
		writeFileSync(path, "content\n");
		const store = createReadStateStore();
		store.set(path, { content: "old", timestamp: 1, offset: undefined, limit: undefined });

		await restoreReadState(
			store,
			[
				assistantEntry("failed-call", call("failed-call", "read", { path })),
				messageEntry("failed-result", { ...readResult("failed-call", Date.now()), isError: true }),
				messageEntry("unmatched-result", readResult("missing-call", Date.now())),
			],
			directory,
		);

		expect(store.get(path)).toBeUndefined();
	});

	it("skips evidence when the file is newer or deleted", async () => {
		const directory = mkdtempSync(join(tmpdir(), "read-replay-"));
		directories.push(directory);
		const newerPath = join(directory, "newer.txt");
		const deletedPath = join(directory, "deleted.txt");
		writeFileSync(newerPath, "newer\n");
		writeFileSync(deletedPath, "deleted\n");
		rmSync(deletedPath);
		const oldTimestamp = Math.floor(statSync(newerPath).mtimeMs) - 1000;
		utimesSync(newerPath, new Date(), new Date(oldTimestamp + 5000));
		const store = createReadStateStore();

		await restoreReadState(
			store,
			[
				assistantEntry("newer-call", call("newer-call", "read", { path: newerPath })),
				messageEntry("newer-result", readResult("newer-call", oldTimestamp)),
				assistantEntry("deleted-call", call("deleted-call", "read", { path: deletedPath })),
				messageEntry("deleted-result", readResult("deleted-call", Date.now() + 1000)),
			],
			directory,
		);

		expect(store.get(newerPath)).toBeUndefined();
		expect(store.get(deletedPath)).toBeUndefined();
	});

	it.each(["edit", "write", "bash", "powershell"])("restores successful %s evidence", async (name) => {
		const directory = mkdtempSync(join(tmpdir(), "read-replay-"));
		directories.push(directory);
		const path = join(directory, "target.txt");
		writeFileSync(path, "content\n");
		const timestamp = Math.ceil(statSync(path).mtimeMs) + 1000;
		const args: ToolCall["arguments"] =
			name === "edit" ? { file_path: path } : name === "write" ? { path } : { command: "cat target.txt" };
		const store = createReadStateStore();
		await restoreReadState(
			store,
			[
				assistantEntry("call", call("call", name, args)),
				messageEntry("result", {
					...readResult("call", timestamp),
					toolName: name,
					...(name === "bash" || name === "powershell"
						? { details: { readState: { path, offset: 1, limit: 2 } } }
						: {}),
				}),
			],
			directory,
		);
		expect(store.get(path)?.timestamp).toBe(timestamp);
	});

	it("does not restore image reads or shell results without read evidence", async () => {
		const directory = mkdtempSync(join(tmpdir(), "read-replay-"));
		directories.push(directory);
		const path = join(directory, "target.txt");
		writeFileSync(path, "content\n");
		const timestamp = Math.ceil(statSync(path).mtimeMs) + 1000;
		const store = createReadStateStore();
		await restoreReadState(
			store,
			[
				assistantEntry("image", call("image", "read", { path })),
				messageEntry("image-result", {
					...readResult("image", timestamp),
					content: [{ type: "text", text: "Read image file [image/png]" }],
				}),
				assistantEntry("shell", call("shell", "bash", { command: "cat target.txt" })),
				messageEntry("shell-result", { ...readResult("shell", timestamp), toolName: "bash" }),
			],
			directory,
		);
		expect(store.get(path)).toBeUndefined();
	});

	it("keeps replay bounded and includes pre-compaction history", async () => {
		const directory = mkdtempSync(join(tmpdir(), "read-replay-"));
		directories.push(directory);
		const manager = SessionManager.inMemory(directory);
		const paths = ["one", "two", "three"].map((name) => join(directory, `${name}.txt`));
		for (const [index, path] of paths.entries()) {
			writeFileSync(path, "content\n");
			manager.appendMessage(
				fauxAssistantMessage([call(`call-${index}`, "read", { path })], { stopReason: "toolUse" }),
			);
			manager.appendMessage(readResult(`call-${index}`, Math.ceil(statSync(path).mtimeMs) + 1000 + index));
		}
		manager.appendCompaction("summary", manager.getLeafId(), 100);
		const store = createReadStateStore(2);
		await restoreReadState(store, manager.getBranch(), directory);
		expect(store.get(paths[0]!)).toBeUndefined();
		expect(store.get(paths[1]!)).toBeDefined();
		expect(store.get(paths[2]!)).toBeDefined();
	});

	it("clears abandoned-branch evidence before rebuilding", async () => {
		const directory = mkdtempSync(join(tmpdir(), "read-replay-"));
		directories.push(directory);
		const path = join(directory, "abandoned.txt");
		writeFileSync(path, "content\n");
		const store = createReadStateStore();
		store.set(path, { content: "old", timestamp: Date.now(), offset: undefined, limit: undefined });

		await restoreReadState(store, [], directory);

		expect(store.get(path)).toBeUndefined();
	});
});
