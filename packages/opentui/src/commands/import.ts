/**
 * `/import`: Import and resume a session from a JSONL file.
 *
 * Stub: replace `run` (and add `getArgumentCompletions` where the interactive mode has them).
 */

import type { CommandDefinition } from "./registry.ts";
import { reportNotImplemented } from "./stub.ts";

export const importCommand: CommandDefinition = {
	name: "import",
	acceptsArgs: true,
	clearEditor: "after",
	run: (ctx) => reportNotImplemented(ctx, "import"),
};
