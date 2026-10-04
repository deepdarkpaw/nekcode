/**
 * `/arminsayshi`: Easter egg (ArminComponent).
 *
 * Stub: replace `run` (and add `getArgumentCompletions` where the interactive mode has them).
 */

import type { CommandDefinition } from "./registry.ts";
import { reportNotImplemented } from "./stub.ts";

export const arminsayshiCommand: CommandDefinition = {
	name: "arminsayshi",
	acceptsArgs: false,
	clearEditor: "after",
	hidden: true,
	run: (ctx) => reportNotImplemented(ctx, "arminsayshi"),
};
