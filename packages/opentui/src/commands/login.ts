/**
 * `/login`: Configure provider authentication.
 *
 * Stub: replace `run` (and add `getArgumentCompletions` where the interactive mode has them).
 */

import type { CommandDefinition } from "./registry.ts";
import { reportNotImplemented } from "./stub.ts";

export const loginCommand: CommandDefinition = {
	name: "login",
	acceptsArgs: true,
	clearEditor: "before",
	run: (ctx) => reportNotImplemented(ctx, "login"),
};
