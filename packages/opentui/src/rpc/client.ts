/**
 * JSONL RPC client for `nek --mode rpc`.
 *
 * The client owns one backend process (or any pair of streams in tests): it frames records,
 * correlates responses by id, forwards session events and extension UI requests to listeners,
 * and shuts the backend down by closing its stdin.
 */

import { type ChildProcess, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import { JsonlDecoder, parseRecord, serializeJsonLine } from "./jsonl.ts";
import type {
	CommandType,
	OutgoingCommand,
	ResponseData,
	RpcEventRecord,
	RpcExtensionUIResponse,
	UiRequest,
} from "./protocol.ts";

/** Streams of a backend process. `exited` resolves with the exit code once the process is gone. */
export interface RpcTransport {
	stdin: Writable;
	stdout: Readable;
	stderr?: Readable;
	exited: Promise<{ code: number | null; signal: string | null }>;
	kill?: () => void;
}

export class RpcCommandError extends Error {
	readonly command: string;

	constructor(command: string, message: string) {
		super(message);
		this.name = "RpcCommandError";
		this.command = command;
	}
}

interface PendingRequest {
	command: string;
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout> | undefined;
}

export interface RpcClientOptions {
	/** Reject a request without a response after this long. 0 disables the timeout. */
	requestTimeoutMs?: number;
	/** Bytes of stderr kept for diagnostics after an unexpected exit. */
	stderrTailBytes?: number;
}

export interface BackendExit {
	code: number | null;
	signal: string | null;
	stderrTail: string;
	/** True when the exit followed `shutdown()`. */
	expected: boolean;
}

type Listener<T> = (value: T) => void;

/** Start the backend command with piped stdio. `command[0]` is the executable. */
export function spawnBackend(
	command: readonly string[],
	options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): RpcTransport {
	const [file, ...args] = command;
	if (!file) throw new Error("Empty backend command");
	const child: ChildProcess = spawn(file, args, {
		cwd: options.cwd,
		env: options.env,
		stdio: ["pipe", "pipe", "pipe"],
		windowsHide: true,
	});
	const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
		// "close" follows "exit" once stdio is drained, so every record is read before the exit is reported.
		child.once("close", (code, signal) => resolve({ code, signal }));
		child.once("error", () => resolve({ code: null, signal: null }));
	});
	if (!child.stdin || !child.stdout) throw new Error("Backend process has no stdio pipes");
	return {
		stdin: child.stdin,
		stdout: child.stdout,
		stderr: child.stderr ?? undefined,
		exited,
		kill: () => {
			child.kill();
		},
	};
}

export class RpcClient {
	private readonly transport: RpcTransport;
	private readonly requestTimeoutMs: number;
	private readonly stderrTailBytes: number;
	private readonly decoder = new JsonlDecoder();
	private readonly pending = new Map<string, PendingRequest>();
	private readonly eventListeners = new Set<Listener<RpcEventRecord>>();
	private readonly uiListeners = new Set<Listener<UiRequest>>();
	private readonly exitListeners = new Set<Listener<BackendExit>>();
	private nextId = 1;
	private stderrTail = "";
	private closing = false;
	private exitInfo: BackendExit | undefined;

	constructor(transport: RpcTransport, options: RpcClientOptions = {}) {
		this.transport = transport;
		this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
		this.stderrTailBytes = options.stderrTailBytes ?? 8192;
		transport.stdout.on("data", (chunk: string | Uint8Array) => {
			for (const line of this.decoder.push(chunk)) this.handleLine(line);
		});
		transport.stdout.on("end", () => {
			for (const line of this.decoder.end()) this.handleLine(line);
		});
		transport.stderr?.on("data", (chunk: string | Uint8Array) => {
			this.stderrTail = (this.stderrTail + chunk.toString()).slice(-this.stderrTailBytes);
		});
		// Writes after the backend died raise EPIPE asynchronously; the exit handler reports it instead.
		transport.stdin.on("error", () => {});
		void transport.exited.then(({ code, signal }) => this.handleExit(code, signal));
	}

