import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import type { SessionInfo, SessionInfoBuilder } from "../session-entries.ts";

/**
 * Listing cache of one durable session, next to its database: `<name>.meta.json` for `<name>.sqlite`. Listing reads
 * it instead of opening every database. The writer rewrites it after every committed batch and after closing the
 * database, so it is fresh when it is at least as new as the database and its write-ahead log; otherwise listing
 * rebuilds it from the database.
 */
export type SessionSidecar = {
	readonly version: 1;
	readonly id: string;
	readonly cwd: string;
	readonly name?: string;
	readonly parentSessionPath?: string;
	readonly created: string;
	/** Last activity, or the header time; absent when neither is known and the file time applies. */
	readonly modified?: string;
	readonly messageCount: number;
	readonly firstMessage: string;
	readonly allMessagesText: string;
};

const SIDECAR_VERSION = 1;

export function sidecarPath(databasePath: string): string {
	return databasePath.endsWith(".sqlite")
		? `${databasePath.slice(0, -".sqlite".length)}.meta.json`
		: `${databasePath}.meta.json`;
}

/** The sidecar of a summarized session; `undefined` before the session has a header. */
export function sidecarFromBuilder(builder: SessionInfoBuilder): SessionSidecar | undefined {
	const unknownTime = new Date(Number.NaN);
	const info = builder.build("", unknownTime);
	if (info === null) return undefined;
	return {
		version: SIDECAR_VERSION,
		id: info.id,
		cwd: info.cwd,
		...(info.name === undefined ? {} : { name: info.name }),
		...(info.parentSessionPath === undefined ? {} : { parentSessionPath: info.parentSessionPath }),
		// The raw header value: listing builds `created` from it exactly as JSONL listing does.
		created: String(builder.header?.timestamp),
		...(Number.isNaN(info.modified.getTime()) ? {} : { modified: info.modified.toISOString() }),
		messageCount: info.messageCount,
		firstMessage: info.firstMessage,
		allMessagesText: info.allMessagesText,
	};
}

export function writeSessionSidecar(databasePath: string, sidecar: SessionSidecar): void {
	const path = sidecarPath(databasePath);
	const temporary = `${path}.tmp-${process.pid}`;
	writeFileSync(temporary, JSON.stringify(sidecar));
	renameSync(temporary, path);
}

/** The session info a fresh sidecar caches, or `undefined` when it is missing, stale, or unreadable. */
export function readFreshSidecar(databasePath: string, databaseModifiedMs: number): SessionInfo | undefined {
	const path = sidecarPath(databasePath);
	try {
		if (!existsSync(path) || statSync(path).mtimeMs < databaseModifiedMs) return undefined;
		const sidecar = JSON.parse(readFileSync(path, "utf8")) as SessionSidecar;
		if (sidecar.version !== SIDECAR_VERSION) return undefined;
		return sessionInfoFromSidecar(databasePath, sidecar, databaseModifiedMs);
	} catch {
		return undefined;
	}
}

export function sessionInfoFromSidecar(
	databasePath: string,
	sidecar: SessionSidecar,
	databaseModifiedMs: number,
): SessionInfo {
	return {
		path: databasePath,
		id: sidecar.id,
		cwd: sidecar.cwd,
		name: sidecar.name,
		parentSessionPath: sidecar.parentSessionPath,
		created: new Date(sidecar.created),
		modified: sidecar.modified === undefined ? new Date(databaseModifiedMs) : new Date(sidecar.modified),
		messageCount: sidecar.messageCount,
		firstMessage: sidecar.firstMessage,
		allMessagesText: sidecar.allMessagesText,
	};
}
