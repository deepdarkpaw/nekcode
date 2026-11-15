import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type HistoryStorage, openHistoryStorage } from "../../../core/durable/history-storage.ts";
import { resolvePath } from "../../../utils/paths.ts";
import type { GuiContext } from "./context.ts";
import type { RpcHistoryCommand } from "./history-protocol.ts";

/** A new session deliberately has no file until its first user message; this is not missing persisted history. */
export function openHistorySource(ctx: GuiContext, command: RpcHistoryCommand, requested: string): HistoryStorage {
	const path = resolvePath(requested);
	if (existsSync(path)) return openHistoryStorage(path);
	const manager = ctx.session?.sessionManager;
	if (
		command.sessionPath !== undefined ||
		!manager ||
		manager.hasInitializedStorage() ||
		manager.getCommittedEntryCount() !== 0
	)
		return openHistoryStorage(path);
	if (manager.getSessionFile() !== requested)
		throw new Error("Unpersisted history does not match the current session");
	const header = manager.getHeader();
	if (!header) throw new Error("Unpersisted history has no current session header");
	return {
		path: join(realpathSync(dirname(path)), basename(path)),
		header,
		entries: [],
		format: "sqlite",
		watermark: { entryId: 0, conversationId: 0, nextSeq: 0 },
		bytes() {
			throw new Error("An unpersisted history has no stored content");
		},
		verify() {
			if (
				manager.getSessionFile() !== requested ||
				manager.getHeader() !== header ||
				manager.hasInitializedStorage() ||
				existsSync(path)
			)
				throw new Error("Session persistence changed during empty history read; retry");
		},
		close() {},
	};
}
