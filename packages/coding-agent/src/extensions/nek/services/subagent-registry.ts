import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentSession, AgentSessionEvent } from "../../../core/agent-session.ts";
import { truncateHead } from "../../../core/tools/truncate.ts";
import type { NekConfig } from "../config.ts";
import type { SubagentRecord, SubagentStatus } from "../types.ts";
import { modelRef } from "./child-session.ts";

/** Registry limits and timeouts (NekConfig.subagent). */
export type SubagentConfig = NekConfig["subagent"];

/** Arguments of `start()`: the record fields and a factory for the child session. */
export interface StartSubagentInput {
	description: string;
	/** Agent type name, stored on the record. */
	type: string;
	prompt: string;
	background: boolean;
	/** Parent abort signal of a foreground subagent; background subagents survive the parent's Esc. */
	signal?: AbortSignal;
	createSession: () => Promise<AgentSession>;
}

/** Arguments of `resume()`. `reopen` restores a child that is no longer retained (e.g. after a restart). */
export interface ResumeSubagentInput {
	id: string;
	prompt: string;
	interrupt: boolean;
	background: boolean;
	signal?: AbortSignal;
	reopen?: { description: string; type: string; createSession: () => Promise<AgentSession> };
	/** Adjust the child before the run starts, e.g. restrict its active tools in plan mode. */
	prepare?: (session: AgentSession) => void;
}

/** Result of `await()`: the finished records it returned (now observed) and whether the wait timed out. */
export interface AwaitSubagentsResult {
	done: SubagentRecord[];
	timedOut: boolean;
	interrupted?: boolean;
}

/** Elements of Map<id, SubagentEntry>. */
interface SubagentEntry {
	record: SubagentRecord;
	session: AgentSession;
	done: Promise<void>;
	unsubscribe: () => void;
	/** Progress listener of the foreground subagent call waiting on this entry. */
	onProgress?: (record: SubagentRecord) => void;
	/** Abort requested for the current run; re-applied on `agent_start` when it arrived before the run was active. */
	abortRequested: boolean;
	/** Removes the parent abort listener when a foreground wait is detached. */
	detachAbort?: () => void;
}

/** Maximum characters retained for the latest streamed activity text. */
export const ACTIVITY_MAX_CHARS = 80;

/** Lower bound of a blocking await (Codex clamp). */
export const MIN_AWAIT_MS = 1000;

/**
 * Timeout of one await (plan.md section 7.6): omitted -> `awaitDefaultMs`; `<= 0` -> 0 (non-blocking status check);
 * otherwise clamped to `[1000, awaitMaxMs]`.
 */
export function clampAwaitTimeout(requested: number | undefined, config: SubagentConfig): number {
	const value = requested ?? config.awaitDefaultMs;
	if (value <= 0) return 0;
	return Math.min(Math.max(value, MIN_AWAIT_MS), Math.max(config.awaitMaxMs, MIN_AWAIT_MS));
}

/**
 * In-memory registry of subagent runs (plan.md section 7.6), the only class of the extension. It owns the child
 * sessions, their run promises, and the "settled" broadcast that `await` listens to. Running subagents are bounded by
 * `maxConcurrent`; retained records by `maxRetained` (finished, observed records are evicted oldest first).
 */
export class SubagentRegistry {
	private readonly config: SubagentConfig;
	private readonly notify: (record: SubagentRecord) => void;
	private readonly onChange: (record: SubagentRecord) => void;
	private readonly entries = new Map<string, SubagentEntry>();
	private readonly settled = new EventTarget();
	private readonly waitInterrupted = new EventTarget();
	/** Starts that passed the limit check but have no session yet; parallel subagent calls must not overshoot. */
	private pendingStarts = 0;

	/**
	 * `notify` receives a background record that finished unobserved; `onChange` receives every progress and status
	 * change (UI refresh).
	 */
	constructor(
		config: SubagentConfig,
		notify: (record: SubagentRecord) => void,
		onChange?: (record: SubagentRecord) => void,
	) {
		this.config = config;
		this.notify = notify;
		this.onChange = onChange ?? (() => {});
	}

	/** Number of records that are still running. */
	runningCount(): number {
		return this.list().filter((record) => record.status === "running").length;
	}

