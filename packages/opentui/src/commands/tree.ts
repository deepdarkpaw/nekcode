/**
 * `/tree`: Navigate the session tree (TreeSelectorComponent parity).
 *
 * Stub: replace `run` (and add `getArgumentCompletions` where the interactive mode has them).
 */

import type { CommandDefinition } from "./registry.ts";
import { reportNotImplemented } from "./stub.ts";

export const treeCommand: CommandDefinition = {
	name: "tree",
	acceptsArgs: false,
	clearEditor: "after",
	run: (ctx) => reportNotImplemented(ctx, "tree"),
};
