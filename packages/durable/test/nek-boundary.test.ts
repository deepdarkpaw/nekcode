/**
 * nek: boundary hook results (`afterResponse` replacement, `afterTools` and `onYield` entries, `continue: true`, memo
 * pinning), triggered writes, and abort keeping a tool's returned result. The kill tests run a child process that a
 * real SIGKILL stops at the named point.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	type Message,
	Type,
} from "@earendil-works/pi-ai";
import {
	defineTool,
	type EntryId,
	type EntryRecord,
	GenerationTask,
	type Harness,
	MemoryStorage,
	type TaskId,
	ToolTask,
} from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "vitest";
import { LiveDoc } from "../src/harness/live.ts";
import { openNodeSqliteStorage } from "../src/storage/sqlite/node.ts";
import { allEntries, type ChatSetup, chatSetup, openChat, textOf, waitFor } from "./chat-support.ts";
import { addHooks, addTool } from "./harness-support.ts";
import { context } from "./session-support.ts";
import { deferred } from "./task-support.ts";

const directories = new Set<string>();
const children = new Set<ChildProcess>();
afterEach(async () => {
	for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
	children.clear();
	for (const directory of directories) await rm(directory, { recursive: true, force: true });
	directories.clear();
});

const reminder: Message = { role: "user", content: "reminder", timestamp: 1 };
const answer = (text: string): AssistantMessage => fauxAssistantMessage([fauxText(text)]);
const call = (): AssistantMessage =>
	fauxAssistantMessage([fauxToolCall("work", {}, { id: "c1" })], { stopReason: "toolUse" });
const work = defineTool({
	name: "work",
	description: "work",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "worked" }] }),
});

/** Kind and text of each entry, oldest first, without system entries. */
async function transcript(harness: { root: Awaited<ReturnType<typeof openChat>>["root"] }): Promise<string[]> {
	return (await allEntries(harness.root)).flatMap((entry: EntryRecord) =>
		entry.kind === "pi.system" ? [] : [`${entry.kind}:${textOf(entry.model?.at(-1)) ?? ""}`],
	);
}

