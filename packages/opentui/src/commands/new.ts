/**
 * `/new`: Start a new session.
 *
 * Stub: replace `run` (and add `getArgumentCompletions` where the interactive mode has them).
 */

import type { CommandDefinition } from "./registry.ts";
import { reportNotImplemented } from "./stub.ts";

export const newCommand: CommandDefinition = {
	name: "new",
	acceptsArgs: false,
	clearEditor: "before",
	run: (ctx) => reportNotImplemented(ctx, "new"),
};
