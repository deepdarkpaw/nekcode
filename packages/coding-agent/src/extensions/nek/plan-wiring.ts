import type { KeyId } from "@earendil-works/pi-tui";
import type {
	AgentSettledEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	InputEvent,
	InputEventResult,
	SessionStartEvent,
} from "../../core/extensions/types.ts";
import { NEK_REMINDER_TYPE, type NekRuntime } from "./index.ts";
import { freshImplementMessage } from "./prompts/implement.ts";
import { MODE_SELECTION } from "./prompts/mode-selection.ts";
import { modeReminder } from "./prompts/plan-mode.ts";
import { approvedPlanMessage, planWorkflowReminder } from "./prompts/plan-workflow.ts";
import { planTodos, readPlanBody } from "./services/plan-store.ts";
import { checkModeToolCall, modeToolNames } from "./state/mode-rules.ts";
import {
	NEK_MODE_ENTRY_TYPE,
	NEK_PLAN_ENTRY_TYPE,
	NEK_PLAN_SNAPSHOT_ENTRY_TYPE,
	NEK_TODOS_ENTRY_TYPE,
	samePlanRevision,
} from "./state/session-state.ts";
import { openTodos } from "./state/todos.ts";
import { createAskQuestionToolDefinition } from "./tools/ask-question.ts";
import { createCreatePlanToolDefinition } from "./tools/create-plan.ts";
import { createSwitchModeToolDefinition } from "./tools/switch-mode.ts";
import type {
	Mode,
	ModeEntryData,
	PlanData,
	PlanLifecycleData,
	PlanRecord,
	PlanReference,
	TodoListData,
} from "./types.ts";
import { showPlanApproval } from "./ui/plan-approval.ts";
import { PLAN_PREVIEW_TYPE, renderPlanPreview, syncPlanUi } from "./ui/plan-view.ts";
import { syncTodoUi } from "./ui/todo-widget.ts";

/** The editor consumes an unstyled mode value so it can respond to theme changes. */
export const MODE_STATUS_KEY = "nek.mode";
export const NEK_BUILD_COMMAND = "nek-build";
export const PLAN_FLAG = "plan";

interface PendingImplementation {
	text: string;
	reference: PlanReference;
	cancelled: boolean;
}

/** Per-session planning state; artifacts and lifecycle remain branch-scoped. */
export interface PlanWiring {
	pi: ExtensionAPI;
	nek: NekRuntime;
	announcedMode: Mode;
	planCreated?: PlanReference;
	epoch: number;
	pendingImplementation?: PendingImplementation;
}

/** Register planning, review, explicit mode exit, and revision-bound execution. */
export function registerPlanMode(pi: ExtensionAPI, nek: NekRuntime): void {
	const wiring: PlanWiring = { pi, nek, announcedMode: nek.session.mode, epoch: 0 };
	registerPlanTools(wiring);
	registerPlanCommands(wiring);
	pi.registerMessageRenderer(PLAN_PREVIEW_TYPE, renderPlanPreview);
	pi.on("session_start", (event, ctx) => onSessionStart(wiring, event, ctx));
	pi.on("session_tree", (_event, ctx) => restoreMode(wiring, ctx, true));
	pi.on("input", (event, ctx) => onPlanInput(wiring, event, ctx));
	pi.on("before_agent_start", (event) => {
		nek.automaticWorkAllowed = true;
		event.systemPromptOptions.sections.mode_selection = MODE_SELECTION;
		event.systemPromptOptions.sections.plan_workflow = planWorkflowReminder(nek.session);
		return modeReminderMessage(wiring);
	});
	pi.on("tool_call", (event) => {
		const reason = checkModeToolCall(nek.session.mode, event.toolName, event.input);
		return reason ? { block: true, reason } : undefined;
	});
	pi.on("agent_settled", (event, ctx) => onPlanSettled(wiring, event, ctx));
}

