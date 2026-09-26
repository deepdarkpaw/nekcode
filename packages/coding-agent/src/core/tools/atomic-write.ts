import {
	chmodSync,
	closeSync,
	fsyncSync,
	openSync,
	readlinkSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

/** Options used by the atomic file writer. */
export interface AtomicWriteOptions {
	/** Encoding used to turn the text into bytes. */
	encoding: BufferEncoding;
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function flushFile(path: string): void {
	const descriptor = openSync(path, "r+");
	try {
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
}

function resolveWriteTarget(filePath: string): string {
	try {
		const linkTarget = readlinkSync(filePath);
		return isAbsolute(linkTarget) ? linkTarget : resolve(dirname(filePath), linkTarget);
	} catch (error) {
		if (
			!isMissingFileError(error) &&
			typeof error === "object" &&
			error !== null &&
			"code" in error &&
			error.code !== "EINVAL"
		) {
			throw error;
		}
		return filePath;
	}
}

/** Write a file through a flushed temporary file and atomic rename, preserving links and permissions. */
export function atomicWriteFile(filePath: string, content: string, options: AtomicWriteOptions): void {
	const targetPath = resolveWriteTarget(filePath);
	const tempPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`;
	let targetMode: number | undefined;
	let targetExists = false;
	try {
		targetMode = statSync(targetPath).mode;
		targetExists = true;
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
	}

	try {
		writeFileSync(tempPath, content, { encoding: options.encoding, ...(targetExists ? {} : { mode: 0o666 }) });
		flushFile(tempPath);
		if (targetMode !== undefined) chmodSync(tempPath, targetMode);
		renameSync(tempPath, targetPath);
	} catch (atomicError) {
		try {
			unlinkSync(tempPath);
		} catch {
			// The temporary file may not have been created.
		}
		throw atomicError;
	}
}

/** Async-compatible wrapper for the default edit operation. */
export async function atomicWriteFileAsync(
	filePath: string,
	content: string,
	options: AtomicWriteOptions,
): Promise<void> {
	atomicWriteFile(filePath, content, options);
}
