/**
 * Paging for `get_entries`.
 *
 * A session is an append-only tree, so entries page by position: `beforeEntryId` names the older end of the window
 * and `limit` caps how many entries it holds. A page is the newest `limit` entries older than that id, so a client
 * that starts at the leaf walks back through history while `hasMore` says an older page exists.
 */

import type { SessionEntry } from "../../core/session-manager.ts";

/** One page of session entries, in append order. */
export interface EntryPage {
	entries: SessionEntry[];
	/** Older entries exist before this page. */
	hasMore: boolean;
}

/** Paging of a `get_entries` request. Both fields absent keeps the whole list. */
export interface EntryPageQuery {
	/** Maximum entries in the page; a positive integer. */
	limit?: number;
	/** Return only entries older than this entry id. */
	beforeEntryId?: string;
}

/**
 * Page `entries`, which must be in append order: the newest `limit` entries older than `beforeEntryId`, or every
 * such entry when `limit` is absent. `hasMore` reports whether entries older than the page exist, including at the
 * older end of a page that dropped entries, so a client can page back from the leaf one window at a time.
 */
export function pageEntries(entries: readonly SessionEntry[], query: EntryPageQuery = {}): EntryPage {
	const before = query.beforeEntryId === undefined ? entries.length : indexOfEntry(entries, query.beforeEntryId);
	const candidates = entries.slice(0, before);
	const limit = pageLimit(query.limit);
	if (limit === undefined) return { entries: candidates, hasMore: false };
	const start = Math.max(0, candidates.length - limit);
	return { entries: candidates.slice(start), hasMore: start > 0 };
}

/** Position of `id` in `entries`; an unknown id is the same failure an unknown `since` cursor reports. */
function indexOfEntry(entries: readonly SessionEntry[], id: string): number {
	const index = entries.findIndex((entry) => entry.id === id);
	if (index === -1) throw new Error(`Entry not found: ${id}`);
	return index;
}

/** Page size of a request; `undefined` means every entry. */
function pageLimit(limit: number | undefined): number | undefined {
	if (limit === undefined) return undefined;
	if (!Number.isInteger(limit) || limit < 1) throw new Error(`limit must be a positive integer: ${limit}`);
	return limit;
}
