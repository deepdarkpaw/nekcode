/**
 * Response records for GUI commands.
 *
 * Every GUI command answers with one `response` record. Failures are RPC errors with `success: false`;
 * commands whose outcome is user-facing data (`fetch_provider_models`, `test_provider`, ...) report
 * failure inside their data instead.
 */

import type { RpcGuiResponseData } from "./protocol.ts";

export interface GuiSuccessResponse<K extends keyof RpcGuiResponseData> {
	id: string | undefined;
	type: "response";
	command: K;
	success: true;
	data: RpcGuiResponseData[K];
}

export function guiSuccess<K extends keyof RpcGuiResponseData>(
	id: string | undefined,
	command: K,
	data: RpcGuiResponseData[K],
): GuiSuccessResponse<K> {
	return { id, type: "response", command, success: true, data };
}

export interface GuiErrorResponse {
	id: string | undefined;
	type: "response";
	command: string;
	success: false;
	error: string;
}

export function guiError(id: string | undefined, command: string, error: unknown): GuiErrorResponse {
	return { id, type: "response", command, success: false, error: errorMessage(error) };
}

/** Human-readable message of a thrown value. */
export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
