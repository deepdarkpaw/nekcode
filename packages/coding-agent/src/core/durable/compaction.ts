import type { Context } from "@earendil-works/chord";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Message, Model, Models, RetryPolicy, Usage } from "@earendil-works/pi-ai";
import {
	CompactionEntry,
	type CompactionHooks,
	type ContextView,
	type EntryRecord,
	type Harness,
	type HookApi,
	UsageDoc,
} from "@earendil-works/pi-durable";
import { formatNoApiKeyFoundMessage } from "../auth-guidance.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	type CompactionSettings,
	compact,
	createFileOps,
	estimateContextTokens,
	extractFileOpsFromMessage,
	resolveCompactionModel,
	resolveCompactionThinkingLevel,
} from "../compaction/index.ts";
import { agentContext } from "./context.ts";
import {
	CompactionDetailsDoc,
	type CompactionRecord,
	compactionDetails,
	compactionSummaryText,
	hashSummary,
	MAX_COMPACTION_RECORDS,
} from "./entries.ts";
import type { DurableHostHooks } from "./hooks.ts";
import { toStrictJson } from "./json.ts";

type BeforeCompact = CompactionHooks["beforeCompact"];
type DurableCompaction = Parameters<BeforeCompact>[0];

/** What the compaction bridge needs from the engine. */
export type CompactionBridge = {
	readonly harness: () => Harness;
	readonly models: Models;
	readonly hooks: DurableHostHooks;
	/** Pi's compaction settings for the current model. */
	readonly settings: () => CompactionSettings;
	/** The `compaction.model` setting; unset summarizes with the conversation's model. */
	readonly compactionModel: () => string | undefined;
	/** The `compaction.thinkingLevel` setting; unset summarizes at the conversation's level. */
	readonly compactionThinkingLevel: () => ThinkingLevel | undefined;
	/** Throws when a configured compaction model cannot authenticate; its requests still resolve auth in `models`. */
	readonly compactionAuth: (model: Model<Api>, signal: AbortSignal) => Promise<void>;
	/** Retry policy for the summarization call. */
	readonly retry: () => RetryPolicy;
	readonly report: (error: unknown) => void;
};

/** Default `compactionAuth`: the model's provider must resolve auth in `models`. */
export function requireModelAuth(models: Models): CompactionBridge["compactionAuth"] {
	return async (model, signal) => {
		if ((await models.getAuth(model, { signal })) !== undefined) return;
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	};
}

/**
 * Durable `beforeCompact` handler that keeps pi's compaction format: durable selects the range, pi's
 * `session_before_compact` handlers may cancel or supply the summary, and otherwise pi's summarizer
 * (`core/compaction`) writes it, file lists included, with the `compaction.model` model when that setting is set. Pi's `tokensBefore`, details, and `fromHook` go to the
 * conversation's `nek.compaction-details` side record, since the `pi.compaction` entry carries only the summary.
 *
 * Deviation from pi: durable picks the cut, so pi's own cut-point choice, split-turn prefix summaries, and a
 * hook-supplied `firstKeptEntryId` do not apply.
 *
 * Durable never runs its own summarizer while this handler is installed: a failed pi summarization declines the
 * compaction instead, so a summary in durable's format never enters the transcript.
 *
 * Crash note: durable runs this hook before the commit that places the summary. A crash in between reruns it after
 * reopen, so pi's handlers and summarizer may run twice for one compaction.
 */
export function createBeforeCompact(bridge: CompactionBridge): BeforeCompact {
	return async (compaction, api, context) => {
		const signal = context.abortSignal ?? new AbortController().signal;
		const harness = bridge.harness();
		const conversation = await harness.conversation(api.conversationId, context);
		if (conversation === undefined) return { decline: true };
		const [view, stored, agent] = await Promise.all([
			conversation.context(context),
			api.snapshot(CompactionDetailsDoc, api.conversationId, context),
			conversation.agent(context),
		]);
		const records = stored?.records ?? [];
		const preparation = buildPreparation(compaction, view, records, bridge);

		let decision: Awaited<ReturnType<NonNullable<DurableHostHooks["beforeCompact"]>>>;
		try {
			decision = await bridge.hooks.beforeCompact?.({
				reason: compaction.reason,
				preparation,
				...(compaction.instructions === undefined ? {} : { customInstructions: compaction.instructions }),
				signal,
			});
		} catch (error) {
			if (signal.aborted) throw error;
			bridge.report(error);
			decision = undefined;
		}
		if (decision !== undefined && "cancel" in decision) return { decline: true };

		let result: CompactionResult;
		let usageModel: string | undefined;
		if (decision !== undefined) result = decision.compaction;
		else {
			const ref = agent.model;
			const mainModel = ref === undefined ? undefined : bridge.models.getModel(ref.provider, ref.modelId);
			if (mainModel === undefined) return { decline: true };
			let model: Model<Api> = mainModel;
			try {
				const configured = await resolveCompactionModel(
					bridge.compactionModel(),
					bridge.models,
					async (candidate) => {
						await bridge.compactionAuth(candidate, signal);
						return { model: candidate };
					},
					signal,
				);
				model = configured?.model ?? mainModel;
				result = await compact(
					preparation,
					model,
					undefined,
					undefined,
					compaction.instructions,
					signal,
					resolveCompactionThinkingLevel(
						bridge.compactionThinkingLevel(),
						model,
						agent.thinkingLevel as ThinkingLevel,
					),
					(streamModel, streamContext, options) => bridge.models.streamSimple(streamModel, streamContext, options),
					undefined,
					bridge.retry(),
					undefined,
					undefined,
					configured?.checkRequest,
				);
			} catch (error) {
				if (signal.aborted) throw error;
				bridge.hooks.compactionFailed?.(compaction.reason, error);
				bridge.report(error);
				return { decline: true };
			}
			usageModel = `${model.provider}/${model.id}`;
		}

		const record: CompactionRecord = {
			firstKept: compaction.firstKept,
			summaryHash: hashSummary(result.summary),
			tokensBefore: result.tokensBefore,
			details: toStrictJson(result.details),
			fromHook: decision !== undefined,
		};
		await saveRecord(harness, api, record, usageModel, result.usage, context);
		return { summary: result.summary };
	};
}

