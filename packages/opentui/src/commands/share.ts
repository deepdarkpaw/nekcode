/**
 * `/share`: Share the session as a secret GitHub gist.
 *
 * Stub: replace `run` (and add `getArgumentCompletions` where the interactive mode has them).
 */

import type { CommandDefinition } from "./registry.ts";
import { reportNotImplemented } from "./stub.ts";

export const shareCommand: CommandDefinition = {
	name: "share",
	acceptsArgs: false,
	clearEditor: "after",
	run: (ctx) => reportNotImplemented(ctx, "share"),
};
