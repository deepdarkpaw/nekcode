import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { emitSessionShutdownEvent } from "../../src/core/extensions/runner.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { DEFAULT_NEK_CONFIG } from "../../src/extensions/nek/config.ts";
import { createNekExtension } from "../../src/extensions/nek/index.ts";
import { testTool, textResult, untilAborted } from "../durable/support.ts";
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

describe("CLI session reopen without automatic recovery", { timeout: 120_000 }, () => {
	it.each([
		["stream", "partial"],
		["safe-tool", "tool"],
		["unsafe-tool", "tool"],
		["queue", "queued"],
		["compact", "summarizing"],
		["before-settle", "before-settle"],
		["trigger", "custom"],
		["subagent", "child-request"],
	])("opens idle after a process is killed during %s", async (scenario, mark) => {
		const path = sessionPath();
		await killChild(await startChild(path, scenario, mark));
		const toolRuns = vi.fn(async () => textResult("must not replay"));
		const settlement = vi.fn(() => ({ continue: true }));
		const harness = await reopen(path, {
			resumeInterruptedWork: false,
			tools: [testTool("probe_safe", toolRuns, { replay: "safe" }), testTool("probe_unsafe", toolRuns)],
			responses: [fauxAssistantMessage("only after new input")],
			extensionFactories: [
				(pi) => {
					pi.on("agent_before_settle", settlement);
				},
			],
		});
		await harness.session.bindExtensions({ mode: "tui" });
		await withTimeout(harness.session.waitForIdle(), 30_000, "discard interrupted work");

		expect(harness.faux.state.callCount).toBe(0);
		expect(toolRuns).not.toHaveBeenCalled();
		expect(settlement).not.toHaveBeenCalled();
		expect(harness.session.isIdle).toBe(true);
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.isCompacting).toBe(false);
		expect(harness.session.pendingMessageCount).toBe(0);
		expect(harness.eventsOfType("agent_start")).toEqual([]);
		if (scenario === "stream") {
			const partial = harness.session.messages.findLast((message) => message.role === "assistant");
			expect(partial).toMatchObject({ stopReason: "aborted" });
			expect(JSON.stringify(partial?.content)).toContain("word");
		}
		if (scenario === "queue") {
			expect(JSON.stringify(harness.session.messages)).not.toMatch(/steer-1|follow-1/);
		}

		// Cancellation is persisted: even a later SDK open with recovery enabled cannot restart the old work.
		await harness.session.dispose();
		const reopened = await reopen(path, { responses: [fauxAssistantMessage("new response")] });
		await reopened.session.bindExtensions({ mode: "print" });
		await reopened.session.waitForIdle();
		expect(reopened.faux.state.callCount).toBe(0);
		await reopened.session.prompt("new request");
		expect(reopened.faux.state.callCount).toBe(1);
		expect(reopened.session.getLastAssistantText()).toBe("new response");
	});

	it("also remains idle after a clean shutdown during a response", async () => {
		const path = sessionPath();
		const first = await reopen(path, {
			resumeInterruptedWork: false,
			responses: [(_context, options) => untilAborted(options?.signal)],
		});
		const prompt = first.session.prompt("start");
		await vi.waitFor(() => expect(first.faux.state.callCount).toBe(1));
		await first.session.dispose();
		await prompt;

		const reopened = await reopen(path, {
			resumeInterruptedWork: false,
			responses: [fauxAssistantMessage("must not resume")],
		});
		await reopened.session.bindExtensions({ mode: "tui" });
		await reopened.session.waitForIdle();
		expect(reopened.faux.state.callCount).toBe(0);
		expect(reopened.session.isIdle).toBe(true);
		expect(reopened.session.messages.findLast((message) => message.role === "assistant")).toMatchObject({
			stopReason: "aborted",
		});
	});

	it("accepts explicit input after a killed run without first binding extensions", async () => {
		const path = sessionPath();
		await killChild(await startChild(path, "queue", "queued"));
		const harness = await reopen(path, {
			resumeInterruptedWork: false,
			responses: [fauxAssistantMessage("new response")],
		});
		await harness.session.prompt("explicit new input");
		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.session.getLastAssistantText()).toBe("new response");
		expect(JSON.stringify(harness.session.messages)).not.toMatch(/steer-1|follow-1/);
		expect(harness.session.isIdle).toBe(true);
	});

	it("accepts the first prompt and later prompts with recovery disabled", async () => {
		const harness = await reopen(sessionPath(), {
			resumeInterruptedWork: false,
			responses: [fauxAssistantMessage("first"), fauxAssistantMessage("second")],
		});
		await harness.session.prompt("start");
		await harness.session.bindExtensions({ mode: "tui" });
		await harness.session.prompt("next");
		expect(harness.faux.state.callCount).toBe(2);
		expect(harness.session.getLastAssistantText()).toBe("second");
		expect(harness.session.isIdle).toBe(true);
	});
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

	it("reports a run resumed while binding extensions as streaming until it settles", async () => {
		const path = sessionPath();
		await killChild(await startChild(path, "stream", "partial"));
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const harness = await reopen(path, {
			responses: [
				async () => {
					await gate;
					return fauxAssistantMessage("recovered");
				},
			],
		});
		await harness.session.bindExtensions({});
		// The UI shows Working from this: a resumed run announces no turn_start.
		expect(harness.session.isStreaming).toBe(true);
		release();
		await withTimeout(harness.session.waitForIdle(), 30_000, "resumed run");
		expect(harness.session.isStreaming).toBe(false);
		expect(harness.session.getLastAssistantText()).toBe("recovered");
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
		const text = JSON.stringify(result?.role === "toolResult" ? result.content : undefined);
		expect(text).toContain("The probe_unsafe call was interrupted because nekcode stopped");
		expect(text).not.toContain("<harness>");
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
			// Pi's compaction cuts inside the last turn here, so it summarizes the history and the turn prefix.
			responses: [fauxAssistantMessage("recovered summary"), fauxAssistantMessage("recovered prefix")],
		});
		await withTimeout(harness.session.waitForIdle(), 30_000, "compaction reopen");
		expect(harness.session.messages.some((message) => message.role === "compactionSummary")).toBe(true);
	});

	it("reattaches a foreground subagent to its child session after reopen", async () => {
		const path = sessionPath();
		await killChild(await startChild(path, "subagent", "child-request"));
		vi.stubEnv(ENV_AGENT_DIR, join(dirname(path), "agent-home"));
		const childRequests: string[] = [];
		let parentRequests = 0;
		const step: FauxResponseStep = (context) => {
			const serialized = JSON.stringify(context.messages);
			if (serialized.includes("You are currently working inside a subagent.")) {
				childRequests.push(serialized);
				return fauxAssistantMessage("Found the files.");
			}
			parentRequests++;
			return fauxAssistantMessage("parent done");
		};
		const harness = await reopen(path, {
			extensionFactories: [createNekExtension({ role: "root", config: DEFAULT_NEK_CONFIG })],
			responses: Array.from({ length: 4 }, () => step),
		});
		await harness.session.bindExtensions({ mode: "print" });
		await withTimeout(harness.session.waitForIdle(), 30_000, "subagent reopen");

		// The rerun reopened the child the killed run started; its interrupted request was sent again, once.
		expect(readdirSync(join(dirname(path), "subagents")).filter((name) => name.endsWith(".sqlite"))).toHaveLength(1);
		expect(childRequests).toHaveLength(1);
		expect(childRequests[0]?.match(/List the files\./g)).toHaveLength(1);
		const result = harness.session.messages.findLast(
			(message) => message.role === "toolResult" && message.toolName === "subagent",
		);
		expect(JSON.stringify(result?.role === "toolResult" ? result.content : undefined)).toContain("Found the files.");
		expect(parentRequests).toBe(1);
		expect(harness.session.getLastAssistantText()).toBe("parent done");
		// Shutdown disposes the child sessions, as the runtime does on quit.
		await emitSessionShutdownEvent(harness.session.extensionRunner, { type: "session_shutdown", reason: "quit" });
		vi.unstubAllEnvs();
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
