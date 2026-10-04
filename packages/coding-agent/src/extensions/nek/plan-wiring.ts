import type { AgentMessage } from "@earendil-works/pi-agent-core";
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
import { planId, planTodos, readPlanBody } from "./services/plan-store.ts";
import { checkModeToolCall, modeToolNames } from "./state/mode-rules.ts";
import {
	activePlan,
	findPlan,
	NEK_MODE_ENTRY_TYPE,
	NEK_PLAN_ENTRY_TYPE,
	NEK_PLAN_SNAPSHOT_ENTRY_TYPE,
	NEK_TODOS_ENTRY_TYPE,
	samePlanRevision,
} from "./state/session-state.ts";
import { createAskQuestionToolDefinition } from "./tools/ask-question.ts";
import { createCreatePlanToolDefinition } from "./tools/create-plan.ts";
import { createSwitchModeToolDefinition } from "./tools/switch-mode.ts";
import { createUpdatePlanToolDefinition } from "./tools/update-plan.ts";
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

/** Register planning, review, explicit mode exit, and approval that hands the plan to Agent mode. */
export function registerPlanMode(pi: ExtensionAPI, nek: NekRuntime): void {
	const wiring: PlanWiring = { pi, nek, announcedMode: nek.session.mode, epoch: 0 };
	registerPlanTools(wiring);
	registerPlanCommands(wiring);
	pi.registerMessageRenderer(PLAN_PREVIEW_TYPE, renderPlanPreview);
	pi.on("context", (event) => {
		const messages = event.messages.filter((message) => !isPlanPreview(message));
		return messages.length === event.messages.length ? undefined : { messages };
	});
	pi.on("session_start", (event, ctx) => onSessionStart(wiring, event, ctx));
	pi.on("session_tree", (_event, ctx) => restoreMode(wiring, ctx));
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
	const setPlan = (plan: PlanRecord, markdown: string, ctx: ExtensionContext): void => {
		const snapshot = { plan: { ...plan, todos: plan.todos.map((todo) => ({ ...todo })) }, markdown };
		const index = nek.session.plans.findIndex((item) => item.plan.path === plan.path);
		nek.session.plans =
			index < 0
				? [...nek.session.plans, snapshot]
				: nek.session.plans.map((item, itemIndex) => (itemIndex === index ? snapshot : item));
		nek.session.activePlan = plan.path;
		nek.session.planStatus = "ready";
		wiring.planCreated = { path: plan.path, revision: plan.revision };
		wiring.epoch++;
		syncPlanUi(ctx, nek.session, nek.config.plan.shortcut);
	};
	pi.registerTool(
		createCreatePlanToolDefinition({
			getMode: () => nek.session.mode,
			getPlans: () => nek.session.plans,
			getPlanDir: () => nek.config.plan.dir,
			setPlan,
		}),
	);
	pi.registerTool(
		createUpdatePlanToolDefinition({
			getMode: () => nek.session.mode,
			getPlans: () => nek.session.plans,
			getActivePlanId: () => {
				const selected = activePlan(nek.session);
				return selected ? planId(selected.plan) : undefined;
			},
			setPlan,
		}),
	);
	pi.registerTool(createAskQuestionToolDefinition());
}

function registerPlanCommands(wiring: PlanWiring): void {
	const { pi } = wiring;
	pi.registerCommand("plan", {
		description: "Enter Plan or submit a planning request",
		handler: (args, ctx) => planCommand(wiring, args, ctx),
	});
	pi.registerCommand("plans", {
		description: "Select a saved plan and preview it",
		handler: (_args, ctx) => plansCommand(wiring, ctx),
	});
	pi.registerCommand("agent", {
		description: "Exit Plan without implementing the plan",
		handler: async (_args, ctx) => {
			changeUserMode(wiring, ctx, "agent");
			await ctx.waitForIdle();
		},
	});
	pi.registerCommand(NEK_BUILD_COMMAND, {
		description: "Implement a saved plan ([plan_id] --fresh: in a new session)",
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
	restoreMode(wiring, ctx);
	if (event.reason === "startup" && wiring.pi.getFlag(PLAN_FLAG) === true) setMode(wiring, ctx, "plan");
}

function restoreMode(wiring: PlanWiring, ctx: ExtensionContext): void {
	cancelPendingWork(wiring);
	wiring.announcedMode = wiring.nek.session.mode;
	syncMode(wiring, ctx);
}

/** Change interaction mode; a stale approval panel or deferred approved-plan message no longer applies. */
export function setMode(wiring: PlanWiring, ctx: ExtensionContext, next: Mode): void {
	if (wiring.nek.session.mode === next) return;
	wiring.epoch++;
	if (wiring.pendingImplementation) wiring.pendingImplementation.cancelled = true;
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
		...(state.activePlan ? { active: state.activePlan } : {}),
	});
	syncPlanUi(ctx, state, wiring.nek.config.plan.shortcut);
}

