import { type ChildProcess, spawn } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type FauxResponseStep, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { CompactionEntry } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import type { DurableEngine } from "../../src/core/durable/engine.ts";
import { CompactionDetailsDoc } from "../../src/core/durable/entries.ts";
import { SessionLockedError } from "../../src/core/durable/lock.ts";
import {
	type DurableTestSetup,
	duplicateEntries,
	durableSetup,
	modelOf,
	openEngine,
	tempDir,
	testTool,
	textOf,
	textResult,
} from "./support.ts";

const sourceResolverUrl = pathToFileURL(
	fileURLToPath(new URL("../../src/experimental/source-resolver.ts", import.meta.url)),
).href;
const childScript = fileURLToPath(new URL("./fixtures/crash-child.ts", import.meta.url));

const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Start the child on `path` and resolve once it printed `MARK <mark>`. */
async function startChild(path: string, scenario: string, wanted: string): Promise<ChildProcess> {
	const child = spawn(
		process.execPath,
		["--no-warnings", "--import", sourceResolverUrl, childScript, path, scenario],
		{
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	cleanups.push(() => {
		if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	});
	let stdout = "";
	let stderr = "";
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	await new Promise<void>((resolve, reject) => {
		child.stdout?.on("data", (chunk: Buffer) => {
			stdout += chunk.toString();
			if (stdout.split("\n").includes(`MARK ${wanted}`)) resolve();
		});
		child.on("exit", (code, signal) =>
			reject(new Error(`Child exited (${code ?? signal}) before ${wanted}\n${stdout}\n${stderr}`)),
		);
	});
	return child;
}

/** Kill the child the way a crash would, and wait until it is gone. */
async function crash(child: ChildProcess): Promise<void> {
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill("SIGKILL");
	await exited;
}

async function reopen(setup: DurableTestSetup, path: string, tools = parentTools()): Promise<DurableEngine> {
	const engine = await openEngine(setup, path, { model: undefined, tools });
	cleanups.push(() => engine.close());
	return engine;
}

/** The child's tools, answering at once in the parent; `runs` counts executions per tool. */
function parentTools(runs: Record<string, number> = {}) {
	return ["probe_safe", "probe_unsafe"].map((name) =>
		testTool(
			name,
			async () => {
				runs[name] = (runs[name] ?? 0) + 1;
				return textResult(`rerun ${name}`);
			},
			name === "probe_safe" ? { replay: "safe" } : {},
		),
	);
}

/** Wait until no task is live, background compactions included. */
async function settle(engine: DurableEngine): Promise<void> {
	await engine.waitForIdle();
	const deadline = Date.now() + 30_000;
	while ((await engine.harness.inspect(BACKGROUND_CONTEXT)).tasks.length > 0) {
		if (Date.now() > deadline) throw new Error("Tasks did not settle");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	await engine.waitForIdle();
}

function answering(text: string): FauxResponseStep[] {
	return Array.from({ length: 8 }, () => fauxAssistantMessage(text));
}

function sessionPath(): string {
	const { dir, cleanup } = tempDir("nek-durable-crash-");
	cleanups.push(cleanup);
	return join(dir, "session.sqlite");
}

describe("DurableEngine crash recovery (child process killed)", { timeout: 120_000 }, () => {
	it("restarts a request killed mid-stream after a committed partial", async () => {
		const path = sessionPath();
		await crash(await startChild(path, "stream", "partial"));

		const setup = durableSetup();
		setup.faux.setResponses(answering("done"));
		const engine = await reopen(setup, path);
		await settle(engine);

		const entries = await engine.entries();
		const messages = entries.map(modelOf);
		expect(messages.map((message) => message?.role)).toEqual(["system", "user", "assistant", "assistant"]);
		const [partial, answer] = messages.slice(2);
		expect(partial?.role === "assistant" ? partial.stopReason : undefined).toBe("aborted");
		expect(textOf(partial)?.startsWith("word")).toBe(true);
		expect(answer?.role === "assistant" ? answer.stopReason : undefined).toBe("stop");
		expect(textOf(answer)).toBe("done");
		// The aborted partial stays out of model context.
		expect((await engine.messages()).map((message) => message.role)).toEqual(["system", "user", "assistant"]);
		expect(duplicateEntries(entries)).toEqual([]);
		expect(setup.faux.state.callCount).toBe(1);
	});

	it("reruns a replay-safe tool killed mid-execution", async () => {
		const path = sessionPath();
		await crash(await startChild(path, "safe-tool", "tool"));

		const setup = durableSetup();
		setup.faux.setResponses(answering("done"));
		const runs: Record<string, number> = {};
		const engine = await reopen(setup, path, parentTools(runs));
		await settle(engine);

		const entries = await engine.entries();
		const result = entries.map(modelOf).find((message) => message?.role === "toolResult");
		expect(runs).toEqual({ probe_safe: 1 });
		expect(textOf(result)).toBe("rerun probe_safe");
		expect(textOf(modelOf(entries[entries.length - 1]!))).toBe("done");
		expect(duplicateEntries(entries)).toEqual([]);
	});

	it("answers an unsafe tool killed mid-execution as interrupted and continues the turn", async () => {
		const path = sessionPath();
		await crash(await startChild(path, "unsafe-tool", "tool"));

		const setup = durableSetup();
		setup.faux.setResponses(answering("done"));
		const runs: Record<string, number> = {};
		const engine = await reopen(setup, path, parentTools(runs));
		await settle(engine);

		const entries = await engine.entries();
		const result = entries.map(modelOf).find((message) => message?.role === "toolResult");
		expect(runs).toEqual({});
		expect(result?.role === "toolResult" ? result.isError : undefined).toBe(true);
		expect(textOf(result)).toMatch(/interrupted/i);
		expect(textOf(modelOf(entries[entries.length - 1]!))).toBe("done");
		expect(duplicateEntries(entries)).toEqual([]);
	});

	it("keeps a queued steer and follow-up, in order", async () => {
		const path = sessionPath();
		await crash(await startChild(path, "queue", "queued"));

		const setup = durableSetup();
		setup.faux.setResponses(answering("ok"));
		const engine = await reopen(setup, path);
		await settle(engine);

		const entries = await engine.entries();
		const inputs = entries
			.map(modelOf)
			.filter((message) => message?.role === "user")
			.map(textOf);
		expect(inputs).toEqual(["go", "steer-1", "follow-1"]);
		const last = modelOf(entries[entries.length - 1]!);
		expect(last?.role === "assistant" ? last.stopReason : undefined).toBe("stop");
		expect(await engine.queued()).toEqual({ steering: [], followUp: [] });
		expect(duplicateEntries(entries)).toEqual([]);
	});

	it("finishes a compaction killed while summarizing", async () => {
		const path = sessionPath();
		await crash(await startChild(path, "compact", "summarizing"));

		const setup = durableSetup({
			settings: { compaction: { enabled: false, reserveTokens: 1000, keepRecentTokens: 1 } },
		});
		setup.faux.setResponses([fauxAssistantMessage("## Goal\nRecovered summary")]);
		const engine = await reopen(setup, path);
		await settle(engine);

		const entries = await engine.entries();
		const summaries = entries.filter((entry) => CompactionEntry.is(entry));
		expect(summaries).toHaveLength(1);
		const records = await engine.harness.snapshot(CompactionDetailsDoc, engine.conversationId, BACKGROUND_CONTEXT);
		expect(records?.records).toHaveLength(1);
		const messages = await engine.messages();
		expect(messages[0]?.role).toBe("compactionSummary");
		expect(messages[0]?.role === "compactionSummary" ? messages[0].summary : undefined).toContain(
			"Recovered summary",
		);
		expect(duplicateEntries(entries)).toEqual([]);
	});
});

describe("DurableEngine session lock", { timeout: 60_000 }, () => {
	it("rejects a second process while the owner lives and reclaims the lock after it is killed", async () => {
		const path = sessionPath();
		const child = await startChild(path, "lock", "open");

		const setup = durableSetup();
		await expect(openEngine(setup, path)).rejects.toBeInstanceOf(SessionLockedError);

		await crash(child);
		const engine = await reopen(setup, path);
		expect(engine.conversationId).toBeDefined();
	});
});
