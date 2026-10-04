/**
 * Protocol types shared with `nek --mode rpc`.
 *
 * Outgoing commands use the coding-agent's exported definitions (type-only imports, erased at
 * runtime). Incoming records are untrusted JSON, so they are kept loose and narrowed where used.
 */

import type {
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
} from "../../../coding-agent/src/modes/rpc/rpc-types.ts";

export type { RpcCommand, RpcExtensionUIRequest, RpcExtensionUIResponse, RpcSessionState };

/** A command without its correlation id; the client assigns one. */
export type OutgoingCommand = RpcCommand extends infer C ? (C extends { id?: string } ? Omit<C, "id"> : never) : never;

export type CommandType = RpcCommand["type"];

/** Response data of a successful command, or undefined for commands without data. */
export type ResponseData<K extends CommandType> = Extract<RpcResponse, { command: K; success: true }> extends infer R
	? R extends { data: infer D }
		? D
		: undefined
	: never;

/** Any record on the backend's stdout other than a response or an extension UI request. */
export interface RpcEventRecord {
	type: string;
	[key: string]: unknown;
}

/** Extension UI requests handled by the frontend. */
export type UiRequest = RpcExtensionUIRequest;
