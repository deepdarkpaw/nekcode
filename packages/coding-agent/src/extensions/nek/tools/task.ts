import type { Api, Model } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { AgentToolUpdateCallback, ExtensionContext, ToolDefinition } from "../../../core/extensions/types.ts";
import { backgroundStartText, formatTaskResult } from "../prompts/subagent.ts";
import { findAgentType } from "../services/agent-types.ts";
import { resolveChildModel } from "../services/child-session.ts";
import type { TaskRegistry } from "../services/task-registry.ts";
import type { AgentType, Mode, TaskRecord, TaskToolData } from "../types.ts";
import { taskRenderers } from "../ui/task-view.ts";

/** Tool name of the Cursor Task tool (snake_case, plan.md D3). */
export const TASK_TOOL_NAME = "task";

/** Default subagent_type when the call omits it (plan.md section 7.2). */
export const DEFAULT_AGENT_TYPE = "generalPurpose";

/** Cursor Task schema (reference/cursor/cursor-tools-2026.json line 679) without the cloud and attachment fields. */
function createTaskSchema(typeNames: readonly string[]) {
	return Type.Object({
		description: Type.String({
			description:
				"A short, user-friendly title for the subagent. This appears in the UI as the subagent's name. Make it concrete and distinct, consider recent titles to avoid reuse. For resumed subagents which you are prompting to work on a separate task, give an updated description based on the latest work the subagent is performing. (Do not rename if the subagent is continuing work on the same high-level task.)",
		}),
		prompt: Type.String({ description: "The task for the agent to perform" }),
		subagent_type: Type.Optional(
			Type.String({ description: `Subagent type to use for this task. Must be one of: ${typeNames.join(", ")}.` }),
		),
		model: Type.Optional(
			Type.String({
				description:
					"Optional model for this agent ('inherit' or provider/model). If omitted, the subagent uses the same model as the parent agent. Do not pass if resume is set (prior model will be used). Use \"inherit\" unless the user explicitly requested another listed model.",
			}),
		),
		run_in_background: Type.Optional(
			Type.Boolean({
				description:
					"Run the agent in the background. If this is false, you will be blocked until the agent completes. When true, the background subagent will send a notification when it completes.",
			}),
		),
		resume: Type.Optional(
			Type.String({
				description:
					"Optional agent ID to resume from. If provided, sends a follow-up message to the agent after it has completed. Requests to a currently running agent fail unless `interrupt` is true; set `interrupt` to true only when you intend to interrupt the running agent.",
			}),
		),
		interrupt: Type.Optional(
			Type.Boolean({
				description:
					"If true and `resume` targets a running agent, interrupt the current run and send this prompt immediately. Only use when the user explicitly asks to interrupt or change what the running agent is doing.",
			}),
		),
	});
}

type TaskSchema = ReturnType<typeof createTaskSchema>;

/** Validated task arguments. */
export type TaskToolInput = Static<TaskSchema>;

/** A child session request resolved by the task tool; the wiring turns it into createChildSession(). */
export interface ChildSessionRequest {
	type: AgentType;
	/** Undefined when resuming from a session file: the child keeps its previous model. */
	model: Model<Api> | undefined;
	forceReadonly: boolean;
	resumeFile?: string;
}

/** A task of the current branch that the registry no longer retains (from a previous task result). */
export interface BranchTask {
	description: string;
	type: string;
	sessionFile: string;
}

/** Access to the registry, the agent types, and the mode owned by the extension. */
export interface TaskToolOptions {
	/** Full description (TASK_DESCRIPTION plus the generated type and model sections). */
	description: string;
	agentTypes: readonly AgentType[];
	getRegistry(): TaskRegistry;
	getMode(): Mode;
	createSession(request: ChildSessionRequest, ctx: ExtensionContext): Promise<AgentSession>;
	/** Find a task that is not retained, so resume can reopen its session file. */
	findBranchTask(id: string, ctx: ExtensionContext): BranchTask | undefined;
	/** Restrict a resumed child to the tools of its type (read-only in plan mode). */
	restrictTools(session: AgentSession, type: AgentType, forceReadonly: boolean): void;
}

