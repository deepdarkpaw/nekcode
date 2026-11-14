import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { HistoryJson } from "../../../core/durable/history-json.ts";
import {
	type HistoryStorage,
	type HistoryStoredEntry,
	historyEntrySpans,
	legacyHistoryProjection,
} from "../../../core/durable/history-storage.ts";
import { isSessionLocked, readSessionLockOwner, sessionLockPath } from "../../../core/durable/lock.ts";
import { projectRecord } from "../../../core/durable/session-format.ts";
import type { SessionEntry } from "../../../core/session-entries.ts";
import { resolvePath } from "../../../utils/paths.ts";
import type { GuiContext } from "./context.ts";
import type {
	RpcHistoryCommand,
	RpcHistoryCommandResult,
	RpcHistoryContent,
	RpcHistoryDirectory,
	RpcHistoryEntry,
	RpcHistoryErrorCode,
	RpcHistoryIdentity,
	RpcHistoryMetadata,
	RpcHistoryOmission,
	RpcHistoryPage,
	RpcHistoryResponseData,
	RpcHistorySelection,
	RpcHistorySubagent,
	RpcHistorySubagentDirectory,
	RpcHistorySubagentRecord,
	RpcHistorySummaryPage,
	RpcHistoryTurn,
	RpcHistoryTurnPage,
} from "./history-protocol.ts";
import { openHistorySource } from "./history-source.ts";

