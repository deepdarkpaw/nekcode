/**
 * Editor key actions owned by commands: model and thinking cycling, and the session shortcuts that
 * open command selectors. The mode checks these (`findKeyAction` in `registry.ts`) when the prompt
 * editor has focus, like `defaultEditor.onAction(...)` in the interactive mode. Keys come from the
 * configurable keybindings; never match literal keys here.
 */

import { copyCommand } from "./copy.ts";
import { forkCommand } from "./fork.ts";
import { modelCommand } from "./model.ts";
import { newCommand } from "./new.ts";
import type { CommandDefinition, CommandInvocation, KeyActionDefinition } from "./registry.ts";
import { resumeCommand } from "./resume.ts";
import { reportNotImplemented } from "./stub.ts";
import { treeCommand } from "./tree.ts";

function invocationOf(command: CommandDefinition): CommandInvocation {
	return { name: command.name, args: undefined, text: `/${command.name}` };
}

function runCommand(command: CommandDefinition): KeyActionDefinition["run"] {
	return (ctx) => command.run(ctx, invocationOf(command));
}

export const BUILTIN_KEY_ACTIONS: readonly KeyActionDefinition[] = [
	{ id: "app.thinking.cycle", run: (ctx) => reportNotImplemented(ctx, "thinking (cycle)") },
	{ id: "app.model.cycleForward", run: (ctx) => reportNotImplemented(ctx, "model (cycle forward)") },
	{ id: "app.model.cycleBackward", run: (ctx) => reportNotImplemented(ctx, "model (cycle backward)") },
	{ id: "app.model.select", run: runCommand(modelCommand) },
	{ id: "app.message.copy", run: runCommand(copyCommand) },
	{ id: "app.session.new", run: runCommand(newCommand) },
	{ id: "app.session.tree", run: runCommand(treeCommand) },
	{ id: "app.session.fork", run: runCommand(forkCommand) },
	{ id: "app.session.resume", run: runCommand(resumeCommand) },
];