describe("nek boundary hooks", () => {
	it("classifies and commits an afterResponse replacement, chained in hook order", async () => {
		const setup = chatSetup();
		const seen: string[] = [];
		addHooks(setup.registry, GenerationTask, {
			afterResponse: (message) => ({ message: { ...message, content: [{ type: "text", text: "replaced" }] } }),
		});
		addHooks(setup.registry, GenerationTask, { afterResponse: (message) => void seen.push(textOf(message) ?? "") });
		setup.faux.setResponses([answer("original")]);
		const opened = await openChat(new MemoryStorage(), setup);
		await (await opened.root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(seen).toEqual(["replaced"]);
		expect(await transcript(opened)).toEqual(["pi.user:go", "pi.assistant:replaced"]);
		await opened.harness.close(context);
	});

	it("appends onYield entries after the answer and continues from them with continue: true", async () => {
		const setup = chatSetup();
		let yields = 0;
		addHooks(setup.registry, GenerationTask, {
			onYield: () =>
				yields++ === 0 ? { continue: true, entries: [{ kind: "nek.reminder", model: [reminder] }] } : undefined,
		});
		const requests: string[] = [];
		setup.faux.setResponses([
			answer("first"),
			(request) => {
				requests.push(request.messages.map((message) => message.role).join(","));
				return answer("second");
			},
		]);
		const opened = await openChat(new MemoryStorage(), setup);
		const settled = await (await opened.root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(settled.status).toBe("done");
		expect(await transcript(opened)).toEqual([
			"pi.user:go",
			"pi.assistant:first",
			"nek.reminder:reminder",
			"pi.assistant:second",
		]);
		expect(requests).toEqual(["user,assistant,user"]);
		await opened.harness.close(context);
	});

	it("passes the committed answer to onYield and continues on continue: true as the host decided", async () => {
		const setup = chatSetup();
		const seen: EntryId[] = [];
		addHooks(setup.registry, GenerationTask, {
			onYield: (_message, _api, _context, entry) => {
				seen.push(entry);
				// The host checks that the context can continue; entries without model messages do not stop it.
				return seen.length === 1
					? { continue: true, entries: [{ kind: "nek.label", data: { label: "x" } }] }
					: undefined;
			},
		});
		setup.faux.setResponses([answer("only"), answer("again")]);
		const opened = await openChat(new MemoryStorage(), setup);
		await (await opened.root.submit({ type: "input", content: "go" }, context)).wait(context);
		await opened.harness.waitForIdle(context);
		const kinds = new Map((await allEntries(opened.root)).map((entry: EntryRecord) => [entry.id, entry.kind]));
		expect(seen.map((id) => kinds.get(id))).toEqual(["pi.assistant", "pi.assistant"]);
		expect(await transcript(opened)).toEqual(["pi.user:go", "pi.assistant:only", "nek.label:", "pi.assistant:again"]);
		expect(setup.reports).toEqual([]);
		await opened.harness.close(context);
	});

	it("appends afterTools entries after the round's results, before the next request", async () => {
		const setup = chatSetup();
		addTool(setup.registry, work);
		addHooks(setup.registry, GenerationTask, {
			afterTools: () => ({ entries: [{ kind: "nek.notice", model: [reminder] }] }),
		});
		setup.faux.setResponses([call(), answer("done")]);
		const opened = await openChat(new MemoryStorage(), setup);
		await (await opened.root.submit({ type: "input", content: "go" }, context)).wait(context);
		expect(await transcript(opened)).toEqual([
			"pi.user:go",
			"pi.assistant:",
			"pi.tool-result:worked",
			"nek.notice:reminder",
			"pi.assistant:done",
		]);
		await opened.harness.close(context);
	});
});

describe("nek triggered writes", () => {
	const write = { type: "write", trigger: true, entry: { kind: "nek.message", model: [reminder] } } as const;

	it("places an idle triggered write and starts a run with it in the same commit", async () => {
		const setup = chatSetup();
		setup.faux.setResponses([answer("answered")]);
		const opened = await openChat(new MemoryStorage(), setup);
		const commits: string[][] = [];
		opened.harness.subscribeCommits((publication) => commits.push(publication.changes.map((change) => change.type)));
		const submission = await opened.root.submit(write, context);
		expect((await submission.status(context)).status).toBe("done");
		expect(commits[0]).toEqual(expect.arrayContaining(["entry", "submission", "task"]));
		await opened.harness.waitForIdle(context);
		expect(await transcript(opened)).toEqual(["nek.message:reminder", "pi.assistant:answered"]);
		await opened.harness.close(context);
	});

	it("reports and ignores the trigger of a write that is not model input", async () => {
		const setup = chatSetup();
		const opened = await openChat(new MemoryStorage(), setup);
		await opened.root.submit({ type: "write", trigger: true, entry: { kind: "nek.label", data: {} } }, context);
		await opened.harness.waitForIdle(context);
		expect(await transcript(opened)).toEqual(["nek.label:"]);
		expect(setup.reports.map(String)).toEqual([expect.stringContaining("trigger ignored")]);
		await opened.harness.close(context);
	});

	it("queues a busy triggered write as a plain write", async () => {
		const setup = chatSetup();
		const gate = deferred();
		setup.faux.setResponses([
			async () => {
				await gate.promise;
				return answer("first");
			},
		]);
		const opened = await openChat(new MemoryStorage(), setup);
		const input = await opened.root.submit({ type: "input", content: "go" }, context);
		const queued = await opened.root.submit(write, context);
		expect((await queued.status(context)).status).toBe("queued");
		gate.resolve();
		await input.wait(context);
		await opened.harness.waitForIdle(context);
		expect((await queued.status(context)).status).toBe("done");
		expect(await transcript(opened)).toEqual(["pi.user:go", "pi.assistant:first", "nek.message:reminder"]);
		await opened.harness.close(context);
	});
});

describe("nek tool abort", () => {
	it("settles the result a tool returns after the abort mark, through afterTool", async () => {
		const setup = chatSetup();
		const started = deferred();
		addTool(
			setup.registry,
			defineTool({
				name: "work",
				description: "work",
				parameters: Type.Object({}),
				execute: async (_args, api, callContext) => {
					await api.details({ partial: { lines: 1 } }, callContext);
					started.resolve();
					await new Promise((resolve) => callContext.abortSignal!.addEventListener("abort", resolve));
					return {
						content: [{ type: "text", text: "line 1\n\nCommand aborted" }],
						details: { lines: 1 },
						isError: true,
					};
				},
			}),
		);
		const after: string[] = [];
		addHooks(setup.registry, ToolTask, { afterTool: (_call, result) => void after.push(String(result.isError)) });
		setup.faux.setResponses([call(), answer("done")]);
		const opened = await openChat(new MemoryStorage(), setup);
		const submission = await opened.root.submit({ type: "input", content: "go" }, context);
		await started.promise;
		const taskId = await toolTaskId(opened.harness);
		expect(await opened.harness.abortTask(taskId, context)).toBe("marked");
		expect((await opened.harness.waitForTask(taskId, context)).state.outcome.status).toBe("aborted");
		await submission.wait(context);
		const result = (await allEntries(opened.root)).find((entry) => entry.kind === "pi.tool-result")!.model![0]!;
		expect(result).toMatchObject({
			role: "toolResult",
			content: [{ type: "text", text: "line 1\n\nCommand aborted" }],
			details: { lines: 1 },
			isError: true,
		});
		expect(after).toEqual(["true"]);
		await opened.harness.close(context);
	});
});

async function toolTaskId(harness: Harness): Promise<TaskId> {
	let id: TaskId | undefined;
	await waitFor(async () => {
		id = (await harness.snapshot(LiveDoc, 1 as never, context))?.tools?.[0]?.taskId;
		return id !== undefined;
	});
	return id!;
}

const resolver = pathToFileURL(
	fileURLToPath(new URL("../../coding-agent/src/experimental/source-resolver.ts", import.meta.url)),
).href;
const childScript = fileURLToPath(new URL("./fixtures/nek-boundary-child.ts", import.meta.url));

/** Run the child in `mode` until it reaches its kill point, then SIGKILL it. */
async function killAt(mode: string, path: string): Promise<void> {
	const child = spawn(process.execPath, ["--no-warnings", "--import", resolver, childScript, mode, path], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	children.add(child);
	let output = "";
	const reached = new Promise<void>((resolve, reject) => {
		const read = (chunk: Buffer) => {
			output += chunk.toString();
			if (output.includes("KILL-POINT")) resolve();
		};
		child.stdout.on("data", read);
		child.stderr.on("data", read);
		child.once("exit", () => reject(new Error(`Child exited before its kill point:\n${output}`)));
	});
	await reached;
	const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
	child.kill("SIGKILL");
	await exited;
}

async function sqlitePath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "pi-durable-nek-"));
	directories.add(directory);
	return join(directory, "session.sqlite");
}

