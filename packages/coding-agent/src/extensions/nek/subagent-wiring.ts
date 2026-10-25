import { getAgentDir } from "../../config.ts";
import type { AgentSession } from "../../core/agent-session.ts";
import type {
	AgentBeforeSettleEvent,
	BoundaryResult,
	CustomMessageEntryDraft,
	ExtensionAPI,
	ExtensionContext,
} from "../../core/extensions/types.ts";
import { type MentionTarget, withMentionCompletions } from "../../modes/interactive/mention-autocomplete.ts";
import { createNekExtension, type NekRuntime } from "./index.ts";
import { completionNotice, SUBAGENTS_SECTION, subagentsSection } from "./prompts/subagent.ts";
import { BUILTIN_AGENT_TYPES, describeAgentTypes, discoverAgentTypes } from "./services/agent-types.ts";
import { childToolNames, createChildSession, modelRef } from "./services/child-session.ts";
import { SubagentRegistry } from "./services/subagent-registry.ts";
import { todosAreActive } from "./state/session-state.ts";
import { createAwaitToolDefinition } from "./tools/await.ts";
import { createStopSubagentToolDefinition } from "./tools/stop-subagent.ts";
import {
	type BranchSubagent,
	type ChildSessionRequest,
	createSubagentToolDefinition,
	SUBAGENT_TOOL_NAME,
} from "./tools/subagent.ts";
import type { AgentType, SubagentNoticeData, SubagentRecord } from "./types.ts";
import { applySubagentWidget, renderSubagentNotice, SUBAGENT_NOTICE_TYPE, showSubagents } from "./ui/subagent-view.ts";

/** Subagent wiring of one root nek instance. */
export interface SubagentWiring {
	pi: ExtensionAPI;
	nek: NekRuntime;
	/** Built-in, user, and project types; rediscovered on every session_start. */
	agentTypes: readonly AgentType[];
	/** Scoped models (`provider/id`) listed as model overrides in the `subagents` section; set on session_start. */
	models: readonly string[];
	/** Created on first use with the loaded config; process-scoped, disposed on session_shutdown. */
	registry: SubagentRegistry | undefined;
	/** Latest context, used by background completions that arrive outside any event. */
	ctx: ExtensionContext | undefined;
	/**
	 * Start of the parent's current run (`Date.now()`); aborting the run stops the subagents launched since. A run
	 * resumed after a restart announces no `agent_start`, so session_start sets it too.
	 */
	runStartedAt: number;
}

/**
 * Wire Cursor-style subagents into a root session (plan.md section 7): the subagent and await tools, the background
 * completion notice (idle: new turn, or next submission in plan mode; running: `agent_before_settle`), `/subagents`, the
 * `nek.subagent_notice` renderer, the running-subagent status, and disposal on shutdown. Register before the todo guard so
 * notices are appended before the open-todos reminder.
 */
export function registerSubagents(pi: ExtensionAPI, nek: NekRuntime): void {
	const wiring: SubagentWiring = {
		pi,
		nek,
		agentTypes: BUILTIN_AGENT_TYPES,
		models: [],
		registry: undefined,
		ctx: undefined,
		runStartedAt: Date.now(),
	};
	registerSubagentTools(wiring);
	pi.registerMessageRenderer<SubagentNoticeData>(SUBAGENT_NOTICE_TYPE, renderSubagentNotice);
	pi.registerCommand("subagents", {
		description: "List subagents; cancel one or show its result",
		handler: (_args, ctx) => showSubagents(ctx, getRegistry(wiring)),
	});
	pi.registerCommand("agents", {
		description: "List available subagent presets",
		handler: async (_args, ctx) => {
			ctx.ui.notify(describeAgentTypes(wiring.agentTypes), "info");
		},
	});
	pi.on("session_start", (_event, ctx) => onSessionStart(wiring, ctx));
	// Types and models change only on session_start, so the section stays byte-identical for the whole session.
	pi.on("before_agent_start", (event) => {
		event.systemPromptOptions.sections[SUBAGENTS_SECTION] = subagentsSection(
			describeAgentTypes(wiring.agentTypes),
			wiring.models,
		);
	});
	pi.on("input_queued", (event) => {
		if (event.behavior === "steer" && event.source !== "extension") wiring.registry?.interruptWaits();
	});
	pi.on("agent_before_settle", (event, ctx) => {
		wiring.ctx = ctx;
		return settleNotices(wiring, event);
	});
	pi.on("agent_start", () => {
		wiring.runStartedAt = Date.now();
	});
	pi.on("agent_settled", (event, ctx) => {
		wiring.ctx = ctx;
		if (event.outcome === "aborted") stopRunSubagents(wiring, ctx);
		deliverIdleNotices(wiring);
	});
	pi.on("session_shutdown", async () => {
		const registry = wiring.registry;
		wiring.registry = undefined;
		wiring.ctx = undefined;
		await registry?.disposeAll();
	});
}