function registerPlanTools(wiring: PlanWiring): void {
	const { pi, nek } = wiring;
	pi.registerTool(
		createSwitchModeToolDefinition({
			getMode: () => nek.session.mode,
			setMode: (mode, ctx) => {
				setMode(wiring, ctx, mode);
				wiring.announcedMode = mode;
			},
		}),
	);
	pi.registerTool(
		createCreatePlanToolDefinition({
			getMode: () => nek.session.mode,
			getPlan: () => nek.session.plan,
			getPlanDir: () => nek.config.plan.dir,
			setPlan: (plan, markdown, ctx) => {
				nek.session.plan = plan;
				nek.session.planMarkdown = markdown;
				nek.session.planStatus = "ready";
				delete nek.session.execution;
				wiring.planCreated = { path: plan.path, revision: plan.revision };
				wiring.epoch++;
				syncPlanUi(ctx, nek.session, nek.config.plan.shortcut);
			},
		}),
	);
	pi.registerTool(createAskQuestionToolDefinition());
}

function registerPlanCommands(wiring: PlanWiring): void {
	const { pi } = wiring;
	pi.registerCommand("plan", {
		description: "Enter Plan, show the current plan, or submit a planning request",
		handler: (args, ctx) => planCommand(wiring, args, ctx),
	});
	pi.registerCommand("agent", {
		description: "Exit Plan without implementing the plan",
		handler: async (_args, ctx) => {
			changeUserMode(wiring, ctx, "agent");
			await ctx.waitForIdle();
		},
	});
	pi.registerCommand(NEK_BUILD_COMMAND, {
		description: "Implement the reviewed plan (--fresh: in a new session)",
		handler: (args, ctx) => buildCommand(wiring, args, ctx),
	});
	pi.registerFlag(PLAN_FLAG, { description: "Start in plan mode", type: "boolean" });
}

function onSessionStart(wiring: PlanWiring, event: SessionStartEvent, ctx: ExtensionContext): void {
	wiring.pi.registerShortcut(wiring.nek.config.plan.shortcut as KeyId, {
		description: "Switch between Plan and Agent",
		handler: (shortcutCtx) =>
			changeUserMode(wiring, shortcutCtx, wiring.nek.session.mode === "plan" ? "agent" : "plan"),
	});
	restoreMode(wiring, ctx, event.reason !== "new");
	if (event.reason === "startup" && wiring.pi.getFlag(PLAN_FLAG) === true) setMode(wiring, ctx, "plan");
}

function restoreMode(wiring: PlanWiring, ctx: ExtensionContext, revoke: boolean): void {
	wiring.epoch++;
	delete wiring.planCreated;
	if (wiring.pendingImplementation) wiring.pendingImplementation.cancelled = true;
	if (revoke) interruptExecution(wiring, ctx);
	wiring.announcedMode = wiring.nek.session.mode;
	syncMode(wiring, ctx);
}

/** Change interaction mode without granting execution permission. */
export function setMode(wiring: PlanWiring, ctx: ExtensionContext, next: Mode): void {
	if (wiring.nek.session.mode === next) return;
	wiring.epoch++;
	if (wiring.pendingImplementation) wiring.pendingImplementation.cancelled = true;
	interruptExecution(wiring, ctx);
	wiring.pi.appendEntry<ModeEntryData>(NEK_MODE_ENTRY_TYPE, { mode: next });
	wiring.nek.session.mode = next;
	if (next === "plan") markDraft(wiring, ctx);
	syncMode(wiring, ctx);
}

function changeUserMode(wiring: PlanWiring, ctx: ExtensionContext, next: Mode): void {
	setMode(wiring, ctx, next);
	if (!ctx.isIdle()) {
		wiring.nek.automaticWorkAllowed = false;
		ctx.abort();
	}
}

function syncMode(wiring: PlanWiring, ctx: ExtensionContext): void {
	const { pi, nek } = wiring;
	pi.setActiveTools(modeToolNames(pi.getActiveTools(), nek.session.mode));
	if (ctx.hasUI) ctx.ui.setStatus(MODE_STATUS_KEY, nek.session.mode === "plan" ? "plan" : undefined);
	syncPlanUi(ctx, nek.session, nek.config.plan.shortcut);
}

function persistLifecycle(wiring: PlanWiring, ctx: ExtensionContext): void {
	const state = wiring.nek.session;
	wiring.pi.appendEntry<PlanLifecycleData>(NEK_PLAN_ENTRY_TYPE, {
		status: state.planStatus ?? "draft",
		...(state.execution ? { execution: { ...state.execution } } : {}),
	});
	syncPlanUi(ctx, state, wiring.nek.config.plan.shortcut);
}

