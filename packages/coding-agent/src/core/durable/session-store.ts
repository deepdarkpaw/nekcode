import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai";
import {
	type ContextEdit,
	type ConversationId,
	type ConversationRecord,
	type Cursor,
	createRegistry,
	type EntryDraft,
	type EntryId,
	type EntryRecord,
	Harness,
	type HarnessSettings,
	MemoryStorage,
	type Registry,
	ROOT_CONVERSATION_ID,
	type Storage,
	type Tx,
} from "@earendil-works/pi-durable";
import { type SessionEntry, SessionInfoBuilder } from "../session-entries.ts";
import { acquireSessionLock, type SessionLock, sessionLockPath } from "./lock.ts";
import { HookedModels } from "./models.ts";
import { createSessionDatabase, StaleSessionPlacement, writePlansSync } from "./session-db.ts";
import type { EntryPlan } from "./session-format.ts";
import { sidecarFromBuilder, writeSessionSidecar } from "./session-sidecar.ts";
import { Placement, projectSnapshot, readSessionSnapshot } from "./session-snapshot.ts";
import { openSqliteStorage } from "./sqlite.ts";

/**
 * Harness options a host binds after the store opened its Harness: models, registry, and settings are switchable
 * objects the Harness reads at every use, so an engine attaches to the open Harness without reopening it.
 */
export class StoreHost {
	readonly models = new HookedModels(createModels(), {});
	readonly registry: Registry = createRegistry();
	settings: HarnessSettings = {};
	report: (error: unknown) => void = () => {};

	/** The settings object handed to the Harness: every read goes to the current `settings`. */
	readonly harnessSettings: HarnessSettings = createSwitchableSettings(() => this.settings);
}

function createSwitchableSettings(current: () => HarnessSettings): HarnessSettings {
	return {
		get extensions() {
			return current().extensions;
		},
		get stream() {
			return current().stream;
		},
		get retry() {
			return current().retry;
		},
		get compaction() {
			return current().compaction;
		},
		get progress() {
			return current().progress;
		},
		get toolExecution() {
			return current().toolExecution;
		},
		get steeringMode() {
			return current().steeringMode;
		},
		get followUpMode() {
			return current().followUpMode;
		},
		get toolErrorText() {
			return current().toolErrorText;
		},
	};
}

const stores = new Map<string, DurableSessionStore>();

function storeKey(path: string): string {
	return process.platform === "win32" ? path.toLowerCase() : path;
}

/**
 * Durable storage of one session, shared by every `SessionManager` of that session in this process.
 *
 * - While no engine has the session pinned, `write()` commits synchronously (`session-db.ts`), holding the session
 *   lock only for the write, so another process running an engine on the session makes it throw `SessionLockedError`.
 * - `pin()` opens a Harness and holds the lock until the last `unpin()`; writes meanwhile go through the Harness
 *   in order, and `flush()` waits for them.
 * - The first write of a session creates it atomically: a temporary database is written and renamed into place, so a
 *   crash leaves either no session or the whole one. Temporaries of dead processes are removed at the next creation.
 */
export class DurableSessionStore {
	readonly path: string | undefined;
	readonly host = new StoreHost();
	#lock: SessionLock | undefined;
	#memory: MemoryStorage | undefined;
	#harness: Harness | undefined;
	#opening: Promise<Harness> | undefined;
	/** Where pi entries live, valid while the database's next commit sequence is `#placementSeq`. */
	#placement: Placement | undefined;
	#placementSeq: number | undefined;
	#summary: SessionInfoBuilder | undefined;
	#pins = 0;
	#queue: EntryPlan[] = [];
	#drain: Promise<void> | undefined;
	#error: unknown;

	private constructor(path: string | undefined) {
		this.path = path;
	}

	/** The store of a session database path in this process. */
	static forPath(path: string): DurableSessionStore {
		const key = storeKey(path);
		let store = stores.get(key);
		if (store === undefined) {
			store = new DurableSessionStore(path);
			stores.set(key, store);
		}
		return store;
	}

	/** A store over memory, for sessions that are not persisted. */
	static inMemory(): DurableSessionStore {
		return new DurableSessionStore(undefined);
	}