/** Invalidate an open approval panel, the pending plan review, and any deferred approved-plan message. */
function cancelPendingWork(wiring: PlanWiring): void {
	wiring.epoch++;
	delete wiring.planCreated;
	if (wiring.pendingImplementation) wiring.pendingImplementation.cancelled = true;
}

function markDraft(wiring: PlanWiring, ctx: ExtensionContext): void {
	cancelPendingWork(wiring);
	wiring.nek.session.planStatus = "draft";
	persistLifecycle(wiring, ctx);
}

function onPlanInput(wiring: PlanWiring, event: InputEvent, ctx: ExtensionContext): InputEventResult | undefined {
	const pending = wiring.pendingImplementation;
	if (pending && event.source === "extension" && event.text === pending.text) {
		delete wiring.pendingImplementation;
		if (pending.cancelled || !samePlanRevision(pending.reference, activePlan(wiring.nek.session)?.plan))
			return { action: "handled" };
		return undefined;
	}
	if (pending) pending.cancelled = true;
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
	if (!text) return;
	markDraft(wiring, ctx);
	wiring.pi.sendUserMessage(text);
}

async function plansCommand(wiring: PlanWiring, ctx: ExtensionCommandContext): Promise<void> {
	const snapshots = wiring.nek.session.plans;
	if (snapshots.length === 0) {
		ctx.ui.notify("No saved plans on this branch.", "warning");
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("The /plans picker requires an interactive UI.", "warning");
		return;
	}
	const labels = snapshots.map((snapshot) => planLabel(wiring, snapshot));
	const selectedLabel = await ctx.ui.select("Select a plan", labels);
	const selected = snapshots[labels.indexOf(selectedLabel ?? "")];
	if (!selected) return;
	activatePlan(wiring, ctx, selected);
	showPlanPreview(wiring, selected);
}

/** Append a display-only copy of the snapshot to the transcript; the `context` handler keeps it out of model input. */
function showPlanPreview(wiring: PlanWiring, snapshot: PlanData): void {
	wiring.pi.sendMessage<PlanData>(
		{ customType: PLAN_PREVIEW_TYPE, content: snapshot.markdown, display: true, details: snapshot },
		{ triggerTurn: false },
	);
}

function isPlanPreview(message: AgentMessage): boolean {
	return message.role === "custom" && message.customType === PLAN_PREVIEW_TYPE;
}

function planLabel(wiring: PlanWiring, snapshot: PlanData): string {
	const active = snapshot.plan.path === wiring.nek.session.activePlan ? " active" : "";
	return `${planId(snapshot.plan)} | ${snapshot.plan.name} | ${snapshot.plan.path} | revision ${snapshot.plan.revision}${active}`;
}

function activatePlan(wiring: PlanWiring, ctx: ExtensionContext, snapshot: PlanData): void {
	const state = wiring.nek.session;
	if (state.activePlan === snapshot.plan.path && activePlan(state)) return;
	wiring.epoch++;
	if (wiring.pendingImplementation) wiring.pendingImplementation.cancelled = true;
	state.activePlan = snapshot.plan.path;
	state.planStatus = "ready";
	persistLifecycle(wiring, ctx);
}

async function onPlanSettled(wiring: PlanWiring, event: AgentSettledEvent, ctx: ExtensionContext): Promise<void> {
	if (event.outcome !== "completed") {
		delete wiring.planCreated;
		return;
	}
	await offerPlanApproval(wiring, ctx);
}

async function offerPlanApproval(wiring: PlanWiring, ctx: ExtensionContext): Promise<void> {
	const created = wiring.planCreated;
	delete wiring.planCreated;
	const state = wiring.nek.session;
	const selected = activePlan(state);
	const plan = selected?.plan;
	if (
		!plan ||
		selected?.markdown === undefined ||
		!samePlanRevision(created, plan) ||
		state.planStatus !== "ready" ||
		state.mode !== "plan" ||
		!ctx.hasUI
	)
		return;
	if (ctx.ui.getEditorText().trim() || ctx.hasPendingMessages()) return;
	showPlanPreview(wiring, selected);
	const epoch = wiring.epoch;
	const choice = await showPlanApproval(ctx, selected);
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
		const text = `/${NEK_BUILD_COMMAND} ${planId(plan)} --fresh`;
		wiring.pendingImplementation = { text, reference: plan, cancelled: false };
		wiring.pi.sendUserMessage(text, { expandPromptTemplates: true });
	} else if (choice === "stay") markDraft(wiring, ctx);
	else if (choice === "exit") setMode(wiring, ctx, "agent");
}