function interruptExecution(wiring: PlanWiring, ctx: ExtensionContext): void {
	const state = wiring.nek.session;
	if (state.execution?.status !== "active") return;
	state.execution = { ...state.execution, status: "interrupted" };
	wiring.nek.automaticWorkAllowed = false;
	state.todos = state.todos.map((todo) => (todo.status === "in_progress" ? { ...todo, status: "pending" } : todo));
	wiring.pi.appendEntry<TodoListData>(NEK_TODOS_ENTRY_TYPE, { todos: state.todos, owner: state.todoOwner });
	syncTodoUi(ctx, state.todos, wiring.nek.config.todo.widgetMaxLines);
	persistLifecycle(wiring, ctx);
}

function markDraft(wiring: PlanWiring, ctx: ExtensionContext): void {
	wiring.epoch++;
	delete wiring.planCreated;
	if (wiring.pendingImplementation) wiring.pendingImplementation.cancelled = true;
	interruptExecution(wiring, ctx);
	wiring.nek.session.planStatus = "draft";
	persistLifecycle(wiring, ctx);
}

function onPlanInput(wiring: PlanWiring, event: InputEvent, ctx: ExtensionContext): InputEventResult | undefined {
	const pending = wiring.pendingImplementation;
	if (pending && event.source === "extension" && event.text === pending.text) {
		delete wiring.pendingImplementation;
		if (pending.cancelled || !samePlanRevision(pending.reference, wiring.nek.session.plan))
			return { action: "handled" };
		return undefined;
	}
	if (pending) pending.cancelled = true;
	if (event.source !== "extension" || pending) interruptExecution(wiring, ctx);
	if (wiring.nek.session.mode === "plan") markDraft(wiring, ctx);
	return undefined;
}

function modeReminderMessage(wiring: PlanWiring): BeforeAgentStartEventResult | undefined {
	const mode = wiring.nek.session.mode;
	const content = modeReminder(mode, mode !== wiring.announcedMode);
	wiring.announcedMode = mode;
	return content ? { message: { customType: NEK_REMINDER_TYPE, content, display: false } } : undefined;
}

async function planCommand(wiring: PlanWiring, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const text = args.trim();
	changeUserMode(wiring, ctx, "plan");
	await ctx.waitForIdle();
	if (text) {
		markDraft(wiring, ctx);
		wiring.pi.sendUserMessage(text);
		return;
	}
	const state = wiring.nek.session;
	if (!state.plan || state.planMarkdown === undefined) return;
	wiring.pi.sendMessage<PlanData>(
		{
			customType: PLAN_PREVIEW_TYPE,
			content: state.planMarkdown,
			display: true,
			details: { plan: state.plan, markdown: state.planMarkdown },
		},
		{ triggerTurn: false },
	);
}

async function onPlanSettled(wiring: PlanWiring, event: AgentSettledEvent, ctx: ExtensionContext): Promise<void> {
	if (event.outcome !== "completed") {
		interruptExecution(wiring, ctx);
		delete wiring.planCreated;
		return;
	}
	const state = wiring.nek.session;
	if (state.execution?.status === "active" && openTodos(state.todos).length === 0) {
		state.execution = { ...state.execution, status: "completed" };
		persistLifecycle(wiring, ctx);
	}
	await offerPlanApproval(wiring, ctx);
}

async function offerPlanApproval(wiring: PlanWiring, ctx: ExtensionContext): Promise<void> {
	const created = wiring.planCreated;
	delete wiring.planCreated;
	const state = wiring.nek.session;
	const plan = state.plan;
	if (
		!plan ||
		state.planMarkdown === undefined ||
		!samePlanRevision(created, plan) ||
		state.planStatus !== "ready" ||
		state.mode !== "plan" ||
		!ctx.hasUI
	)
		return;
	if (ctx.ui.getEditorText().trim() || ctx.hasPendingMessages()) return;
	const epoch = wiring.epoch;
	const choice = await showPlanApproval(ctx, { plan, markdown: state.planMarkdown });
	if (
		epoch !== wiring.epoch ||
		state !== wiring.nek.session ||
		state.mode !== "plan" ||
		state.planStatus !== "ready" ||
		ctx.hasPendingMessages()
	)
		return;
	if (choice === "implement") implementPlan(wiring, ctx, plan);
	else if (choice === "fresh") {
		const text = `/${NEK_BUILD_COMMAND} --fresh`;
		wiring.pendingImplementation = { text, reference: plan, cancelled: false };
		wiring.pi.sendUserMessage(text, { expandPromptTemplates: true });
	} else if (choice === "stay") markDraft(wiring, ctx);
	else if (choice === "exit") setMode(wiring, ctx, "agent");
}