/** Snapshot of a record for tool details, so later progress does not mutate a stored result. */
export function snapshotTask(record: TaskRecord): TaskRecord {
	return { ...record, progress: [...record.progress] };
}

function taskResult(text: string, record: TaskRecord) {
	return { content: [{ type: "text" as const, text }], details: { task: snapshotTask(record) } };
}

/**
 * Cursor Task as `task` (plan.md section 7.7). Starts or resumes an in-process subagent. Foreground calls block until
 * the child finishes and return its final text; background calls return at once and report through the completion
 * notice. Plan mode forces read-only children. The default parallel execution mode lets one message start several.
 */
export function createTaskToolDefinition(options: TaskToolOptions): ToolDefinition<TaskSchema, TaskToolData> {
	return {
		name: TASK_TOOL_NAME,
		label: "task",
		description: options.description,
		parameters: createTaskSchema(options.agentTypes.map((type) => type.name)),
		async execute(_toolCallId, params: TaskToolInput, signal, onUpdate, ctx) {
			const record = params.resume
				? await resumeTask(options, params, signal, ctx)
				: await startTask(options, params, signal, ctx);
			if (record.background) return taskResult(backgroundStartText(record), record);
			const done = await options.getRegistry().wait(record.id, progressReporter(onUpdate));
			return taskResult(formatTaskResult(done), done);
		},
		...taskRenderers,
	};
}

function progressReporter(onUpdate: AgentToolUpdateCallback<TaskToolData> | undefined) {
	if (!onUpdate) return undefined;
	return (record: TaskRecord) => onUpdate(taskResult(record.progress.join("\n"), record));
}

function resolveAgentType(options: TaskToolOptions, name: string | undefined): AgentType {
	const requested = name ?? DEFAULT_AGENT_TYPE;
	const type = findAgentType(options.agentTypes, requested);
	if (type) return type;
	const available = options.agentTypes.map((agentType) => agentType.name).join(", ");
	throw new Error(`Unknown subagent_type "${requested}". Available subagent types: ${available}.`);
}

async function startTask(
	options: TaskToolOptions,
	params: TaskToolInput,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<TaskRecord> {
	const type = resolveAgentType(options, params.subagent_type);
	const model = resolveChildModel(params.model ?? type.model, ctx);
	const forceReadonly = type.readonly || options.getMode() === "plan";
	const background = params.run_in_background ?? type.background;
	return options.getRegistry().start({
		description: params.description,
		type: type.name,
		prompt: params.prompt,
		background,
		signal: background ? undefined : signal,
		createSession: () => options.createSession({ type, model, forceReadonly }, ctx),
	});
}

async function resumeTask(
	options: TaskToolOptions,
	params: TaskToolInput,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<TaskRecord> {
	const id = params.resume ?? "";
	const registry = options.getRegistry();
	const retained = registry.get(id);
	const branchTask = retained ? undefined : options.findBranchTask(id, ctx);
	const typeName = retained?.type ?? branchTask?.type;
	if (!typeName) throw new Error(`Unknown subagent ${id}.`);
	const type = findAgentType(options.agentTypes, typeName) ?? resolveAgentType(options, undefined);
	const forceReadonly = type.readonly || options.getMode() === "plan";
	const background = params.run_in_background ?? retained?.background ?? type.background;
	return registry.resume({
		id,
		prompt: params.prompt,
		interrupt: params.interrupt === true,
		background,
		signal: background ? undefined : signal,
		prepare: (session) => options.restrictTools(session, type, forceReadonly),
		reopen: branchTask && {
			description: params.description,
			type: branchTask.type,
			createSession: () =>
				options.createSession({ type, model: undefined, forceReadonly, resumeFile: branchTask.sessionFile }, ctx),
		},
	});
}
