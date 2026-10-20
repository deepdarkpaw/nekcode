import type { Api, Model } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import type { AgentSession } from "../../../core/agent-session.ts";
import type {
	AgentToolUpdateCallback,
	ExtensionContext,
	ToolCallMemo,
	ToolDefinition,
} from "../../../core/extensions/types.ts";
import { backgroundSubagentStartText, formatSubagentResult, SUBAGENT_DESCRIPTION } from "../prompts/subagent.ts";
import { findAgentType } from "../services/agent-types.ts";
import { modelRef, resolveChildModel } from "../services/child-session.ts";
import type { SubagentRegistry } from "../services/subagent-registry.ts";
import type { AgentType, Mode, SubagentRecord, SubagentToolData } from "../types.ts";
import { createSubagentRenderers } from "../ui/subagent-view.ts";

/** Tool name of the subagent tool (snake_case, plan.md D3). */
export const SUBAGENT_TOOL_NAME = "subagent";

/** Default subagent_type when the call omits it (plan.md section 7.2). */
export const DEFAULT_AGENT_TYPE = "explorer";

/**
 * Cursor subagent schema (reference/cursor/cursor-tools-2026.json line 679) without the cloud and attachment fields.
 * Static, so the tool declaration never changes within a session; the type list lives in the `subagents` section.
 */
const subagentSchema = Type.Object({
	description: Type.String({
		description:
			"Short, specific title shown to the user as the subagent's name. When resuming, keep the title unless the subagent now works on a different task.",
	}),
	prompt: Type.String({
		description: "Self-contained task: goal, relevant context, whether files may be edited, and what to return.",
	}),
	subagent_type: Type.Optional(
		Type.String({
			description: `One of the types listed in the <subagents> section. Default: ${DEFAULT_AGENT_TYPE}.`,
		}),
	),
	model: Type.Optional(
		Type.String({
			description:
				"A type's preset model takes precedence; conflicting arguments are ignored with a warning. Other types accept provider/model, or 'inherit' (the default). Unavailable models warn and use the parent model. Set model only when the user explicitly asks for one. Ignored with resume.",
		}),
	),
	run_in_background: Type.Optional(
		Type.Boolean({
			description:
				"Return immediately and get a notification when the subagent completes. If false, this call blocks until it completes.",
		}),
	),
	resume: Type.Optional(
		Type.String({
			description:
				"Subagent id to continue with its context preserved; the prompt is sent as a follow-up. Fails for a running subagent unless interrupt is true.",
		}),
	),
	interrupt: Type.Optional(
		Type.Boolean({
			description:
				"With resume on a running subagent: interrupt its current run and send this prompt now. Only when the user asks to redirect it.",
		}),
	),
});

type SubagentSchema = typeof subagentSchema;

/** Validated subagent arguments. */
export type SubagentToolInput = Static<SubagentSchema>;

/** A child session request resolved by the subagent tool; the wiring turns it into createChildSession(). */
export interface ChildSessionRequest {
	type: AgentType;
	/** Undefined when reopening without a preset; otherwise the resolved preset, override, or parent model applies. */
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
	agentTypes: readonly AgentType[];
	getRegistry(): SubagentRegistry;
	getMode(): Mode;
	createSession(request: ChildSessionRequest, ctx: ExtensionContext): Promise<AgentSession>;
	/** Find a subagent that is not retained, so resume can reopen its session file. */
	findBranchSubagent(id: string, ctx: ExtensionContext): BranchSubagent | undefined;
	/** Restrict a resumed child to the tools of its type (read-only in plan mode). */
	restrictTools(session: AgentSession, type: AgentType, forceReadonly: boolean): void;
}

/** What a crash rerun of one subagent call needs to reattach to the child the first run started. */
type SubagentCallMemo = {
	id: string;
	sessionFile: string;
	description: string;
	type: string;
	prompt: string;
	background: boolean;
};

/** Tool call memo name of {@link SubagentCallMemo}. */
const SUBAGENT_MEMO = "nek.subagent";

/** Remember a started child before its prompt is sent; children without a session file cannot be reopened. */
type Remember = ((record: SubagentRecord) => Promise<void>) | undefined;

/** Snapshot of a record for tool details, so later activity does not mutate a stored result. */
export function snapshotSubagent(record: SubagentRecord): SubagentRecord {
	return { ...record };
}

function subagentResult(text: string, record: SubagentRecord, warnings: readonly string[] = []) {
	const notices = warnings.map((warning) => `Warning: ${warning}`).join("\n");
	return {
		content: [{ type: "text" as const, text: notices ? `${notices}\n\n${text}` : text }],
		details: { subagent: snapshotSubagent(record), ...(warnings.length > 0 ? { warnings: [...warnings] } : {}) },
	};
}

/** Report model substitutions before launch without changing the type or any persisted configuration. */
function selectSubagentModel(
	type: AgentType,
	requested: string | undefined,
	ctx: ExtensionContext,
	warn: (message: string) => void,
): Model<Api> {
	const preset = type.model?.trim();
	const override = requested?.trim();
	const selection = resolveChildModel(preset ?? override, ctx);
	const conflict = preset !== undefined && override !== undefined && override !== preset;
	const ignored = conflict ? `Ignoring model "${override}" for subagent type "${type.name}". ` : "";
	const notice = selection.warning ?? (conflict ? `Using preset model ${modelRef(selection.model)}.` : undefined);
	if (notice) warn(`${ignored}${notice}`);
	return selection.model;
}

