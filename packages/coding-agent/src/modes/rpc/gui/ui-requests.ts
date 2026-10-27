/**
 * Client dialogs over the extension UI sub-protocol.
 *
 * Both RPC process modes need the same request/response plumbing: send `extension_ui_request`, resolve on the
 * matching `extension_ui_response`, and dismiss the client's dialog with `extension_ui_cancel` when the
 * request is aborted or times out.
 */

import * as crypto from "node:crypto";
import type { RpcExtensionUIResponse } from "../rpc-types.ts";
import type { RpcExtensionUiCancel, RpcStructuredUiResponse } from "./protocol.ts";

export interface UiRequestOptions {
	signal?: AbortSignal;
	timeout?: number;
}

export interface UiRequester {
	/**
	 * Send one dialog request and resolve with the parsed answer. A cancelled, aborted, or timed-out request
	 * resolves with `defaultValue`.
	 */
	request<T>(
		defaultValue: T,
		request: Record<string, unknown>,
		parse: (response: RpcExtensionUIResponse) => T,
		options?: UiRequestOptions,
	): Promise<T>;
	/** Ask a structured question (`method: "structured"`); `undefined` when the client cancels. */
	requestStructured<T = unknown>(kind: string, payload: unknown, options?: UiRequestOptions): Promise<T | undefined>;
	/** Route an `extension_ui_response` record to the request waiting for it. */
	respond(response: RpcExtensionUIResponse): void;
	/** Drop every pending request without answering it, used when the process shuts down. */
	cancelAll(): void;
}

interface PendingRequest {
	resolve: (response: RpcExtensionUIResponse) => void;
}

export function createUiRequester(output: (record: object) => void): UiRequester {
	const pending = new Map<string, PendingRequest>();

	const request = <T>(
		defaultValue: T,
		record: Record<string, unknown>,
		parse: (response: RpcExtensionUIResponse) => T,
		options?: UiRequestOptions,
	): Promise<T> => {
		if (options?.signal?.aborted) return Promise.resolve(defaultValue);
		const id = crypto.randomUUID();
		return new Promise<T>((resolve) => {
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (timeoutId) clearTimeout(timeoutId);
				options?.signal?.removeEventListener("abort", cancel);
				pending.delete(id);
			};
			/** Dismiss the dialog on the nek side so the client closes it instead of waiting. */
			const cancel = () => {
				cleanup();
				output({ type: "extension_ui_cancel", id } satisfies RpcExtensionUiCancel);
				resolve(defaultValue);
			};
			options?.signal?.addEventListener("abort", cancel, { once: true });
			if (options?.timeout) timeoutId = setTimeout(cancel, options.timeout);
			pending.set(id, {
				resolve: (response: RpcExtensionUIResponse) => {
					cleanup();
					resolve(parse(response));
				},
			});
			output({ type: "extension_ui_request", id, ...record });
		});
	};

	return {
		request,
		requestStructured: <T = unknown>(kind: string, payload: unknown, options?: UiRequestOptions) =>
			request<T | undefined>(
				undefined,
				{ method: "structured", kind, payload },
				(response) =>
					"cancelled" in response && response.cancelled
						? undefined
						: (response as RpcStructuredUiResponse & { result: T }).result,
				options,
			),
		respond(response: RpcExtensionUIResponse): void {
			const entry = pending.get(response.id);
			if (!entry) return;
			pending.delete(response.id);
			entry.resolve(response);
		},
		cancelAll(): void {
			for (const [id, entry] of pending) {
				pending.delete(id);
				output({ type: "extension_ui_cancel", id } satisfies RpcExtensionUiCancel);
				entry.resolve({ type: "extension_ui_response", id, cancelled: true });
			}
		},
	};
}
