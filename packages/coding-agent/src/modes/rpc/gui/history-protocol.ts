/** Read-only GUI history: display projections never replace stored/model context entries. */
import type { RpcSessionLockOwner, RpcSessionSummary } from "./protocol.ts";

export interface RpcHistoryOptions {
	sessionPath?: string;
	branchRevision?: string;
	/** Entire UTF8 RPC response, including envelope. Default 1MiB, range 64KiB..4MiB. */
	maxBytes?: number;
}
export type RpcHistoryCommand =
	| ({ id?: string; type: "read_session_metadata" } & RpcHistoryOptions)
	| ({
			id?: string;
			type: "read_history_page";
			beforeCursor?: string;
			afterCursor?: string;
			aroundEntryId?: string;
			turnLimit?: number;
	  } & RpcHistoryOptions)
	| ({ id?: string; type: "read_history_turn"; turnId: string; cursor?: string } & RpcHistoryOptions)
	| ({
			id?: string;
			type: "read_history_directory";
			query?: string;
			cursor?: string;
			direction?: "oldest" | "newest";
			aroundEntryId?: string;
			limit?: number;
	  } & RpcHistoryOptions)
	| ({ id?: string; type: "read_history_content"; ref: string; offset?: number; limit?: number } & RpcHistoryOptions)
	| RpcHistorySubagentCommand;

/** Single-id lookup retains its original shape; omission of the id enumerates persisted parent-branch facts. */
export type RpcHistorySubagentCommand =
	| ({
			id?: string;
			type: "read_history_subagent";
			subagentId: string;
			cursor?: never;
			limit?: never;
	  } & RpcHistoryOptions)
	| ({
			id?: string;
			type: "read_history_subagent";
			subagentId?: undefined;
			cursor?: string;
			limit?: number;
	  } & RpcHistoryOptions);

export type RpcHistoryErrorCode =
	| "INVALID_REQUEST"
	| "INVALID_CURSOR"
	| "STALE_CURSOR"
	| "FOREIGN_CURSOR"
	| "NOT_FOUND"
	| "INDEX_LIMIT"
	| "INVALID_STORAGE"
	| "RESPONSE_LIMIT";
export type RpcHistoryResult<T> =
	| ({ ok: true } & T)
	| { ok: false; error: { code: RpcHistoryErrorCode; message: string } };
export interface RpcHistoryIdentity {
	sessionPath: string;
	sessionId: string;
	/** Observed persisted branch prefix, not a live stream revision. */
	branchRevision: string;
	leafId: string | null;
	watermark: { entryId: number; conversationId: number; nextSeq: number };
}
export interface RpcHistorySelection {
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
}
export interface RpcHistoryOmission {
	/** RFC6901 pointer into the display entry; null replaces this original JSON value. */
	pointer: string;
	/** Root omissions identify the original source record; durable records need projectRecord before display. */
	format?: "durable-record" | "session-entry";
	ref: string;
	totalBytes: number;
	mediaType: "application/json";
	encoding: "base64";
}
export interface RpcHistoryEntry {
	id: string;
	parentId: string | null;
	position: number;
	turnId: string;
	timestamp: string;
	type: string;
	role?: string;
	preview: string;
	/** Original persisted call anchor, even when outside the loaded page; null means no saved call exists. */
	toolCallOrigin?: { entryId: string; position: number; toolCallId: string; name: string } | null;
	/** At most eight related child summaries; lookup any further id through read_history_subagent. */
	subagents?: RpcHistorySubagentRecord[];
	subagentCount?: number;
	/** Complete only when omissions is empty. Never use a display projection as model context. */
	entry: Record<string, unknown>;
	omissions: RpcHistoryOmission[];
}
export interface RpcHistoryTurn {
	id: string;
	userEntryId: string | null;
	position: number;
	preview: string;
	entryCount: number;
	header: RpcHistoryEntry;
	continuationCursor?: string;
}
export interface RpcHistoryMetadata extends RpcHistoryIdentity {
	session: RpcSessionSummary;
	lockedBy?: RpcSessionLockOwner;
	totalTurns: number;
	totalEntries: number;
	selection: RpcHistorySelection;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number };
	children: { count: number };
	status: "persisted";
}
export interface RpcHistoryPage extends RpcHistoryIdentity {
	turns: RpcHistoryTurn[];
	entries: RpcHistoryEntry[];
	olderCursor?: string;
	newerCursor?: string;
	hasOlder: boolean;
	hasNewer: boolean;
	totalTurns: number;
	totalEntries: number;
	seed: RpcHistorySelection;
}
export interface RpcHistoryTurnPage extends RpcHistoryIdentity {
	turn: RpcHistoryTurn;
	entries: RpcHistoryEntry[];
	hasMore: boolean;
	continuationCursor?: string;
}
export interface RpcHistoryDirectory extends RpcHistoryIdentity {
	items: { entryId: string; turnId: string; position: number; preview: string }[];
	hasMore: boolean;
	nextCursor?: string;
	totalTurns: number;
}
export interface RpcHistoryContent extends RpcHistoryIdentity {
	ref: string;
	offset: number;
	totalBytes: number;
	mediaType: "application/json";
	encoding: "base64";
	/** Base64 of raw UTF8 JSON bytes: concatenate decoded chunks, then JSON.parse. */
	data: string;
	nextOffset?: number;
}
export interface RpcHistorySubagentRecord {
	id: string;
	spawnEntryId: string;
	spawnPosition: number;
	sessionFile?: string;
	type?: string;
	description?: string;
	status?: string;
	model?: string;
	startedAt?: number;
	endedAt?: number;
	detached: true;
}
export interface RpcHistorySubagent extends RpcHistoryIdentity {
	subagent: RpcHistorySubagentRecord;
}
export interface RpcHistorySubagentDirectory extends RpcHistoryIdentity {
	kind: "subagents";
	/** First-spawn order; updates/resume never move an existing child. */
	subagents: RpcHistorySubagentRecord[];
	total: number;
	count: number;
	hasMore: boolean;
	nextCursor?: string;
}
export type RpcHistoryCommandResult<C extends RpcHistoryCommand> = C extends { type: "read_history_subagent" }
	? C extends { subagentId: string }
		? RpcHistoryResult<RpcHistorySubagent>
		: RpcHistoryResult<RpcHistorySubagentDirectory>
	: RpcHistoryResponseData[C["type"]];
export interface RpcHistoryResponseData {
	read_session_metadata: RpcHistoryResult<RpcHistoryMetadata>;
	read_history_page: RpcHistoryResult<RpcHistoryPage>;
	read_history_turn: RpcHistoryResult<RpcHistoryTurnPage>;
	read_history_directory: RpcHistoryResult<RpcHistoryDirectory>;
	read_history_content: RpcHistoryResult<RpcHistoryContent>;
	read_history_subagent: RpcHistoryResult<RpcHistorySubagent | RpcHistorySubagentDirectory>;
}
