import type { Api, Model } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { AgentSession } from "../../../core/agent-session.ts";
import type { AgentToolUpdateCallback, ExtensionContext, ToolDefinition } from "../../../core/extensions/types.ts";
import { backgroundSubagentStartText, formatSubagentResult } from "../prompts/subagent.ts";
import { findAgentType } from "../services/agent-types.ts";
import { resolveChildModel } from "../services/child-session.ts";
import type { SubagentRegistry } from "../services/subagent-registry.ts";
import type { AgentType, Mode, SubagentRecord, SubagentToolData } from "../types.ts";
import { createSubagentRenderers } from "../ui/subagent-view.ts";

/** Tool name of the subagent tool (snake_case, plan.md D3). */
export const SUBAGENT_TOOL_NAME = "subagent";

/** Default subagent_type when the call omits it (plan.md section 7.2). */
export const DEFAULT_AGENT_TYPE = "generalPurpose";

/** Cursor subagent schema (reference/cursor/cursor-tools-2026.json line 679) without the cloud and attachment fields. */
function createSubagentSchema(typeNames: readonly string[]) {
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

type SubagentSchema = ReturnType<typeof createSubagentSchema>;

/** Validated subagent arguments. */
export type SubagentToolInput = Static<SubagentSchema>;

/** A child session request resolved by the subagent tool; the wiring turns it into createChildSession(). */
export interface ChildSessionRequest {
	type: AgentType;
	/** Undefined when resuming from a session file: the child keeps its previous model. */
	model: Model<Api> | undefined;
	forceReadonly: boolean;
	resumeFile?: string;
}

/** A subagent of the current branch that the registry no longer retains (from a previous subagent result). */
export interface BranchSubagent {
	description: string;
	type: string;
	sessionFile: string;
}

/** Access to the registry, the agent types, and the mode owned by the extension. */
export interface SubagentToolOptions {
	/** Full description (SUBAGENT_DESCRIPTION plus the generated type and model sections). */
	description: string;
	agentTypes: readonly AgentType[];
	getRegistry(): SubagentRegistry;
	getMode(): Mode;
	createSession(request: ChildSessionRequest, ctx: ExtensionContext): Promise<AgentSession>;
	/** Find a subagent that is not retained, so resume can reopen its session file. */
	findBranchSubagent(id: string, ctx: ExtensionContext): BranchSubagent | undefined;
	/** Restrict a resumed child to the tools of its type (read-only in plan mode). */
	restrictTools(session: AgentSession, type: AgentType, forceReadonly: boolean): void;
}

/** Snapshot of a record for tool details, so later activity does not mutate a stored result. */
export function snapshotSubagent(record: SubagentRecord): SubagentRecord {
	return { ...record };
}

function subagentResult(text: string, record: SubagentRecord) {
	return { content: [{ type: "text" as const, text }], details: { subagent: snapshotSubagent(record) } };
}

/**
 * Cursor-style subagent tool as `subagent` (plan.md section 7.7). Starts or resumes an in-process subagent. Foreground calls block until
 * the child finishes and return its final text; background calls return at once and report through the completion
 * notice. Plan mode forces read-only children. The default parallel execution mode lets one message start several.
 */
export function createSubagentToolDefinition(
	options: SubagentToolOptions,
): ToolDefinition<SubagentSchema, SubagentToolData> {
	return {
		name: SUBAGENT_TOOL_NAME,
		label: "Subagent",
		description: options.description,
		parameters: createSubagentSchema(options.agentTypes.map((type) => type.name)),
		async execute(_toolCallId, params: SubagentToolInput, signal, onUpdate, ctx) {
			const record = params.resume
				? await resumeSubagent(options, params, signal, ctx)
				: await startSubagent(options, params, signal, ctx);
			if (record.background) return subagentResult(backgroundSubagentStartText(record), record);
			const done = await options.getRegistry().wait(record.id, activityReporter(onUpdate));
			if (done.background && done.status === "running") {
				return subagentResult(
					`Subagent ${done.id} ("${done.description}") moved to the background because the user sent a new message. You will be notified when it completes.`,
					done,
				);
			}
			return subagentResult(formatSubagentResult(done), done);
		},
		...createSubagentRenderers(options.getRegistry),
	};
}

function activityReporter(onUpdate: AgentToolUpdateCallback<SubagentToolData> | undefined) {
	if (!onUpdate) return undefined;
	return (record: SubagentRecord) => onUpdate(subagentResult(record.activity ?? "", record));
}

function resolveAgentType(options: SubagentToolOptions, name: string | undefined): AgentType {
	const requested = name ?? DEFAULT_AGENT_TYPE;
	const type = findAgentType(options.agentTypes, requested);
	if (type) return type;
	const available = options.agentTypes.map((agentType) => agentType.name).join(", ");
	throw new Error(`Unknown subagent_type "${requested}". Available subagent types: ${available}.`);
}

async function startSubagent(
	options: SubagentToolOptions,
	params: SubagentToolInput,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<SubagentRecord> {
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

async function resumeSubagent(
	options: SubagentToolOptions,
	params: SubagentToolInput,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
): Promise<SubagentRecord> {
	const id = params.resume ?? "";
	const registry = options.getRegistry();
	const retained = registry.get(id);
	const branchSubagent = retained ? undefined : options.findBranchSubagent(id, ctx);
	const typeName = retained?.type ?? branchSubagent?.type;
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
		reopen: branchSubagent && {
			description: params.description,
			type: branchSubagent.type,
			createSession: () =>
				options.createSession(
					{ type, model: undefined, forceReadonly, resumeFile: branchSubagent.sessionFile },
					ctx,
				),
		},
	});
}
