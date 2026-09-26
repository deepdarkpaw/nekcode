import type { KeyId } from "@earendil-works/pi-tui";
import type {
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	SessionStartEvent,
} from "../../core/extensions/types.ts";
import { NEK_REMINDER_TYPE, type NekRuntime } from "./index.ts";
import { freshImplementMessage, IMPLEMENT_PLAN_MESSAGE } from "./prompts/implement.ts";
import { MODE_SELECTION } from "./prompts/mode-selection.ts";
import { modeReminder } from "./prompts/plan-mode.ts";
import { planTodos, readPlanBody } from "./services/plan-store.ts";
import { checkModeToolCall, modeToolNames } from "./state/mode-rules.ts";
import { NEK_MODE_ENTRY_TYPE, NEK_TODOS_ENTRY_TYPE } from "./state/session-state.ts";
import { createAskQuestionToolDefinition } from "./tools/ask-question.ts";
import { createCreatePlanToolDefinition } from "./tools/create-plan.ts";
import { createSwitchModeToolDefinition } from "./tools/switch-mode.ts";
import type { Mode, ModeEntryData, PlanRecord, TodoListData } from "./types.ts";
import { showPlanApproval } from "./ui/plan-approval.ts";
import { syncTodoUi } from "./ui/todo-widget.ts";

/** Status key of the plan mode indicator. */
export const MODE_STATUS_KEY = "nek.mode";

/** Command that implements the current plan; `--fresh` starts a new session first. Used by the approval panel. */
export const NEK_BUILD_COMMAND = "nek-build";

/** CLI flag that starts the session in plan mode. */
export const PLAN_FLAG = "plan";

/** Plan mode wiring of one root nek instance. */
export interface PlanWiring {
	pi: ExtensionAPI;
	nek: NekRuntime;
	/** Mode the model was last told about; a different current mode adds the enter notice to the next submission. */
	announcedMode: Mode;
	/** create_plan succeeded in the current run; cleared when the run settles. */
	planCreated: boolean;
}

/**
 * Wire Cursor-style plan mode into a root session: switch_mode, create_plan, and ask_question; the mode_selection
 * section and per-submission reminders; the markdown-only edit guard; `/plan`, the toggle shortcut, `--plan`; and the
 * "Implement this plan?" panel after a run that created a plan.
 */
export function registerPlanMode(pi: ExtensionAPI, nek: NekRuntime): void {
	const wiring: PlanWiring = { pi, nek, announcedMode: nek.session.mode, planCreated: false };
	registerPlanTools(wiring);
	registerPlanCommands(wiring);
	pi.on("session_start", (event, ctx) => onSessionStart(wiring, event, ctx));
	pi.on("session_tree", (_event, ctx) => restoreMode(wiring, ctx));
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections.mode_selection = MODE_SELECTION;
		return modeReminderMessage(wiring);
	});
	pi.on("tool_call", (event) => {
		const reason = checkModeToolCall(nek.session.mode, event.toolName, event.input);
		return reason ? { block: true, reason } : undefined;
	});
	pi.on("agent_settled", (_event, ctx) => offerPlanApproval(wiring, ctx));
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
			setPlan: (plan) => {
				nek.session.plan = plan;
				wiring.planCreated = true;
			},
		}),
	);
	pi.registerTool(createAskQuestionToolDefinition());
}

function registerPlanCommands(wiring: PlanWiring): void {
	const { pi } = wiring;
	pi.registerCommand("plan", {
		description: "Toggle plan mode; with text, enter plan mode and submit the text",
		handler: async (args, ctx) => planCommand(wiring, args, ctx),
	});
	pi.registerCommand(NEK_BUILD_COMMAND, {
		description: "Implement the current plan (--fresh: in a new session)",
		handler: (args, ctx) => buildCommand(wiring, args, ctx),
	});
	pi.registerFlag(PLAN_FLAG, { description: "Start in plan mode", type: "boolean" });
}

function onSessionStart(wiring: PlanWiring, event: SessionStartEvent, ctx: ExtensionContext): void {
	const { pi, nek } = wiring;
	pi.registerShortcut(nek.config.plan.shortcut as KeyId, {
		description: "Toggle plan mode",
		handler: (shortcutCtx) => setMode(wiring, shortcutCtx, otherMode(nek.session.mode)),
	});
	restoreMode(wiring, ctx);
	if (event.reason === "startup" && pi.getFlag(PLAN_FLAG) === true) setMode(wiring, ctx, "plan");
}

