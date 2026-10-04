/**
 * `/model`: Select a model; `/model <search>` switches directly on a unique match.
 *
 * Stub: replace `run` (and add `getArgumentCompletions` where the interactive mode has them).
 */

import type { CommandDefinition } from "./registry.ts";
import { reportNotImplemented } from "./stub.ts";

export const modelCommand: CommandDefinition = {
	name: "model",
	acceptsArgs: true,
	clearEditor: "before",
	run: (ctx) => reportNotImplemented(ctx, "model"),
};
