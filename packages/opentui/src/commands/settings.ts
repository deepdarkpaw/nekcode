/**
 * `/settings`: Open the settings selector (SettingsSelectorComponent parity).
 *
 * Stub: replace `run` (and add `getArgumentCompletions` where the interactive mode has them).
 */

import { settingsSelector } from "../selectors/settings.ts";
import type { CommandDefinition } from "./registry.ts";

export const settingsCommand: CommandDefinition = {
	name: "settings",
	acceptsArgs: false,
	clearEditor: "after",
	run: async (ctx) => {
		await settingsSelector.open(ctx, undefined);
	},
};
