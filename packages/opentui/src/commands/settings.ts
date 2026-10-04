/**
 * `/settings`: Open the settings selector (SettingsSelectorComponent parity).
 *
 * Stub: replace `run` (and add `getArgumentCompletions` where the interactive mode has them).
 */

import type { CommandDefinition } from "./registry.ts";
import { reportNotImplemented } from "./stub.ts";

export const settingsCommand: CommandDefinition = {
	name: "settings",
	acceptsArgs: false,
	clearEditor: "after",
	run: (ctx) => reportNotImplemented(ctx, "settings"),
};
