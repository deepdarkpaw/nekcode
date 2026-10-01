import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import type {
	ExtensionCommandContextActions,
	ExtensionUIContext,
	ReplacedSessionContext,
} from "../../src/core/extensions/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { DEFAULT_NEK_CONFIG } from "../../src/extensions/nek/config.ts";
import { createNekExtension } from "../../src/extensions/nek/index.ts";
import { IMPLEMENT_FRESH_PREFIX } from "../../src/extensions/nek/prompts/implement.ts";
import { replayBranch } from "../../src/extensions/nek/state/session-state.ts";
import type { PlanApprovalChoice } from "../../src/extensions/nek/ui/plan-approval.ts";
import { initTheme, type Theme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { createHarness, type Harness } from "./harness.ts";

interface UiRecord {
	modeStatus: string | undefined;
	approval: PlanApprovalChoice | undefined;
	approvalShown: number;
	confirmResult: boolean;
	onApproval?: () => Promise<PlanApprovalChoice | undefined>;
}

function createUiContext(record: UiRecord): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => record.confirmResult,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: (key, text) => {
			if (key === "nek.mode") record.modeStatus = text;
		},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => {
			record.approvalShown++;
			return (record.onApproval ? await record.onApproval() : record.approval) as T;
		},
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: (_theme: string | Theme) => ({ success: false, error: "Theme switching not available in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

function createRecord(): UiRecord {
	return { modeStatus: undefined, approval: undefined, approvalShown: 0, confirmResult: false };
}

function toolCallMessage(name: string, args: JsonObject) {
	return fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
}

function createPlanCall(args: JsonObject) {
	return toolCallMessage("create_plan", {
		overview: "Add session auth.",
		plan: "# Add auth\n\n- Add the schema",
		todos: [
			{ id: "schema", content: "Add the schema" },
			{ id: "routes", content: "Add routes" },
		],
		...args,
	});
}

function captureRequest(requests: string[], text = "done"): FauxResponseStep {
	return (context) => {
		const lastAssistant = context.messages.map((message) => message.role).lastIndexOf("assistant");
		requests.push(JSON.stringify(context.messages.slice(lastAssistant + 1)));
		return fauxAssistantMessage(text);
	};
}

function toolResults(harness: Harness, toolName: string) {
	return harness.session.messages.flatMap((message) =>
		message.role === "toolResult" && message.toolName === toolName ? [message] : [],
	);
}

function currentState(harness: Harness) {
	return replayBranch(harness.sessionManager.getBranch());
}

describe("nek plan mode", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark", false);
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function createNekHarness(record: UiRecord | undefined): Promise<Harness> {
		const harness = await createHarness({
			extensionFactories: [createNekExtension({ role: "root", config: DEFAULT_NEK_CONFIG })],
		});
		harnesses.push(harness);
		if (record) await harness.session.bindExtensions({ uiContext: createUiContext(record), mode: "tui" });
		else await harness.session.bindExtensions({ mode: "print" });
		return harness;
	}

	it("/plan activates create_plan, sends the plan reminder, and blocks non-markdown writes", async () => {
		const record = createRecord();
		const harness = await createNekHarness(record);
		expect(harness.session.getActiveToolNames()).not.toContain("create_plan");
		expect(harness.session.getActiveToolNames()).toContain("switch_mode");

		await harness.session.prompt("/plan");
		expect(currentState(harness).mode).toBe("plan");
		expect(record.modeStatus).toBe("plan");
		expect(harness.session.getActiveToolNames()).toContain("create_plan");
		expect(harness.session.getActiveToolNames()).toContain("switch_mode");

		const requests: string[] = [];
		harness.setResponses([
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return toolCallMessage("write", { path: "src/app.ts", content: "x" });
			},
			toolCallMessage("write", { path: "notes.md", content: "# Notes" }),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("design auth");

		expect(requests[0]).toContain("You are now in Plan mode. You have EXITED your previous mode.");
		expect(requests[0]).toContain("Plan mode is active.");
		expect(requests[0]).toContain("<plan_mode_guardrails>");
		const writes = toolResults(harness, "write");
		expect(writes[0].isError).toBe(true);
		expect(JSON.stringify(writes[0].content)).toContain("Plan mode: only markdown files can be edited.");
		expect(existsSync(join(harness.tempDir, "src", "app.ts"))).toBe(false);
		expect(writes[1].isError).toBe(false);
		expect(readFileSync(join(harness.tempDir, "notes.md"), "utf-8")).toBe("# Notes");

		harness.setResponses([captureRequest(requests)]);
		await harness.session.prompt("more");
		expect(requests[1]).not.toContain("You are now in Plan mode.");
		expect(requests[1]).toContain("You are still in **Plan Mode**");
	});

	it("create_plan writes the plan file, ends the batch, and revises the same file", async () => {
		const harness = await createNekHarness(undefined);
		await harness.session.prompt("/plan");
		harness.setResponses([createPlanCall({ name: "Add auth" }), fauxAssistantMessage("not reached")]);

		await harness.session.prompt("plan auth");

		expect(harness.faux.state.callCount).toBe(1);
		expect(harness.getPendingResponseCount()).toBe(1);
		const plan = currentState(harness).plan;
		if (!plan) throw new Error("expected a plan after create_plan");
		expect(plan.path).toContain(join(CONFIG_DIR_NAME, "plans"));
		expect(plan.path).toMatch(/[\\/]add-auth_[0-9a-f]{6}\.plan\.md$/);
		expect(readFileSync(plan.path, "utf-8")).toContain("# Add auth\n\n- Add the schema");

		harness.setResponses([
			createPlanCall({ name: "Other name", overview: "Revised.", plan: "# Add auth v2", todos: [] }),
		]);
		await harness.session.prompt("revise");

		const revised = currentState(harness).plan;
		expect(revised).toEqual({ ...plan, revision: 2, overview: "Revised.", todos: [] });
		expect(currentState(harness).planMarkdown).toBe("# Add auth v2");
		expect(readFileSync(plan.path, "utf-8")).toContain("# Add auth v2");
	});

	it("/plan <text> enters plan mode and submits the text", async () => {
		const harness = await createNekHarness(undefined);
		const requests: string[] = [];
		harness.setResponses([captureRequest(requests)]);

		await harness.session.prompt("/plan design auth");
		await vi.waitFor(() => expect(harness.eventsOfType("agent_settled")).toHaveLength(1));

		expect(currentState(harness).mode).toBe("plan");
		expect(requests[0]).toContain("design auth");
		expect(requests[0]).toContain("Plan mode is active.");
	});

	it("ask_question without UI tells the model to proceed with the recommended options", async () => {
		const harness = await createNekHarness(undefined);
		const question = {
			id: "store",
			prompt: "Which store?",
			options: [
				{ id: "redis", label: "Redis (Recommended)" },
				{ id: "memory", label: "In-memory" },
			],
		};
		harness.setResponses([toolCallMessage("ask_question", { questions: [question] }), fauxAssistantMessage("ok")]);

		await harness.session.prompt("ask");

		const [result] = toolResults(harness, "ask_question");
		expect(result.isError).toBe(false);
		expect(JSON.stringify(result.content)).toContain("Proceed with the recommended option for each question");
	});

	it("switch_mode without UI fails and keeps the mode", async () => {
		const harness = await createNekHarness(undefined);
		harness.setResponses([toolCallMessage("switch_mode", { target_mode_id: "plan" }), fauxAssistantMessage("ok")]);

		await harness.session.prompt("switch");

		const [result] = toolResults(harness, "switch_mode");
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain("Mode switch requires user approval");
		expect(currentState(harness).mode).toBe("agent");
		expect(harness.session.getActiveToolNames()).not.toContain("create_plan");
	});

	it("switch_mode switches after the user confirms and returns the enter notice with the plan reminder", async () => {
		const record = createRecord();
		record.confirmResult = true;
		const harness = await createNekHarness(record);
		const requests: string[] = [];
		harness.setResponses([toolCallMessage("switch_mode", { target_mode_id: "plan" }), fauxAssistantMessage("ok")]);
		await harness.session.prompt("switch");

		const [result] = toolResults(harness, "switch_mode");
		expect(JSON.stringify(result.content)).toContain("You are now in Plan mode.");
		expect(JSON.stringify(result.content)).toContain("Plan mode is active.");
		expect(currentState(harness).mode).toBe("plan");
		expect(harness.session.getActiveToolNames()).toContain("create_plan");

		harness.setResponses([captureRequest(requests)]);
		await harness.session.prompt("next");
		expect(requests[0]).not.toContain("You are now in Plan mode.");
		expect(requests[0]).toContain("You are still in **Plan Mode**");
	});

	it("implementing the plan switches to agent, writes the todos, and announces agent mode", async () => {
		const record = createRecord();
		record.approval = "implement";
		const harness = await createNekHarness(record);
		await harness.session.prompt("/plan");
		const requests: string[] = [];
		harness.setResponses([
			createPlanCall({ name: "Add auth" }),
			captureRequest(requests, "implemented"),
			fauxAssistantMessage("finishing todos"),
		]);

		await harness.session.prompt("plan auth");

		expect(record.approvalShown).toBe(1);
		const state = currentState(harness);
		expect(state.mode).toBe("agent");
		expect(state.todos).toEqual([
			{ id: "schema", content: "Add the schema", status: "in_progress" },
			{ id: "routes", content: "Add routes", status: "pending" },
		]);
		expect(record.modeStatus).toBeUndefined();
		expect(harness.session.getActiveToolNames()).not.toContain("create_plan");
		expect(requests[0]).toContain("You are now in Agent mode. You have EXITED your previous mode.");
		expect(requests[0]).toContain("Implement the plan.");
		expect(requests[0]).not.toContain("Plan mode is active.");
	});

	it("continues planning without starting implementation", async () => {
		const record = createRecord();
		record.approval = "stay";
		const harness = await createNekHarness(record);
		await harness.session.prompt("/plan");
		harness.setResponses([createPlanCall({ name: "Add auth" })]);

		await harness.session.prompt("plan auth");

		expect(record.approvalShown).toBe(1);
		expect(currentState(harness).mode).toBe("plan");
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("keeps repeated /plan in plan mode and exits explicitly without executing", async () => {
		const record = createRecord();
		const harness = await createNekHarness(record);
		await harness.session.prompt("/plan");
		await harness.session.prompt("/plan");
		expect(currentState(harness).mode).toBe("plan");
		await harness.session.prompt("/agent");
		expect(currentState(harness).mode).toBe("agent");
		expect(harness.faux.state.callCount).toBe(0);
	});

	it("does not resume interrupted plan todos after answering a new request", async () => {
		const record = createRecord();
		record.approval = "implement";
		const harness = await createNekHarness(record);
		await harness.session.prompt("/plan");
		harness.setResponses([
			createPlanCall({ name: "Add auth" }),
			fauxAssistantMessage("interrupted", { stopReason: "aborted" }),
		]);
		await harness.session.prompt("plan auth");

		const requests: string[] = [];
		harness.setResponses([captureRequest(requests, "answer to the new question")]);
		await harness.session.prompt("Stop auth. Explain the new requirement first.");

		expect(harness.faux.state.callCount).toBe(3);
		expect(requests[0]).toContain("Explain the new requirement first.");
		expect(currentState(harness).todos).toHaveLength(2);
		expect(harness.session.pendingMessageCount).toBe(0);
	});

	it("publishes the immutable plan body before asking for approval and reopens it without a model call", async () => {
		const record = createRecord();
		const harness = await createNekHarness(record);
		record.onApproval = async () => {
			const [saved] = toolResults(harness, "create_plan");
			expect(JSON.stringify(saved.content)).toContain("# Add auth");
			expect(saved.details).toMatchObject({ markdown: "# Add auth\n\n- Add the schema", plan: { revision: 1 } });
			return undefined;
		};
		await harness.session.prompt("/plan");
		harness.setResponses([createPlanCall({ name: "Add auth" })]);
		await harness.session.prompt("design auth");
		await harness.session.prompt("/plan");
		expect(harness.faux.state.callCount).toBe(1);
		expect(currentState(harness).mode).toBe("plan");
		expect(harness.session.messages).toContainEqual(
			expect.objectContaining({ role: "custom", customType: "nek.plan_preview" }),
		);
	});

	it("re-evaluates the latest request and asks a new question before storing a revised plan", async () => {
		const record = createRecord();
		const harness = await createNekHarness(record);
		await harness.session.prompt("/plan");
		harness.setResponses([createPlanCall({ name: "Add auth" })]);
		await harness.session.prompt("design auth");
		const original = currentState(harness).plan;
		await harness.session.prompt("/agent");
		await harness.session.prompt("/plan");
		expect(currentState(harness).planStatus).toBe("draft");
		const errors: string[] = [];
		await harness.session.bindExtensions({ onError: (error) => errors.push(error.error) });
		await harness.session.prompt("/nek-build");
		expect(errors).toContainEqual(expect.stringContaining("being revised"));
		expect(harness.faux.state.callCount).toBe(1);
		await harness.session.bindExtensions({
			mode: "rpc",
			uiContext: { ...createUiContext(record), select: async () => "Redis" },
		});
		harness.setResponses([
			(context) => {
				expect(JSON.stringify(context.messages)).toContain("Treat re-planning as a fresh planning session");
				return toolCallMessage("ask_question", {
					questions: [
						{
							id: "store",
							prompt: "Which cache store?",
							options: [
								{ id: "redis", label: "Redis" },
								{ id: "memory", label: "Memory" },
							],
						},
					],
				});
			},
			createPlanCall({ overview: "Add caching instead.", plan: "# Cache\n\nUse Redis.", todos: [] }),
		]);
		await harness.session.prompt("Replace auth with caching. Reconsider the previous decisions.");
		expect(toolResults(harness, "ask_question").at(-1)?.details).toMatchObject({
			answers: [{ questionId: "store", optionIds: ["redis"] }],
		});
		expect(currentState(harness)).toMatchObject({
			mode: "plan",
			planStatus: "ready",
			planMarkdown: "# Cache\n\nUse Redis.",
			plan: { path: original?.path, revision: 2 },
		});
	});

	it.each(["implement", "fresh"] as const)(
		"does not apply a stale %s approval after a newer request arrived",
		async (choice) => {
			const record = createRecord();
			const harness = await createNekHarness(record);
			const opened = Promise.withResolvers<void>();
			const approval = Promise.withResolvers<PlanApprovalChoice>();
			record.onApproval = async () => {
				opened.resolve();
				return approval.promise;
			};
			await harness.session.prompt("/plan");
			harness.setResponses([createPlanCall({ name: "Add auth" }), fauxAssistantMessage("new request answered")]);
			const first = harness.session.prompt("design auth");
			await opened.promise;
			await harness.session.prompt("Do not implement auth. Plan caching instead.");
			approval.resolve(choice);
			await first;
			expect(harness.faux.state.callCount).toBe(2);
			expect(currentState(harness).mode).toBe("plan");
			expect(currentState(harness).planStatus).toBe("draft");
			expect(currentState(harness).execution).toBeUndefined();
		},
	);

	it("suppresses approval when the planning run is interrupted after saving", async () => {
		const record = createRecord();
		record.approval = "implement";
		const harness = await createNekHarness(record);
		const ended = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		harness.session.agent.subscribe(async (event) => {
			if (event.type === "agent_end") {
				ended.resolve();
				await release.promise;
			}
		});
		await harness.session.prompt("/plan");
		harness.setResponses([createPlanCall({ name: "Add auth" })]);
		const prompt = harness.session.prompt("design auth");
		await ended.promise;
		const abort = harness.session.abort();
		release.resolve();
		await Promise.all([prompt, abort]);
		expect(record.approvalShown).toBe(0);
		expect(currentState(harness).mode).toBe("plan");
		expect(currentState(harness).execution).toBeUndefined();
	});

	it("exit from plan review changes mode without starting implementation", async () => {
		const record = createRecord();
		record.approval = "exit";
		const harness = await createNekHarness(record);
		await harness.session.prompt("/plan");
		harness.setResponses([createPlanCall({ name: "Add auth" })]);
		await harness.session.prompt("design auth");
		expect(currentState(harness).mode).toBe("agent");
		expect(currentState(harness).execution).toBeUndefined();
		expect(harness.faux.state.callCount).toBe(1);
	});

	it("/nek-build --fresh starts a new session in agent mode with the todos and the Codex prefix", async () => {
		const harness = await createNekHarness(undefined);
		const created = SessionManager.inMemory();
		const sent: string[] = [];
		const actions: ExtensionCommandContextActions = {
			waitForIdle: async () => {},
			newSession: async (options) => {
				await options?.setup?.(created);
				const replaced = { sendUserMessage: async (text: string) => void sent.push(text) };
				await options?.withSession?.(replaced as unknown as ReplacedSessionContext);
				return { cancelled: false };
			},
			fork: async () => ({ cancelled: false }),
			navigateTree: async () => ({ cancelled: false }),
			switchSession: async () => ({ cancelled: false }),
			reload: async () => {},
		};
		await harness.session.bindExtensions({ commandContextActions: actions });
		await harness.session.prompt("/plan");
		harness.setResponses([createPlanCall({ name: "Add auth" })]);
		await harness.session.prompt("plan auth");

		await harness.session.prompt("/nek-build --fresh");

		const state = replayBranch(created.getBranch());
		expect(state.mode).toBe("agent");
		expect(state.todos.map((todo) => todo.status)).toEqual(["in_progress", "pending"]);
		expect(state.plan).toMatchObject({ name: "Add auth", revision: 1 });
		expect(state.planMarkdown).toBe("# Add auth\n\n- Add the schema");
		expect(state.execution).toMatchObject({ path: state.plan?.path, revision: 1, status: "active" });
		expect(sent).toEqual([`${IMPLEMENT_FRESH_PREFIX}\n\n# Add auth\n\n- Add the schema`]);
	});

	it("requires renewed review when the file body changed after its snapshot", async () => {
		const harness = await createNekHarness(undefined);
		const errors: string[] = [];
		await harness.session.bindExtensions({ onError: (error) => errors.push(error.error) });
		await harness.session.prompt("/plan");
		harness.setResponses([createPlanCall({ name: "Add auth" })]);
		await harness.session.prompt("plan auth");
		const plan = currentState(harness).plan;
		if (!plan) throw new Error("Expected saved plan");
		writeFileSync(plan.path, "# Changed plan\n\nA different task.");
		await harness.session.prompt("/nek-build");
		expect(errors).toContainEqual(expect.stringContaining("changed after review"));
		expect(currentState(harness).execution).toBeUndefined();
		expect(harness.faux.state.callCount).toBe(1);
	});

	it.each(["restart", "tree"] as const)(
		"retains progress but revokes execution authorization after %s",
		async (restore) => {
			const record = createRecord();
			record.approval = "implement";
			const harness = await createNekHarness(record);
			await harness.session.prompt("/plan");
			harness.setResponses([
				createPlanCall({ name: "Add auth" }),
				fauxAssistantMessage("partial work"),
				fauxAssistantMessage("paused for user"),
			]);
			await harness.session.prompt("plan auth");
			expect(currentState(harness).execution?.status).toBe("active");
			const leaf = harness.sessionManager.getLeafId();
			if (!leaf) throw new Error("Expected session leaf");
			if (restore === "restart")
				await harness.session.bindExtensions({ uiContext: createUiContext(record), mode: "tui" });
			else {
				const previous = harness.sessionManager
					.getBranch()
					.find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
				if (!previous) throw new Error("Expected earlier branch node");
				await harness.session.navigateTree(previous);
				await harness.session.navigateTree(leaf);
			}
			expect(currentState(harness).execution?.status).toBe("interrupted");
			expect(currentState(harness).todos.map((todo) => todo.status)).toEqual(["pending", "pending"]);
			expect(currentState(harness).planMarkdown).toBe("# Add auth\n\n- Add the schema");
			harness.setResponses([fauxAssistantMessage("answer to the new question")]);
			await harness.session.prompt("Explain caching. Do not resume auth.");
			expect(harness.faux.state.callCount).toBe(4);
		},
	);

	it("resumes only matching plan-owned progress after explicit approval", async () => {
		const record = createRecord();
		record.approval = "implement";
		const harness = await createNekHarness(record);
		await harness.session.prompt("/plan");
		harness.setResponses([
			createPlanCall({ name: "Add auth" }),
			toolCallMessage("todo_write", {
				merge: true,
				todos: [
					{ id: "schema", content: "Add the schema", status: "completed" },
					{ id: "routes", content: "Add routes", status: "in_progress" },
				],
			}),
			fauxAssistantMessage("interrupted", { stopReason: "aborted" }),
		]);
		await harness.session.prompt("plan auth");
		expect(currentState(harness).execution?.status).toBe("interrupted");
		expect(currentState(harness).todos.map((todo) => todo.status)).toEqual(["completed", "pending"]);
		harness.setResponses([fauxAssistantMessage("completed", { stopReason: "aborted" })]);
		await harness.session.prompt("/nek-build");
		expect(currentState(harness).todos.map((todo) => todo.status)).toEqual(["completed", "pending"]);
	});

	it("restores the mode and the tools after tree navigation", async () => {
		const record = createRecord();
		const harness = await createNekHarness(record);
		harness.setResponses([fauxAssistantMessage("agent answer")]);
		await harness.session.prompt("first");
		const agentLeaf = harness.sessionManager.getLeafId();
		await harness.session.prompt("/plan");
		harness.setResponses([fauxAssistantMessage("plan answer")]);
		await harness.session.prompt("second");
		const planLeaf = harness.sessionManager.getLeafId();
		if (!agentLeaf || !planLeaf) throw new Error("expected leaves");

		await harness.session.navigateTree(agentLeaf);
		expect(harness.session.getActiveToolNames()).not.toContain("create_plan");
		expect(record.modeStatus).toBeUndefined();

		await harness.session.navigateTree(planLeaf);
		expect(harness.session.getActiveToolNames()).toContain("create_plan");
		expect(record.modeStatus).toBe("plan");
	});
});