/** Re-apply the replayed mode (session start, tree navigation): tools, status, and the announced mode. */
function restoreMode(wiring: PlanWiring, ctx: ExtensionContext): void {
	wiring.announcedMode = wiring.nek.session.mode;
	syncMode(wiring, ctx);
}

/** Switch modes: record a `nek.mode` entry, update the state, and re-sync the active tools and the status. */
export function setMode(wiring: PlanWiring, ctx: ExtensionContext, next: Mode): void {
	if (wiring.nek.session.mode === next) return;
	wiring.pi.appendEntry<ModeEntryData>(NEK_MODE_ENTRY_TYPE, { mode: next });
	wiring.nek.session.mode = next;
	syncMode(wiring, ctx);
}

function syncMode(wiring: PlanWiring, ctx: ExtensionContext): void {
	const mode = wiring.nek.session.mode;
	wiring.pi.setActiveTools(modeToolNames(wiring.pi.getActiveTools(), mode));
	if (ctx.hasUI) ctx.ui.setStatus(MODE_STATUS_KEY, mode === "plan" ? "plan" : undefined);
}

function otherMode(mode: Mode): Mode {
	return mode === "plan" ? "agent" : "plan";
}

function modeReminderMessage(wiring: PlanWiring): BeforeAgentStartEventResult | undefined {
	const mode = wiring.nek.session.mode;
	const content = modeReminder(mode, mode !== wiring.announcedMode);
	wiring.announcedMode = mode;
	if (!content) return undefined;
	return { message: { customType: NEK_REMINDER_TYPE, content, display: false } };
}

function planCommand(wiring: PlanWiring, args: string, ctx: ExtensionCommandContext): void {
	const text = args.trim();
	setMode(wiring, ctx, text ? "plan" : otherMode(wiring.nek.session.mode));
	if (!text) return;
	wiring.pi.sendUserMessage(text, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
}

/** After a run that created a plan: offer the Codex panel when the user is not already typing or queueing input. */
async function offerPlanApproval(wiring: PlanWiring, ctx: ExtensionContext): Promise<void> {
	const created = wiring.planCreated;
	wiring.planCreated = false;
	const plan = wiring.nek.session.plan;
	if (!created || !plan || wiring.nek.session.mode !== "plan" || !ctx.hasUI) return;
	if (ctx.ui.getEditorText().trim() !== "" || ctx.hasPendingMessages()) return;
	const choice = await showPlanApproval(ctx);
	if (choice === "implement") implementPlan(wiring, ctx, plan);
	if (choice === "fresh") wiring.pi.sendUserMessage(`/${NEK_BUILD_COMMAND} --fresh`, { expandPromptTemplates: true });
}

/** Implement in the current session: agent mode, the plan todos as a `nek.todos` entry, then "Implement the plan.". */
export function implementPlan(wiring: PlanWiring, ctx: ExtensionContext, plan: PlanRecord): void {
	const { pi, nek } = wiring;
	setMode(wiring, ctx, "agent");
	const todos = planTodos(plan);
	pi.appendEntry<TodoListData>(NEK_TODOS_ENTRY_TYPE, { todos });
	nek.session.todos = todos;
	syncTodoUi(ctx, todos, nek.config.todo.widgetMaxLines);
	pi.sendUserMessage(IMPLEMENT_PLAN_MESSAGE, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
}

async function buildCommand(wiring: PlanWiring, args: string, ctx: ExtensionCommandContext): Promise<void> {
	const plan = wiring.nek.session.plan;
	if (!plan) {
		ctx.ui.notify("No plan on this branch. Create one in plan mode first.", "warning");
		return;
	}
	if (args.trim() !== "--fresh") return implementPlan(wiring, ctx, plan);
	const message = freshImplementMessage(readPlanBody(plan));
	const todos = planTodos(plan);
	await ctx.newSession({
		parentSession: ctx.sessionManager.getSessionFile(),
		setup: async (sessionManager) => {
			sessionManager.appendCustomEntry(NEK_MODE_ENTRY_TYPE, { mode: "agent" } satisfies ModeEntryData);
			sessionManager.appendCustomEntry(NEK_TODOS_ENTRY_TYPE, { todos } satisfies TodoListData);
		},
		withSession: async (next) => next.sendUserMessage(message),
	});
}