	/** Throw the Codex AgentLimitReached error when another run would exceed `maxConcurrent`. */
	private assertCapacity(): void {
		if (this.runningCount() + this.pendingStarts < this.config.maxConcurrent) return;
		throw new Error(
			`Subagent limit reached (${this.config.maxConcurrent} running). Wait for one to finish or cancel one with /subagents.`,
		);
	}

	/** Create a child session while holding a pending slot, so parallel starts cannot overshoot the limit. */
	private async createWithSlot(createSession: () => Promise<AgentSession>): Promise<AgentSession> {
		this.assertCapacity();
		this.pendingStarts++;
		try {
			return await createSession();
		} finally {
			this.pendingStarts--;
		}
	}

	/** Create a child session and run its first prompt without waiting; returns the running record. */
	async start(input: StartSubagentInput): Promise<SubagentRecord> {
		const session = await this.createWithSlot(input.createSession);
		const entry = this.adopt(session, input.description, input.type, input.background);
		this.launch(entry, input.prompt, input.signal);
		return entry.record;
	}

	/** Send a follow-up prompt to a finished child, or to a running one when `interrupt` is set (Cursor resume). */
	async resume(input: ResumeSubagentInput): Promise<SubagentRecord> {
		const entry = this.entries.get(input.id) ?? (await this.reopen(input));
		if (entry.record.status === "running") {
			if (!input.interrupt) {
				throw new Error(`Subagent ${input.id} is still running. Pass interrupt: true to replace its current run.`);
			}
			entry.record.observed = true;
			await requestAbort(entry);
			await entry.done;
		}
		this.assertCapacity();
		input.prepare?.(entry.session);
		entry.record.background = input.background;
		entry.record.model ??= sessionModelRef(entry.session);
		this.launch(entry, input.prompt, input.signal);
		return entry.record;
	}

	private async reopen(input: ResumeSubagentInput): Promise<SubagentEntry> {
		if (!input.reopen) throw new Error(`Unknown subagent ${input.id}.`);
		const session = await this.createWithSlot(input.reopen.createSession);
		const entry = this.adopt(session, input.reopen.description, input.reopen.type, input.background);
		entry.record.status = "completed";
		entry.record.observed = true;
		return entry;
	}

	/** Wait for one subagent's current run and return its record, marked observed (foreground subagent result). */
	async wait(id: string, onProgress?: (record: SubagentRecord) => void): Promise<SubagentRecord> {
		const entry = this.entries.get(id);
		if (!entry) throw new Error(`Unknown subagent ${id}.`);
		entry.onProgress = onProgress;
		let detached = false;
		let removeInterruptListener = () => {};
		const interrupted = new Promise<void>((resolve) => {
			const listener = () => {
				detached = entry.record.background && entry.record.status === "running";
				resolve();
			};
			removeInterruptListener = () => this.waitInterrupted.removeEventListener("interrupted", listener);
			this.waitInterrupted.addEventListener("interrupted", listener, { once: true });
		});
		try {
			await Promise.race([entry.done, interrupted]);
		} finally {
			removeInterruptListener();
			entry.onProgress = undefined;
		}
		if (detached) return entry.record;
		entry.record.observed = true;
		return entry.record;
	}

	/**
	 * Wait until one of `ids` (default: every background subagent) finishes or the clamped timeout elapses. Returns the
	 * finished records and marks them observed. Explicit ids return finished records even when already observed.
	 */
	async await(
		ids: string[] | undefined,
		timeoutMs: number | undefined,
		signal?: AbortSignal,
	): Promise<AwaitSubagentsResult> {
		const explicit = ids !== undefined && ids.length > 0;
		const targets = this.targets(ids);
		const finished = takeFinished(targets, explicit);
		if (finished.length > 0) return { done: finished, timedOut: false };
		const timeout = clampAwaitTimeout(timeoutMs, this.config);
		if (timeout === 0 || !targets.some((record) => record.status === "running")) {
			return { done: [], timedOut: false };
		}
		const result = await this.waitForSettle(() => takeFinished(targets, explicit), timeout, signal);
		return {
			done: result.done,
			timedOut: result.done.length === 0 && !result.interrupted && !signal?.aborted,
			...(result.interrupted ? { interrupted: true } : {}),
		};
	}

	/**
	 * Take the finished background records that were never delivered to the model and mark them observed; idempotent.
	 * Foreground records are delivered by their own subagent call.
	 */
	drainUnobserved(): SubagentRecord[] {
		const drained = this.list().filter(
			(record) => record.background && record.status !== "running" && !record.observed,
		);
		for (const record of drained) record.observed = true;
		return drained;
	}

