/**
 * `/name`: Show or set the session display name.
 *
 * Stub: replace `run` (and add `getArgumentCompletions` where the interactive mode has them).
 */

import type { CommandDefinition } from "./registry.ts";
import { reportNotImplemented } from "./stub.ts";

export const nameCommand: CommandDefinition = {
	name: "name",
	acceptsArgs: true,
	clearEditor: "after",
	run: (ctx) => reportNotImplemented(ctx, "name"),
};