const SECRET = randomBytes(32);
const DEFAULT_BYTES = 1024 * 1024;
const MAX_ENTRIES = 256;
const CHILD_TOOLS = ["subagent", "await", "stop_subagent"];
type Turn = { id: string; start: number; header: number; end: number; userEntryId: string | null };
type Range = [start: number, end: number];
type TurnWindow = { turn: Turn; descriptor: RpcHistoryTurn; low: number; high: number; around: boolean; left: boolean };
type Token = {
	session: string;
	count: number;
	prefix: string;
	kind: string;
	position: number;
	turnId?: string;
	query?: string;
	direction?: string;
	entryId?: string;
	start?: number;
	end?: number;
	remaining?: Range[];
};
type View = {
	storage: HistoryStorage;
	branch: HistoryStoredEntry[];
	prefixes: string[];
	sessionKey: string;
	identity: RpcHistoryIdentity;
	turns: Turn[];
	turnAt: number[];
	childRecords?: Map<string, RpcHistorySubagentRecord>;
	callOwners?: Map<string, NonNullable<RpcHistoryEntry["toolCallOrigin"]>>;
};
type CursorAuthority = Pick<View, "branch" | "prefixes" | "sessionKey">;
class HistoryError extends Error {
	readonly code: RpcHistoryErrorCode;
	constructor(code: RpcHistoryErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}
function fail(code: RpcHistoryErrorCode, message: string): never {
	throw new HistoryError(code, message);
}
function integer(value: number | undefined, fallback: number, min: number, max: number): number {
	const number = value === undefined ? fallback : value;
	if (!Number.isSafeInteger(number) || number < min || number > max)
		fail("INVALID_REQUEST", `Expected integer in ${min}..${max}`);
	return number;
}
function preview(entry: SessionEntry): string {
	const e = entry as unknown as Record<string, unknown>;
	const message = e.message as Record<string, unknown> | undefined;
	const content = message?.content ?? e.content ?? e.summary;
	const text =
		typeof content === "string"
			? content
			: Array.isArray(content)
				? content.find((part) => part?.type === "text" || typeof part?.text === "string")?.text
				: "";
	return String(text ?? "")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, 256);
}
function openView(ctx: GuiContext, command: RpcHistoryCommand, depth = 0): View {
	if (depth > 8) fail("INVALID_STORAGE", "Child history ancestry exceeds eight levels");
	const requested = command.sessionPath ?? ctx.session?.sessionFile;
	if (!requested) fail("INVALID_REQUEST", "sessionPath is required without an active persisted session");
	const storage = openHistorySource(ctx, command, requested);
	try {
		if (basename(dirname(storage.path)) === "subagents") {
			if (!storage.header.parentSession) fail("FOREIGN_CURSOR", "Child history has no persisted parent");
			const parent = openView(
				ctx,
				{ type: "read_session_metadata", sessionPath: storage.header.parentSession },
				depth + 1,
			);
			try {
				const relation = children(parent).get(storage.header.id);
				if (!relation?.sessionFile || realpathSync(resolvePath(relation.sessionFile)) !== storage.path)
					fail("FOREIGN_CURSOR", "Child is not authorized by the parent effective branch");
			} finally {
				parent.storage.close();
			}
		}
		const byId = new Map<string, HistoryStoredEntry>();
		for (const row of storage.entries) {
			if (byId.has(row.entry.id)) fail("INVALID_STORAGE", "Duplicate history entry identity");
			byId.set(row.entry.id, row);
		}
		const current = ctx.session?.sessionFile;
		const same =
			current !== undefined &&
			existsSync(resolvePath(current)) &&
			realpathSync(resolvePath(current)) === storage.path;
		let leaf = same ? ctx.session!.sessionManager.getLeafId() : (storage.entries.at(-1)?.entry.id ?? null);
		const branch: HistoryStoredEntry[] = [];
		const seen = new Set<string>();
		while (leaf !== null) {
			if (seen.has(leaf)) fail("INVALID_STORAGE", "Cyclic history branch");
			seen.add(leaf);
			const row = byId.get(leaf);
			if (!row) fail("INVALID_STORAGE", "Selected branch is not persisted; retry after commit");
			branch.push(row);
			leaf = row.entry.parentId;
		}
		branch.reverse();
		const sessionKey = createHash("sha256")
			.update(JSON.stringify([storage.path, storage.header]))
			.digest("hex");
		const prefixes: string[] = [];
		let hash = sessionKey;
		for (const row of branch) {
			hash = createHash("sha256").update(hash).update(row.fingerprint).digest("hex");
			prefixes.push(hash);
		}
		const authority: CursorAuthority = { branch, prefixes, sessionKey };
		if (command.observationCursor !== undefined) untoken(authority, command.observationCursor, "observation");
		const identity: RpcHistoryIdentity = {
			sessionPath: storage.path,
			sessionId: storage.header.id,
			branchRevision: hash,
			observationCursor: token(authority, { kind: "observation", position: 0 }),
			leafId: branch.at(-1)?.entry.id ?? null,
			watermark: storage.watermark,
		};
		if (command.branchRevision !== undefined && command.branchRevision !== hash)
			fail("STALE_CURSOR", "Persisted branch revision changed");
		const turns: Turn[] = [];
		const turnAt: number[] = [];
		for (let position = 0; position < branch.length; position++) {
			const entry = branch[position].entry;
			const user = entry.type === "message" && entry.message.role === "user";
			if (user && turns.length === 1 && turns[0].userEntryId === null) {
				// Leading configuration belongs to the first user round, never an extra pagination round.
				Object.assign(turns[0], { id: `turn:${entry.id}`, header: position, userEntryId: entry.id });
			} else if (user || !turns.length) {
				if (turns.length) turns[turns.length - 1].end = position;
				turns.push({
					id: user ? `turn:${entry.id}` : "preamble",
					start: position,
					header: position,
					end: branch.length,
					userEntryId: user ? entry.id : null,
				});
			}
			turnAt.push(turns.length - 1);
		}
		return { storage, branch, prefixes, sessionKey, identity, turns, turnAt };
	} catch (error) {
		storage.close();
		throw error;
	}
}
function token(view: CursorAuthority, fields: Omit<Token, "session" | "count" | "prefix">): string {
	const data: Token = {
		session: view.sessionKey,
		count: view.branch.length,
		prefix: view.prefixes.at(-1) ?? view.sessionKey,
		...fields,
	};
	const payload = Buffer.from(JSON.stringify(data)).toString("base64url");
	return `${payload}.${createHmac("sha256", SECRET).update(payload).digest("base64url")}`;
}
function untoken(view: CursorAuthority, encoded: string, kind: string): Token {
	if (typeof encoded !== "string" || encoded.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(encoded))
		fail("INVALID_CURSOR", "Invalid history capability");
	const [payload, signature, extra] = encoded.split(".");
	const expected = createHmac("sha256", SECRET)
		.update(payload ?? "")
		.digest();
	const actual = Buffer.from(signature ?? "", "base64url");
	if (
		extra !== undefined ||
		actual.toString("base64url") !== signature ||
		expected.length !== actual.length ||
		!timingSafeEqual(expected, actual)
	)
		fail("INVALID_CURSOR", "Invalid or expired history capability");
	let value: Token;
	try {
		value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Token;
	} catch {
		return fail("INVALID_CURSOR", "Malformed history capability");
	}
	if (value.session !== view.sessionKey) fail("FOREIGN_CURSOR", "History capability belongs to another session");
	if (
		value.kind !== kind ||
		!Number.isSafeInteger(value.count) ||
		!Number.isSafeInteger(value.position) ||
		value.count < 0 ||
		value.position < 0
	)
		fail("INVALID_CURSOR", "Wrong history capability kind or position");
	if (
		view.branch.length < value.count ||
		(value.count ? view.prefixes[value.count - 1] : view.sessionKey) !== value.prefix
	)
		fail("STALE_CURSOR", "History branch was removed, replaced or navigated");
	return value;
}
function omission(view: View, position: number, pointer: string, start: number, end: number): RpcHistoryOmission {
	return {
		pointer,
		ref: token(view, { kind: "content", position, entryId: view.branch[position].entry.id, start, end }),
		totalBytes: end - start,
		mediaType: "application/json",
		encoding: "base64",
	};
}
function projected(view: View, position: number, raw: unknown): SessionEntry {
	const base = view.branch[position].entry;
	if (view.storage.format === "jsonl")
		return legacyHistoryProjection(raw as Record<string, unknown>, base) as unknown as SessionEntry;
	const result = projectRecord(raw as EntryRecord, () => ({
		id: base.id,
		parentId: base.parentId,
		fallbackTimestamp: base.timestamp,
		idOf: (id) => view.storage.entries.find((row) => row.storageId === id)?.entry.id,
		compactionRecords: [],
	}));
	if (result.type !== "entry") fail("INVALID_STORAGE", "Indexed entry no longer projects");
	return { ...result.entry, parentId: base.parentId };
}
function toolOrigin(view: View, position: number, toolCallId: string): RpcHistoryEntry["toolCallOrigin"] {
	view.callOwners ??= new Map();
	const found = Symbol("tool call owner");
	for (let prior = position - 1; prior >= 0; prior--) {
		const entry = view.branch[prior].entry;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		const known = view.callOwners.get(`${prior}:${toolCallId}`);
		if (known) return known;
		const source = view.storage.bytes(view.branch[prior]);
		let block: { type?: string; id?: string; name?: string } = {};
		try {
			new HistoryJson(source).walk((span) => {
				const path = span.path;
				const contentAt = path.indexOf("content");
				if (contentAt < 0 || typeof path[contentAt + 1] !== "number") return;
				const prefix = path.slice(0, contentAt).join(".");
				if (!["message", "data.entry.message", "model.0", "data.message"].includes(prefix)) return;
				if (
					path.length === contentAt + 3 &&
					["type", "id", "name"].includes(String(path.at(-1))) &&
					typeof span.value === "string"
				)
					Object.assign(block, { [String(path.at(-1))]: span.value });
				if (path.length !== contentAt + 2) return;
				if (block.type === "toolCall" && block.id && block.name) {
					const origin = { entryId: entry.id, position: prior, toolCallId: block.id, name: block.name };
					if (view.callOwners!.size >= MAX_ENTRIES) view.callOwners!.delete(view.callOwners!.keys().next().value!);
					view.callOwners!.set(`${prior}:${block.id}`, origin);
					if (block.id === toolCallId) throw found;
				}
				block = {};
			});
		} catch (error) {
			if (error === found) return view.callOwners.get(`${prior}:${toolCallId}`)!;
			throw error;
		} finally {
			source.close();
		}
	}
	return null;
}
function displayEntry(view: View, position: number, inlineBytes = 8192): RpcHistoryEntry {
	const stored = view.branch[position];
	const base = stored.entry;
	const message = base.type === "message" ? base.message : undefined;
	const result: RpcHistoryEntry = {
		id: base.id,
		parentId: base.parentId,
		position,
		turnId: view.turns[view.turnAt[position]].id,
		timestamp: base.timestamp,
		type: base.type,
		...(message ? { role: message.role } : {}),
		preview: preview(base),
		entry: {},
		omissions: [],
	};
	if (message?.role === "toolResult") result.toolCallOrigin = toolOrigin(view, position, message.toolCallId);
	const details = (
		message && "details" in message ? message.details : base.type === "custom_message" ? base.details : undefined
	) as Record<string, unknown> | undefined;
	if (details) {
		const ids = [
			details.subagent,
			...(Array.isArray(details.subagents) ? details.subagents : []),
			...(Array.isArray(details.running) ? details.running : []),
		].flatMap((fact) =>
			fact && typeof fact === "object" && "id" in fact && typeof fact.id === "string" ? [fact.id] : [],
		);
		if (ids.length) {
			const all = children(view);
			result.subagentCount = ids.length;
			result.subagents = ids.slice(0, 8).flatMap((id) => (all.has(id) ? [all.get(id)!] : []));
		}
	}
	const source = view.storage.bytes(stored);
	try {
		if (source.length <= inlineBytes) {
			result.entry = projected(
				view,
				position,
				JSON.parse(source.read(0, source.length).toString("utf8")),
			) as unknown as Record<string, unknown>;
			return result;
		}
		const rootReference = () => {
			result.entry = { type: base.type, id: base.id, parentId: base.parentId, timestamp: base.timestamp };
			result.omissions = [
				{
					...omission(view, position, "", 0, source.length),
					format: view.storage.format === "sqlite" ? "durable-record" : "session-entry",
				},
			];
			return result;
		};
		const spans = historyEntrySpans(source);
		if (!spans) return rootReference();
		const hasStored = [...spans.keys()].some((key) => key.startsWith('["data","entry",'));
		const root = view.storage.format === "jsonl" ? [] : hasStored ? ["data", "entry"] : [];
		const body: Record<string, unknown> = {
			type: base.type,
			id: base.id,
			parentId: base.parentId,
			timestamp: base.timestamp,
		};
		let remaining = inlineBytes;
		const copy = (path: (string | number)[], key: string, target: Record<string, unknown>, pointer: string) => {
			const span = spans.get(JSON.stringify(path));
			if (!span) return;
			const bytes = span.end - span.start;
			if (bytes <= remaining && bytes <= 4096) {
				target[key] = JSON.parse(source.read(span.start, bytes).toString("utf8"));
				remaining -= bytes;
			} else {
				target[key] = null;
				result.omissions.push(omission(view, position, pointer, span.start, span.end));
			}
		};
		if (view.storage.format === "jsonl" || hasStored) {
			for (const key of spans.keys()) {
				const path = JSON.parse(key) as (string | number)[];
				if (path.length !== root.length + 1 || !root.every((part, i) => part === path[i])) continue;
				const field = String(path.at(-1));
				if (field === "message") continue;
				copy(path, field, body, `/${field.replace(/~/gu, "~0").replace(/\//gu, "~1")}`);
			}
		}
		if (base.type === "message") {
			const ownMessage = [...root, "message"];
			const prefix = spans.has(JSON.stringify([...ownMessage, "role"]))
				? ownMessage
				: spans.has('["model",0,"role"]')
					? ["model", 0]
					: ["data", "message"];
			const msg: Record<string, unknown> = {};
			for (const key of spans.keys()) {
				const path = JSON.parse(key) as (string | number)[];
				if (path.length !== prefix.length + 1 || !prefix.every((part, i) => part === path[i])) continue;
				const field = String(path.at(-1));
				copy(path, field, msg, `/message/${field.replace(/~/gu, "~0").replace(/\//gu, "~1")}`);
			}
			body.message = msg;
		}
		if (!hasStored && view.storage.format === "sqlite" && base.type !== "message") {
			// Derived summaries/custom entries may transform multiple source fields. Keep their source exact,
			// rather than inventing a partially transformed entry or allocating its original giant values.
			return rootReference();
		}
		result.entry = view.storage.format === "jsonl" ? legacyHistoryProjection(body, base) : body;
		if (Buffer.byteLength(JSON.stringify(result)) > inlineBytes + 4096) return rootReference();
		return result;
	} finally {
		source.close();
	}
}
function selection(view: View, end = view.branch.length): RpcHistorySelection {
	const result: RpcHistorySelection = {};
	for (let i = 0; i < end; i++) {
		const entry = view.branch[i].entry;
		if (entry.type === "model_change") result.model = { provider: entry.provider, modelId: entry.modelId };
		if (entry.type === "thinking_level_change") result.thinkingLevel = entry.thinkingLevel;
		if (entry.type === "message" && entry.message.role === "assistant")
			result.model = { provider: entry.message.provider, modelId: entry.message.model };
	}
	return result;
}
function children(view: View): Map<string, RpcHistorySubagentRecord> {
	if (view.childRecords) return view.childRecords;
	const records = new Map<string, RpcHistorySubagentRecord>();
	let indexBytes = 0;
	for (let position = 0; position < view.branch.length; position++) {
		const entry = view.branch[position].entry;
		const message =
			entry.type === "message"
				? (entry.message as unknown as Record<string, unknown>)
				: entry.type === "custom_message"
					? { role: "custom", customType: entry.customType, details: entry.details }
					: undefined;
		if (!message) continue;
		if (
			message.role === "toolResult"
				? !CHILD_TOOLS.includes(String(message.toolName))
				: message.role !== "custom" || message.customType !== "nek.subagent_notice"
		)
			continue;
		const details = message.details as Record<string, unknown> | undefined;
		if (!details) continue;
		for (const raw of [
			details.subagent,
			...(Array.isArray(details.subagents) ? details.subagents : []),
			...(Array.isArray(details.running) ? details.running : []),
		]) {
			if (!raw || typeof raw !== "object") continue;
			const fact = raw as Record<string, unknown>;
			if (
				typeof fact.id !== "string" ||
				typeof fact.type !== "string" ||
				typeof fact.description !== "string" ||
				typeof fact.startedAt !== "number" ||
				!["running", "completed", "errored", "aborted"].includes(String(fact.status))
			)
				continue;
			const previous = records.get(fact.id);
			const record: RpcHistorySubagentRecord = {
				...previous,
				id: fact.id,
				spawnEntryId: previous?.spawnEntryId ?? entry.id,
				spawnPosition: previous?.spawnPosition ?? position,
				detached: true,
			};
			for (const field of [
				"sessionFile",
				"type",
				"description",
				"status",
				"model",
				"startedAt",
				"endedAt",
			] as const) {
				if (fact[field] !== undefined)
					Object.assign(record, {
						[field]:
							typeof fact[field] === "string"
								? String(fact[field]).slice(0, field === "description" ? 256 : 2048)
								: fact[field],
					});
			}
			indexBytes +=
				Buffer.byteLength(JSON.stringify(record)) +
				128 -
				(previous ? Buffer.byteLength(JSON.stringify(previous)) + 128 : 0);
			records.set(fact.id, record);
			if (records.size > 16384 || indexBytes > 16 * 1024 * 1024)
				fail("INDEX_LIMIT", "Child fact index exceeds 16384 identities or 16MiB");
		}
	}
	view.childRecords = records;
	return records;
}
function metadata(view: View): RpcHistoryMetadata {
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
	for (const row of view.branch) {
		const entry = row.entry;
		const value =
			entry.type === "message" && entry.message.role === "assistant"
				? entry.message.usage
				: "usage" in entry
					? entry.usage
					: undefined;
		if (!value) continue;
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const)
			usage[key] += Number(value[key] ?? 0);
		usage.cost += Number(value.cost?.total ?? 0);
	}
	const lock = sessionLockPath(view.storage.path);
	if (existsSync(lock) && statSync(lock).size > 16384) fail("INVALID_STORAGE", "Session lock metadata exceeds 16KiB");
	const owner = readSessionLockOwner(view.storage.path);
	const header = view.storage.header;
	const name = view.branch.map((row) => row.entry).findLast((entry) => entry.type === "session_info")?.name;
	return {
		...view.identity,
		session: {
			path: view.storage.path,
			id: header.id,
			cwd: header.cwd,
			createdAt: header.timestamp,
			modifiedAt: view.branch.at(-1)?.entry.timestamp ?? header.timestamp,
			messageCount: view.branch.filter((row) => row.entry.type === "message").length,
			firstMessage: view.branch.find((row) => row.entry.type === "message" && row.entry.message.role === "user")
				? preview(
						view.branch.find((row) => row.entry.type === "message" && row.entry.message.role === "user")!.entry,
					)
				: "",
			locked: isSessionLocked(view.storage.path),
			...(name === undefined ? {} : { name }),
			...(header.parentSession ? { parentSessionPath: header.parentSession } : {}),
		},
		...(owner ? { lockedBy: { ...owner, startedAt: new Date(owner.startedAt).toISOString() } } : {}),
		totalTurns: view.turns.length,
		totalEntries: view.branch.length,
		selection: selection(view),
		usage,
		children: { count: children(view).size },
		status: "persisted",
	};
}
function turnDescriptor(view: View, turn: Turn): RpcHistoryTurn {
	return {
		id: turn.id,
		userEntryId: turn.userEntryId,
		position: view.turnAt[turn.start],
		preview: preview(view.branch[turn.header].entry),
		entryCount: turn.end - turn.start,
		header: displayEntry(view, turn.header, 512),
	};
}
function responseSize(command: RpcHistoryCommand, data: object): number {
	return Buffer.byteLength(
		JSON.stringify({ id: command.id, type: "response", command: command.type, success: true, data }),
	);
}
/** Remaining ranges are bounded, disjoint and pinned to this read's observed branch end. */
function turnCursor(view: View, turn: Turn, remaining: Range[]): string | undefined {
	if (!remaining.length) return undefined;
	return token(view, { kind: "turn", turnId: turn.id, position: remaining[0][0], remaining });
}
function windowCursor(view: View, window: TurnWindow): string | undefined {
	const { turn, low, high } = window;
	const remaining: Range[] = [];
	if (turn.start < low) remaining.push([turn.start, low]);
	if (high < turn.end) remaining.push([high, turn.end]);
	return turnCursor(view, turn, remaining);
}
/** Admit every turn's header and target/tail first, then grow windows fairly within the shared budget. */
function loadWindows(
	view: View,
	command: RpcHistoryCommand,
	result: RpcHistoryPage,
	budget: number,
	target?: number,
): void {
	const windows: TurnWindow[] = result.turns.map((descriptor) => {
		const turn = view.turns[descriptor.position];
		const around = target !== undefined && view.turnAt[target] === descriptor.position && target !== turn.header;
		const position = around ? target! : turn.end - 1;
		const window = { turn, descriptor, low: position, high: position + 1, around, left: true };
		descriptor.continuationCursor = windowCursor(view, window);
		result.entries.push(descriptor.header);
		return window;
	});
	const available = budget - responseSize(command, { ok: true, ...result });
	const inlineBytes = Math.max(512, Math.min(8192, Math.floor(available / Math.max(1, windows.length)) - 2048));
	for (const window of windows) {
		if (window.low !== window.turn.header) result.entries.push(displayEntry(view, window.low, inlineBytes));
	}
	if (responseSize(command, { ok: true, ...result }) > budget)
		fail("RESPONSE_LIMIT", "Turn headers and target projections exceed response budget; reduce turnLimit");
	let pending = windows;
	while (pending.length && result.entries.length < MAX_ENTRIES) {
		const next: TurnWindow[] = [];
		for (const window of pending) {
			if (result.entries.length >= MAX_ENTRIES) break;
			const { turn, low, high } = window;
			const left = low > turn.start && (!window.around || window.left || high === turn.end);
			const position = left ? low - 1 : high;
			if (position >= turn.end) continue;
			if (left) window.low--;
			else window.high++;
			const previousCursor = window.descriptor.continuationCursor;
			window.descriptor.continuationCursor = windowCursor(view, window);
			const header = position === turn.header;
			if (!header) result.entries.push(displayEntry(view, position, inlineBytes));
			if (responseSize(command, { ok: true, ...result }) > budget) {
				if (!header) result.entries.pop();
				Object.assign(window, { low, high });
				window.descriptor.continuationCursor = previousCursor;
				continue;
			}
			window.left = !left;
			next.push(window);
		}
		pending = next;
	}
	result.entries.sort((a, b) => a.position - b.position);
}
function page(
	view: View,
	command: Extract<RpcHistoryCommand, { type: "read_history_page" }>,
	budget: number,
): RpcHistoryPage | RpcHistorySummaryPage {
	if (command.view !== undefined && command.view !== "entries" && command.view !== "summary")
		fail("INVALID_REQUEST", "History page view must be entries or summary");
	if (
		[command.beforeCursor, command.afterCursor, command.aroundEntryId].filter((value) => value !== undefined).length >
		1
	)
		fail("INVALID_REQUEST", "Choose before, after or around");
	const limit = integer(command.turnLimit, 20, 1, 20);
	let start = Math.max(0, view.turns.length - limit);
	let end = view.turns.length;
	let target: number | undefined;
	if (command.beforeCursor) {
		end = untoken(view, command.beforeCursor, "before").position;
		if (end <= 0 || end > view.turns.length) fail("INVALID_CURSOR", "Nonadvancing older cursor");
		start = Math.max(0, end - limit);
	} else if (command.afterCursor) {
		start = untoken(view, command.afterCursor, "after").position;
		if (start >= view.turns.length) fail("INVALID_CURSOR", "Nonadvancing newer cursor");
		end = Math.min(view.turns.length, start + limit);
	} else if (command.aroundEntryId !== undefined) {
		target = view.branch.findIndex((row) => row.entry.id === command.aroundEntryId);
		if (target < 0) fail("NOT_FOUND", "History target is not on effective branch");
		start = Math.max(0, view.turnAt[target] - Math.floor(limit / 2));
		end = Math.min(view.turns.length, start + limit);
	}
	const boundary = {
		...view.identity,
		hasOlder: start > 0,
		hasNewer: end < view.turns.length,
		totalTurns: view.turns.length,
		totalEntries: view.branch.length,
		...(start > 0 ? { olderCursor: token(view, { kind: "before", position: start }) } : {}),
		...(end < view.turns.length ? { newerCursor: token(view, { kind: "after", position: end }) } : {}),
	};
	const selected = view.turns.slice(start, end);
	if (command.view === "summary")
		return {
			...boundary,
			view: "summary",
			turns: selected.map((turn) => ({
				id: turn.id,
				userEntryId: turn.userEntryId,
				position: view.turnAt[turn.start],
				preview: preview(view.branch[turn.header].entry),
				entryCount: turn.end - turn.start,
				headerEntryId: view.branch[turn.header].entry.id,
				headerPosition: turn.header,
				continuationCursor: turnCursor(view, turn, [[turn.start, turn.end]])!,
			})),
		};
	const result: RpcHistoryPage = {
		...boundary,
		view: "entries",
		turns: selected.map((turn) => turnDescriptor(view, turn)),
		entries: [],
		seed: selection(view, view.turns[start]?.header ?? 0),
	};
	loadWindows(view, command, result, budget, target);
	return result;
}
function turnRanges(cursor: Token, turn: Turn): Range[] {
	const ranges = cursor.remaining;
	if (cursor.turnId !== turn.id || !Array.isArray(ranges) || !ranges.length || ranges.length > 2)
		fail("INVALID_CURSOR", "Turn continuation does not belong to this turn");
	let previous = turn.start - 1;
	for (const range of ranges) {
		if (
			!Array.isArray(range) ||
			range.length !== 2 ||
			!range.every(Number.isSafeInteger) ||
			range[0] < turn.start ||
			range[0] <= previous ||
			range[0] >= range[1] ||
			range[1] > Math.min(turn.end, cursor.count)
		)
			fail("INVALID_CURSOR", "Invalid or nonadvancing turn itinerary");
		previous = range[1];
	}
	if (cursor.position !== ranges[0][0]) fail("INVALID_CURSOR", "Turn itinerary position mismatch");
	return ranges;
}
function turnPage(
	view: View,
	command: Extract<RpcHistoryCommand, { type: "read_history_turn" }>,
	budget: number,
): RpcHistoryTurnPage {
	const cursor = command.cursor ? untoken(view, command.cursor, "turn") : undefined;
	const turn = view.turns.find((turn) => turn.id === command.turnId);
	if (!turn) fail("NOT_FOUND", "Unknown effective branch turn");
	let remaining: Range[] = cursor ? turnRanges(cursor, turn) : [[turn.start, turn.end]];
	const result: RpcHistoryTurnPage = {
		...view.identity,
		turn: turnDescriptor(view, turn),
		entries: [],
		hasMore: true,
		continuationCursor: turnCursor(view, turn, remaining),
	};
	while (remaining.length && result.entries.length < MAX_ENTRIES) {
		const [start, end] = remaining[0];
		const next: Range[] = start + 1 === end ? remaining.slice(1) : [[start + 1, end], ...remaining.slice(1)];
		result.entries.push(start === turn.header ? result.turn.header : displayEntry(view, start));
		result.hasMore = next.length > 0;
		result.continuationCursor = turnCursor(view, turn, next);
		if (responseSize(command, { ok: true, ...result }) > budget) {
			result.entries.pop();
			result.hasMore = true;
			result.continuationCursor = turnCursor(view, turn, remaining);
			break;
		}
		remaining = next;
	}
	if (!result.entries.length) fail("RESPONSE_LIMIT", "One entry projection exceeds response budget");
	return result;
}
function contains(view: View, position: number, query: string): boolean {
	if (preview(view.branch[position].entry).toLowerCase().includes(query)) return true;
	const source = view.storage.bytes(view.branch[position]);
	try {
		const found = Symbol("history search match");
		const parser = new HistoryJson(source);
		let tail = "";
		parser.onText = (chunk, first) => {
			const text = (first ? "" : tail) + chunk.toLowerCase();
			if (text.includes(query)) throw found;
			tail = text.slice(-query.length);
		};
		try {
			parser.walk(() => {});
		} catch (error) {
			if (error === found) return true;
			throw error;
		}
		return false;
	} finally {
		source.close();
	}
}
function directory(
	view: View,
	command: Extract<RpcHistoryCommand, { type: "read_history_directory" }>,
	budget: number,
): RpcHistoryDirectory {
	const limit = integer(command.limit, 20, 1, 100);
	if (command.query !== undefined && (typeof command.query !== "string" || command.query.length > 256))
		fail("INVALID_REQUEST", "Search query must be at most 256 characters");
	const query = command.query?.toLowerCase() ?? "";
	const direction = command.direction ?? "oldest";
	if (!["oldest", "newest"].includes(direction)) fail("INVALID_REQUEST", "Invalid directory direction");
	if (command.cursor && command.aroundEntryId) fail("INVALID_REQUEST", "Choose directory cursor or target");
	const cursor = command.cursor ? untoken(view, command.cursor, "directory") : undefined;
	if (cursor && (cursor.query !== query || cursor.direction !== direction))
		fail("INVALID_CURSOR", "Search cursor query/direction changed");
	const step = direction === "oldest" ? 1 : -1;
	let position = cursor?.position ?? (step === 1 ? 0 : view.branch.length - 1);
	if (command.aroundEntryId) {
		position = view.branch.findIndex((row) => row.entry.id === command.aroundEntryId);
		if (position < 0) fail("NOT_FOUND", "Unknown directory target");
		if (!query) position = view.turns[view.turnAt[position]].header;
	}
	const result: RpcHistoryDirectory = { ...view.identity, items: [], hasMore: false, totalTurns: view.turns.length };
	for (; position >= 0 && position < view.branch.length; position += step) {
		const turn = view.turns[view.turnAt[position]];
		if (query ? !contains(view, position, query) : position !== turn.header) continue;
		result.items.push({
			entryId: view.branch[position].entry.id,
			turnId: turn.id,
			position,
			preview: preview(view.branch[position].entry),
		});
		if (
			responseSize(command, {
				ok: true,
				...result,
				nextCursor: token(view, { kind: "directory", position: position + step, query, direction }),
			}) > budget
		) {
			result.items.pop();
			break;
		}
		if (result.items.length >= limit) {
			position += step;
			break;
		}
	}
	result.hasMore = position >= 0 && position < view.branch.length;
	if (result.hasMore) result.nextCursor = token(view, { kind: "directory", position, query, direction });
	return result;
}
function content(
	view: View,
	command: Extract<RpcHistoryCommand, { type: "read_history_content" }>,
	budget: number,
): RpcHistoryContent {
	const ref = untoken(view, command.ref, "content");
	const stored = view.branch[ref.position];
	if (
		!stored ||
		stored.entry.id !== ref.entryId ||
		!Number.isSafeInteger(ref.start) ||
		!Number.isSafeInteger(ref.end) ||
		ref.start! < 0 ||
		ref.end! <= ref.start! ||
		ref.end! > stored.length
	)
		fail("INVALID_CURSOR", "Invalid content range/owner");
	const totalBytes = ref.end! - ref.start!;
	const offset = integer(command.offset, 0, 0, totalBytes);
	const limit = integer(command.limit, 65536, 1, 256 * 1024);
	const result: RpcHistoryContent = {
		...view.identity,
		ref: command.ref,
		offset,
		totalBytes,
		mediaType: "application/json",
		encoding: "base64",
		data: "",
		nextOffset: totalBytes,
	};
	// Reserve the largest possible offset spelling and the exact envelope before base64 expansion.
	const available = budget - responseSize(command, { ok: true, ...result });
	const length = Math.min(limit, totalBytes - offset, Math.floor(available / 4) * 3);
	if (length < 0 || (length === 0 && offset < totalBytes))
		fail("RESPONSE_LIMIT", "Content metadata exceeds response budget");
	const source = view.storage.bytes(stored);
	try {
		result.data = source.read(ref.start! + offset, length).toString("base64");
		if (offset + length < totalBytes) result.nextOffset = offset + length;
		else delete result.nextOffset;
		return result;
	} finally {
		source.close();
	}
}
function subagent(
	view: View,
	command: Extract<RpcHistoryCommand, { type: "read_history_subagent" }>,
	budget: number,
): RpcHistorySubagent | RpcHistorySubagentDirectory {
	if (command.subagentId !== undefined) {
		if (
			typeof command.subagentId !== "string" ||
			command.subagentId.length > 256 ||
			command.cursor !== undefined ||
			command.limit !== undefined
		)
			fail("INVALID_REQUEST", "Choose single child identity or child enumeration");
		const record = children(view).get(command.subagentId);
		if (!record) fail("NOT_FOUND", "Child is not recorded on the parent effective branch");
		return { ...view.identity, subagent: record };
	}
	const limit = integer(command.limit, 20, 1, 100);
	const records = children(view);
	const cursor = command.cursor ? untoken(view, command.cursor, "subagents") : undefined;
	let position = cursor?.position ?? 0;
	if (cursor && position >= records.size) fail("INVALID_CURSOR", "Nonadvancing child enumeration cursor");
	const result: RpcHistorySubagentDirectory = {
		...view.identity,
		kind: "subagents",
		subagents: [],
		total: records.size,
		count: 0,
		hasMore: false,
	};
	let index = 0;
	for (const record of records.values()) {
		if (index++ < position) continue;
		result.subagents.push(record);
		const next = token(view, { kind: "subagents", position: position + 1 });
		if (
			responseSize(command, {
				ok: true,
				...result,
				count: result.subagents.length,
				hasMore: true,
				nextCursor: next,
			}) > budget
		) {
			result.subagents.pop();
			if (!result.subagents.length) fail("RESPONSE_LIMIT", "One child summary exceeds response budget");
			break;
		}
		position++;
		if (result.subagents.length >= limit) break;
	}
	result.count = result.subagents.length;
	result.hasMore = position < records.size;
	if (result.hasMore) result.nextCursor = token(view, { kind: "subagents", position });
	return result;
}

