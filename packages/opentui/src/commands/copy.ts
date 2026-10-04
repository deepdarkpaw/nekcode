/**
 * `/copy`: Copy the last assistant message to the clipboard.
 *
 * Stub: replace `run` (and add `getArgumentCompletions` where the interactive mode has them).
 */

import type { CommandDefinition } from "./registry.ts";
import { reportNotImplemented } from "./stub.ts";

export const copyCommand: CommandDefinition = {
	name: "copy",
	acceptsArgs: false,
	clearEditor: "after",
	run: (ctx) => reportNotImplemented(ctx, "copy"),
};
