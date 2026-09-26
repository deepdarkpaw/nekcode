import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	type AssistantMessage,
	type FauxResponseStep,
	fauxAssistantMessage,
	fauxToolCall,
	type JsonObject,
	type Message,
} from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { DEFAULT_NEK_CONFIG } from "../../src/extensions/nek/config.ts";
import { createNekExtension } from "../../src/extensions/nek/index.ts";
import { READ_ONLY_TOOL_NAMES } from "../../src/extensions/nek/services/agent-types.ts";
import type { TaskToolData } from "../../src/extensions/nek/types.ts";
import { createHarness, type Harness } from "./harness.ts";

type Reply = (context: { messages: Message[] }) => AssistantMessage | Promise<AssistantMessage>;

/**
 * Parent and children share one faux provider (the child reuses the parent's ModelRuntime). Every request is routed
 * by whether its context carries the Cursor subagent reminder, so interleaved parent and child calls stay ordered.
 */
interface Router {
	parent: Reply[];
	child: Reply[];
	parentRequests: string[];
	childRequests: Message[][];
}

const SUBAGENT_MARKER = "You are currently working inside a Task subagent.";

function reply(message: AssistantMessage): Reply {
	return () => message;
}

function toolCall(name: string, args: JsonObject): AssistantMessage {
	return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

function taskCall(args: JsonObject): AssistantMessage {
	return toolCall("task", { description: "Map files", prompt: "List the files and report them.", ...args });
}

function createRouter(harness: Harness): Router {
	const router: Router = { parent: [], child: [], parentRequests: [], childRequests: [] };
	const step: FauxResponseStep = async (context) => {
		const serialized = JSON.stringify(context.messages);
		const isChild = serialized.includes(SUBAGENT_MARKER);
		if (isChild) router.childRequests.push(context.messages);
		else router.parentRequests.push(serialized);
		const next = (isChild ? router.child : router.parent).shift();
		if (!next) throw new Error(`No ${isChild ? "child" : "parent"} reply queued`);
		return next(context);
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

/** The task record stored in a task tool result. */
function taskDetails(result: { details?: unknown }): TaskToolData["task"] {
	const details = result.details as TaskToolData | undefined;
	if (!details) throw new Error("task result without details");
	return details.task;
}

function toolResults(harness: Harness, toolName: string) {
	return harness.session.messages.flatMap((message) =>
		message.role === "toolResult" && message.toolName === toolName ? [message] : [],
	);
}

function taskNotices(harness: Harness) {
	return harness.session.messages.filter(
		(message) => message.role === "custom" && message.customType === "nek.task_notice",
	);
}

interface Gate {
	promise: Promise<void>;
	open: () => void;
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

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function createNekHarness(): Promise<{ harness: Harness; router: Router }> {
		const harness = await createHarness({
			extensionFactories: [createNekExtension({ role: "root", config: DEFAULT_NEK_CONFIG })],
		});
		harnesses.push(harness);
		const agentDir = join(harness.tempDir, "agent-home");
		mkdirSync(agentDir, { recursive: true });
		vi.stubEnv(ENV_AGENT_DIR, agentDir);
		await harness.session.bindExtensions({ mode: "print" });
		return { harness, router: createRouter(harness) };
	}

	it("foreground task returns the child's final text without the child's tool output", async () => {
		const { harness, router } = await createNekHarness();
		writeFileSync(join(harness.tempDir, "secret-marker.txt"), "x");
		router.parent.push(reply(taskCall({ subagent_type: "explore" })), reply(fauxAssistantMessage("parent done")));
		router.child.push(reply(toolCall("ls", {})), reply(fauxAssistantMessage("Found 1 file: the marker.")));

		await harness.session.prompt("map the files");

		const [result] = toolResults(harness, "task");
		expect(result.isError).toBe(false);
		const text = JSON.stringify(result.content);
		expect(text).toContain("(Map files) completed.");
		expect(text).toContain("Found 1 file: the marker.");
		expect(JSON.stringify(router.childRequests[1])).toContain("secret-marker.txt");
		expect(router.parentRequests[1]).toContain("Found 1 file: the marker.");
		expect(router.parentRequests[1]).not.toContain("secret-marker.txt");
		expect(taskDetails(result)).toMatchObject({ status: "completed", observed: true });
		expect(taskNotices(harness)).toHaveLength(0);
	});

	it("child sessions have no task or await tool and plan mode forces the read-only set", async () => {
		const { harness, router } = await createNekHarness();
		router.parent.push(reply(taskCall({})), reply(fauxAssistantMessage("ok")));
		router.child.push(reply(fauxAssistantMessage("general done")));
		await harness.session.prompt("delegate");

		const generalTools = requestToolNames(router.childRequests[0]);
		expect(generalTools).toContain("edit");
		expect(generalTools).toContain("todo_write");
		expect(generalTools).not.toContain("task");
		expect(generalTools).not.toContain("await");
		expect(requestToolNames(JSON.parse(router.parentRequests[0]) as Message[])).toContain("task");

		await harness.session.prompt("/plan");
		router.parent.push(reply(taskCall({ subagent_type: "generalPurpose" })), reply(fauxAssistantMessage("ok")));
		router.child.push(reply(fauxAssistantMessage("plan child done")));
		await harness.session.prompt("plan something");

		expect(requestToolNames(router.childRequests[1])).toEqual([...READ_ONLY_TOOL_NAMES].sort());
	});

	it("a background task result continues the parent with a system_notification after its turn", async () => {
		const { harness, router } = await createNekHarness();
		const gate = createGate();
		router.parent.push(
			reply(taskCall({ run_in_background: true })),
			reply(fauxAssistantMessage("I will wait for the notification.")),
			reply(fauxAssistantMessage("Integrated the result.")),
		);
		router.child.push(async () => {
			await gate.promise;
			return fauxAssistantMessage("background findings");
		});

		await harness.session.prompt("start background work");
		const [started] = toolResults(harness, "task");
		expect(JSON.stringify(started.content)).toContain("in the background. You will be notified when it completes");
		expect(router.parentRequests).toHaveLength(2);

		gate.open();
		await vi.waitFor(() => expect(router.parentRequests).toHaveLength(3));
		await vi.waitFor(() => expect(harness.session.isIdle).toBe(true));

		expect(router.parentRequests[2]).toContain("<system_notification>");
		expect(router.parentRequests[2]).toContain("background findings");
		expect(taskNotices(harness)).toHaveLength(1);
	});

	it("a background result finished during the parent's run is appended before settling and continues once", async () => {
		const { harness, router } = await createNekHarness();
		router.parent.push(
			reply(taskCall({ run_in_background: true })),
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
		expect(taskNotices(harness)).toHaveLength(1);
	});

	it("a task observed with await before it finishes is not notified again", async () => {
		const { harness, router } = await createNekHarness();
		router.parent.push(
			reply(taskCall({ run_in_background: true })),
			() => {
				const [started] = toolResults(harness, "task");
				const id = taskDetails(started).id;
				return toolCall("await", { task_id: id, block_until_ms: 10_000 });
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
		expect(taskNotices(harness)).toHaveLength(0);
	});

	it("a child does not inherit the parent's read records", async () => {
		const { harness, router } = await createNekHarness();
		writeFileSync(join(harness.tempDir, "notes.txt"), "alpha\n");
		router.parent.push(
			reply(toolCall("read", { path: "notes.txt" })),
			reply(taskCall({ prompt: "Replace alpha with beta in notes.txt." })),
			reply(fauxAssistantMessage("ok")),
		);
		router.child.push(
			reply(toolCall("edit", { file_path: "notes.txt", old_string: "alpha", new_string: "beta" })),
			reply(fauxAssistantMessage("could not edit")),
		);

		await harness.session.prompt("edit via child");

		expect(toolResults(harness, "read")[0].isError).toBe(false);
		const childEdit = JSON.stringify(router.childRequests[1]);
		expect(childEdit).toContain("File has not been read yet. Read it first before editing it.");
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
			reply(taskCall({ subagent_type: "explore", run_in_background: true })),
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
		router.parent.push(reply(taskCall({ prompt: "Remember the word PELICAN." })), reply(fauxAssistantMessage("ok")));
		router.child.push(reply(fauxAssistantMessage("Noted.")));
		await harness.session.prompt("first");
		const id = taskDetails(toolResults(harness, "task")[0]).id;

		router.parent.push(reply(taskCall({ resume: id, prompt: "Which word?" })), reply(fauxAssistantMessage("ok")));
		router.child.push(reply(fauxAssistantMessage("PELICAN")));
		await harness.session.prompt("second");

		const resumed = JSON.stringify(router.childRequests[1]);
		expect(resumed).toContain("Remember the word PELICAN.");
		expect(resumed).toContain("Noted.");
		expect(resumed).toContain("Which word?");
		const second = toolResults(harness, "task")[1];
		expect(taskDetails(second).id).toBe(id);
		expect(JSON.stringify(second.content)).toContain("PELICAN");
	});

	it("an unavailable model fails and lists the available models", async () => {
		const { harness, router } = await createNekHarness();
		router.parent.push(reply(taskCall({ model: "nope/missing" })), reply(fauxAssistantMessage("ok")));

		await harness.session.prompt("use another model");

		const [result] = toolResults(harness, "task");
		expect(result.isError).toBe(true);
		const text = JSON.stringify(result.content);
		expect(text).toContain('Model \\"nope/missing\\" is not available. Available models: inherit, ');
		expect(text).toContain(`${harness.getModel().provider}/${harness.getModel().id}`);
		expect(router.childRequests).toHaveLength(0);
	});

	it("an unknown subagent_type fails and lists the available types", async () => {
		const { harness, router } = await createNekHarness();
		router.parent.push(reply(taskCall({ subagent_type: "bugbot" })), reply(fauxAssistantMessage("ok")));
		await harness.session.prompt("bugbot");
		const text = JSON.stringify(toolResults(harness, "task")[0].content);
		expect(text).toContain(
			'Unknown subagent_type \\"bugbot\\". Available subagent types: generalPurpose, explore, shell.',
		);
	});
});
