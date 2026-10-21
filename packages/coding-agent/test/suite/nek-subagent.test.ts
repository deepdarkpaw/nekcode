import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	type JsonObject,
	type Message,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import type { AgentSession } from "../../src/core/agent-session.ts";
import type { ToolCallMemo, ToolCallMemoValue } from "../../src/core/extensions/types.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { DEFAULT_NEK_CONFIG, type NekConfig } from "../../src/extensions/nek/config.ts";
import { createNekExtension } from "../../src/extensions/nek/index.ts";
import { BUILTIN_AGENT_TYPES, READ_ONLY_TOOL_NAMES } from "../../src/extensions/nek/services/agent-types.ts";
import * as childSession from "../../src/extensions/nek/services/child-session.ts";
import { SubagentRegistry } from "../../src/extensions/nek/services/subagent-registry.ts";
import { createSubagentToolDefinition } from "../../src/extensions/nek/tools/subagent.ts";
import type { SubagentRecord, SubagentToolData } from "../../src/extensions/nek/types.ts";
import { createHarness, getMessageText, type Harness, type HarnessOptions } from "./harness.ts";

type Reply = (
	context: { messages: Message[] },
	options?: SimpleStreamOptions,
) => AssistantMessage | Promise<AssistantMessage>;

/**
 * Parent and children share one faux provider (the child reuses the parent's ModelRuntime). Every request is routed
 * by whether its context carries the Cursor subagent reminder, so interleaved parent and child calls stay ordered.
 */
interface Router {
	parent: Reply[];
	child: Reply[];
	parentRequests: string[];
	childRequests: Message[][];
	childModels: string[];
	childThinking: SimpleStreamOptions["reasoning"][];
}

const SUBAGENT_MARKER = "You are currently working inside a subagent.";

function reply(message: AssistantMessage): Reply {
	return () => message;
}

function toolCall(name: string, args: JsonObject): AssistantMessage {
	return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

function subagentCall(args: JsonObject): AssistantMessage {
	return toolCall("subagent", { description: "Map files", prompt: "List the files and report them.", ...args });
}

function createRouter(harness: Harness): Router {
	const router: Router = {
		parent: [],
		child: [],
		parentRequests: [],
		childRequests: [],
		childModels: [],
		childThinking: [],
	};
	const step: FauxResponseStep = async (context, options, _state, model) => {
		const serialized = JSON.stringify(context.messages);
		const isChild = serialized.includes(SUBAGENT_MARKER);
		if (isChild) {
			router.childRequests.push(context.messages);
			router.childModels.push(`${model.provider}/${model.id}`);
			router.childThinking.push(options?.reasoning);
		} else router.parentRequests.push(serialized);
		const next = (isChild ? router.child : router.parent).shift();
		if (!next) throw new Error(`No ${isChild ? "child" : "parent"} reply queued`);
		return next(context, options);
	};
	harness.setResponses(Array.from({ length: 40 }, () => step));
	return router;
}

/** Tool names a request declared through its system messages. */
function requestToolNames(messages: Message[]): string[] {
	const names = new Set<string>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsAdded ?? []) names.add(tool.name);
		for (const tool of message.toolsRemoved ?? []) names.delete(tool.name);
	}
	return [...names].sort();
}

/** The subagent record stored in a subagent tool result. */
function subagentDetails(result: { details?: unknown }): SubagentToolData["subagent"] {
	const details = result.details as SubagentToolData | undefined;
	if (!details) throw new Error("subagent result without details");
	return details.subagent;
}

function toolResults(harness: Harness, toolName: string) {
	return harness.session.messages.flatMap((message) =>
		message.role === "toolResult" && message.toolName === toolName ? [message] : [],
	);
}

function subagentNotices(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === "nek.subagent_notice",
	);
}

interface Gate {
	promise: Promise<void>;
	open: () => void;
}

/** A reply held until its request is aborted; `onAbort` runs when the abort arrives. */
function abortableReply(onAbort: () => void = () => {}): Reply {
	return (_context, options) =>
		new Promise((resolve) => {
			const abort = () => {
				onAbort();
				resolve(fauxAssistantMessage("late"));
			};
			if (options?.signal?.aborted) abort();
			else options?.signal?.addEventListener("abort", abort, { once: true });
		});
}

function createGate(): Gate {
	let open = () => {};
	const promise = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { promise, open };
}