	/** Whether an engine in this process has `path` open. */
	static isPinned(path: string): boolean {
		const store = stores.get(storeKey(path));
		return store !== undefined && store.#pins > 0;
	}

	/**
	 * Write entries in order. Synchronous unless the session is pinned or in memory, where they are committed through
	 * the Harness and `flush()` waits for them.
	 */
	write(plans: readonly EntryPlan[]): void {
		if (plans.length === 0) return;
		if (this.path === undefined || this.#pins > 0 || this.#harness !== undefined || this.#opening !== undefined) {
			this.#queue.push(...plans);
			this.#drain ??= this.#runQueue();
			return;
		}
		this.#writeSync(this.path, plans);
	}

	/** Resolve when every write is committed; reject with the first write failure since the last flush. */
	async flush(): Promise<void> {
		while (this.#drain !== undefined) await this.#drain;
		const error = this.#error;
		this.#error = undefined;
		if (error !== undefined) throw error;
	}

	/** The open Harness, kept open with the session lock held until the matching `unpin()`. */
	async pin(context: Context = BACKGROUND_CONTEXT): Promise<Harness> {
		if (this.path !== undefined && this.#lock === undefined)
			this.#lock = acquireSessionLock(sessionLockPath(this.path));
		this.#pins++;
		try {
			await this.flush();
			return await this.#open(context);
		} catch (error) {
			await this.unpin();
			throw error;
		}
	}

	/** Release one pin; the last one flushes, closes the Harness, and releases the lock. */
	async unpin(): Promise<void> {
		this.#pins = Math.max(0, this.#pins - 1);
		if (this.#pins === 0) await this.close();
	}

	/** Conversation holding a pi entry, once known; the conversation an engine attaches to for a leaf. */
	conversationOf(piId: string): ConversationId | undefined {
		return this.#placement?.home.get(piId);
	}

	/** Flush, close the Harness, and release the lock. An in-memory store keeps its Harness: it holds the session. */
	async close(): Promise<void> {
		await this.flush();
		if (this.path === undefined) return;
		const harness = this.#harness;
		this.#harness = undefined;
		// Commits through the Harness advanced the database; placement is reread at the next write.
		this.#placement = undefined;
		// The Harness's own commits (inputs, answers, tool results) are not in the summary, so after it ran the summary
		// is rebuilt from the database before the sidecar describes it. Without a fresh summary no sidecar is written,
		// and listing rebuilds it from the database.
		let summaryFresh = harness === undefined;
		try {
			if (harness !== undefined) {
				await harness.close(BACKGROUND_CONTEXT);
				this.#reload(this.path);
				summaryFresh = true;
			}
		} finally {
			if (summaryFresh) this.#writeSidecar();
			this.#lock?.release();
			this.#lock = undefined;
		}
	}

	#writeSync(path: string, plans: readonly EntryPlan[]): void {
		const lock = this.#lock === undefined ? acquireSessionLock(sessionLockPath(path)) : undefined;
		try {
			if (!existsSync(path)) this.#create(path, plans);
			else this.#append(path, plans);
		} finally {
			lock?.release();
		}
		this.#writeSidecar();
	}

	/** Write a new session to a temporary database and move it into place. */
	#create(path: string, plans: readonly EntryPlan[]): void {
		removeStaleTemporaries(path);
		const temporary = `${path}.tmp-${process.pid}-${randomUUID().slice(0, 8)}`;
		const placement = new Placement();
		placement.tails.set(ROOT_CONVERSATION_ID, null);
		try {
			createSessionDatabase(temporary);
			const seq = writePlansSync(temporary, placement, plans, undefined);
			renameSync(temporary, path);
			this.#placement = placement;
			this.#placementSeq = seq;
		} catch (error) {
			rmSync(temporary, { force: true });
			throw error;
		}
		this.#summary = new SessionInfoBuilder();
		for (const plan of plans) this.#summary.add(plan.source);
	}

	#append(path: string, plans: readonly EntryPlan[]): void {
		for (let attempt = 0; ; attempt++) {
			if (this.#placement === undefined) this.#reload(path);
			try {
				this.#placementSeq = writePlansSync(path, this.#placement!, plans, this.#placementSeq);
				for (const plan of plans) this.#summary?.add(plan.source);
				return;
			} catch (error) {
				// A failed write may have advanced placement in memory; reread it from the database.
				this.#placement = undefined;
				if (!(error instanceof StaleSessionPlacement) || attempt > 0) throw error;
			}
		}
	}

	#reload(path: string): void {
		const snapshot = readSessionSnapshot(path);
		const projected = projectSnapshot(snapshot);
		this.#placement = projected.placement;
		this.#placementSeq = snapshot.nextSeq;
		this.#summary = new SessionInfoBuilder();
		for (const entry of projected.fileEntries) this.#summary.add(entry);
	}

