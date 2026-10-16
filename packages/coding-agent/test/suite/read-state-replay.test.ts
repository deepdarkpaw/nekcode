import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../../src/core/agent-session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { DEFAULT_CUSTOM_TOOL_NAMES } from "../../src/extensions/nek/services/agent-types.ts";
import { type ChildSessionSpec, createChildSession } from "../../src/extensions/nek/services/child-session.ts";
import { createHarness, type Harness } from "./harness.ts";

function toolResults(harness: Harness, toolName: string) {
	return harness.session.messages.filter(
		(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === toolName,
	);
}

describe("read state replay in sessions", () => {
	const harnesses: Harness[] = [];
	const children: AgentSession[] = [];
	const directories: string[] = [];

	afterEach(async () => {
		for (const child of children.splice(0)) await child.dispose();
		for (const harness of harnesses.splice(0)) {
			await harness.session.dispose();
			harness.cleanup();
		}
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("restores a read on reopen so write succeeds", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "read-replay-suite-"));
		const sessionDir = join(cwd, "sessions");
		directories.push(cwd);
		const path = join(cwd, "target.txt");
		writeFileSync(path, "before\n");
		const firstManager = SessionManager.create(cwd, sessionDir);
		const first = await createHarness({
			sessionManager: firstManager,
			responses: [
				fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" }),
				fauxAssistantMessage("read complete"),
			],
		});
		harnesses.push(first);
		await first.session.prompt("inspect the file");
		const sessionFile = first.session.sessionFile;
		expect(sessionFile).toBeDefined();
		await first.session.dispose();

		let startupWriteSucceeded = false;
		const reopened: Harness = await createHarness({
			sessionManager: SessionManager.open(sessionFile!),
			extensionFactories: [
				(pi) => {
					pi.on("session_start", async () => {
						const tool = reopened.session.agent.state.tools.find((tool) => tool.name === "write")!;
						await tool.execute("startup-write", { path, content: "startup write\n" });
						startupWriteSucceeded = true;
					});
				},
			],
			responses: [
				fauxAssistantMessage([fauxToolCall("write", { path, content: "after\n" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("write complete"),
			],
		});
		harnesses.push(reopened);
		await reopened.session.bindExtensions({ mode: "print" });
		expect(startupWriteSucceeded).toBe(true);
		await reopened.session.prompt("overwrite the file");

		const [writeResult] = toolResults(reopened, "write");
		expect(writeResult?.isError).toBe(false);
	});

	it("reopens a child with its own reads but not its parent's reads", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "read-replay-child-"));
		directories.push(cwd);
		const parent = await createHarness({ sessionManager: SessionManager.create(cwd, join(cwd, "sessions")) });
		harnesses.push(parent);
		const parentPath = join(parent.tempDir, "parent-only.txt");
		const childPath = join(parent.tempDir, "child-only.txt");
		writeFileSync(parentPath, "parent\n");
		writeFileSync(childPath, "child\n");
		parent.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: parentPath })], { stopReason: "toolUse" }),
			fauxAssistantMessage("parent read complete"),
		]);
		await parent.session.prompt("read the parent file");
		const spec: ChildSessionSpec = {
			parentCtx: parent.session.extensionRunner.createContext(),
			type: {
				name: "worker",
				description: "Writable test worker",
				source: "user",
				readonly: false,
				background: false,
				autonomous: false,
				tools: [...DEFAULT_CUSTOM_TOOL_NAMES],
				disallowedTools: [],
			},
			model: parent.getModel(),
			thinkingLevel: "off",
			forceReadonly: false,
			agentDir: join(parent.tempDir, "agent-home"),
			extension: () => {},
		};
		const firstChild = await createChildSession(spec);
		children.push(firstChild);
		parent.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: childPath })], { stopReason: "toolUse" }),
			fauxAssistantMessage("child read complete"),
		]);
		await firstChild.prompt("read the child file");
		const resumeFile = firstChild.sessionFile;
		expect(resumeFile).toBeDefined();
		await firstChild.dispose();

		const reopenedChild = await createChildSession({ ...spec, resumeFile, model: undefined });
		children.push(reopenedChild);
		parent.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path: childPath, content: "child updated\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("child write complete"),
			fauxAssistantMessage([fauxToolCall("write", { path: parentPath, content: "not authorized\n" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("parent write rejected"),
		]);
		await reopenedChild.prompt("overwrite the child's file");
		await reopenedChild.prompt("overwrite the parent's file");
		const writes = reopenedChild.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "write",
		);
		expect(writes.map((result) => result.isError)).toEqual([false, true]);
		expect(JSON.stringify(writes[1]?.content)).toContain("File has not been read yet");
	});

	it("drops read authorization after navigating to a branch without the read", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "read-replay-tree-"));
		directories.push(cwd);
		const path = join(cwd, "target.txt");
		writeFileSync(path, "before\n");
		const harness = await createHarness({
			sessionManager: SessionManager.create(cwd, join(cwd, "sessions")),
			responses: [
				fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" }),
				fauxAssistantMessage("read complete"),
			],
		});
		harnesses.push(harness);
		await harness.session.prompt("inspect the file");
		const userEntry = harness.sessionManager
			.getBranch()
			.find((entry) => entry.type === "message" && entry.message.role === "user");
		expect(userEntry).toBeDefined();
		await harness.session.navigateTree(userEntry!.id);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("write", { path, content: "after\n" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("write rejected"),
		]);

		await harness.session.prompt("overwrite without reading");

		const [writeResult] = toolResults(harness, "write");
		expect(writeResult?.isError).toBe(true);
		expect(JSON.stringify(writeResult?.content)).toContain("File has not been read yet");
	});
});