	/** All retained records, oldest first. */
	list(): SubagentRecord[] {
		return [...this.entries.values()].map((entry) => entry.record);
	}

	/** One retained record. */
	get(id: string): SubagentRecord | undefined {
		return this.entries.get(id)?.record;
	}

	/** End active waits after a user message without aborting the child sessions. */
	interruptWaits(): void {
		for (const entry of this.entries.values()) {
			if (entry.record.status === "running" && !entry.record.background) this.detachEntry(entry);
		}
		this.waitInterrupted.dispatchEvent(new Event("interrupted"));
	}

	/** Cancel a running child; its record stays (status aborted, observed so no notice is sent). */
	async abort(id: string): Promise<void> {
		const entry = this.entries.get(id);
		if (!entry || entry.record.status !== "running") return;
		entry.record.observed = true;
		await requestAbort(entry);
		await entry.done;
	}

	/** Abort and dispose every child session; called on session shutdown. */
	async disposeAll(): Promise<void> {
		for (const id of [...this.entries.keys()]) {
			await this.abort(id);
			this.dispose(id);
		}
	}

	private adopt(session: AgentSession, description: string, type: string, background: boolean): SubagentEntry {
		const record = createRecord(session, description, type, background);
		const entry: SubagentEntry = {
			record,
			session,
			done: Promise.resolve(),
			unsubscribe: () => {},
			abortRequested: false,
		};
		entry.unsubscribe = session.subscribe((event) => this.trackProgress(entry, event));
		this.entries.set(record.id, entry);
		this.evictIfNeeded();
		return entry;
	}

	private launch(entry: SubagentEntry, prompt: string, signal: AbortSignal | undefined): void {
		const record = entry.record;
		record.status = "running";
		record.observed = false;
		record.error = undefined;
		record.endedAt = undefined;
		record.activity = undefined;
		entry.abortRequested = false;
		this.onChange(record);
		entry.done = this.run(entry, prompt, signal);
	}

	/** Run one prompt on the child and derive the outcome from its last assistant message. */
	private async run(entry: SubagentEntry, prompt: string, signal: AbortSignal | undefined): Promise<void> {
		const onAbort = () => void requestAbort(entry);
		if (signal?.aborted) onAbort();
		else if (signal) {
			signal.addEventListener("abort", onAbort, { once: true });
			entry.detachAbort = () => signal.removeEventListener("abort", onAbort);
		}
		try {
			await entry.session.prompt(prompt, { expandPromptTemplates: false });
			finishRecord(entry.record, entry.session, this.config.finalTextMaxBytes);
		} catch (error) {
			entry.record.status = "errored";
			entry.record.error = error instanceof Error ? error.message : String(error);
		} finally {
			entry.detachAbort?.();
			delete entry.detachAbort;
			entry.record.endedAt = Date.now();
			this.onChange(entry.record);
			this.settled.dispatchEvent(new Event("settled"));
			if (entry.record.background && !entry.record.observed) this.notify(entry.record);
		}
	}