	async #runQueue(): Promise<void> {
		try {
			while (this.#queue.length > 0) {
				const batch = this.#queue.splice(0);
				try {
					const harness = await this.#open(BACKGROUND_CONTEXT);
					await this.#reloadPlacement(BACKGROUND_CONTEXT);
					await commitPlans(harness, this.#placement!, batch, BACKGROUND_CONTEXT);
					for (const plan of batch) this.#summary?.add(plan.source);
					this.#writeSidecar();
				} catch (error) {
					this.#error ??= error;
					this.host.report(error);
				}
			}
		} finally {
			this.#drain = undefined;
		}
	}

	/** Read the complete in-memory durable tables for a synchronous SessionManager projection. */
	async memorySnapshot(
		context: Context = BACKGROUND_CONTEXT,
	): Promise<{ conversations: ConversationRecord[]; entries: EntryRecord[]; nextSeq: number } | undefined> {
		if (this.path !== undefined || this.#memory === undefined) return undefined;
		const conversations: ConversationRecord[] = [];
		let conversationCursor: Cursor | undefined;
		do {
			const page = await this.#memory.scanConversations({}, 256, conversationCursor, context);
			conversations.push(...page.items);
			conversationCursor = page.next;
		} while (conversationCursor !== undefined);
		const entries: EntryRecord[] = [];
		for (const conversation of conversations) {
			let entryCursor: Cursor | undefined;
			do {
				const page = await this.#memory.scanEntries({ conversationId: conversation.id }, 256, entryCursor, context);
				entries.push(...page.items);
				entryCursor = page.next;
			} while (entryCursor !== undefined);
		}
		conversations.sort((left, right) => left.id - right.id);
		entries.sort((left, right) => left.id - right.id);
		return { conversations, entries, nextSeq: 0 };
	}

	async #reloadPlacement(context: Context): Promise<void> {
		if (this.path !== undefined) {
			this.#reload(this.path);
			return;
		}
		const snapshot = await this.memorySnapshot(context);
		if (snapshot === undefined) return;
		const projected = projectSnapshot(snapshot);
		this.#placement = projected.placement;
		this.#summary = new SessionInfoBuilder();
		for (const entry of projected.fileEntries) this.#summary.add(entry);
	}

	async #open(context: Context): Promise<Harness> {
		if (this.#harness !== undefined) return this.#harness;
		this.#opening ??= this.#openNow(context).finally(() => {
			this.#opening = undefined;
		});
		return this.#opening;
	}

	async #openNow(context: Context): Promise<Harness> {
		let storage: Storage;
		if (this.path === undefined) {
			this.#memory ??= new MemoryStorage();
			storage = this.#memory;
			if (this.#placement === undefined) {
				this.#placement = new Placement();
				this.#placement.tails.set(ROOT_CONVERSATION_ID, null);
			}
		} else {
			// Nothing written yet: create the session empty, then continue on it.
			if (!existsSync(this.path)) this.#create(this.path, []);
			this.#reload(this.path);
			storage = await openSqliteStorage(this.path);
		}
		const harness = await Harness.open(
			storage,
			{
				models: this.host.models,
				registry: this.host.registry,
				settings: this.host.harnessSettings,
				onReport: (error) => this.host.report(error),
			},
			context,
		);
		await harness.root(context);
		this.#harness = harness;
		return harness;
	}

	#writeSidecar(): void {
		if (this.path === undefined || this.#summary === undefined) return;
		const sidecar = sidecarFromBuilder(this.#summary);
		if (sidecar === undefined) return;
		try {
			writeSessionSidecar(this.path, sidecar);
		} catch (error) {
			// The sidecar is a listing cache; listing rebuilds it from the database.
			this.host.report(error);
		}
	}
}

