/**
 * `/clone`: Duplicate the session at the current position.
 *
 * Stub: replace `run` (and add `getArgumentCompletions` where the interactive mode has them).
 */

import type { CommandDefinition } from "./registry.ts";
import { reportNotImplemented } from "./stub.ts";

export const cloneCommand: CommandDefinition = {
	name: "clone",
	acceptsArgs: false,
	clearEditor: "before",
	run: (ctx) => reportNotImplemented(ctx, "clone"),
};
