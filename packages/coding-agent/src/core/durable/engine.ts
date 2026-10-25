import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AgentMessage, AgentTool, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model, Models } from "@earendil-works/pi-ai";
import { retryDelayMs } from "@earendil-works/pi-ai/utils/retry";
import {
	type AgentEventStream,
	type Conversation,
	type ConversationId,
	createRegistry,
	type EntryDraft,
	type EntryId,
	type EntryRecord,
	Harness,
	InboxDoc,
	LiveDoc,
	MemoryStorage,
	type Registry,
	ROOT_CONVERSATION_ID,
	type Storage,
	type Submission,
	SystemEntry,
	type UserInput,
	watchEvents,
} from "@earendil-works/pi-durable";
import type { ToolCallMemo } from "../extensions/types.ts";
import { convertToLlm } from "../messages.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { requireModelAuth } from "./compaction.ts";
import { agentContext } from "./context.ts";
import {
	agentMessageEntry,
	CompactionDetailsDoc,
	type CompactionRecord,
	CompactionRequestDoc,
	SettlementDoc,
} from "./entries.ts";
import { DurableEventAdapter, type DurableSessionEvent } from "./events.ts";
import type { DurableHostHooks } from "./hooks.ts";
import { acquireSessionLock, type SessionLock, sessionLockPath } from "./lock.ts";
import { planSystemEntries } from "./prompt.ts";
import {
	createHookExtension,
	createPendingResults,
	createPromptExtension,
	createToolsExtension,
	PROMPT_SECTION_KEY,
	PromptDoc,
	type PromptSection,
	storedPromptSections,
} from "./registry.ts";
import type { DurableSessionStore } from "./session-store.ts";
import { createHarnessSettings } from "./settings.ts";
import { openSqliteStorage } from "./sqlite.ts";

/** Options of {@link DurableEngine.open}. */
export type DurableEngineOptions = {
	/** SQLite database path; `undefined` keeps the session in memory, without a lock. */
	readonly path: string | undefined;
	/** Phase 2 store to pin instead of independently opening `path`, when supplied by AgentSession. */
	readonly store?: DurableSessionStore;
	/** Model access; a host wraps its `ModelRuntime` in `HookedModels` to run provider hooks. */
	readonly models: Models;
	readonly settingsManager: SettingsManager;
	/** Tools offered to the model, in order. */
	readonly tools: readonly AgentTool[];
	/** Model and thinking level to configure; absent keeps the stored choice of a reopened session. */
	readonly model?: Model<Api>;
	readonly thinkingLevel?: ThinkingLevel;
	/** Pi extension callbacks; they may rerun after a crash (see {@link DurableHostHooks}). */
	readonly hooks?: DurableHostHooks;
	/**
	 * Throws when a configured `compaction.model` cannot authenticate; default requires auth from `models`. A host with
	 * its own request auth rules (an SDK custom stream function) supplies them here.
	 */
	readonly compactionAuth?: (model: Model<Api>, signal: AbortSignal) => Promise<void>;
	/**
	 * Whether durable compacts automatically (threshold and overflow). `false` when the host runs pi's own automatic
	 * compaction; default `true`.
	 */
	readonly autoCompaction?: boolean;
	/**
	 * Whether interrupted work resumes as the engine opens; default `true`. With `false` it waits for `resume()`, so a
	 * host can bind what that work calls into (extensions) first.
	 */
	readonly resume?: boolean;
	/** Conversation to attach to; default the root conversation. */
	readonly conversationId?: ConversationId;
	/** Extension and delivery failures that do not fail an operation. Must not throw. */
	readonly onReport?: (error: unknown) => void;
};

