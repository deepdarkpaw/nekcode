/**
 * `/fork`: Fork from a previous user message (UserMessageSelectorComponent parity).
 *
 * Stub: replace `run` (and add `getArgumentCompletions` where the interactive mode has them).
 */

import type { CommandDefinition } from "./registry.ts";
import { reportNotImplemented } from "./stub.ts";

export const forkCommand: CommandDefinition = {
	name: "fork",
	acceptsArgs: false,
	clearEditor: "after",
	run: (ctx) => reportNotImplemented(ctx, "fork"),
};
