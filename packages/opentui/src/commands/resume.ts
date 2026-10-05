/**
 * `/resume`: Resume a different session (SessionSelectorComponent parity).
 *
 * Stub: replace `run` (and add `getArgumentCompletions` where the interactive mode has them).
 */

import type { CommandDefinition } from "./registry.ts";
import { reportNotImplemented } from "./stub.ts";

export const resumeCommand: CommandDefinition = {
	name: "resume",
	acceptsArgs: false,
	clearEditor: "after",
	run: (ctx) => reportNotImplemented(ctx, "resume"),
};