/** Commit `plans` through the Harness, placing each entry in its conversation. */
async function commitPlans(
	harness: Harness,
	placement: Placement,
	plans: readonly EntryPlan[],
	context: Context,
): Promise<void> {
	let next = 0;
	while (next < plans.length) {
		next = await harness.commit(async (tx) => {
			// Durable forks only at committed entries: a fork at an entry of this commit waits for the next one.
			const staged = new Set<string>();
			let index = next;
			for (; index < plans.length; index++) {
				const plan = plans[index]!;
				if (plan.source.type === "session") {
					if (placement.headerWritten) continue;
					await tx.appendEntry(ROOT_CONVERSATION_ID, toDraft(plan, placement));
					placement.headerWritten = true;
					continue;
				}
				const entry = plan.source as SessionEntry;
				if (index > next && forksAtStaged(placement, entry, staged)) break;
				const conversationId = await conversationFor(tx, placement, entry);
				const record = await tx.appendEntry(conversationId, toDraft(plan, placement));
				placement.record(entry.id, record.id, conversationId);
				staged.add(entry.id);
			}
			return index;
		}, context);
	}
}

function parentOf(entry: SessionEntry): string | null {
	return entry.parentId === entry.id ? null : entry.parentId;
}

function forksAtStaged(placement: Placement, entry: SessionEntry, staged: ReadonlySet<string>): boolean {
	const parentId = parentOf(entry);
	return parentId !== null && staged.has(parentId) && placement.conversationEndingAt(parentId) === undefined;
}

/** Same placement rule as `session-db.ts`, through a transaction. */
async function conversationFor(tx: Tx, placement: Placement, entry: SessionEntry): Promise<ConversationId> {
	const parentId = parentOf(entry);
	if (parentId !== null) {
		const continued = placement.conversationEndingAt(parentId);
		if (continued !== undefined) return continued;
		const at = placement.durableIds.get(parentId);
		const home = placement.home.get(parentId);
		if (at !== undefined && home !== undefined) {
			const fork = await tx.forkConversation(home, at, { ownership: { kind: "ownerless" } });
			placement.tails.set(fork.id, null);
			return fork.id;
		}
	} else if (placement.tails.get(ROOT_CONVERSATION_ID) === null) {
		return ROOT_CONVERSATION_ID;
	}
	const created = await tx.createConversation({ ownership: { kind: "ownerless" } });
	placement.tails.set(created.id, null);
	return created.id;
}

function toDraft(plan: EntryPlan, placement: Placement): EntryDraft {
	const head =
		plan.head === undefined
			? undefined
			: plan.head === "self"
				? "self"
				: (placement.durableIds.get(plan.head) ?? "self");
	const edits: ContextEdit[] = [];
	for (const edit of plan.edits ?? []) {
		const target = placement.durableIds.get(edit.target);
		if (target === undefined) continue;
		edits.push(
			edit.action === "omit" ? { target, action: "omit" } : { target, action: "replace", messages: edit.messages },
		);
	}
	return {
		kind: plan.kind,
		data: plan.data,
		...(plan.model === undefined ? {} : { model: plan.model }),
		...(head === undefined ? {} : { head: head as EntryId | "self" }),
		...(edits.length === 0 ? {} : { edits }),
	};
}

/** Remove temporary databases a crashed creation of `path` left behind. */
export function removeStaleTemporaries(path: string): void {
	const directory = dirname(path);
	const prefix = `${basename(path)}.tmp-`;
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch {
		return;
	}
	for (const name of names) {
		if (!name.startsWith(prefix)) continue;
		const pid = Number(name.slice(prefix.length).split("-")[0]);
		if (pid === process.pid || isAlive(pid)) continue;
		rmSync(join(directory, name), { force: true });
	}
}

function isAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Newest modification time of a session database and its write-ahead log. */
export function databaseModifiedMs(path: string): number {
	let modified = 0;
	for (const file of [path, `${path}-wal`]) {
		try {
			modified = Math.max(modified, statSync(file).mtimeMs);
		} catch {
			// Absent write-ahead log.
		}
	}
	return modified;
}
