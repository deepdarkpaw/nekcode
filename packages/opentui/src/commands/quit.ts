/**
 * `/quit`: graceful exit (same path as the double interrupt and `app.exit`).
 */

import type { CommandDefinition } from "./registry.ts";

export const quitCommand: CommandDefinition = {
	name: "quit",
	acceptsArgs: false,
	clearEditor: "before",
	run: (ctx) => ctx.shutdown(),
};
