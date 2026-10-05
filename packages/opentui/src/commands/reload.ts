/**
 * `/reload`: Reload keybindings, extensions, skills, prompts, themes, and context files.
 *
 * Stub: replace `run` (and add `getArgumentCompletions` where the interactive mode has them).
 */

import type { CommandDefinition } from "./registry.ts";
import { reportNotImplemented } from "./stub.ts";

export const reloadCommand: CommandDefinition = {
	name: "reload",
	acceptsArgs: false,
	clearEditor: "before",
	run: (ctx) => reportNotImplemented(ctx, "reload"),
};
