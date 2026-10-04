/**
 * `/thinking`: Set the thinking level; without an argument opens the thinking selector.
 *
 * Stub: replace `run` (and add `getArgumentCompletions` where the interactive mode has them).
 */

import type { CommandDefinition } from "./registry.ts";
import { reportNotImplemented } from "./stub.ts";

export const thinkingCommand: CommandDefinition = {
	name: "thinking",
	acceptsArgs: true,
	clearEditor: "before",
	run: (ctx) => reportNotImplemented(ctx, "thinking"),
};
