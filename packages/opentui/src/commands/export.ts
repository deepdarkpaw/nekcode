/**
 * `/export`: Export the session to HTML (default) or JSONL (`/export <path>`).
 *
 * Stub: replace `run` (and add `getArgumentCompletions` where the interactive mode has them).
 */

import type { CommandDefinition } from "./registry.ts";
import { reportNotImplemented } from "./stub.ts";

export const exportCommand: CommandDefinition = {
	name: "export",
	acceptsArgs: true,
	clearEditor: "after",
	run: (ctx) => reportNotImplemented(ctx, "export"),
};
