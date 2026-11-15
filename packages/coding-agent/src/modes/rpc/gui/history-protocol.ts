/** Read-only GUI history: display projections never replace stored/model context entries. */
import type { RpcSessionLockOwner, RpcSessionSummary } from "./protocol.ts";

export interface RpcHistoryOptions {
	sessionPath?: string;
	branchRevision?: string;
	/** Append-safe proof of the previously observed session/branch prefix; retries are non-consuming. */
	observationCursor?: string;
	/** Entire UTF8 RPC response, including envelope. Default 1 MiB, range 64 KiB..32 MiB. */
	maxBytes?: number;
}
export type RpcHistoryCommand =
	| ({ id?: string; type: "read_session_metadata" } & RpcHistoryOptions)
	| ({
			id?: string;
			type: "read_history_page";
			/** Default entries loads whole turns; target loads only the owning header and requested entry. */
			view?: "summary" | "entries" | "target";
			beforeCursor?: string;
			afterCursor?: string;
			aroundEntryId?: string;
			turnLimit?: number;
	  } & RpcHistoryOptions)
	| ({
			id?: string;
			type: "read_history_directory";
			query?: string;
			cursor?: string;
			direction?: "oldest" | "newest";
			aroundEntryId?: string;
			limit?: number;
	  } & RpcHistoryOptions)
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
	/** Opaque current prefix observation, present even for empty history. Not a live sequence or path authority. */
	observationCursor: string;
	leafId: string | null;
	watermark: { entryId: number; conversationId: number; nextSeq: number };
}
export interface RpcHistorySelection {
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
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
	/** Complete projection, minus assistant signatures/tool-result image data. Never use as model context. */
	entry: Record<string, unknown>;
}
export interface RpcHistoryTurn {
	id: string;
	userEntryId: string | null;
	position: number;
	preview: string;
	entryCount: number;
	/** The same complete projection returned in entries, without a separate header byte cap. */
	header: RpcHistoryEntry;
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
export interface RpcHistoryPage extends RpcHistoryPageBoundary {
	view: "entries" | "target";
	turns: RpcHistoryTurn[];
	/** Original position order: whole admitted turns, or just the owning header and target in target view. */
	entries: RpcHistoryEntry[];
	seed: RpcHistorySelection;
}
export interface RpcHistorySummaryPage extends RpcHistoryPageBoundary {
	view: "summary";
	/** Metadata only: neither headers nor any other display bodies have been loaded. */
	turns: (Pick<RpcHistoryTurn, "id" | "userEntryId" | "position" | "preview" | "entryCount"> & {
		headerEntryId: string;
		headerPosition: number;
	})[];
}
export interface RpcHistoryPageBoundary extends RpcHistoryIdentity {
	olderCursor?: string;
	newerCursor?: string;
	hasOlder: boolean;
	hasNewer: boolean;
	totalTurns: number;
	totalEntries: number;
}
export interface RpcHistoryDirectory extends RpcHistoryIdentity {
	items: { entryId: string; turnId: string; position: number; preview: string }[];
	hasMore: boolean;
	nextCursor?: string;
	totalTurns: number;
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
/** Preserve default entry typing and discriminate explicit summary and child-directory reads. */
export type RpcHistoryCommandResult<C extends RpcHistoryCommand> = C extends { type: "read_history_subagent" }
	? C extends { subagentId: string }
		? RpcHistoryResult<RpcHistorySubagent>
		: RpcHistoryResult<RpcHistorySubagentDirectory>
	: C extends { type: "read_history_page" }
		? C extends { view: "summary" }
			? RpcHistoryResult<RpcHistorySummaryPage>
			: C extends { view?: "entries" | "target" }
				? RpcHistoryResult<RpcHistoryPage>
				: "view" extends keyof C
					? RpcHistoryResult<RpcHistoryPage | RpcHistorySummaryPage>
					: RpcHistoryResult<RpcHistoryPage>
		: RpcHistoryResponseData[C["type"]];
export interface RpcHistoryResponseData {
	read_session_metadata: RpcHistoryResult<RpcHistoryMetadata>;
	read_history_page: RpcHistoryResult<RpcHistoryPage | RpcHistorySummaryPage>;
	read_history_directory: RpcHistoryResult<RpcHistoryDirectory>;
	read_history_subagent: RpcHistoryResult<RpcHistorySubagent | RpcHistorySubagentDirectory>;
}