/** Options of {@link DurableEngine.prompt}. */
export type DurablePromptOptions = {
	/**
	 * Effective system prompt for this run, after `before_agent_start`: ordered sections, or one text. Absent keeps the
	 * stored one.
	 */
	readonly systemPrompt?: string | readonly PromptSection[];
	/** Tools offered from this run on; absent keeps the current ones. */
	readonly tools?: readonly AgentTool[];
	/** Messages placed right after the input in its placement commit, as pi places `before_agent_start` messages. */
	readonly messages?: readonly AgentMessage[];
	/** What to do when the conversation is busy; default `reject` (throws `ConversationBusy`). */
	readonly whenBusy?: "steer" | "followUp" | "reject";
};

type Listener = (event: DurableSessionEvent) => void | Promise<void>;

export { sessionLockPath };

/**
 * Pi's coding agent loop on a durable Harness. Every input, answer, tool call, queue, and compaction is committed to
 * the session database as it happens; reopening the same path resumes whatever was in flight:
 *
 * - a streamed answer restarts its request (committed partials are replaced by the new attempt);
 * - a tool call interrupted by the crash reruns when it is replay-safe, otherwise its result says it was interrupted;
 * - queued steering and follow-up inputs stay queued, in order;
 * - a compaction resumes from its last checkpoint.
 *
 * Events are pi `AgentSessionEvent`s translated from durable's committed state, so listeners only ever see
 * committed facts.
 */
export class DurableEngine {
	readonly harness: Harness;
	readonly #registry: Registry;
	readonly #lock: SessionLock | undefined;
	readonly #store: DurableSessionStore | undefined;
	readonly #options: DurableEngineOptions;
	/** Shared by the wrapped tools and the hook extension; see `createPendingResults()`. */
	readonly #pending: ReturnType<typeof createPendingResults>;
	readonly #listeners = new Set<Listener>();
	readonly #drainWaiters = new Set<() => void>();
	#conversation: Conversation;
	#stream: AgentEventStream | undefined;
	#adapter: DurableEventAdapter | undefined;
	#model: Model<Api> | undefined;
	#closed = false;
	#resumed = false;
	/** Keys of the installed prompt extension's sections, in order. */
	#promptKeys: string[] = [PROMPT_SECTION_KEY];

	private constructor(
		harness: Harness,
		registry: Registry,
		lock: SessionLock | undefined,
		conversation: Conversation,
		options: DurableEngineOptions,
		pending: ReturnType<typeof createPendingResults>,
		store: DurableSessionStore | undefined,
	) {
		this.harness = harness;
		this.#pending = pending;
		this.#registry = registry;
		this.#lock = lock;
		this.#conversation = conversation;
		this.#options = options;
		this.#store = store;
		this.#model = options.model;
	}

	/**
	 * Open or create a session: lock, storage, Harness, conversation, event stream, then resume of whatever was in
	 * flight. Throws `SessionLockedError` while another live process owns the database.
	 */
	static async open(options: DurableEngineOptions): Promise<DurableEngine> {
		if (options.store !== undefined && options.store.path !== options.path) {
			throw new Error("Durable engine path must match its session store");
		}
		const lock =
			options.store !== undefined || options.path === undefined
				? undefined
				: acquireSessionLock(sessionLockPath(options.path));
		try {
			return await DurableEngine.#open(options, lock);
		} catch (error) {
			lock?.release();
			throw error;
		}
	}

