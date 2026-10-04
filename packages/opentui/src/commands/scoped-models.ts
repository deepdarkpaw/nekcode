/**
 * `/scoped-models`: Enable or disable models for model cycling (ScopedModelsSelectorComponent parity).
 *
 * Stub: replace `run` (and add `getArgumentCompletions` where the interactive mode has them).
 */

import type { CommandDefinition } from "./registry.ts";
import { reportNotImplemented } from "./stub.ts";

export const scopedModelsCommand: CommandDefinition = {
	name: "scoped-models",
	acceptsArgs: false,
	clearEditor: "before",
	run: (ctx) => reportNotImplemented(ctx, "scoped-models"),
};
