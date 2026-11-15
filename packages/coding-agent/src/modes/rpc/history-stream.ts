import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AgentSessionEvent } from "../../core/agent-session.ts";
import type { SessionEntry } from "../../core/session-entries.ts";
import type { RpcHistoryStreamEvent, RpcHistoryStreamState } from "./gui/history-stream-protocol.ts";
import { historyJsonChunks } from "./history-json-stream.ts";
import { type HistoryLiveEvent, historyLiveEvent } from "./history-live-event.ts";

const MAX_EVENT_BYTES = 1048576;
const INLINE_BYTES = 512 * 1024;
const MAX_PENDING = 32;
const MAX_COMMITTED_BATCH = 4096;
export interface HistoryStreamSource {
	sessionPath: string | undefined;
	sessionId: string;
	leafId(): string | null;
	waitForWrites(): Promise<void>;
	committedPosition(): number;
	hasCommittedEntry(entryId: string): boolean;
	committedSince(position: number): { position: number; entries: readonly SessionEntry[] };
}
export interface HistoryStreamEmitter {
	/** Remains true after a visible stream error: never fall back to legacy giant events. */
	enabled(): boolean;
	configure(version: 0 | 1): Promise<RpcHistoryStreamState>;
	rebind(source: HistoryStreamSource): Promise<void>;
	publish(event: AgentSessionEvent): void;
	publishExternal(event: Record<string, unknown>): void;
	drain(): Promise<void>;
	/** Stop accepting new callbacks while existing frames drain during the owner's normal shutdown. */
	seal(): void;
	stop(): void;
}
type Frame = RpcHistoryStreamEvent extends infer E
	? E extends RpcHistoryStreamEvent
		? Omit<E, "version" | "epoch" | "seq">
		: never
	: never;
type Work = { epoch: string; source: HistoryStreamSource } & (
	| { kind: "entry"; entryId: string; parentId: string | null }
	| { kind: "event"; value: HistoryLiveEvent }
);
class StreamFailure extends Error {
	readonly code: "STREAM_LIMIT" | "STORAGE_ERROR" | "ENCODING_ERROR";
	constructor(code: StreamFailure["code"], message: string) {
		super(message);
		this.code = code;
	}
}