	static async #open(options: DurableEngineOptions, lock: SessionLock | undefined): Promise<DurableEngine> {
		const context = BACKGROUND_CONTEXT;
		const store = options.store;
		const registry = store?.host.registry ?? createRegistry();
		const report = (error: unknown): void => options.onReport?.(error);
		let engine: DurableEngine | undefined;
		const currentModel = () => (engine === undefined ? options.model : engine.#model);
		const settings = createHarnessSettings(options.settingsManager, currentModel, {
			...(options.autoCompaction === undefined ? {} : { autoCompaction: options.autoCompaction }),
		});
		const pending = createPendingResults();
		registry.install(createPromptExtension());
		registry.install(
			createHookExtension({
				harness: () => {
					if (engine === undefined) throw new Error("Durable engine is not open");
					return engine.harness;
				},
				models: options.models,
				hooks: options.hooks ?? {},
				settings: () => options.settingsManager.getCompactionSettings(currentModel()),
				compactionModel: () => options.settingsManager.getCompactionModel(),
				compactionThinkingLevel: () => options.settingsManager.getCompactionThinkingLevel(),
				compactionAuth: options.compactionAuth ?? requireModelAuth(options.models),
				retry: () => options.settingsManager.getRetrySettings(),
				report,
				pending,
			}),
		);
		registry.install(createToolsExtension(options.tools, pending));
		let harness: Harness;
		if (store !== undefined) {
			store.host.models.reconfigure(options.models, {});
			store.host.settings = settings;
			store.host.report = report;
			harness = await store.pin(context);
		} else {
			const storage: Storage =
				options.path === undefined ? new MemoryStorage() : await openSqliteStorage(options.path);
			harness = await Harness.open(
				storage,
				{ models: options.models, registry, settings, onReport: report },
				context,
			);
		}
		try {
			const id = options.conversationId ?? ROOT_CONVERSATION_ID;
			const conversation =
				id === ROOT_CONVERSATION_ID ? await harness.root(context) : await harness.conversation(id, context);
			if (conversation === undefined) throw new Error(`Conversation ${id} does not exist`);
			engine = new DurableEngine(harness, registry, lock, conversation, options, pending, store);
			// A resumed request renders the stored prompt's sections.
			engine.#installPromptKeys(storedPromptSections(await harness.snapshot(PromptDoc, conversation.id, context)));
			await engine.#configureModel(context);
			await engine.#attach();
			if (options.resume !== false) engine.resume();
			return engine;
		} catch (error) {
			if (store === undefined) await harness.close(context).catch(report);
			else await store.unpin().catch(report);
			throw error;
		}
	}

	/** Resume interrupted work (runs, tools, compactions); later calls do nothing. */
	resume(): void {
		if (this.#resumed) return;
		this.#resumed = true;
		this.harness.resume();
	}

	get conversationId(): ConversationId {
		return this.#conversation.id;
	}

	/** Listen to pi session events. Returns an unsubscribe function. */
	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/**
	 * Admit user input. The effective system prompt is stored first, so every request of the run, including one
	 * prepared after a crash, renders it; injected messages are placed right after the input, in its placement commit.
	 *
	 * Storing the prompt and admitting the input are two commits: a crash between them leaves the stored prompt without
	 * the input, which the host resubmits.
	 */
	async prompt(content: UserInput, options: DurablePromptOptions = {}): Promise<Submission> {
		const context = BACKGROUND_CONTEXT;
		if (options.tools !== undefined) this.setTools(options.tools);
		const systemPrompt = options.systemPrompt;
		if (systemPrompt !== undefined) {
			const sections =
				typeof systemPrompt !== "string"
					? systemPrompt
					: systemPrompt === ""
						? []
						: [{ key: PROMPT_SECTION_KEY, value: systemPrompt }];
			await this.#storePrompt(sections, context);
		}
		const convert = this.#options.hooks?.convertToLlm ?? convertToLlm;
		const after = (options.messages ?? []).map((message) => agentMessageEntry(message, convert));
		return this.#conversation.submit(
			{ type: "input", content, whenBusy: options.whenBusy ?? "reject", ...(after.length > 0 ? { after } : {}) },
			context,
		);
	}

	/**
	 * Queue input that joins the current run after its tool round; starts a run when idle. `after` messages are placed
	 * right after the input, in its placement commit, as with {@link prompt}.
	 */
	steer(content: UserInput, after: readonly AgentMessage[] = []): Promise<Submission> {
		return this.#queueInput(content, "steer", after);
	}

	/** Queue input that runs after the current run's last answer; starts a run when idle. `after` as for steer. */
	followUp(content: UserInput, after: readonly AgentMessage[] = []): Promise<Submission> {
		return this.#queueInput(content, "followUp", after);
	}