/** Both RPC modes enter here; the control process never opens/resumes a live session. */
export function readHistoryCommand<C extends RpcHistoryCommand>(
	ctx: GuiContext,
	command: C,
): RpcHistoryCommandResult<C>;
export function readHistoryCommand(
	ctx: GuiContext,
	command: RpcHistoryCommand,
): RpcHistoryResponseData[RpcHistoryCommand["type"]] {
	let view: View | undefined;
	try {
		if (command.id !== undefined && (typeof command.id !== "string" || Buffer.byteLength(command.id) > 256))
			fail("INVALID_REQUEST", "History request id exceeds 256 bytes");
		const budget = integer(command.maxBytes, DEFAULT_BYTES, 65536, 4 * 1024 * 1024);
		for (const field of [
			"beforeCursor",
			"afterCursor",
			"cursor",
			"ref",
			"sessionPath",
			"branchRevision",
			"observationCursor",
			"aroundEntryId",
			"turnId",
			"subagentId",
		]) {
			const value = (command as unknown as Record<string, unknown>)[field];
			if (value !== undefined && (typeof value !== "string" || !value || Buffer.byteLength(value) > 4096))
				fail(
					field.toLowerCase().includes("cursor") || field === "ref" ? "INVALID_CURSOR" : "INVALID_REQUEST",
					`Invalid ${field}`,
				);
		}
		view = openView(ctx, command);
		let data:
			| RpcHistoryMetadata
			| RpcHistoryPage
			| RpcHistorySummaryPage
			| RpcHistoryTurnPage
			| RpcHistoryDirectory
			| RpcHistoryContent
			| RpcHistorySubagent
			| RpcHistorySubagentDirectory;
		switch (command.type) {
			case "read_session_metadata":
				data = metadata(view);
				break;
			case "read_history_page":
				data = page(view, command, budget);
				break;
			case "read_history_turn":
				data = turnPage(view, command, budget);
				break;
			case "read_history_directory":
				data = directory(view, command, budget);
				break;
			case "read_history_content":
				data = content(view, command, budget);
				break;
			case "read_history_subagent":
				data = subagent(view, command, budget);
				break;
		}
		view.storage.verify();
		const result = { ok: true as const, ...data };
		if (responseSize(command, result) > budget)
			fail("RESPONSE_LIMIT", "History response exceeds requested byte budget");
		return result;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			error: {
				code:
					error instanceof HistoryError
						? error.code
						: message.startsWith("INDEX_LIMIT:")
							? "INDEX_LIMIT"
							: "INVALID_STORAGE",
				message: message.slice(0, 512),
			},
		};
	} finally {
		view?.storage.close();
	}
}