async function reopen(path: string, setup: ChatSetup) {
	const opened = await openChat(await openNodeSqliteStorage(path), setup);
	opened.harness.resume();
	return opened;
}

describe("nek boundary kills", { timeout: 60_000 }, () => {
	it("applies a pinned onYield decision after a kill before its consuming commit, without asking again", async () => {
		const path = await sqlitePath();
		await killAt("yield", path);
		const setup = chatSetup();
		let asked = 0;
		addHooks(setup.registry, GenerationTask, {
			onYield: () => {
				asked++;
				return undefined;
			},
		});
		// The answer committed before onYield was asked, so the resumed generation keeps it.
		setup.faux.setResponses([answer("again")]);
		const opened = await reopen(path, setup);
		await opened.harness.waitForIdle(context);
		expect(await transcript(opened)).toEqual([
			"pi.user:go",
			"pi.assistant:first",
			"nek.reminder:reminder",
			"pi.assistant:again",
		]);
		// Only the continued generation asks; the pinned decision was applied as it was.
		expect(asked).toBe(1);
		await opened.harness.close(context);
	});

	it("applies pinned afterTools entries after a kill before the round's closing commit", async () => {
		const path = await sqlitePath();
		await killAt("tools", path);
		const setup = chatSetup();
		addTool(setup.registry, work);
		let asked = 0;
		addHooks(setup.registry, GenerationTask, {
			afterTools: () => {
				asked++;
				return { entries: [{ kind: "nek.notice", model: [{ ...reminder, content: "asked again" }] }] };
			},
		});
		setup.faux.setResponses([answer("done")]);
		const opened = await reopen(path, setup);
		await opened.harness.waitForIdle(context);
		expect(await transcript(opened)).toEqual([
			"pi.user:go",
			"pi.assistant:",
			"pi.tool-result:worked",
			"nek.notice:reminder",
			"pi.assistant:done",
		]);
		expect(asked).toBe(0);
		await opened.harness.close(context);
	});

	it("places a triggered write admitted while busy once, as a plain write, after a kill before placement", async () => {
		const path = await sqlitePath();
		await killAt("trigger-busy", path);
		const setup = chatSetup();
		setup.faux.setResponses([answer("first")]);
		const opened = await reopen(path, setup);
		await opened.harness.waitForIdle(context);
		expect(await transcript(opened)).toEqual(["pi.user:go", "pi.assistant:first", "nek.message:reminder"]);
		await opened.harness.close(context);
	});

	it("resumes the run an idle triggered write started after a kill right after its commit", async () => {
		const path = await sqlitePath();
		await killAt("trigger-idle", path);
		const setup = chatSetup();
		setup.faux.setResponses([answer("answered")]);
		const opened = await reopen(path, setup);
		await opened.harness.waitForIdle(context);
		expect(await transcript(opened)).toEqual(["nek.message:reminder", "pi.assistant:answered"]);
		await opened.harness.close(context);
	});
});
