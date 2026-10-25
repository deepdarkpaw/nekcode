/**
 * `get_info` and `get_changelog`: process identity and the bundled changelog, shared by both RPC modes.
 */

import { getChangelogPath, NEK_VERSION, VERSION } from "../../../config.ts";
import { getNewEntries, normalizeChangelogLinks, parseChangelog } from "../../../utils/changelog.ts";
import type { GuiContext } from "./context.ts";
import { NEK_GUI_PROTOCOL_VERSION, type RpcInfo } from "./protocol.ts";

/** Identity of the running RPC process. */
export function getInfo(ctx: GuiContext): RpcInfo {
	return {
		protocolVersion: NEK_GUI_PROTOCOL_VERSION,
		nekVersion: NEK_VERSION,
		piVersion: VERSION,
		mode: ctx.mode,
		agentDir: ctx.agentDir,
		sessionDir: ctx.sessionDir,
		cwd: ctx.cwd,
		platform: process.platform,
		nodeVersion: process.version,
	};
}

/** Changelog markdown, newest entry first, optionally limited to entries newer than `sinceVersion`. */
export function getChangelog(sinceVersion?: string): { markdown: string } {
	const entries = parseChangelog(getChangelogPath());
	const selected = sinceVersion === undefined ? entries : getNewEntries(entries, sinceVersion);
	if (selected.length === 0) return { markdown: "No changelog entries found." };
	return {
		markdown: selected
			.slice()
			.reverse()
			.map((entry) => normalizeChangelogLinks(entry.content, entry))
			.join("\n\n"),
	};
}
