import { getAgentDir } from "../../config.ts";
import type {
	AgentBeforeSettleEvent,
	BoundaryResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
} from "../../core/extensions/types.ts";
import { DEFAULT_NEK_CONFIG, loadNekConfig, type NekConfig } from "./config.ts";
import { registerPlanMode } from "./plan-wiring.ts";
import { openTodosReminder, TASK_MANAGEMENT } from "./prompts/task-management.ts";
import { registerSubagentPrompts } from "./services/subagent-role.ts";
import { createSessionState, replayBranch, todosAreActive } from "./state/session-state.ts";
import { describeTodos, openTodos } from "./state/todos.ts";
import { registerSubagents } from "./task-wiring.ts";
import { createTodoWriteToolDefinition } from "./tools/todo-write.ts";
import type { NekSessionState } from "./types.ts";
import { showTodoList, syncTodoUi } from "./ui/todo-widget.ts";

/** `root` wires the main session; `subagent` wires a child session (no task/await, so no nesting). */
export type NekRole = "root" | "subagent";

/** Options for one nek extension instance. */
export interface NekExtensionOptions {
	role: NekRole;
	/** Fixed config, e.g. inherited by child sessions. When omitted, nek.yaml is loaded on session_start. */
	config?: NekConfig;
	/** Subagent role only: instructions of the delegated agent type, added as a system prompt section. */
	instructions?: string;
}

/** Per-instance state shared by the tools, hooks, and UI of one nek extension. */
export interface NekRuntime {
	role: NekRole;
	config: NekConfig;
	/** Branch-scoped state, rebuilt by replayBranch() on session_start and session_tree. */
	session: NekSessionState;
	/** The open-todos reminder already continued the current run; cleared when the run settles. */
	settleReminderSent: boolean;
	/** A user interruption blocks automatic work until a new explicit request starts. */
	automaticWorkAllowed: boolean;
}

/** Custom message type of hidden nek reminders. */
export const NEK_REMINDER_TYPE = "nek.reminder";

/**
 * Create the nek extension factory for the given role. Root: subagents, todos, plan mode; subagent: todos and the
 * subagent prompts only. Subagents register first so their completion notices precede the open-todos reminder in
 * `agent_before_settle`.
 */
export function createNekExtension(options: NekExtensionOptions): ExtensionFactory {
	return (pi) => {
		const nek: NekRuntime = {
			role: options.role,
			config: options.config ?? DEFAULT_NEK_CONFIG,
			session: createSessionState(),
			settleReminderSent: false,
			automaticWorkAllowed: true,
		};
		pi.on("session_start", (_event, ctx) => {
			if (!options.config) nek.config = loadNekConfig(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());
			restoreSessionState(nek, ctx);
		});
		pi.on("session_tree", (_event, ctx) => restoreSessionState(nek, ctx));
		pi.on("agent_settled", (event) => {
			nek.automaticWorkAllowed = event.outcome === "completed";
		});
		if (options.role === "root") registerSubagents(pi, nek);
		else registerSubagentPrompts(pi, options.instructions);
		registerTodos(pi, nek);
		if (options.role === "root") registerPlanMode(pi, nek);
	};
}

function restoreSessionState(nek: NekRuntime, ctx: ExtensionContext): void {
	nek.session = replayBranch(ctx.sessionManager.getBranch());
	syncTodoUi(ctx, nek.session.todos, nek.config.todo.widgetMaxLines);
}

function registerTodos(pi: ExtensionAPI, nek: NekRuntime): void {
	pi.registerTool(
		createTodoWriteToolDefinition({
			getTodos: () => (todosAreActive(nek.session) ? nek.session.todos : []),
			getOwner: () =>
				nek.session.mode === "plan"
					? "planning"
					: nek.session.execution?.status === "active"
						? nek.session.todoOwner
						: undefined,
			setTodos: (todos, ctx, owner) => {
				nek.session.todos = todos;
				if (owner) nek.session.todoOwner = owner;
				else delete nek.session.todoOwner;
				syncTodoUi(ctx, todos, nek.config.todo.widgetMaxLines);
			},
		}),
	);
	pi.registerCommand("todos", {
		description: "Show the todo list of the current branch",
		handler: (_args, ctx) => showTodoList(ctx, nek.session.todos),
	});
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections.task_management = TASK_MANAGEMENT;
	});
	pi.on("agent_before_settle", (event) => remindOpenTodos(nek, event));
	pi.on("agent_settled", () => {
		nek.settleReminderSent = false;
	});
}

/** Continue a completed agent-mode run once when todos are still open (Cursor task_management). */
function remindOpenTodos(nek: NekRuntime, event: AgentBeforeSettleEvent): BoundaryResult | undefined {
	if (event.outcome !== "completed" || !nek.config.todo.settleReminder) return undefined;
	if (nek.settleReminderSent || nek.session.mode !== "agent" || !todosAreActive(nek.session)) return undefined;
	const open = openTodos(nek.session.todos);
	if (open.length === 0) return undefined;
	nek.settleReminderSent = true;
	const reminder = {
		type: "custom_message" as const,
		customType: NEK_REMINDER_TYPE,
		content: openTodosReminder(describeTodos(open)),
		display: false,
	};
	return { entries: [...event.entries, reminder], continue: true };
}