function reviewedMarkdown(wiring: PlanWiring, plan: PlanRecord): string {
	const state = wiring.nek.session;
	if (state.planStatus !== "ready" || !samePlanRevision(state.plan, plan) || state.planMarkdown === undefined) {
		throw new Error("This plan is being revised. Save and review the updated plan before implementation.");
	}
	if (readPlanBody(plan) !== state.planMarkdown.trim()) {
		throw new Error("The plan file changed after review. Revise and review it again before implementation.");
	}
	return state.planMarkdown;
}

/** Approve only this snapshot; unrelated subsequent user input cancels any deferred implementation. */
export function implementPlan(wiring: PlanWiring, ctx: ExtensionContext, plan: PlanRecord): void {
	const markdown = reviewedMarkdown(wiring, plan);
	const { pi, nek } = wiring;
	const resume =
		nek.session.execution?.status === "interrupted" &&
		nek.session.todoOwner !== "planning" &&
		samePlanRevision(nek.session.todoOwner, plan) &&
		samePlanRevision(nek.session.execution, plan);
	setMode(wiring, ctx, "agent");
	const owner = { path: plan.path, revision: plan.revision };
	nek.session.execution = { ...owner, status: "active" };
	nek.session.todos = resume ? nek.session.todos.map((todo) => ({ ...todo })) : planTodos(plan);
	nek.session.todoOwner = owner;
	pi.appendEntry<TodoListData>(NEK_TODOS_ENTRY_TYPE, { todos: nek.session.todos, owner });
	persistLifecycle(wiring, ctx);
	syncTodoUi(ctx, nek.session.todos, nek.config.todo.widgetMaxLines);
	const text = approvedPlanMessage(plan.path, plan.revision, markdown);
	wiring.pendingImplementation = { text, reference: owner, cancelled: false };
	pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
}

async function buildCommand(wiring: PlanWiring, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const pending = wiring.pendingImplementation;
	if (pending?.text === `/${NEK_BUILD_COMMAND} --fresh`) {
		delete wiring.pendingImplementation;
		if (pending.cancelled || !samePlanRevision(pending.reference, wiring.nek.session.plan)) return;
	}
	const plan = wiring.nek.session.plan;
	if (!plan) {
		ctx.ui.notify("No plan on this branch. Create one in Plan first.", "warning");
		return;
	}
	if (!ctx.isIdle()) {
		ctx.ui.notify("Interrupt the current run before starting plan implementation.", "warning");
		return;
	}
	if (args.trim() !== "--fresh") return implementPlan(wiring, ctx, plan);
	const markdown = reviewedMarkdown(wiring, plan);
	const message = freshImplementMessage(markdown);
	const owner = { path: plan.path, revision: plan.revision };
	const todos = planTodos(plan);
	await ctx.newSession({
		parentSession: ctx.sessionManager.getSessionFile(),
		setup: async (manager) => {
			manager.appendCustomEntry(NEK_MODE_ENTRY_TYPE, { mode: "agent" } satisfies ModeEntryData);
			manager.appendCustomEntry(NEK_PLAN_SNAPSHOT_ENTRY_TYPE, { plan, markdown } satisfies PlanData);
			manager.appendCustomEntry(NEK_TODOS_ENTRY_TYPE, { todos, owner } satisfies TodoListData);
			manager.appendCustomEntry(NEK_PLAN_ENTRY_TYPE, {
				status: "ready",
				execution: { ...owner, status: "active" },
			} satisfies PlanLifecycleData);
		},
		withSession: async (next) => next.sendUserMessage(message),
	});
}
