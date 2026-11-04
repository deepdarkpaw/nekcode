/** Shared command execution utilities for extensions and custom tools. */
import { constants as bufferConstants } from "node:buffer";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { waitForChildProcess } from "../utils/child-process.ts";

const DEFAULT_EXEC_MAX_BUFFER = Math.min(256 * 1024 * 1024, bufferConstants.MAX_STRING_LENGTH);
const FORCE_KILL_DELAY_MS = 5000;

/** Options for executing shell commands. */
export interface ExecOptions {
	/** AbortSignal to cancel the command. */
	signal?: AbortSignal;
	/** Timeout in milliseconds. */
	timeout?: number;
	/** Working directory. */
	cwd?: string;
	/** Combined stdout/stderr byte limit. Overflow terminates the command. Default: 256 MB. */
	maxBuffer?: number;
}

/** Result of executing a shell command. */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
	/** Output exceeded maxBuffer. Optional for existing extension implementations. */
	truncated?: boolean;
}

/** Execute with bounded UTF-8 output, timeout/abort cleanup, and inspectable spawn errors. */
export async function execCommand(
	command: string,
	args: string[],
	cwd: string,
	options?: ExecOptions,
): Promise<ExecResult> {
	const maxBuffer = options?.maxBuffer ?? DEFAULT_EXEC_MAX_BUFFER;
	if (!Number.isInteger(maxBuffer) || maxBuffer < 0 || maxBuffer > bufferConstants.MAX_STRING_LENGTH) {
		throw new RangeError(`maxBuffer must be an integer between 0 and ${bufferConstants.MAX_STRING_LENGTH} bytes`);
	}
	const proc = spawn(command, args, { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] });
	let stdout = "";
	let stderr = "";
	const stdoutDecoder = new StringDecoder("utf8");
	const stderrDecoder = new StringDecoder("utf8");
	let outputBytes = 0;
	let truncated = false;
	let killed = false;
	let timeoutId: NodeJS.Timeout | undefined;
	let forceKillId: NodeJS.Timeout | undefined;
	const killProcess = () => {
		if (killed) return;
		killed = true;
		proc.kill("SIGTERM");
		forceKillId = setTimeout(() => {
			if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
		}, FORCE_KILL_DELAY_MS);
	};
	if (options?.signal?.aborted) killProcess();
	else options?.signal?.addEventListener("abort", killProcess, { once: true });
	if (options?.timeout && options.timeout > 0) timeoutId = setTimeout(killProcess, options.timeout);

	const takeWithinCap = (data: Buffer): Buffer | undefined => {
		if (truncated) return undefined;
		const remaining = maxBuffer - outputBytes;
		if (data.length <= remaining) {
			outputBytes += data.length;
			return data;
		}
		truncated = true;
		proc.stdout?.destroy();
		proc.stderr?.destroy();
		killProcess();
		return remaining > 0 ? data.subarray(0, remaining) : undefined;
	};
	proc.stdout?.on("data", (data: Buffer) => {
		const chunk = takeWithinCap(data);
		if (chunk) stdout += stdoutDecoder.write(chunk);
	});
	proc.stderr?.on("data", (data: Buffer) => {
		const chunk = takeWithinCap(data);
		if (chunk) stderr += stderrDecoder.write(chunk);
	});
	let code: number | null;
	try {
		code = await waitForChildProcess(proc);
	} catch (error) {
		if (!(error instanceof Error)) throw error;
		code = 1;
		if (!stderr) stderr = error.message;
	} finally {
		clearTimeout(timeoutId);
		clearTimeout(forceKillId);
		options?.signal?.removeEventListener("abort", killProcess);
	}
	if (!truncated) {
		stdout += stdoutDecoder.end();
		stderr += stderrDecoder.end();
	}
	const exitCode = code ?? 0;
	return { stdout, stderr, code: truncated && exitCode === 0 ? 1 : exitCode, killed, truncated };
}