/**
 * Pi's compaction preparation for durable's selection. `compaction.entries` are the first entries of the current
 * context; when that no longer holds, the model messages durable passed stand in for pi's messages.
 */
function buildPreparation(
	compaction: DurableCompaction,
	view: ContextView,
	records: readonly CompactionRecord[],
	bridge: CompactionBridge,
): CompactionPreparation {
	const count = compaction.entries.length;
	const aligned = compaction.entries.every((entry, index) => view.entries[index]?.id === entry.id);
	if (!aligned) bridge.report(new Error("Compaction range no longer matches the conversation context"));
	const summarizedView: ContextView = {
		head: view.head,
		entries: view.entries.slice(0, count),
		contributions: view.contributions.slice(0, count),
		messages: [],
	};
	const summarized: AgentMessage[] = aligned
		? agentContext(summarizedView, records).messages
		: compaction.messages.map((message: Message) => message);
	const head: EntryRecord | undefined = compaction.entries[0];
	const previous = head !== undefined && CompactionEntry.is(head) ? head : undefined;
	const previousRecord = previous === undefined ? undefined : compactionDetails(records, previous);
	// Pi summarizes the conversation after the previous summary and passes that summary separately.
	const messagesToSummarize = summarized.filter(
		(message) => message.role !== "compactionSummary" && message.role !== "system",
	);
	const fileOps = createFileOps();
	if (previousRecord !== undefined && previousRecord.fromHook !== true)
		addRecordedFiles(previousRecord.details, fileOps);
	for (const message of messagesToSummarize) extractFileOpsFromMessage(message, fileOps);
	const previousSummary = previous === undefined ? undefined : compactionSummaryText(previous);
	return {
		firstKeptEntryId: String(compaction.firstKept),
		messagesToSummarize,
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: estimateContextTokens(agentContext(view, records).messages).tokens,
		...(previousSummary === undefined ? {} : { previousSummary }),
		fileOps,
		settings: bridge.settings(),
	};
}

function addRecordedFiles(details: unknown, fileOps: ReturnType<typeof createFileOps>): void {
	if (details === null || typeof details !== "object" || Array.isArray(details)) return;
	const { readFiles, modifiedFiles } = details as { readFiles?: unknown; modifiedFiles?: unknown };
	if (Array.isArray(readFiles)) for (const file of readFiles) if (typeof file === "string") fileOps.read.add(file);
	if (Array.isArray(modifiedFiles)) {
		for (const file of modifiedFiles) if (typeof file === "string") fileOps.edited.add(file);
	}
}

/** Commit the side record, bounded, and the summarization spend that durable's own summarizer would have recorded. */
async function saveRecord(
	harness: Harness,
	api: HookApi,
	record: CompactionRecord,
	usageModel: string | undefined,
	usage: Usage | undefined,
	context: Context,
): Promise<void> {
	await harness.commit(async (tx) => {
		const doc = await tx.doc(CompactionDetailsDoc, api.conversationId);
		doc.records.push(record);
		if (doc.records.length > MAX_COMPACTION_RECORDS)
			doc.records.splice(0, doc.records.length - MAX_COMPACTION_RECORDS);
		if (usageModel === undefined || usage === undefined) return;
		const ledger = await tx.doc(UsageDoc, api.conversationId);
		const current = ledger.models[usageModel];
		ledger.models[usageModel] = current === undefined ? toStrictUsage(usage) : addUsage(current, usage);
	}, context);
}

/** A copy holding only pi-ai's usage fields, which are all numbers. */
function toStrictUsage(usage: Usage): Usage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		totalTokens: usage.totalTokens,
		cost: { ...usage.cost },
	};
}

function addUsage(left: Usage, right: Usage): Usage {
	return toStrictUsage({
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		totalTokens: left.totalTokens + right.totalTokens,
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	});
}