	/** Session events (everything that is not a response or an extension UI request). */
	onEvent(listener: Listener<RpcEventRecord>): () => void {
		this.eventListeners.add(listener);
		return () => this.eventListeners.delete(listener);
	}

	onUiRequest(listener: Listener<UiRequest>): () => void {
		this.uiListeners.add(listener);
		return () => this.uiListeners.delete(listener);
	}

	onExit(listener: Listener<BackendExit>): () => void {
		this.exitListeners.add(listener);
		return () => this.exitListeners.delete(listener);
	}

	get exited(): BackendExit | undefined {
		return this.exitInfo;
	}

	/** Recent backend stderr, for error reports. */
	get stderr(): string {
		return this.stderrTail;
	}

	/** Send a command and resolve with its response data; failed commands reject with `RpcCommandError`. */
	request<K extends CommandType>(
		command: Extract<OutgoingCommand, { type: K }>,
		options: { timeoutMs?: number } = {},
	): Promise<ResponseData<K>> {
		if (this.exitInfo) return Promise.reject(new Error("Backend has exited"));
		const id = `r${this.nextId++}`;
		const timeoutMs = options.timeoutMs ?? this.requestTimeoutMs;
		return new Promise<ResponseData<K>>((resolve, reject) => {
			const timer =
				timeoutMs > 0
					? setTimeout(() => {
							this.pending.delete(id);
							reject(new RpcCommandError(command.type, `Timed out after ${timeoutMs} ms`));
						}, timeoutMs)
					: undefined;
			this.pending.set(id, {
				command: command.type,
				resolve: (data) => resolve(data as ResponseData<K>),
				reject,
				timer,
			});
			this.write({ ...command, id });
		});
	}

	/** Answer an extension UI dialog. */
	respondUi(response: RpcExtensionUIResponse): void {
		this.write(response);
	}

	/**
	 * Close the backend's stdin (an orderly shutdown request) and wait for it to exit, killing it
	 * after `timeoutMs`. Resolves with the exit code.
	 */
	async shutdown(timeoutMs = 5000): Promise<number | null> {
		this.closing = true;
		if (this.exitInfo) return this.exitInfo.code;
		this.transport.stdin.end();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timedOut = new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), timeoutMs);
		});
		const result = await Promise.race([this.transport.exited, timedOut]);
		clearTimeout(timer);
		if (result === "timeout") {
			this.transport.kill?.();
			return (await this.transport.exited).code;
		}
		return result.code;
	}

	private write(record: unknown): void {
		if (this.exitInfo || this.transport.stdin.destroyed || this.transport.stdin.writableEnded) return;
		this.transport.stdin.write(serializeJsonLine(record));
	}

	private handleLine(line: string): void {
		const record = parseRecord(line);
		if (!record || typeof record.type !== "string") return;
		if (record.type === "response") {
			this.handleResponse(record);
			return;
		}
		if (record.type === "extension_ui_request") {
			for (const listener of this.uiListeners) listener(record as unknown as UiRequest);
			return;
		}
		for (const listener of this.eventListeners) listener(record as RpcEventRecord);
	}

	private handleResponse(record: Record<string, unknown>): void {
		const id = typeof record.id === "string" ? record.id : undefined;
		const pending = id ? this.pending.get(id) : undefined;
		if (!id || !pending) {
			// Uncorrelated responses (parse errors) surface as events so the UI can report them.
			for (const listener of this.eventListeners) listener({ ...record, type: "rpc_uncorrelated_response" });
			return;
		}
		this.pending.delete(id);
		if (pending.timer) clearTimeout(pending.timer);
		if (record.success === true) {
			pending.resolve(record.data);
		} else {
			const message = typeof record.error === "string" ? record.error : "Command failed";
			pending.reject(new RpcCommandError(pending.command, message));
		}
	}

	private handleExit(code: number | null, signal: string | null): void {
		this.exitInfo = { code, signal, stderrTail: this.stderrTail, expected: this.closing };
		for (const [id, pending] of this.pending) {
			if (pending.timer) clearTimeout(pending.timer);
			pending.reject(new Error(`Backend exited before answering ${pending.command}`));
			this.pending.delete(id);
		}
		for (const listener of this.exitListeners) listener(this.exitInfo);
	}
}