	#queueInput(
		content: UserInput,
		whenBusy: "steer" | "followUp",
		after: readonly AgentMessage[],
	): Promise<Submission> {
		const convert = this.#options.hooks?.convertToLlm ?? convertToLlm;
		const entries = after.map((message) => agentMessageEntry(message, convert));
		return this.#conversation.submit(
			{ type: "input", content, whenBusy, ...(entries.length > 0 ? { after: entries } : {}) },
			BACKGROUND_CONTEXT,
		);
	}

	/**
	 * Write a pi message with a coding-agent role; placed at once when idle, else at the next boundary. A triggered
	 * write starts a run when idle; while busy, `deliverAs` delivers it like steering or follow-up input, continuing the
	 * run, as pi delivers a custom message sent with `triggerTurn` during a run. `after` messages are placed right after
	 * it, in its placement commit, as pi places `before_agent_start` messages after the message that starts a run.
	 */
	async appendMessage(
		message: AgentMessage,
		options: {
			readonly displayOnly?: boolean;
			readonly trigger?: true;
			readonly deliverAs?: "steer" | "followUp";
			readonly after?: readonly AgentMessage[];
		} = {},
	): Promise<Submission> {
		const convert = this.#options.hooks?.convertToLlm ?? convertToLlm;
		const entry = agentMessageEntry(message, convert, options);
		const trigger =
			options.trigger === true
				? { trigger: true as const, ...(options.deliverAs === undefined ? {} : { deliverAs: options.deliverAs }) }
				: {};
		const after = (options.after ?? []).map((item) => agentMessageEntry(item, convert));
		return this.#conversation.submit(
			{ type: "write", entry, ...trigger, ...(after.length > 0 ? { after } : {}) },
			BACKGROUND_CONTEXT,
		);
	}

	/** Mark that a run the host starts must settle; see `SettlementDoc`. */
	async markSettlementPending(): Promise<void> {
		const conversationId = this.#conversation.id;
		await this.#conversation.commit(async (tx) => {
			const doc = await tx.doc(SettlementDoc, conversationId);
			if (!doc.pending) doc.pending = true;
		}, BACKGROUND_CONTEXT);
	}

	/** Whether a host run is still settling, and whether the conversation is idle; read after a reopen. */
	async settlementState(): Promise<{ pending: boolean; idle: boolean }> {
		const conversationId = this.#conversation.id;
		const [doc, live] = await Promise.all([
			this.harness.snapshot(SettlementDoc, conversationId, BACKGROUND_CONTEXT),
			this.harness.snapshot(LiveDoc, conversationId, BACKGROUND_CONTEXT),
		]);
		return { pending: doc?.pending === true, idle: live?.run === undefined };
	}

	/** Append a settlement's entries and clear the pending mark in one commit. */
	async finishSettlement(entries: readonly EntryDraft[]): Promise<void> {
		const conversationId = this.#conversation.id;
		await this.#conversation.commit(async (tx) => {
			for (const entry of entries) await tx.appendEntry(conversationId, entry);
			const doc = await tx.doc(SettlementDoc, conversationId);
			if (doc.pending) doc.pending = false;
		}, BACKGROUND_CONTEXT);
	}

	/** Mark a manual compaction in progress; see `CompactionRequestDoc`. */
	async markCompactionPending(instructions: string | undefined): Promise<void> {
		const conversationId = this.#conversation.id;
		await this.#conversation.commit(async (tx) => {
			const doc = await tx.doc(CompactionRequestDoc, conversationId);
			doc.pending = true;
			if (instructions === undefined) delete doc.instructions;
			else doc.instructions = instructions;
		}, BACKGROUND_CONTEXT);
	}

	async clearCompactionPending(): Promise<void> {
		const conversationId = this.#conversation.id;
		await this.#conversation.commit(async (tx) => {
			const doc = await tx.doc(CompactionRequestDoc, conversationId);
			if (doc.pending) doc.pending = false;
			delete doc.instructions;
		}, BACKGROUND_CONTEXT);
	}

	/** The manual compaction a crash interrupted, if any. */
	async compactionPending(): Promise<{ instructions?: string } | undefined> {
		const doc = await this.harness.snapshot(CompactionRequestDoc, this.#conversation.id, BACKGROUND_CONTEXT);
		if (doc?.pending !== true) return undefined;
		return doc.instructions === undefined ? {} : { instructions: doc.instructions };
	}

	/**
	 * Start a run from the current context without new input, as pi's `continue()`: the caller checked that the context
	 * ends in a non-assistant message. Writes a hidden marker entry that carries the trigger.
	 */
	continueRun(): Promise<Submission> {
		return this.#conversation.submit(
			{ type: "write", entry: { kind: "nek.continue" }, trigger: true, continueContext: true },
			BACKGROUND_CONTEXT,
		);
	}

	/** Write a prepared entry; a triggered write starts a run when idle (see `appendMessage`). */
	writeEntry(entry: EntryDraft, options: { readonly trigger?: true } = {}): Promise<Submission> {
		return this.#conversation.submit(
			{ type: "write", entry, ...(options.trigger === true ? { trigger: true } : {}) },
			BACKGROUND_CONTEXT,
		);
	}

	/** The memo of a tool call running now; see `ExtensionContext.getToolCallMemo`. */
	toolCallMemo(toolCallId: string): ToolCallMemo | undefined {
		return this.#pending.calls.get(toolCallId);
	}

	/** Whether a finished call's result asked to end the run (`terminate`); taken once, by the round's `afterTools`. */
	takeResultTerminate(toolCallId: string): boolean {
		return this.#pending.terminated.delete(toolCallId);
	}

	/** Resolve once listeners received the events of every committed entry and no run is open. */
	delivered(): Promise<void> {
		return this.#drain();
	}

	/** Withdraw queued steer/follow-up submissions without aborting the active run. */
	async clearQueue(): Promise<void> {
		const inspection = await this.harness.inspect(BACKGROUND_CONTEXT);
		for (const submission of inspection.submissions) {
			if (submission.conversationId !== this.#conversation.id || submission.status !== "queued") continue;
			if (submission.type === "input")
				await this.harness.abortSubmission(submission.id, BACKGROUND_CONTEXT, this.#conversation.id);
		}
		await this.#drain();
	}
	/** Abort the run and withdraw queued inputs. */
	async abort(): Promise<void> {
		await this.#conversation.abort(BACKGROUND_CONTEXT);
		await this.#drain();
	}

	/** Resolve when the conversation and every resumed background task are idle, with all events delivered. */
	async waitForIdle(): Promise<void> {
		for (;;) {
			await this.#conversation.waitForIdle(BACKGROUND_CONTEXT);
			await this.#drain();
			if ((await this.harness.inspect(BACKGROUND_CONTEXT)).tasks.length === 0) return;
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
	}

	/** Compact now; resolves when the compaction ended and its events were delivered. */
	async compact(instructions?: string): Promise<void> {
		const taskId = await this.#conversation.compact(instructions, BACKGROUND_CONTEXT);
		await this.harness.waitForTask(taskId, BACKGROUND_CONTEXT);
		await this.#drain();
	}

	/** Change the model and thinking level of the conversation. */
	async setModel(model: Model<Api>, thinkingLevel?: ThinkingLevel): Promise<void> {
		this.#model = model;
		await this.#conversation.configure(
			{
				model: { provider: model.provider, modelId: model.id },
				...(thinkingLevel === undefined ? {} : { thinkingLevel }),
			},
			BACKGROUND_CONTEXT,
		);
	}

	/** Change the thinking level of the conversation. */
	async setThinkingLevel(thinkingLevel: ThinkingLevel): Promise<void> {
		await this.#conversation.configure({ thinkingLevel }, BACKGROUND_CONTEXT);
	}

	/** Replace the offered tools; the next request offers them through a `pi.system` tool change. */
	setTools(tools: readonly AgentTool[]): void {
		this.#registry.install(createToolsExtension(tools, this.#pending));
	}

	/**
	 * Replace the effective prompt during a run, such as after the active tools changed; the next request renders it
	 * through a `pi.system` change. Idle, `prompt()` stores the run's prompt instead.
	 */
	async setPrompt(sections: readonly PromptSection[]): Promise<void> {
		await this.#storePrompt(sections, BACKGROUND_CONTEXT);
	}

	/**
	 * Fork the conversation after `at` and switch to the fork; the source conversation stays as it is. Returns the new
	 * conversation's ID, which the host persists to reopen it.
	 */
	async fork(at: EntryId): Promise<ConversationId> {
		const fork = await this.#conversation.fork(at, { ownership: { kind: "ownerless" } }, BACKGROUND_CONTEXT);
		await this.#detach();
		this.#conversation = fork;
		await this.#attach();
		return fork.id;
	}

	/** Pi's view of the current model context, compaction summaries included. */
	async messages(): Promise<AgentMessage[]> {
		const view = await this.#conversation.context(BACKGROUND_CONTEXT);
		return agentContext(view, await this.#compactionRecords()).messages;
	}

	/** Every entry of the conversation's history, oldest first. */
	async entries(): Promise<EntryRecord[]> {
		return this.#entriesAfter(0);
	}

	/** Durable's pending queue items, oldest first. */
	async queued(): Promise<{ steering: UserInput[]; followUp: UserInput[] }> {
		const inbox = await this.harness.snapshot(InboxDoc, this.#conversation.id, BACKGROUND_CONTEXT);
		const steering: UserInput[] = [];
		const followUp: UserInput[] = [];
		for (const item of inbox?.items ?? []) {
			if (item.mode === "steer") steering.push(item.content as UserInput);
			else if (item.mode === "followUp") followUp.push(item.content as UserInput);
		}
		return { steering, followUp };
	}

	/** Stop events, close storage, and release the lock. Unfinished work resumes at the next open. */
	async close(): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		try {
			await this.#detach();
			if (this.#store === undefined) await this.harness.close(BACKGROUND_CONTEXT);
		} finally {
			if (this.#store !== undefined) await this.#store.unpin();
			else this.#lock?.release();
		}
	}

	/**
	 * Store the effective prompt and, when idle, append the `pi.system` entries the next request needs, in one commit.
	 * When the conversation is busy or its tail moved since the view was read, generation preparation appends them.
	 */
	async #storePrompt(sections: readonly PromptSection[], context: Context): Promise<void> {
		const conversation = this.#conversation;
		this.#installPromptKeys(sections);
		const [view, agent] = await Promise.all([conversation.context(context), conversation.agent(context)]);
		const tail = view.entries[view.entries.length - 1]?.id;
		const drafts = planSystemEntries(view, sections, agent.tools, Date.now());
		await conversation.commit(async (tx) => {
			const doc = await tx.doc(PromptDoc, conversation.id);
			if (JSON.stringify(storedPromptSections(doc)) !== JSON.stringify(sections)) {
				doc.sections = sections.map((part) => ({ key: part.key, value: part.value }));
				doc.text = "";
			}
			if ((await tx.doc(LiveDoc, conversation.id)).run !== undefined) return;
			const newest = (await tx.scanEntries({ conversationId: conversation.id }, 1)).items[0]?.id;
			if (newest !== tail) return;
			for (const draft of drafts) await tx.appendEntry(SystemEntry, conversation.id, draft);
		}, context);
	}

	/** Reinstall the prompt extension when the section keys or their order changed. */
	#installPromptKeys(sections: readonly PromptSection[]): void {
		const keys = sections.map((part) => part.key);
		if (keys.join("\u0000") === this.#promptKeys.join("\u0000")) return;
		this.#promptKeys = keys;
		this.#registry.install(createPromptExtension(keys));
	}

	async #configureModel(context: Context): Promise<void> {
		const { model, thinkingLevel } = this.#options;
		if (model !== undefined || thinkingLevel !== undefined) {
			await this.#conversation.configure(
				{
					...(model === undefined ? {} : { model: { provider: model.provider, modelId: model.id } }),
					...(thinkingLevel === undefined ? {} : { thinkingLevel }),
				},
				context,
			);
			return;
		}
		const stored = (await this.#conversation.agent(context)).model;
		this.#model = stored === undefined ? undefined : this.#options.models.getModel(stored.provider, stored.modelId);
	}

	async #attach(): Promise<void> {
		const conversationId = this.#conversation.id;
		const adapter = new DurableEventAdapter({
			emit: (event) => this.#emit(event),
			readInbox: () => this.harness.snapshot(InboxDoc, conversationId, BACKGROUND_CONTEXT),
			readCompactionRecords: () => this.#compactionRecords(),
			readTaskOutcome: async (taskId) => {
				const task = await this.harness.getTask(taskId, BACKGROUND_CONTEXT);
				return task?.state.status === "terminal" ? task.state.outcome : undefined;
			},
			entriesAfter: (id) => this.#entriesAfter(id),
			takeResultExtras: (toolCallId) => {
				const extras = this.#pending.extras.get(toolCallId);
				this.#pending.extras.delete(toolCallId);
				return extras;
			},
			maxRetries: () => this.#options.settingsManager.getRetrySettings().maxRetries,
			retryDelayMs: (attempt) => retryDelayMs(this.#options.settingsManager.getRetrySettings(), attempt),
			now: () => Date.now(),
			report: (error) => this.#options.onReport?.(error),
		});
		const stream = await watchEvents(this.harness, conversationId, BACKGROUND_CONTEXT);
		adapter.attach(stream.snapshot);
		this.#adapter = adapter;
		this.#stream = stream;
		stream.start(async (batch) => {
			try {
				await adapter.handle(batch);
			} catch (error) {
				this.#options.onReport?.(error);
			}
			for (const waiter of this.#drainWaiters) waiter();
		});
	}

	async #detach(): Promise<void> {
		const stream = this.#stream;
		this.#stream = undefined;
		this.#adapter = undefined;
		if (stream !== undefined) await stream.stop();
		for (const waiter of this.#drainWaiters) waiter();
	}

	async #emit(event: DurableSessionEvent): Promise<void> {
		for (const listener of this.#listeners) {
			try {
				await listener(event);
			} catch (error) {
				this.#options.onReport?.(error);
			}
		}
	}

	/** Wait until the adapter emitted events for the newest entry and no run is open in its events. */
	async #drain(): Promise<void> {
		const newest = (await this.#conversation.entries({}, 1, undefined, BACKGROUND_CONTEXT)).items[0]?.id ?? 0;
		const done = (): boolean => {
			const adapter = this.#adapter;
			return adapter === undefined || (adapter.lastEntryId >= newest && !adapter.running);
		};
		if (done()) return;
		await new Promise<void>((resolve) => {
			const waiter = (): void => {
				if (!done()) return;
				this.#drainWaiters.delete(waiter);
				resolve();
			};
			this.#drainWaiters.add(waiter);
		});
	}

	async #compactionRecords(): Promise<readonly CompactionRecord[]> {
		const doc = await this.harness.snapshot(CompactionDetailsDoc, this.#conversation.id, BACKGROUND_CONTEXT);
		return doc?.records ?? [];
	}

	async #entriesAfter(id: number): Promise<EntryRecord[]> {
		const newestFirst: EntryRecord[] = [];
		let cursor: Parameters<Conversation["entries"]>[2];
		do {
			const page = await this.#conversation.entries(
				{ minEntryId: (id + 1) as EntryId },
				200,
				cursor,
				BACKGROUND_CONTEXT,
			);
			newestFirst.push(...page.items);
			cursor = page.next;
		} while (cursor !== undefined);
		return newestFirst.reverse();
	}
}
