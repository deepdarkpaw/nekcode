/**
 * Commands that act on the live session: export, share, tree navigation, and entry labels.
 */

import { shareSessionHeadless } from "../../interactive/session-share-native.ts";
import type { GuiContext } from "./context.ts";
import { requireSession } from "./context.ts";

/** Export the current session as a self-contained HTML page or as JSONL. */
export async function exportSession(
	ctx: GuiContext,
	format: "html" | "jsonl",
	outputPath: string | undefined,
): Promise<string> {
	const session = requireSession(ctx, "export_session");
	return format === "jsonl" ? session.exportToJsonl(outputPath) : await session.exportToHtml(outputPath);
}

/** Share the current session and return the viewer URL. */
export async function shareSession(ctx: GuiContext): Promise<string> {
	return await shareSessionHeadless(requireSession(ctx, "share_session"));
}

/** Move the session leaf to an entry, optionally summarizing the branch that is left behind. */
export async function navigateTree(
	ctx: GuiContext,
	command: {
		entryId: string;
		summarize?: boolean;
		customInstructions?: string;
		replaceInstructions?: boolean;
		label?: string;
	},
): Promise<{ cancelled: boolean; editorText?: string }> {
	const session = requireSession(ctx, "navigate_tree");
	const result = await session.navigateTree(command.entryId, {
		summarize: command.summarize,
		customInstructions: command.customInstructions,
		replaceInstructions: command.replaceInstructions,
		label: command.label,
	});
	return result.editorText === undefined
		? { cancelled: result.cancelled }
		: { cancelled: result.cancelled, editorText: result.editorText };
}

/** Set or clear the label of an entry. */
export function setEntryLabel(ctx: GuiContext, entryId: string, label: string | undefined): void {
	const session = requireSession(ctx, "set_entry_label");
	if (!session.sessionManager.getEntry(entryId)) throw new Error(`Entry not found: ${entryId}`);
	session.sessionManager.appendLabelChange(entryId, label);
}