describe("nek subagents", () => {
	const harnesses: Harness[] = [];
	const childSessions: AgentSession[] = [];
	const registries: SubagentRegistry[] = [];
	const sessionDirs: string[] = [];

	afterEach(async () => {
		while (childSessions.length > 0) await childSessions.pop()?.dispose();
		while (registries.length > 0) await registries.pop()?.disposeAll();
		vi.restoreAllMocks();
		while (harnesses.length > 0) {
			const harness = harnesses.pop()!;
			await harness.session.dispose();
			harness.cleanup();
		}
		while (sessionDirs.length > 0) rmSync(sessionDirs.pop()!, { recursive: true, force: true });
	});

	async function createNekHarness(
		options: HarnessOptions = {},
		agentFiles: Record<string, string> = {},
		config: NekConfig = DEFAULT_NEK_CONFIG,
	): Promise<{ harness: Harness; router: Router }> {
		const harness = await createHarness({
			...options,
			extensionFactories: [createNekExtension({ role: "root", config }), ...(options.extensionFactories ?? [])],
		});
		harnesses.push(harness);
		const agentDir = join(harness.tempDir, "agent-home");
		mkdirSync(join(agentDir, "agents"), { recursive: true });
		for (const [name, content] of Object.entries(agentFiles)) {
			writeFileSync(join(agentDir, "agents", name), content);
		}
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		await harness.session.bindExtensions({ mode: "print" });
		return { harness, router: createRouter(harness) };
	}

	async function createModelHarness(
		presetModel = "faux/preset",
		options: HarnessOptions = {},
		config: NekConfig = DEFAULT_NEK_CONFIG,
	): Promise<{ harness: Harness; router: Router }> {
		const agentFiles = Object.fromEntries(
			["preset-worker", "preset-explorer"].map((name) => [
				`${name}.md`,
				`---\nname: ${name}\ndescription: Preset worker\nmodel: ${presetModel}\nthinking: high\n---\nReport findings.\n`,
			]),
		);
		return createNekHarness(
			{
				models: [
					{ id: "parent", reasoning: true },
					{ id: "preset", reasoning: true },
				],
				...options,
			},
			agentFiles,
			config,
		);
	}

	async function createPersistentModelHarness(presetModel = "faux/preset", options: HarnessOptions = {}) {
		const sessionDir = mkdtempSync(join(tmpdir(), "nek-subagent-model-"));
		sessionDirs.push(sessionDir);
		const sessionManager = SessionManager.create(sessionDir, sessionDir);
		const createChildSession = childSession.createChildSession;
		const create = vi.spyOn(childSession, "createChildSession").mockImplementation(async (spec) => {
			const session = await createChildSession(spec);
			childSessions.push(session);
			return session;
		});
		const start = vi.spyOn(SubagentRegistry.prototype, "start");
		const { harness, router } = await createModelHarness(
			presetModel,
			{ ...options, sessionManager },
			{ ...DEFAULT_NEK_CONFIG, subagent: { ...DEFAULT_NEK_CONFIG.subagent, maxRetained: 1 } },
		);
		return { harness, router, create, start };
	}

	it("foreground subagent returns the child's final text without the child's tool output", async () => {
		const { harness, router } = await createNekHarness();
		writeFileSync(join(harness.tempDir, "secret-marker.txt"), "x");
		router.parent.push(
			reply(subagentCall({ subagent_type: "explorer" })),
			reply(fauxAssistantMessage("parent done")),
		);
		router.child.push(reply(toolCall("ls", {})), reply(fauxAssistantMessage("Found 1 file: the marker.")));

		await harness.session.prompt("map the files");

		const [result] = toolResults(harness, "subagent");
		expect(result.isError).toBe(false);
		const text = JSON.stringify(result.content);
		expect(text).toContain("(Map files) completed.");
		expect(text).toContain("Found 1 file: the marker.");
		expect(JSON.stringify(router.childRequests[1])).toContain("secret-marker.txt");
		expect(router.parentRequests[1]).toContain("Found 1 file: the marker.");
		expect(router.parentRequests[1]).not.toContain("secret-marker.txt");
		expect(subagentDetails(result)).toMatchObject({
			status: "completed",
			observed: true,
			model: `${harness.getModel().provider}/${harness.getModel().id}`,
		});
		expect(subagentNotices(harness)).toHaveLength(0);
	});

	it("defaults to a read-only explorer inheriting the parent's model and thinking", async () => {
		const { harness, router } = await createNekHarness({ models: [{ id: "parent", reasoning: true }] });
		harness.session.setThinkingLevel("low");
		router.parent.push(reply(subagentCall({})), reply(fauxAssistantMessage("ok")));
		router.child.push(reply(fauxAssistantMessage("findings")));

		await harness.session.prompt("explore the code");

		const [result] = toolResults(harness, "subagent");
		expect(result.isError).toBe(false);
		expect(subagentDetails(result)).toMatchObject({ type: "explorer", model: "faux/parent", status: "completed" });
		expect(router.childModels).toEqual(["faux/parent"]);
		expect(router.childThinking).toEqual(["low"]);
		expect(requestToolNames(router.childRequests[0])).toEqual([...READ_ONLY_TOOL_NAMES].sort());
	});

	it("custom child sessions have no subagent or await tool and plan mode forces the read-only set", async () => {
		const { harness, router } = await createNekHarness(
			{},
			{
				"worker.md": "---\nname: worker\ndescription: Writes code\n---\n",
			},
		);
		router.parent.push(reply(subagentCall({ subagent_type: "worker" })), reply(fauxAssistantMessage("ok")));
		router.child.push(reply(fauxAssistantMessage("general done")));
		await harness.session.prompt("delegate");

		const identity = "You are working inside nekcode, a terminal coding agent.";
		const childSystem = router.childRequests[0].find((message) => message.role === "system");
		expect(JSON.stringify(childSystem)).toContain(identity);
		expect(router.parentRequests[0]).toContain(identity);
		const generalTools = requestToolNames(router.childRequests[0]);
		expect(generalTools).toContain("edit");
		expect(generalTools).toContain("todo_write");
		expect(generalTools).not.toContain("subagent");
		expect(generalTools).not.toContain("await");
		expect(requestToolNames(JSON.parse(router.parentRequests[0]) as Message[])).toContain("subagent");

		await harness.session.prompt("/plan");
		router.parent.push(reply(subagentCall({ subagent_type: "worker" })), reply(fauxAssistantMessage("ok")));
		router.child.push(reply(fauxAssistantMessage("plan child done")));
		await harness.session.prompt("plan something");

		expect(requestToolNames(router.childRequests[1])).toEqual([...READ_ONLY_TOOL_NAMES].sort());
	});

	it("a background subagent result continues the parent with a system_notification after its turn", async () => {
		const { harness, router } = await createNekHarness();
		const gate = createGate();
		router.parent.push(
			reply(subagentCall({ run_in_background: true })),
			reply(fauxAssistantMessage("I will wait for the notification.")),
			reply(fauxAssistantMessage("Integrated the result.")),
		);
		router.child.push(async () => {
			await gate.promise;
			return fauxAssistantMessage("background findings");
		});

		await harness.session.prompt("start background work");
		const [started] = toolResults(harness, "subagent");
		expect(JSON.stringify(started.content)).toContain("in the background. You will be notified when it completes");
		expect(router.parentRequests).toHaveLength(2);

		gate.open();
		await vi.waitFor(() => expect(router.parentRequests).toHaveLength(3));
		await vi.waitFor(() => expect(harness.session.isIdle).toBe(true));

		expect(router.parentRequests[2]).toContain("<system_notification>");
		expect(router.parentRequests[2]).toContain("background findings");
		expect(subagentNotices(harness)).toHaveLength(1);
	});

	it("a background result finished during the parent's run is appended before settling and continues once", async () => {
		const { harness, router } = await createNekHarness();
		router.parent.push(
			reply(subagentCall({ run_in_background: true })),
			async () => {
				await vi.waitFor(() => expect(router.childRequests).toHaveLength(1));
				await new Promise((resolve) => setTimeout(resolve, 20));
				return fauxAssistantMessage("turn over");
			},
			reply(fauxAssistantMessage("Integrated.")),
		);
		router.child.push(reply(fauxAssistantMessage("fast findings")));

		await harness.session.prompt("start");

		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);
		expect(router.parentRequests).toHaveLength(3);
		expect(router.parentRequests[2]).toContain("fast findings");
		expect(subagentNotices(harness)).toHaveLength(1);
	});

	it("a subagent observed with await before it finishes is not notified again", async () => {
		const { harness, router } = await createNekHarness();
		router.parent.push(
			reply(subagentCall({ run_in_background: true })),
			() => {
				const [started] = toolResults(harness, "subagent");
				const id = subagentDetails(started).id;
				return toolCall("await", { subagent_id: id, block_until_ms: 10_000 });
			},
			reply(fauxAssistantMessage("done")),
		);
		router.child.push(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			return fauxAssistantMessage("awaited findings");
		});

		await harness.session.prompt("start and await");

		const [awaited] = toolResults(harness, "await");
		expect(JSON.stringify(awaited.content)).toContain("awaited findings");
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(router.parentRequests).toHaveLength(3);
		expect(subagentNotices(harness)).toHaveLength(0);
	});

	it("a child does not inherit the parent's read records", async () => {
		const { harness, router } = await createNekHarness(
			{},
			{
				"worker.md": "---\nname: worker\ndescription: Writes code\n---\n",
			},
		);
		writeFileSync(join(harness.tempDir, "notes.txt"), "alpha\n");
		router.parent.push(
			reply(toolCall("read", { path: "notes.txt" })),
			reply(subagentCall({ subagent_type: "worker", prompt: "Replace alpha with beta in notes.txt." })),
			reply(fauxAssistantMessage("ok")),
		);
		router.child.push(
			reply(toolCall("write", { path: "notes.txt", content: "beta\n" })),
			reply(fauxAssistantMessage("could not write")),
		);

		await harness.session.prompt("write via child");

		expect(toolResults(harness, "read")[0].isError).toBe(false);
		const childWrite = JSON.stringify(router.childRequests[1]);
		expect(childWrite).toContain("File has not been read yet. Read it first before overwriting it.");
	});

	it("stop_subagent stops a running background subagent without a completion notice", async () => {
		const { harness, router } = await createNekHarness();
		let childAborted = false;
		router.parent.push(
			reply(subagentCall({ run_in_background: true })),
			async () => {
				await vi.waitFor(() => expect(router.childRequests).toHaveLength(1));
				const id = subagentDetails(toolResults(harness, "subagent")[0]).id;
				return toolCall("stop_subagent", { subagent_id: id });
			},
			reply(fauxAssistantMessage("stopped it")),
		);
		router.child.push(
			abortableReply(() => {
				childAborted = true;
			}),
		);

		await harness.session.prompt("start, then stop");

		const [stopped] = toolResults(harness, "stop_subagent");
		expect(stopped.isError).toBe(false);
		expect(getMessageText(stopped)).toContain("Stopped subagent");
		expect(getMessageText(stopped)).toContain("status: aborted");
		expect(stopped.details).toMatchObject({ stopped: true, subagent: { status: "aborted" } });
		expect(childAborted).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(subagentNotices(harness)).toHaveLength(0);
		expect(router.parentRequests).toHaveLength(3);
	});

	it("stop_subagent reports an unknown subagent as an error", async () => {
		const { harness, router } = await createNekHarness();
		router.parent.push(reply(toolCall("stop_subagent", { subagent_id: "nope" })), reply(fauxAssistantMessage("ok")));
		await harness.session.prompt("stop nothing");
		const [result] = toolResults(harness, "stop_subagent");
		expect(result.isError).toBe(true);
		expect(getMessageText(result)).toContain("Unknown subagent nope.");
	});

	it("aborting the parent run stops the background subagents that run launched, not earlier ones", async () => {
		const start = vi.spyOn(SubagentRegistry.prototype, "start");
		const { harness, router } = await createNekHarness();
		const oldGate = createGate();
		let oldAborted = false;
		let newAborted = false;
		router.parent.push(
			reply(subagentCall({ description: "Old work", run_in_background: true })),
			reply(fauxAssistantMessage("old work started")),
		);
		router.child.push(async (_context, options) => {
			options?.signal?.addEventListener(
				"abort",
				() => {
					oldAborted = true;
				},
				{ once: true },
			);
			await oldGate.promise;
			return fauxAssistantMessage("old findings");
		});
		await harness.session.prompt("start old work");

		router.parent.push(reply(subagentCall({ description: "New work", run_in_background: true })), abortableReply());
		router.child.push(
			abortableReply(() => {
				newAborted = true;
			}),
		);
		const running = harness.session.prompt("start new work");
		await vi.waitFor(() => expect(router.childRequests).toHaveLength(2));
		await vi.waitFor(() => expect(router.parentRequests).toHaveLength(4));
		await harness.session.abort();
		await running;

		const registry = start.mock.contexts[0] as SubagentRegistry;
		const [oldId, newId] = toolResults(harness, "subagent").map((result) => subagentDetails(result).id);
		await vi.waitFor(() => expect(registry.get(newId)?.status).toBe("aborted"));
		expect(newAborted).toBe(true);
		expect(oldAborted).toBe(false);
		expect(registry.get(oldId)?.status).toBe("running");
		// The earlier subagent keeps running to its own end; its notice waits for the next request after the abort.
		oldGate.open();
		await vi.waitFor(() =>
			expect(registry.get(oldId)).toMatchObject({ status: "completed", finalText: "old findings" }),
		);
	});

	it("generalPurpose is writable and inherits the parent's model unless the call overrides it", async () => {
		const { harness, router } = await createNekHarness({
			models: [
				{ id: "parent", reasoning: true },
				{ id: "other", reasoning: true },
			],
		});
		router.parent.push(
			reply(subagentCall({ subagent_type: "generalPurpose" })),
			reply(subagentCall({ subagent_type: "generalPurpose", model: "faux/other" })),
			reply(fauxAssistantMessage("ok")),
		);
		router.child.push(reply(fauxAssistantMessage("inherited")), reply(fauxAssistantMessage("overridden")));

		await harness.session.prompt("delegate twice");

		const results = toolResults(harness, "subagent");
		expect(results.map((result) => result.isError)).toEqual([false, false]);
		expect(results.map((result) => (result.details as unknown as SubagentToolData).warnings)).toEqual([
			undefined,
			undefined,
		]);
		expect(router.childModels).toEqual(["faux/parent", "faux/other"]);
		for (const request of router.childRequests) {
			expect(requestToolNames(request)).toEqual(expect.arrayContaining(["bash", "edit", "write", "read"]));
		}
	});

	it("await without running subagents returns at once", async () => {
		const { harness, router } = await createNekHarness();
		router.parent.push(reply(toolCall("await", {})), reply(fauxAssistantMessage("ok")));
		await harness.session.prompt("await");
		expect(JSON.stringify(toolResults(harness, "await")[0].content)).toContain("No running subagents.");
	});

	it("in plan mode an idle notice waits for the next submission instead of starting a turn", async () => {
		const { harness, router } = await createNekHarness();
		const gate = createGate();
		await harness.session.prompt("/plan");
		router.parent.push(
			reply(subagentCall({ subagent_type: "explorer", run_in_background: true })),
			reply(fauxAssistantMessage("waiting")),
		);
		router.child.push(async () => {
			await gate.promise;
			return fauxAssistantMessage("plan findings");
		});
		await harness.session.prompt("explore in background");

		gate.open();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(router.parentRequests).toHaveLength(2);

		router.parent.push(reply(fauxAssistantMessage("using findings")));
		await harness.session.prompt("continue");
		expect(router.parentRequests[2]).toContain("plan findings");
		expect(router.parentRequests[2]).toContain("<system_notification>");
	});

	it("resume continues the same child with its previous context", async () => {
		const { harness, router } = await createNekHarness();
		router.parent.push(
			reply(subagentCall({ prompt: "Remember the word PELICAN." })),
			reply(fauxAssistantMessage("ok")),
		);
		router.child.push(reply(fauxAssistantMessage("Noted.")));
		await harness.session.prompt("first");
		const id = subagentDetails(toolResults(harness, "subagent")[0]).id;

		router.parent.push(reply(subagentCall({ resume: id, prompt: "Which word?" })), reply(fauxAssistantMessage("ok")));
		router.child.push(reply(fauxAssistantMessage("PELICAN")));
		await harness.session.prompt("second");

		const resumed = JSON.stringify(router.childRequests[1]);
		expect(resumed).toContain("Remember the word PELICAN.");
		expect(resumed).toContain("Noted.");
		expect(resumed).toContain("Which word?");
		const second = toolResults(harness, "subagent")[1];
		expect(subagentDetails(second).id).toBe(id);
		expect(JSON.stringify(second.content)).toContain("PELICAN");
	});

	it.each(["preset-worker", "preset-explorer"])(
		"%s without model runs on its preset model and thinking level",
		async (subagentType) => {
			const { harness, router } = await createModelHarness();
			harness.session.setThinkingLevel("low");
			router.parent.push(reply(subagentCall({ subagent_type: subagentType })), reply(fauxAssistantMessage("ok")));
			router.child.push(reply(fauxAssistantMessage("preset done")));

			await harness.session.prompt("delegate to the preset");

			const [result] = toolResults(harness, "subagent");
			expect(result.isError).toBe(false);
			expect(subagentDetails(result)).toMatchObject({ model: "faux/preset", status: "completed" });
			expect(router.childModels).toEqual(["faux/preset"]);
			expect(router.childThinking).toEqual(["high"]);
		},
	);

	it.each(["inherit", "faux/parent", "missing/model", ""])(
		"a preset type warns and ignores conflicting model %s",
		async (model) => {
			const { harness, router } = await createModelHarness();
			const start = vi.spyOn(SubagentRegistry.prototype, "start");
			router.parent.push(
				reply(subagentCall({ subagent_type: "preset-worker", model })),
				reply(fauxAssistantMessage("ok")),
			);
			router.child.push(reply(fauxAssistantMessage("preset done")));

			await harness.session.prompt("delegate to the preset");

			const [result] = toolResults(harness, "subagent");
			expect(result.isError).toBe(false);
			expect(getMessageText(result)).toContain(`Ignoring model "${model}"`);
			expect(getMessageText(result)).toContain("Using preset model faux/preset.");
			expect(result.details).toMatchObject({ warnings: [expect.any(String)] });
			expect(start).toHaveBeenCalledTimes(1);
			expect(router.childModels).toEqual(["faux/preset"]);
			expect(router.parentRequests[1]).toContain("Using preset model faux/preset.");
			expect(subagentNotices(harness)).toHaveLength(0);
		},
	);

	it("a preset type accepts exactly its preset model", async () => {
		const { harness, router } = await createModelHarness();
		router.parent.push(
			reply(subagentCall({ subagent_type: "preset-explorer", model: "faux/preset" })),
			reply(fauxAssistantMessage("ok")),
		);
		router.child.push(reply(fauxAssistantMessage("preset done")));

		await harness.session.prompt("delegate to the preset");

		expect(toolResults(harness, "subagent")[0].isError).toBe(false);
		expect(router.childModels).toEqual(["faux/preset"]);
	});

	it.each([undefined, "inherit", "faux/preset"])("a non-preset type keeps model behavior for %s", async (model) => {
		const { harness, router } = await createModelHarness();
		router.parent.push(
			reply(subagentCall({ subagent_type: "explorer", ...(model === undefined ? {} : { model }) })),
			reply(fauxAssistantMessage("ok")),
		);
		router.child.push(reply(fauxAssistantMessage("done")));

		await harness.session.prompt("delegate to a general worker");

		const [result] = toolResults(harness, "subagent");
		expect(result.isError).toBe(false);
		const expectedModel = model === "faux/preset" ? model : "faux/parent";
		expect(subagentDetails(result).model).toBe(expectedModel);
		expect(router.childModels).toEqual([expectedModel]);
	});

	it.each(["unknown", "no auth"])("an unavailable preset (%s) warns and uses the parent model", async (reason) => {
		const presetModel = reason === "unknown" ? "nope/missing" : "noauth/preset";
		const { harness, router } = await createModelHarness(presetModel);
		if (reason === "no auth") {
			const preset = harness.getModel("preset")!;
			harness.session.modelRuntime.registerProvider("noauth", {
				baseUrl: preset.baseUrl,
				api: harness.faux.api,
				models: [preset],
			});
		}
		const start = vi.spyOn(SubagentRegistry.prototype, "start");
		router.parent.push(reply(subagentCall({ subagent_type: "preset-explorer" })), reply(fauxAssistantMessage("ok")));
		router.child.push(reply(fauxAssistantMessage("parent model done")));

		await harness.session.prompt("delegate to the preset");

		const [result] = toolResults(harness, "subagent");
		expect(result.isError).toBe(false);
		expect(getMessageText(result)).toContain(`Model "${presetModel}" is not available`);
		expect(getMessageText(result)).toContain("using parent model faux/parent.");
		expect(start).toHaveBeenCalledTimes(1);
		expect(subagentDetails(result).model).toBe("faux/parent");
		expect(router.childModels).toEqual(["faux/parent"]);
	});

	it.each(["retained", "reopen", "reattach"])("%s ignores the call's model", async (path) => {
		const reopen = path === "reopen";
		const { harness, router, create, start } = await createPersistentModelHarness("faux/preset", {
			models: [
				{ id: "parent", reasoning: true },
				{ id: "preset", reasoning: true },
				{ id: "new-preset", reasoning: true },
			],
		});
		harness.session.setThinkingLevel("low");
		router.parent.push(
			reply(subagentCall({ subagent_type: "preset-explorer", prompt: "Remember PELICAN." })),
			reply(fauxAssistantMessage("ok")),
		);
		router.child.push(reply(fauxAssistantMessage("Noted.")));
		await harness.session.prompt("first");
		const registry = start.mock.contexts[0] as SubagentRegistry;
		registries.push(registry);
		const first = subagentDetails(toolResults(harness, "subagent")[0]);

		if (path === "reattach") {
			const spec = create.mock.calls[0][0];
			await childSessions[0].dispose();
			await registry.disposeAll();
			const replayRegistry = new SubagentRegistry(DEFAULT_NEK_CONFIG.subagent, () => {});
			registries.push(replayRegistry);
			const values = new Map<string, ToolCallMemoValue>([
				[
					"nek.subagent",
					{
						id: first.id,
						sessionFile: first.sessionFile!,
						description: first.description,
						type: first.type,
						prompt: "Remember PELICAN.",
						background: false,
					},
				],
			]);
			const memo: ToolCallMemo = {
				get: async <T extends ToolCallMemoValue>(name: string) => values.get(name) as T | undefined,
				set: async <T extends ToolCallMemoValue>(name: string, value: T) => {
					values.set(name, value);
					return value;
				},
			};
			const type = { ...spec.type, model: "nope/missing", thinking: "minimal" as const };
			const tool = createSubagentToolDefinition({
				agentTypes: [type],
				getRegistry: () => replayRegistry,
				getMode: () => "agent",
				createSession: (request) =>
					childSession.createChildSession({
						...spec,
						...request,
						thinkingLevel: request.type.thinking ?? (request.model ? harness.session.thinkingLevel : undefined),
					}),
				findBranchSubagent: () => undefined,
				restrictTools: () => {},
			});
			const inherited = await tool.execute(
				"replayed-call",
				{ description: first.description, prompt: "Remember PELICAN.", model: "faux/parent" },
				undefined,
				undefined,
				{ ...spec.parentCtx, getToolCallMemo: () => memo },
			);
			expect(subagentDetails(inherited)).toMatchObject({ id: first.id, model: "faux/parent", status: "completed" });
			expect(getMessageText(inherited)).toContain("using parent model faux/parent.");
			expect(create).toHaveBeenCalledTimes(2);
			await replayRegistry.disposeAll();

			type.model = "faux/new-preset";
			const result = await tool.execute(
				"replayed-call",
				{ description: first.description, prompt: "Remember PELICAN.", model: "faux/parent" },
				undefined,
				undefined,
				{ ...spec.parentCtx, getToolCallMemo: () => memo },
			);
			expect(subagentDetails(result)).toMatchObject({ id: first.id, model: "faux/new-preset", status: "completed" });
			expect(getMessageText(result)).toContain("Noted.");
			expect(create).toHaveBeenCalledTimes(3);
			expect(create.mock.calls.at(-1)?.[0]).toMatchObject({
				model: { provider: "faux", id: "new-preset" },
				resumeFile: first.sessionFile,
			});
			expect(childSessions.at(-1)?.thinkingLevel).toBe("minimal");
			expect(router.childModels).toEqual(["faux/preset"]);
			return;
		}

		if (reopen) {
			router.parent.push(reply(subagentCall({})), reply(fauxAssistantMessage("ok")));
			router.child.push(reply(fauxAssistantMessage("other child done")));
			await harness.session.prompt("evict the preset child");
			expect(registry.get(first.id)).toBeUndefined();
		}

		router.parent.push(
			reply(subagentCall({ resume: first.id, model: "faux/parent", prompt: "Which word?" })),
			reply(fauxAssistantMessage("ok")),
		);
		router.child.push(reply(fauxAssistantMessage("PELICAN")));
		await harness.session.prompt("resume the preset child");

		const result = toolResults(harness, "subagent").at(-1)!;
		expect(result.isError).toBe(false);
		expect(subagentDetails(result)).toMatchObject({ id: first.id, model: "faux/preset", status: "completed" });
		expect(router.childModels).toEqual(
			reopen ? ["faux/preset", "faux/parent", "faux/preset"] : ["faux/preset", "faux/preset"],
		);
		expect(router.childThinking.at(-1)).toBe("high");
		expect(JSON.stringify(router.childRequests.at(-1))).toContain("Remember PELICAN.");
		expect(create).toHaveBeenCalledTimes(reopen ? 3 : 1);
		if (reopen)
			expect(create.mock.calls.at(-1)?.[0]).toMatchObject({
				model: { provider: "faux", id: "preset" },
				resumeFile: first.sessionFile,
			});
	});

	it.each([
		{ name: "updated preset thinking", model: "faux/new-preset", thinking: "minimal", expectedThinking: "minimal" },
		{
			name: "parent thinking without a thinking preset",
			model: "faux/new-preset",
			thinking: undefined,
			expectedThinking: "low",
		},
		{
			name: "saved model and thinking without a model preset",
			model: undefined,
			thinking: undefined,
			expectedThinking: "high",
		},
	])("reopen uses $name", async ({ model, thinking, expectedThinking }) => {
		const { harness, router, create, start } = await createPersistentModelHarness("faux/preset", {
			models: [
				{ id: "parent", reasoning: true },
				{ id: "preset", reasoning: true },
				{ id: "new-preset", reasoning: true },
			],
		});
		harness.session.setThinkingLevel("low");
		router.parent.push(reply(subagentCall({ subagent_type: "preset-explorer" })), reply(fauxAssistantMessage("ok")));
		router.child.push(reply(fauxAssistantMessage("original preset done")));
		await harness.session.prompt("first");
		const registry = start.mock.contexts[0] as SubagentRegistry;
		registries.push(registry);
		const first = subagentDetails(toolResults(harness, "subagent")[0]);

		router.parent.push(reply(subagentCall({})), reply(fauxAssistantMessage("ok")));
		router.child.push(reply(fauxAssistantMessage("other child done")));
		await harness.session.prompt("evict the preset child");
		expect(registry.get(first.id)).toBeUndefined();

		const fields = ["name: preset-explorer", "description: Updated preset"];
		if (model) fields.push(`model: ${model}`);
		if (thinking) fields.push(`thinking: ${thinking}`);
		writeFileSync(
			join(harness.tempDir, "agent-home", "agents", "preset-explorer.md"),
			`---\n${fields.join("\n")}\n---\n`,
		);
		await harness.session.bindExtensions({ mode: "print" });
		router.parent.push(
			reply(subagentCall({ resume: first.id, model: "inherit" })),
			reply(fauxAssistantMessage("ok")),
		);
		router.child.push(reply(fauxAssistantMessage("reopened preset done")));
		await harness.session.prompt("reopen the preset child");

		const result = toolResults(harness, "subagent").at(-1)!;
		expect(result.isError).toBe(false);
		expect(subagentDetails(result)).toMatchObject({
			id: first.id,
			model: model ?? "faux/preset",
			status: "completed",
		});
		expect(router.childModels).toEqual(["faux/preset", "faux/parent", model ?? "faux/preset"]);
		expect(router.childThinking.at(-1)).toBe(expectedThinking);
		expect(create.mock.calls.at(-1)?.[0]).toMatchObject({
			model: model ? { provider: "faux", id: "new-preset" } : undefined,
			thinkingLevel: model ? expectedThinking : undefined,
			resumeFile: first.sessionFile,
		});
	});

	it.each(["unknown", "no auth"])(
		"reopen warns about an unavailable preset (%s) and continues on the parent model",
		async (reason) => {
			const { harness, router, create, start } = await createPersistentModelHarness("preset-provider/preset");
			const preset = harness.getModel("preset")!;
			const providerConfig = { baseUrl: preset.baseUrl, api: harness.faux.api, models: [preset] };
			const runtime = harness.session.modelRuntime;
			runtime.registerProvider("preset-provider", { ...providerConfig, apiKey: "faux-key" });
			router.parent.push(
				reply(subagentCall({ subagent_type: "preset-explorer" })),
				reply(fauxAssistantMessage("ok")),
			);
			router.child.push(reply(fauxAssistantMessage("preset done")));
			await harness.session.prompt("first");
			const registry = start.mock.contexts[0] as SubagentRegistry;
			registries.push(registry);
			const first = subagentDetails(toolResults(harness, "subagent")[0]);

			router.parent.push(reply(subagentCall({})), reply(fauxAssistantMessage("ok")));
			router.child.push(reply(fauxAssistantMessage("other child done")));
			await harness.session.prompt("evict the preset child");
			expect(registry.get(first.id)).toBeUndefined();
			expect(create).toHaveBeenCalledTimes(2);

			runtime.unregisterProvider("preset-provider");
			if (reason === "no auth") runtime.registerProvider("preset-provider", providerConfig);
			await runtime.refresh({ allowNetwork: false });
			expect(runtime.hasConfiguredAuth("preset-provider")).toBe(false);
			router.parent.push(
				reply(subagentCall({ resume: first.id, model: "faux/parent" })),
				reply(fauxAssistantMessage("ok")),
			);
			router.child.push(reply(fauxAssistantMessage("continued on parent model")));
			await harness.session.prompt("reopen the unavailable preset child");

			const result = toolResults(harness, "subagent").at(-1)!;
			expect(result.isError).toBe(false);
			expect(getMessageText(result)).toContain('Model "preset-provider/preset" is not available');
			expect(getMessageText(result)).toContain("using parent model faux/parent.");
			expect(create).toHaveBeenCalledTimes(3);
			expect(registry.get(first.id)?.model).toBe("faux/parent");
			expect(router.childModels).toEqual(["preset-provider/preset", "faux/parent", "faux/parent"]);
		},
	);

	it("an unavailable override warns and continues using the parent model", async () => {
		const { harness, router } = await createNekHarness();
		router.parent.push(reply(subagentCall({ model: "nope/missing" })), reply(fauxAssistantMessage("ok")));
		router.child.push(reply(fauxAssistantMessage("continued")));

		await harness.session.prompt("use another model");

		const [result] = toolResults(harness, "subagent");
		expect(result.isError).toBe(false);
		expect(getMessageText(result)).toContain('Model "nope/missing" is not available');
		expect(getMessageText(result)).toContain("using parent model");
		expect(subagentDetails(result).model).toBe(`${harness.getModel().provider}/${harness.getModel().id}`);
		expect(router.childRequests).toHaveLength(1);
	});

	it("notifies the user before launching a child with a conflicting model", async () => {
		const { harness } = await createModelHarness();
		const ctx = harness.session.extensionRunner.createContext();
		const notify = vi.fn();
		const registry = new SubagentRegistry(DEFAULT_NEK_CONFIG.subagent, () => {});
		registries.push(registry);
		const done: SubagentRecord = {
			id: "warning-child",
			description: "Inspect",
			type: "preset",
			background: false,
			status: "completed",
			startedAt: Date.now(),
			observed: true,
			model: "faux/preset",
			finalText: "done",
		};
		vi.spyOn(registry, "start").mockImplementation(async () => {
			expect(notify).toHaveBeenCalledWith(expect.stringContaining("Using preset model faux/preset."), "warning");
			return done;
		});
		vi.spyOn(registry, "wait").mockResolvedValue(done);
		const tool = createSubagentToolDefinition({
			agentTypes: [{ ...BUILTIN_AGENT_TYPES[0], name: "preset", model: "faux/preset" }],
			getRegistry: () => registry,
			getMode: () => "agent",
			createSession: async () => {
				throw new Error("The mocked registry does not create sessions");
			},
			findBranchSubagent: () => undefined,
			restrictTools: () => {},
		});
		const result = await tool.execute(
			"warn",
			{ description: "Inspect", prompt: "Inspect", subagent_type: "preset", model: "missing" },
			undefined,
			undefined,
			{
				...ctx,
				hasUI: true,
				ui: { ...ctx.ui, notify },
			},
		);
		expect(result.details?.warnings).toHaveLength(1);
		expect(getMessageText(result)).toContain("Using preset model faux/preset.");
	});

	it("includes fallback warnings in the immediate background result", async () => {
		const { harness, router } = await createNekHarness();
		const gate = createGate();
		router.parent.push(
			reply(subagentCall({ model: "unrecognized", run_in_background: true })),
			reply(fauxAssistantMessage("waiting")),
			reply(fauxAssistantMessage("integrated")),
		);
		router.child.push(async () => {
			await gate.promise;
			return fauxAssistantMessage("findings");
		});
		await harness.session.prompt("delegate in the background");
		const [result] = toolResults(harness, "subagent");
		expect(result.isError).toBe(false);
		expect(getMessageText(result)).toContain("using parent model");
		expect(getMessageText(result)).toContain("in the background");
		expect(result.details).toMatchObject({ warnings: [expect.any(String)] });
		expect(router.parentRequests[1]).toContain("using parent model");
		gate.open();
		await vi.waitFor(() => expect(router.parentRequests).toHaveLength(3));
		await vi.waitFor(() => expect(harness.session.isIdle).toBe(true));
	});

	it("still fails when there is no usable parent model to inherit", async () => {
		const { harness } = await createNekHarness();
		const ctx = harness.session.extensionRunner.createContext();
		expect(() => childSession.resolveChildModel("missing", { ...ctx, model: undefined })).toThrow("no usable model");
		vi.spyOn(ctx.modelRegistry, "hasConfiguredAuth").mockReturnValue(false);
		expect(() => childSession.resolveChildModel(undefined, ctx)).toThrow("no usable model");
	});

	it("does not substitute models for actual upstream execution errors", async () => {
		const { harness, router } = await createModelHarness();
		router.parent.push(
			reply(subagentCall({ subagent_type: "preset-explorer" })),
			reply(fauxAssistantMessage("reported")),
		);
		router.child.push(() => {
			throw new Error("upstream authentication failed");
		});
		await harness.session.prompt("delegate");
		const [result] = toolResults(harness, "subagent");
		expect(subagentDetails(result).status).toBe("errored");
		expect(getMessageText(result)).toContain("upstream authentication failed");
		expect(result.details).not.toHaveProperty("warnings");
		expect(router.childModels).toEqual(["faux/preset"]);
	});

	it("an unknown subagent_type fails and lists the available types", async () => {
		const { harness, router } = await createNekHarness();
		router.parent.push(reply(subagentCall({ subagent_type: "bugbot" })), reply(fauxAssistantMessage("ok")));
		await harness.session.prompt("bugbot");
		const text = JSON.stringify(toolResults(harness, "subagent")[0].content);
		expect(text).toContain(
			`Unknown subagent_type \\"bugbot\\". Available subagent types: ${BUILTIN_AGENT_TYPES.map((type) => type.name).join(", ")}.`,
		);
	});
});