	/**
	 * Resolve with the first non-empty `take()` after a settle, or with [] on timeout or abort. `take()` runs inside the
	 * settle broadcast, so the records are observed before the registry decides whether to send a notice.
	 */
	private waitForSettle(
		take: () => SubagentRecord[],
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<{ done: SubagentRecord[]; interrupted: boolean }> {
		if (signal?.aborted) return Promise.resolve({ done: [], interrupted: false });
		return new Promise((resolve) => {
			const finish = (done: SubagentRecord[], interrupted: boolean) => {
				clearTimeout(timer);
				this.settled.removeEventListener("settled", listener);
				this.waitInterrupted.removeEventListener("interrupted", onInterrupted);
				signal?.removeEventListener("abort", onAbort);
				resolve({ done, interrupted });
			};
			const listener = () => {
				const done = take();
				if (done.length > 0) finish(done, false);
			};
			const onAbort = () => finish([], false);
			const onInterrupted = () => finish([], true);
			const timer = setTimeout(() => finish([], false), timeoutMs);
			this.settled.addEventListener("settled", listener);
			this.waitInterrupted.addEventListener("interrupted", onInterrupted, { once: true });
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	/** Explicit ids must exist; without ids every background record is a target (foreground calls wait themselves). */
	private targets(ids: string[] | undefined): SubagentRecord[] {
		if (!ids || ids.length === 0) return this.list().filter((record) => record.background);
		return ids.map((id) => {
			const record = this.get(id);
			if (!record) throw new Error(`Unknown subagent ${id}.`);
			return record;
		});
	}

	/** Keep the latest tool call or assistant text, and the token count. */
	private trackProgress(entry: SubagentEntry, event: AgentSessionEvent): void {
		const record = entry.record;
		if (event.type === "agent_start" && entry.abortRequested) void entry.session.abort();
		if (event.type === "tool_execution_start") {
			record.activity = `${event.toolName} ${summarizeArgs(event.args)}`.trimEnd();
		} else if (event.type === "message_update" && event.message.role === "assistant") {
			const text = assistantText(event.message);
			record.activity = text ? text.slice(-ACTIVITY_MAX_CHARS) : record.activity;
		} else if (event.type === "message_end" && event.message.role === "assistant") {
			record.tokens += event.message.usage.totalTokens;
		} else {
			return;
		}
		entry.onProgress?.(record);
		this.onChange(record);
	}

	/** Evict the earliest-finished observed records until the registry fits `maxRetained`. */
	private evictIfNeeded(): void {
		while (this.entries.size > this.config.maxRetained) {
			const victims = this.list().filter((record) => record.status !== "running" && record.observed);
			victims.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
			const victim = victims[0];
			if (!victim) return;
			this.dispose(victim.id);
		}
	}

	/** Detach a foreground child without stopping its run. */
	private detachEntry(entry: SubagentEntry): void {
		if (entry.record.status !== "running" || entry.record.background) return;
		entry.record.background = true;
		entry.record.observed = false;
		entry.detachAbort?.();
		delete entry.detachAbort;
		this.onChange(entry.record);
	}

	private dispose(id: string): void {
		const entry = this.entries.get(id);
		if (!entry) return;
		entry.unsubscribe();
		entry.session.dispose();
		this.entries.delete(id);
	}
}

/** Abort the child's run; the flag covers an abort that lands before the run is active (AgentSession ignores it). */
function requestAbort(entry: SubagentEntry): Promise<void> {
	entry.abortRequested = true;
	return entry.session.abort();
}

function createRecord(session: AgentSession, description: string, type: string, background: boolean): SubagentRecord {
	return {
		id: session.sessionId,
		description,
		type,
		background,
		status: "running",
		sessionFile: session.sessionFile,
		startedAt: Date.now(),
		observed: false,
		model: sessionModelRef(session),
		tokens: 0,
	};
}

function sessionModelRef(session: AgentSession): string | undefined {
	return session.model ? modelRef(session.model) : undefined;
}

/** Derive the final status from the last assistant message (plan.md section 7.6 step 2). */
function finishRecord(record: SubagentRecord, session: AgentSession, maxBytes: number): void {
	const last = lastAssistant(session);
	const text = session.getLastAssistantText();
	record.finalText = text ? truncateHead(text, { maxBytes, maxLines: Number.MAX_SAFE_INTEGER }).content : undefined;
	record.status = last ? statusFromStopReason(last) : "completed";
	if (record.status === "errored") record.error = last?.errorMessage ?? "The subagent run failed.";
}

function statusFromStopReason(message: AssistantMessage): SubagentStatus {
	if (message.stopReason === "aborted") return "aborted";
	if (message.stopReason === "error") return "errored";
	return "completed";
}

function lastAssistant(session: AgentSession): AssistantMessage | undefined {
	for (let index = session.messages.length - 1; index >= 0; index--) {
		const message = session.messages[index];
		if (message.role === "assistant") return message;
	}
	return undefined;
}

/** Finished targets to return; implicit waits skip records that were already observed. Marks them observed. */
function takeFinished(targets: SubagentRecord[], includeObserved: boolean): SubagentRecord[] {
	const finished = targets.filter((record) => record.status !== "running" && (includeObserved || !record.observed));
	for (const record of finished) record.observed = true;
	return finished;
}

function assistantText(message: AssistantMessage): string {
	return message.content
		.flatMap((block) => (block.type === "text" ? [block.text] : []))
		.join("")
		.trim();
}

function summarizeArgs(args: unknown): string {
	if (typeof args !== "object" || args === null) return "";
	const first = Object.values(args).find((value) => typeof value === "string");
	return typeof first === "string" ? first.replace(/\s+/g, " ").slice(0, 60) : "";
}