/** A bounded, process-owned RPC transport adapter; all history/context remains with the existing session owner. */
export function createHistoryStreamEmitter(
	initial: HistoryStreamSource,
	write: (frame: RpcHistoryStreamEvent) => Promise<void>,
): HistoryStreamEmitter {
	let source = initial;
	let enabled = false;
	let accepting = true;
	let failed = false;
	let epoch: string = randomUUID();
	let seq = 0;
	let eventId = 0;
	let position = initial.committedPosition();
	/** Last entry the consumer can hold contiguously: the bootstrap leaf, then every announced locator. */
	let announced: string | null = initial.leafId();
	const queue: Work[] = [];
	let pump: Promise<void> | undefined;
	const current = (owner: string) => owner === epoch && enabled && !failed;
	async function emit(frame: Frame, owner = epoch): Promise<void> {
		if (owner !== epoch || !enabled) return;
		for (const field of ["entryId", "sessionId", "sessionPath", "leafId"]) {
			const value = (frame as unknown as Record<string, unknown>)[field];
			if (typeof value === "string" && value.length > (field === "sessionPath" ? 32768 : 4096))
				throw new StreamFailure("STREAM_LIMIT", `Live locator ${field} exceeds its metadata bound`);
		}
		const record = { ...frame, version: 1 as const, epoch: owner, seq: ++seq } as RpcHistoryStreamEvent;
		if (Buffer.byteLength(JSON.stringify(record)) > MAX_EVENT_BYTES)
			throw new StreamFailure("STREAM_LIMIT", "Live history frame exceeds 1MiB");
		await write(record);
	}
	async function fail(error: unknown, owner: string): Promise<void> {
		if (owner !== epoch || failed || !enabled) return;
		failed = true;
		queue.length = 0;
		await emit(
			{
				type: "history_stream_error",
				code: error instanceof StreamFailure ? error.code : "ENCODING_ERROR",
				message: (error instanceof Error ? error.message : String(error)).slice(0, 512),
			},
			owner,
		);
	}
	/**
	 * Locators are contiguous. `ordered` holds for the committed delta and for a stored host append whose parent
	 * is the last announced entry. Any other stored entry the owner's projection has not folded yet (e.g. a host
	 * hook append racing an engine commit) is announced by a later delta after every earlier entry.
	 */
	async function entry(entryId: string, work: Work, ordered: boolean): Promise<void> {
		if (!current(work.epoch)) return;
		const path = work.source.sessionPath;
		if (entryId.length > 4096 || work.source.sessionId.length > 4096 || (path !== undefined && path.length > 32768))
			throw new StreamFailure("STREAM_LIMIT", "Live locator identity exceeds its metadata bound");
		if (!path || !existsSync(path) || !work.source.hasCommittedEntry(entryId)) {
			await emit(
				{ type: "history_entry_pending", sessionPath: path, sessionId: work.source.sessionId, entryId },
				work.epoch,
			);
			return;
		}
		if (!ordered) return;
		await emit(
			{
				type: "history_entry_appended",
				sessionPath: path,
				sessionId: work.source.sessionId,
				entryId,
				leafId: work.source.leafId(),
				ref: { command: "read_history_page", sessionPath: path, aroundEntryId: entryId },
			},
			work.epoch,
		);
		if (current(work.epoch)) announced = entryId;
	}
	async function committed(work: Work): Promise<Set<string>> {
		try {
			await work.source.waitForWrites();
		} catch (error) {
			throw new StreamFailure("STORAGE_ERROR", error instanceof Error ? error.message : String(error));
		}
		const ids = new Set<string>();
		if (!current(work.epoch)) return ids;
		// Check the O(1) watermark before asking the existing owner to allocate an incremental slice.
		const available = work.source.committedPosition();
		if (available < position)
			throw new StreamFailure("STORAGE_ERROR", "Committed history moved backwards; refetch history");
		if (available - position > MAX_COMMITTED_BATCH)
			throw new StreamFailure("STREAM_LIMIT", "Live committed batch exceeds 4096 entries; refetch bounded history");
		// Independent committed cursor: no getEntries(), cold snapshot, refresh/reparse, or historical body cache.
		let delta: ReturnType<HistoryStreamSource["committedSince"]>;
		try {
			delta = work.source.committedSince(position);
		} catch (error) {
			throw new StreamFailure("STORAGE_ERROR", error instanceof Error ? error.message : String(error));
		}
		if (delta.entries.length > MAX_COMMITTED_BATCH)
			throw new StreamFailure("STREAM_LIMIT", "Live committed batch exceeds 4096 entries; refetch bounded history");
		position = delta.position;
		for (const value of delta.entries) {
			if (!current(work.epoch)) break;
			ids.add(value.id);
			await entry(value.id, work, true);
		}
		return ids;
	}
	async function event(value: HistoryLiveEvent, owner: string): Promise<void> {
		const id = ++eventId;
		const chunks = historyJsonChunks(value.event);
		const initial: Buffer[] = [];
		let bytes = 0;
		let done = false;
		while (bytes < INLINE_BYTES) {
			const next = chunks.next();
			if (next.done) {
				done = true;
				break;
			}
			initial.push(next.value);
			bytes += next.value.length;
		}
		if (!current(owner)) return;
		if (done) {
			await emit(
				{
					type: "history_event",
					eventId: id,
					event: JSON.parse(Buffer.concat(initial, bytes).toString("utf8")),
					omissions: value.omissions,
				},
				owner,
			);
			return;
		}
		await emit(
			{
				type: "history_event_start",
				eventId: id,
				eventType: String(value.event.type).slice(0, 256),
				encoding: "json-utf8/base64",
				omissions: value.omissions,
			},
			owner,
		);
		let offset = 0;
		async function chunk(data: Buffer): Promise<void> {
			if (!current(owner)) return;
			await emit(
				{ type: "history_event_chunk", eventId: id, offset, data: data.toString("base64"), final: false },
				owner,
			);
			offset += data.length;
		}
		for (const data of initial) {
			if (!current(owner)) return;
			await chunk(data);
		}
		initial.length = 0;
		for (const data of chunks) {
			if (!current(owner)) return;
			await chunk(data);
		}
		if (current(owner))
			await emit(
				{ type: "history_event_chunk", eventId: id, offset, data: "", final: true, totalBytes: offset },
				owner,
			);
	}
	async function run(): Promise<void> {
		while (queue.length && enabled && !failed) {
			const work = queue.shift()!;
			if (!current(work.epoch)) continue;
			try {
				const ids = await committed(work);
				if (!current(work.epoch)) continue;
				if (work.kind === "entry") {
					if (!ids.has(work.entryId)) await entry(work.entryId, work, work.parentId === announced);
				} else await event(work.value, work.epoch);
			} catch (error) {
				await fail(error, work.epoch);
			}
		}
	}
	function enqueue(work: Work): void {
		if (!enabled || failed || !accepting) return;
		if (queue.length >= MAX_PENDING) {
			void fail(
				new StreamFailure(
					"STREAM_LIMIT",
					"Live event queue exceeds 32; explicitly refetch history and renegotiate",
				),
				epoch,
			);
			return;
		}
		queue.push(work);
		schedule();
	}
	function schedule(): void {
		pump ??= run().finally(() => {
			pump = undefined;
			if (queue.length && enabled && !failed) schedule();
		});
	}
	async function drain(): Promise<void> {
		while (pump) await pump;
	}
	async function reset(next: HistoryStreamSource): Promise<void> {
		source = next;
		epoch = randomUUID();
		seq = 0;
		eventId = 0;
		position = next.committedPosition();
		announced = next.leafId();
		queue.length = 0;
		accepting = true;
		failed = false;
		if (enabled) {
			await emit({ type: "history_stream_reset", sessionPath: next.sessionPath, sessionId: next.sessionId });
			if (!next.sessionPath)
				await fail(
					new StreamFailure(
						"STORAGE_ERROR",
						"The rebound session has no persisted history; explicitly disable historyStream",
					),
					epoch,
				);
		}
	}
	return {
		enabled: () => enabled,
		async configure(version) {
			if (version !== 0 && version !== 1) throw new Error("set_history_stream version must be 0 or 1");
			if (version === 1 && !source.sessionPath)
				throw new Error("historyStream requires a persisted session, not an in-memory session");
			await drain();
			enabled = version === 1;
			await reset(source);
			return { version, epoch, maxEventBytes: MAX_EVENT_BYTES };
		},
		rebind: reset,
		publish(value) {
			if (!enabled || failed || !accepting) return;
			try {
				enqueue(
					value.type === "entry_appended"
						? { kind: "entry", entryId: value.entry.id, parentId: value.entry.parentId, source, epoch }
						: { kind: "event", value: historyLiveEvent(value), source, epoch },
				);
			} catch (error) {
				void fail(error, epoch);
			}
		},
		publishExternal(value) {
			enqueue({ kind: "event", value: { event: value, omissions: [] }, source, epoch });
		},
		drain,
		seal() {
			accepting = false;
		},
		stop() {
			accepting = false;
			failed = true;
			queue.length = 0;
			epoch = randomUUID();
		},
	};
}
