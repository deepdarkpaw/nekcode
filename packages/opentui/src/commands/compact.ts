/**
 * `/compact`: Compact the session context, with optional instructions.
 *
 * Stub: replace `run` (and add `getArgumentCompletions` where the interactive mode has them).
 */

import type { CommandDefinition } from "./registry.ts";
import { reportNotImplemented } from "./stub.ts";

export const compactCommand: CommandDefinition = {
	name: "compact",
	acceptsArgs: true,
	clearEditor: "before",
	run: (ctx) => reportNotImplemented(ctx, "compact"),
};
