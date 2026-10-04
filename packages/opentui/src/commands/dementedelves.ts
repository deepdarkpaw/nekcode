/**
 * `/dementedelves`: Easter egg (DaxnutsComponent / EarendilAnnouncementComponent).
 *
 * Stub: replace `run` (and add `getArgumentCompletions` where the interactive mode has them).
 */

import type { CommandDefinition } from "./registry.ts";
import { reportNotImplemented } from "./stub.ts";

export const dementedelvesCommand: CommandDefinition = {
	name: "dementedelves",
	acceptsArgs: false,
	clearEditor: "after",
	hidden: true,
	run: (ctx) => reportNotImplemented(ctx, "dementedelves"),
};
