/**
 * `/trust`: Save the project trust decision.
 *
 * Stub: replace `run` (and add `getArgumentCompletions` where the interactive mode has them).
 */

import type { CommandDefinition } from "./registry.ts";
import { reportNotImplemented } from "./stub.ts";

export const trustCommand: CommandDefinition = {
	name: "trust",
	acceptsArgs: false,
	clearEditor: "after",
	run: (ctx) => reportNotImplemented(ctx, "trust"),
};
