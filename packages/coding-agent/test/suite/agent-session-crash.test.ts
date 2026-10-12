import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { testTool, textResult } from "../durable/support.ts";
import { createHarness, type Harness } from "./harness.ts";

const sourceResolverUrl = pathToFileURL(
	fileURLToPath(new URL("../../src/experimental/source-resolver.ts", import.meta.url)),
).href;
const childScript = fileURLToPath(new URL("./fixtures/agent-session-crash-child.ts", import.meta.url));
const children: ChildProcess[] = [];
const harnesses: Harness[] = [];
const directories: string[] = [];

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function startChild(path: string, scenario: string, mark: string): Promise<ChildProcess> {
	const child = spawn(
		process.execPath,
		["--no-warnings", "--import", sourceResolverUrl, childScript, path, scenario],
		{ stdio: ["ignore", "pipe", "pipe"] },
	);
	children.push(child);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	await withTimeout(
		new Promise<void>((resolve, reject) => {
			child.stdout?.on("data", () => {
				if (stdout.split("\n").includes(`MARK ${mark}`)) resolve();
			});
			child.once("exit", (code, signal) =>
				reject(new Error(`child exited (${code ?? signal}) before ${mark}\n${stdout}\n${stderr}`)),
			);
		}),
		30_000,
		`child ${scenario}/${mark}`,
	);
	return child;
}

async function killChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill("SIGKILL");
	await withTimeout(exited, 10_000, "child exit");
}

function sessionPath(): string {
	const directory = mkdtempSync(join(tmpdir(), "nek-agentsession-crash-"));
	directories.push(directory);
	return join(directory, "session.sqlite");
}

async function reopen(path: string, options: Parameters<typeof createHarness>[0] = {}): Promise<Harness> {
	const harness = await createHarness({
		...options,
		sessionManager: SessionManager.open(path, dirname(path)),
	});
	harnesses.push(harness);
	return harness;
}

function immediateTool(name: string, replay?: "safe" | "never"): AgentTool {
	return testTool(name, async () => textResult(`recovered ${name}`), replay === undefined ? {} : { replay });
}

afterEach(async () => {
	for (const child of children.splice(0)) await killChild(child).catch(() => undefined);
	for (const harness of harnesses.splice(0)) {
		await harness.session.dispose();
		harness.faux.unregister();
		rmSync(harness.tempDir, { recursive: true, force: true });
	}
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("AgentSession crash recovery through SessionManager reopen", { timeout: 120_000 }, () => {
	it("reopens after a mid-stream SIGKILL", async () => {
		const path = sessionPath();
		await killChild(await startChild(path, "stream", "partial"));
		const harness = await reopen(path, { responses: [fauxAssistantMessage("recovered")] });
		await withTimeout(harness.session.waitForIdle(), 30_000, "mid-stream reopen");
		expect(harness.session.messages.filter((message) => message.role === "user")).toHaveLength(1);
		const recovered = harness.session.messages.findLast(
			(message) => message.role === "assistant" && message.stopReason !== "aborted",
		);
		expect(
			recovered?.role === "assistant" ? recovered.content.find((part) => part.type === "text")?.text : undefined,
		).toBe("recovered");
	});

	it("reruns a safe tool after AgentSession reopen", async () => {
		const path = sessionPath();
		await killChild(await startChild(path, "safe-tool", "tool"));
		const harness = await reopen(path, {
			tools: [immediateTool("probe_safe", "safe")],
			responses: [fauxAssistantMessage("done")],
		});
		await withTimeout(harness.session.waitForIdle(), 30_000, "safe-tool reopen");
		expect(
			harness.session.messages.some((message) => message.role === "toolResult" && message.isError === false),
		).toBe(true);
		expect(harness.session.getLastAssistantText()).toBe("done");
	});

	it("records an unsafe interrupted tool after AgentSession reopen", async () => {
		const path = sessionPath();
		await killChild(await startChild(path, "unsafe-tool", "tool"));
		const harness = await reopen(path, {
			tools: [immediateTool("probe_unsafe")],
			responses: [fauxAssistantMessage("done")],
		});
		await withTimeout(harness.session.waitForIdle(), 30_000, "unsafe-tool reopen");
		const result = harness.session.messages.findLast((message) => message.role === "toolResult");
		expect(result?.role === "toolResult" ? result.isError : undefined).toBe(true);
		expect(harness.session.getLastAssistantText()).toBe("done");
	});

	it("reopens queued steer and follow-up inputs in order", async () => {
		const path = sessionPath();
		await killChild(await startChild(path, "queue", "queued"));
		const harness = await reopen(path, {
			responses: [fauxAssistantMessage("ok"), fauxAssistantMessage("ok"), fauxAssistantMessage("ok")],
		});
		await withTimeout(harness.session.waitForIdle(), 30_000, "queue reopen");
		const users = harness.session.messages
			.filter((message) => message.role === "user")
			.map((message) =>
				typeof message.content === "string"
					? message.content
					: message.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
			);
		expect(users).toEqual(["go", "steer-1", "follow-1"]);
	});

	it("reopens a compaction killed during summarization", async () => {
		const path = sessionPath();
		await killChild(await startChild(path, "compact", "summarizing"));
		const harness = await reopen(path, {
			settings: { compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 1000 } },
			responses: [fauxAssistantMessage("recovered summary")],
		});
		await withTimeout(harness.session.waitForIdle(), 30_000, "compaction reopen");
		expect(harness.session.messages.some((message) => message.role === "compactionSummary")).toBe(true);
	});

	it("reruns nek agent_before_settle continuation after reopen", async () => {
		const path = sessionPath();
		await killChild(await startChild(path, "before-settle", "before-settle"));
		// Continue once: a handler that always continues makes pi's loop run forever.
		let continued = false;
		const harness = await reopen(path, {
			responses: [fauxAssistantMessage("continued")],
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", () => {
						if (continued) return;
						continued = true;
						return {
							entries: [
								{
									type: "custom_message",
									customType: "recovered-continuation",
									content: "continue",
									display: false,
								},
							],
							continue: true,
						};
					});
				},
			],
		});
		await withTimeout(harness.session.waitForIdle(), 30_000, "before-settle reopen");
		expect(
			harness.session.messages.some(
				(message) => message.role === "custom" && message.customType === "recovered-continuation",
			),
		).toBe(true);
	});

	it("reopens a triggerTurn custom message without duplicating it", async () => {
		const path = sessionPath();
		await killChild(await startChild(path, "trigger", "custom"));
		const harness = await reopen(path, { responses: [fauxAssistantMessage("triggered response")] });
		await withTimeout(harness.session.waitForIdle(), 30_000, "trigger reopen");
		const custom = harness.session.messages.filter(
			(message) => message.role === "custom" && message.customType === "crash-trigger",
		);
		expect(custom).toHaveLength(1);
		expect(harness.session.getLastAssistantText()).toBe("triggered response");
	});
});