function reviewedMarkdown(wiring: PlanWiring, plan: PlanRecord): string {
	const selected = activePlan(wiring.nek.session);
	if (wiring.nek.session.planStatus !== "ready" || !selected || !samePlanRevision(selected.plan, plan)) {
		throw new Error("This plan is being revised. Save and review the updated plan before implementation.");
	}
	if (readPlanBody(plan) !== selected.markdown.trim())
		throw new Error("The plan file changed after review. Revise and review it again before implementation.");
	return selected.markdown;
}

/**
 * Hand the approved snapshot to Agent mode: its todos become ordinary todos and the lifecycle stays `ready`.
 * Unrelated subsequent user input cancels the deferred approved-plan message.
 */
export function implementPlan(wiring: PlanWiring, ctx: ExtensionContext, plan: PlanRecord): void {
	const markdown = reviewedMarkdown(wiring, plan);
	const { pi, nek } = wiring;
	setMode(wiring, ctx, "agent");
	nek.session.todos = planTodos(plan);
	delete nek.session.todoOwner;
	pi.appendEntry<TodoListData>(NEK_TODOS_ENTRY_TYPE, { todos: nek.session.todos });
	persistLifecycle(wiring, ctx);
	syncTodoUi(ctx, nek.session.todos, nek.config.todo.widgetMaxLines);
	const text = approvedPlanMessage(plan.path, plan.revision, markdown);
	wiring.pendingImplementation = { text, reference: { path: plan.path, revision: plan.revision }, cancelled: false };
	pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
}

function buildArguments(args: string): { planId?: string; fresh: boolean } | undefined {
	const tokens = args.trim() ? args.trim().split(/\s+/) : [];
	const fresh = tokens.includes("--fresh");
	const ids = tokens.filter((token) => token !== "--fresh");
	return ids.length <= 1 ? { planId: ids[0], fresh } : undefined;
}

async function buildCommand(wiring: PlanWiring, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const pending = wiring.pendingImplementation;
	const pendingArgs = pending?.text.startsWith(`/${NEK_BUILD_COMMAND}`)
		? pending.text.slice(NEK_BUILD_COMMAND.length + 1).trim()
		: undefined;
	if (pendingArgs !== undefined && pendingArgs === args.trim()) {
		delete wiring.pendingImplementation;
		if (pending?.cancelled) return;
	}
	const parsed = buildArguments(args);
	if (!parsed) {
		ctx.ui.notify("Usage: /nek-build [plan_id] [--fresh]", "warning");
		return;
	}
	const selected = parsed.planId ? findPlan(wiring.nek.session, parsed.planId) : activePlan(wiring.nek.session);
	if (!selected) {
		ctx.ui.notify(
			parsed.planId
				? `Unknown plan_id "${parsed.planId}". Choose an id from /plans.`
				: "No active plan. Select one with /plans or create one in Plan mode.",
			"warning",
		);
		return;
	}
	if (
		pending &&
		pendingArgs === args.trim() &&
		(pending.cancelled || !samePlanRevision(pending.reference, selected.plan))
	)
		return;
	if (wiring.nek.session.activePlan !== selected.plan.path) activatePlan(wiring, ctx, selected);
	if (!ctx.isIdle()) {
		ctx.ui.notify("Interrupt the current run before starting plan implementation.", "warning");
		return;
	}
	if (!parsed.fresh) return implementPlan(wiring, ctx, selected.plan);
	const markdown = reviewedMarkdown(wiring, selected.plan);
	const message = freshImplementMessage(markdown);
	const todos = planTodos(selected.plan);
	await ctx.newSession({
		parentSession: ctx.sessionManager.getSessionFile(),
		setup: async (manager) => {
			manager.appendCustomEntry(NEK_MODE_ENTRY_TYPE, { mode: "agent" } satisfies ModeEntryData);
			manager.appendCustomEntry(NEK_PLAN_SNAPSHOT_ENTRY_TYPE, { plan: selected.plan, markdown } satisfies PlanData);
			manager.appendCustomEntry(NEK_TODOS_ENTRY_TYPE, { todos } satisfies TodoListData);
			manager.appendCustomEntry(NEK_PLAN_ENTRY_TYPE, {
				status: "ready",
				active: selected.plan.path,
			} satisfies PlanLifecycleData);
		},
		withSession: async (next) => next.sendUserMessage(message),
	});
}