/**
 * The user aborted the parent run (Escape, or a mode change while it ran): stop every subagent that run launched,
 * background ones included, as a foreground call's abort signal already does. Not awaited, so settlement is not held
 * up by a child that is slow to stop; a failure is reported.
 */
function stopRunSubagents(wiring: SubagentWiring, ctx: ExtensionContext): void {
	const registry = wiring.registry;
	if (!registry) return;
	void registry.abortLaunchedSince(wiring.runStartedAt).catch((error: unknown) => {
		const message = `Could not stop the subagents of the aborted run: ${error instanceof Error ? error.message : String(error)}`;
		if (ctx.hasUI) ctx.ui.notify(message, "error");
		else console.error(message);
	});
}

function onSessionStart(wiring: SubagentWiring, ctx: ExtensionContext): void {
	wiring.ctx = ctx;
	wiring.runStartedAt = Date.now();
	const discovery = discoverAgentTypes(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());
	wiring.agentTypes = discovery.types;
	if (discovery.errors.length > 0 && ctx.hasUI) {
		ctx.ui.notify(`Some subagent definitions could not be loaded:\n${discovery.errors.join("\n")}`, "warning");
	}
	wiring.models = ctx.scopedModels.map((scoped) => modelRef(scoped.model));
	registerSubagentTools(wiring);
	// The UI drops extension autocomplete wrappers whenever the session is replaced or reloaded, so add it per session.
	ctx.ui.addAutocompleteProvider((current) =>
		withMentionCompletions(current, () => agentMentionTargets(wiring.agentTypes)),
	);
}

/** `@agent:<type>` completion targets, in the order of the `subagents` section. */
function agentMentionTargets(types: readonly AgentType[]): MentionTarget[] {
	return types.map((type) => ({ kind: "agent", name: type.name, description: type.description }));
}

/** (Re)register subagent, await, and stop_subagent; re-registering subagent validates against the current types. */
function registerSubagentTools(wiring: SubagentWiring): void {
	const { pi, nek } = wiring;
	pi.registerTool(
		createSubagentToolDefinition({
			agentTypes: wiring.agentTypes,
			getRegistry: () => getRegistry(wiring),
			getMode: () => nek.session.mode,
			createSession: (request, ctx) => createSubagentSession(wiring, request, ctx),
			findBranchSubagent,
			restrictTools: (session, type, forceReadonly) =>
				session.setActiveToolsByName(childToolNames(type, forceReadonly)),
		}),
	);
	pi.registerTool(createAwaitToolDefinition({ getRegistry: () => getRegistry(wiring) }));
	pi.registerTool(createStopSubagentToolDefinition({ getRegistry: () => getRegistry(wiring) }));
}

function getRegistry(wiring: SubagentWiring): SubagentRegistry {
	wiring.registry ??= new SubagentRegistry(
		wiring.nek.config.subagent,
		() => deliverIdleNotices(wiring),
		() => syncSubagentStatus(wiring),
	);
	return wiring.registry;
}

