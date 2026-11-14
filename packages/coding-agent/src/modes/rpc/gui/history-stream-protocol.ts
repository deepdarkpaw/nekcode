/** Opt-in conversation transport only. Default RPC/TUI event semantics stay unchanged. */
export type RpcHistoryStreamCommand = { id?: string; type: "set_history_stream"; version: 0 | 1 };
export interface RpcHistoryStreamState {
	version: 0 | 1;
	epoch: string;
	maxEventBytes: 1048576;
}
export interface RpcHistoryStreamOmission {
	pointer: string;
	resolution: "history";
	reason: "persisted_body" | "redundant_delta";
}
interface RpcHistoryStreamFrame {
	version: 1;
	epoch: string;
	/** Strictly increasing wire-record sequence, independent of durable history watermarks. */
	seq: number;
}
export type RpcHistoryStreamEvent =
	| (RpcHistoryStreamFrame & {
			type: "history_event";
			eventId: number;
			event: Record<string, unknown>;
			omissions: RpcHistoryStreamOmission[];
	  })
	| (RpcHistoryStreamFrame & {
			type: "history_event_start";
			eventId: number;
			eventType: string;
			encoding: "json-utf8/base64";
			omissions: RpcHistoryStreamOmission[];
	  })
	| (RpcHistoryStreamFrame & {
			type: "history_event_chunk";
			eventId: number;
			offset: number;
			data: string;
			final: false;
	  })
	| (RpcHistoryStreamFrame & {
			type: "history_event_chunk";
			eventId: number;
			offset: number;
			data: "";
			final: true;
			totalBytes: number;
	  })
	| (RpcHistoryStreamFrame & {
			type: "history_entry_appended";
			sessionPath: string;
			sessionId: string;
			entryId: string;
			leafId: string | null;
			ref: { command: "read_history_page"; sessionPath: string; aroundEntryId: string };
	  })
	| (RpcHistoryStreamFrame & {
			type: "history_entry_pending";
			sessionPath?: string;
			sessionId: string;
			entryId: string;
	  })
	| (RpcHistoryStreamFrame & { type: "history_stream_reset"; sessionPath?: string; sessionId: string })
	| (RpcHistoryStreamFrame & {
			type: "history_stream_error";
			code: "STREAM_LIMIT" | "STORAGE_ERROR" | "ENCODING_ERROR";
			message: string;
	  });
export interface RpcHistoryStreamResponseData {
	set_history_stream: RpcHistoryStreamState;
}
