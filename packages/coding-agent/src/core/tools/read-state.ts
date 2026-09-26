import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** One recorded read of a file. Both range fields are undefined for a whole-file read. */
export interface ReadStateRecord {
	/** File content with CRLF normalized to LF. */
	content: string;
	/** File modification time in milliseconds when the file was read. */
	timestamp: number;
	/** First line read (1-indexed), or undefined when the whole file was read. */
	offset: number | undefined;
	/** Number of lines read, or undefined when the whole file was read. */
	limit: number | undefined;
}

/**
 * Read state shared by read, write, and edit. An edit requires a prior read of the same file so that a
 * stale view cannot overwrite someone else's changes.
 */
export interface ReadStateStore {
	get(absolutePath: string): ReadStateRecord | undefined;
	set(absolutePath: string, record: ReadStateRecord): void;
}

/** Default entry limit of a store (Claude Code READ_FILE_STATE_CACHE_SIZE). */
export const DEFAULT_READ_STATE_ENTRIES = 100;

/** Default byte limit of a store, 25MB (Claude Code DEFAULT_MAX_CACHE_SIZE_BYTES). */
export const DEFAULT_READ_STATE_BYTES = 25 * 1024 * 1024;

function isMissingPathError(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		(error.code === "ENOENT" || error.code === "ENOTDIR")
	);
}

/**
 * Cache key of a path: resolved against the process cwd and, when the file exists, resolved through symlinks
 * so a link and its target share one record. Missing files keep the resolved path, matching the keys used by
 * the file mutation queue.
 */
export function readStateKey(absolutePath: string): string {
	const resolved = resolve(absolutePath);
	try {
		return realpathSync(resolved);
	} catch (error) {
		if (isMissingPathError(error)) return resolved;
		throw error;
	}
}

/**
 * Create a store bounded by entry count and total bytes. The oldest entry is evicted first, and the newest
 * record always survives so a fresh read is never dropped by its own insertion.
 */
export function createReadStateStore(
	maxEntries: number = DEFAULT_READ_STATE_ENTRIES,
	maxBytes: number = DEFAULT_READ_STATE_BYTES,
): ReadStateStore {
	const records = new Map<string, ReadStateRecord>();
	let totalBytes = 0;

	const sizeOf = (record: ReadStateRecord): number => Buffer.byteLength(record.content, "utf-8");

	const evict = (): void => {
		while ((records.size > maxEntries || totalBytes > maxBytes) && records.size > 1) {
			const oldest = records.keys().next();
			if (oldest.done) return;
			const record = records.get(oldest.value);
			if (record) totalBytes -= sizeOf(record);
			records.delete(oldest.value);
		}
	};

	return {
		get(absolutePath) {
			return records.get(readStateKey(absolutePath));
		},
		set(absolutePath, record) {
			const key = readStateKey(absolutePath);
			const previous = records.get(key);
			if (previous) {
				totalBytes -= sizeOf(previous);
				records.delete(key);
			}
			records.set(key, record);
			totalBytes += sizeOf(record);
			evict();
		},
	};
}