/**
 * Cursor-style subagent tool as `subagent` (plan.md section 7.7). Starts or resumes an in-process subagent. Foreground calls block until
 * the child finishes and return its final text; background calls return at once and report through the completion
 * notice. Plan mode forces read-only children. The default parallel execution mode lets one message start several.
 *
 * Crash recovery: the call remembers its child in the tool call memo before the prompt is sent, and reruns after a
 * crash (`replay: "safe"`). The rerun reopens that child, whose session resumes the interrupted run, instead of
 * starting another one.
 */
export function createSubagentToolDefinition(
	options: SubagentToolOptions,
): ToolDefinition<SubagentSchema, SubagentToolData> {
	return {
		name: SUBAGENT_TOOL_NAME,
		label: "Subagent",
		description: SUBAGENT_DESCRIPTION,
		promptSnippet: "Delegate one bounded task to a subagent with its own context (types in <subagents>)",
		parameters: subagentSchema,
		replay: "safe",
		async execute(toolCallId, params: SubagentToolInput, signal, onUpdate, ctx) {
			const warnings: string[] = [];
			const warn = (message: string) => {
				warnings.push(message);
				if (ctx.hasUI) ctx.ui.notify(message, "warning");
			};
			const record = await startOrReattach(options, params, signal, ctx, ctx.getToolCallMemo?.(toolCallId), warn);
			if (record.background) return subagentResult(backgroundSubagentStartText(record), record, warnings);
			const done = await options.getRegistry().wait(record.id, activityReporter(onUpdate, warnings));
			if (done.background && done.status === "running") {
				return subagentResult(
					`Subagent ${done.id} ("${done.description}") moved to the background because the user sent a new message. You will be notified when it completes.`,
					done,
					warnings,
				);
			}
			return subagentResult(formatSubagentResult(done), done, warnings);
		},
		...createSubagentRenderers(options.getRegistry),
	};
}

function activityReporter(
	onUpdate: AgentToolUpdateCallback<SubagentToolData> | undefined,
	warnings: readonly string[],
) {
	if (!onUpdate) return undefined;
	return (record: SubagentRecord) => onUpdate(subagentResult(record.activity ?? "", record, warnings));
}

/** Start or resume the requested child, or reattach to the one a crashed run of this call started. */
async function startOrReattach(
	options: SubagentToolOptions,
	params: SubagentToolInput,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
	memo: ToolCallMemo | undefined,
	warn: (message: string) => void,
): Promise<SubagentRecord> {
	const previous = await memo?.get<SubagentCallMemo>(SUBAGENT_MEMO);
	if (previous !== undefined) {
		return options.getRegistry().get(previous.id) ?? reattachSubagent(options, previous, signal, ctx, warn);
	}
	const remember: Remember =
		memo &&
		(async (record) => {
			if (record.sessionFile === undefined) return;
			await memo.set<SubagentCallMemo>(SUBAGENT_MEMO, {
				id: record.id,
				sessionFile: record.sessionFile,
				description: record.description,
				type: record.type,
				prompt: params.prompt,
				background: record.background,
			});
		});
	return params.resume
		? resumeSubagent(options, params, signal, ctx, remember, warn)
		: startSubagent(options, params, signal, ctx, remember, warn);
}

async function reattachSubagent(
	options: SubagentToolOptions,
	previous: SubagentCallMemo,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
	warn: (message: string) => void,
): Promise<SubagentRecord> {
	const type = findAgentType(options.agentTypes, previous.type) ?? resolveAgentType(options, undefined);
	const forceReadonly = type.readonly || options.getMode() === "plan";
	return options.getRegistry().reattach({
		description: previous.description,
		type: previous.type,
		prompt: previous.prompt,
		background: previous.background,
		signal: previous.background ? undefined : signal,
		createSession: () =>
			options.createSession(
				{
					type,
					model: type.model !== undefined ? selectSubagentModel(type, undefined, ctx, warn) : undefined,
					forceReadonly,
					resumeFile: previous.sessionFile,
				},
				ctx,
			),
	});
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
	remember: Remember,
	warn: (message: string) => void,
): Promise<SubagentRecord> {
	const type = resolveAgentType(options, params.subagent_type);
	const model = selectSubagentModel(type, params.model, ctx, warn);
	const forceReadonly = type.readonly || options.getMode() === "plan";
	const background = params.run_in_background ?? type.background;
	return options.getRegistry().start({
		description: params.description,
		type: type.name,
		prompt: params.prompt,
		background,
		signal: background ? undefined : signal,
		createSession: () => options.createSession({ type, model, forceReadonly }, ctx),
		...(remember === undefined ? {} : { beforeLaunch: remember }),
	});
}

async function resumeSubagent(
	options: SubagentToolOptions,
	params: SubagentToolInput,
	signal: AbortSignal | undefined,
	ctx: ExtensionContext,
	remember: Remember,
	warn: (message: string) => void,
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
		...(remember === undefined ? {} : { beforeLaunch: remember }),
		reopen: branchSubagent && {
			description: params.description,
			type: branchSubagent.type,
			createSession: () =>
				options.createSession(
					{
						type,
						model: type.model !== undefined ? selectSubagentModel(type, undefined, ctx, warn) : undefined,
						forceReadonly,
						resumeFile: branchSubagent.sessionFile,
					},
					ctx,
				),
		},
	});
}