function createSubagentSession(
	wiring: SubagentWiring,
	request: ChildSessionRequest,
	ctx: ExtensionContext,
): Promise<AgentSession> {
	const extension = createNekExtension({
		role: "subagent",
		config: wiring.nek.config,
		instructions: request.type.instructions,
	});
	return createChildSession({
		parentCtx: ctx,
		type: request.type,
		model: request.model,
		thinkingLevel: request.type.thinking ?? (request.model ? wiring.pi.getThinkingLevel() : undefined),
		forceReadonly: request.forceReadonly,
		agentDir: getAgentDir(),
		extension,
		resumeFile: request.resumeFile,
	});
}

/** The last subagent result on the current branch for `id` that names a session file (resume after eviction/restart). */
function findBranchSubagent(id: string, ctx: ExtensionContext): BranchSubagent | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
		if (entry.message.toolName !== SUBAGENT_TOOL_NAME) continue;
		const subagent = readSubagentDetails(entry.message.details);
		if (subagent?.id === id && subagent.sessionFile) {
			return { description: subagent.description, type: subagent.type, sessionFile: subagent.sessionFile };
		}
	}
	return undefined;
}

function readSubagentDetails(details: unknown): SubagentRecord | undefined {
	if (typeof details !== "object" || details === null || !("subagent" in details)) return undefined;
	const subagent = details.subagent as Partial<SubagentRecord> | undefined;
	if (typeof subagent?.id !== "string" || typeof subagent.type !== "string") return undefined;
	return subagent as SubagentRecord;
}

function noticeDetails(record: SubagentRecord): SubagentNoticeData {
	return { subagent: { ...record } };
}

function noticeDraft(record: SubagentRecord): CustomMessageEntryDraft {
	const content = completionNotice(record);
	return {
		type: "custom_message",
		customType: SUBAGENT_NOTICE_TYPE,
		content,
		display: true,
		details: noticeDetails(record),
	};
}

/**
 * `agent_before_settle`: append a notice per unobserved finished subagent. The run continues only in agent mode after a
 * completed run; plan mode never starts automatic work (Codex), and an aborted run stays stopped.
 */
function settleNotices(wiring: SubagentWiring, event: AgentBeforeSettleEvent): BoundaryResult | undefined {
	const done = wiring.registry?.drainUnobserved() ?? [];
	if (done.length === 0) return undefined;
	const proceed =
		event.outcome === "completed" &&
		wiring.nek.session.mode !== "plan" &&
		wiring.nek.automaticWorkAllowed &&
		todosAreActive(wiring.nek.session);
	return { entries: [...event.entries, ...done.map(noticeDraft)], continue: event.continue || proceed };
}

/**
 * Deliver finished background results while the parent is idle: a new turn in agent mode, or attached to the next
 * submission in plan mode. While the parent runs, `agent_before_settle` picks them up instead.
 */
function deliverIdleNotices(wiring: SubagentWiring): void {
	const ctx = wiring.ctx;
	if (!wiring.registry || !ctx?.isIdle()) return;
	const defer =
		wiring.nek.session.mode === "plan" || !wiring.nek.automaticWorkAllowed || !todosAreActive(wiring.nek.session);
	for (const record of wiring.registry.drainUnobserved()) {
		const message = {
			customType: SUBAGENT_NOTICE_TYPE,
			content: completionNotice(record),
			display: true,
			details: noticeDetails(record),
		};
		wiring.pi.sendMessage<SubagentNoticeData>(message, defer ? { deliverAs: "nextTurn" } : { triggerTurn: true });
	}
}

/** Refresh the running-subagent widget above the editor; removes it when nothing is running in the background. */
function syncSubagentStatus(wiring: SubagentWiring): void {
	const ctx = wiring.ctx;
	if (!ctx?.hasUI || !wiring.registry) return;
	applySubagentWidget(ctx.ui, wiring.registry.list(), ctx.ui.theme);
}
