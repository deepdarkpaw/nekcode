/**
 * Built-in slash command registry.
 *
 * Each built-in command lives in its own module (`commands/<name>.ts`) and exports one
 * `CommandDefinition`. The editor submit path calls `dispatchBuiltinCommand`; autocomplete uses
 * `builtinSlashCommands`. Extension commands, prompt templates, and skills are not registered here:
 * text that matches no built-in command goes to `session.prompt()`, which expands them.
 *
 * Matching mirrors the interactive mode: `/name` matches exactly; commands with `acceptsArgs` also
 * match `/name <args>`. The editor is cleared before or after the handler runs (`clearEditor`),
 * matching the interactive mode per command.
 *
 * This file is a contract shared by parallel work. Add members only; do not rename or remove them.
 */

import type { AppKeybinding } from "@earendil-works/pi-coding-agent/core/keybindings";
import { BUILTIN_SLASH_COMMANDS } from "@earendil-works/pi-coding-agent/core/slash-commands";
import type { AutocompleteItem, KeybindingsManager, SlashCommand } from "@earendil-works/pi-tui";
import type { ModeContext } from "../mode/mode-context.ts";
import { arminsayshiCommand } from "./arminsayshi.ts";
import { changelogCommand } from "./changelog.ts";
import { cloneCommand } from "./clone.ts";
import { compactCommand } from "./compact.ts";
import { copyCommand } from "./copy.ts";
import { debugCommand } from "./debug.ts";
import { dementedelvesCommand } from "./dementedelves.ts";
import { exportCommand } from "./export.ts";
import { forkCommand } from "./fork.ts";
import { hotkeysCommand } from "./hotkeys.ts";
import { importCommand } from "./import.ts";
import { BUILTIN_KEY_ACTIONS } from "./key-actions.ts";
import { loginCommand } from "./login.ts";
import { logoutCommand } from "./logout.ts";
import { modelCommand } from "./model.ts";
import { nameCommand } from "./name.ts";
import { newCommand } from "./new.ts";
import { quitCommand } from "./quit.ts";
import { reloadCommand } from "./reload.ts";
import { resumeCommand } from "./resume.ts";
import { scopedModelsCommand } from "./scoped-models.ts";
import { sessionCommand } from "./session.ts";
import { settingsCommand } from "./settings.ts";
import { shareCommand } from "./share.ts";
import { thinkingCommand } from "./thinking.ts";
import { treeCommand } from "./tree.ts";
import { trustCommand } from "./trust.ts";

/** A parsed command line. */
export interface CommandInvocation {
	/** Command name without the slash (`model`). */
	readonly name: string;
	/** Trimmed text after `/name `, or undefined when there is none (empty args count as none). */
	readonly args: string | undefined;
	/** The full trimmed submitted text (`/export out.html`). */
	readonly text: string;
}

export interface CommandDefinition {
	/** Name without the slash. */
	readonly name: string;
	/** Also match `/name <args>`. Without it only the exact `/name` matches. */
	readonly acceptsArgs: boolean;
	/**
	 * When the editor is cleared: `"before"` the handler runs (selectors and long operations), or
	 * `"after"` it finishes (the handler may still read or replace the editor text).
	 */
	readonly clearEditor: "before" | "after";
	/** Not offered in autocomplete (`/debug`, easter eggs). */
	readonly hidden?: boolean;
	/** Argument completions for `/name <prefix>`. Return null when there are none. */
	getArgumentCompletions?(
		ctx: ModeContext,
		prefix: string,
	): AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
	/** Run the command. Errors are reported with `ctx.showError`. */
	run(ctx: ModeContext, invocation: CommandInvocation): void | Promise<void>;
}

/** All built-in commands, in autocomplete order. */
export const BUILTIN_COMMANDS: readonly CommandDefinition[] = [
	settingsCommand,
	modelCommand,
	treeCommand,
	thinkingCommand,
	scopedModelsCommand,
	exportCommand,
	importCommand,
	shareCommand,
	copyCommand,
	nameCommand,
	sessionCommand,
	changelogCommand,
	hotkeysCommand,
	forkCommand,
	cloneCommand,
	trustCommand,
	loginCommand,
	logoutCommand,
	newCommand,
	compactCommand,
	resumeCommand,
	reloadCommand,
	quitCommand,
	debugCommand,
	arminsayshiCommand,
	dementedelvesCommand,
];

const COMMANDS_BY_NAME: ReadonlyMap<string, CommandDefinition> = new Map(
	BUILTIN_COMMANDS.map((command) => [command.name, command]),
);

/** Look up a built-in command by name (without the slash). */
export function getBuiltinCommand(name: string): CommandDefinition | undefined {
	return COMMANDS_BY_NAME.get(name);
}

/** Match submitted text against the built-in commands. `text` must already be trimmed. */
export function matchBuiltinCommand(
	text: string,
): { command: CommandDefinition; invocation: CommandInvocation } | undefined {
	if (!text.startsWith("/")) return undefined;
	const spaceIndex = text.indexOf(" ");
	const name = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
	const command = COMMANDS_BY_NAME.get(name);
	if (!command) return undefined;
	if (spaceIndex !== -1 && !command.acceptsArgs) return undefined;
	const args = spaceIndex === -1 ? undefined : text.slice(spaceIndex + 1).trim() || undefined;
	return { command, invocation: { name, args, text } };
}

/**
 * Run the built-in command that `text` names. Returns false when `text` is not a built-in command,
 * so the caller can submit it as a prompt.
 */
export async function dispatchBuiltinCommand(ctx: ModeContext, text: string): Promise<boolean> {
	const match = matchBuiltinCommand(text);
	if (!match) return false;
	const { command, invocation } = match;
	if (command.clearEditor === "before") ctx.editor.setText("");
	try {
		await command.run(ctx, invocation);
	} catch (error) {
		ctx.showError(`/${command.name} failed: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		if (command.clearEditor === "after") ctx.editor.setText("");
	}
	return true;
}

/** Visible built-in commands for the autocomplete provider, with descriptions and argument completions. */
export function builtinSlashCommands(ctx: ModeContext): SlashCommand[] {
	const metadata = new Map(BUILTIN_SLASH_COMMANDS.map((command) => [command.name, command]));
	return BUILTIN_COMMANDS.filter((command) => !command.hidden).map((command) => {
		const info = metadata.get(command.name);
		const getCompletions = command.getArgumentCompletions;
		return {
			name: command.name,
			...(info?.description && { description: info.description }),
			...(info?.argumentHint && { argumentHint: info.argumentHint }),
			...(getCompletions && { getArgumentCompletions: (prefix: string) => getCompletions(ctx, prefix) }),
		};
	});
}

/** Names of the visible built-in commands (extension commands with these names are skipped). */
export function builtinCommandNames(): Set<string> {
	return new Set(BUILTIN_COMMANDS.filter((command) => !command.hidden).map((command) => command.name));
}

/** An editor key action owned by commands (`key-actions.ts`). */
export interface KeyActionDefinition {
	/** Configurable keybinding that triggers the action. */
	readonly id: AppKeybinding;
	run(ctx: ModeContext): void | Promise<void>;
}

/** All command-owned key actions (the mode registers them on the prompt editor). */
export function builtinKeyActions(): readonly KeyActionDefinition[] {
	return BUILTIN_KEY_ACTIONS;
}

/** The command-owned key action bound to raw input `data`, if any. */
export function findKeyAction(
	keybindings: Pick<KeybindingsManager, "matches">,
	data: string,
): KeyActionDefinition | undefined {
	return BUILTIN_KEY_ACTIONS.find((action) => keybindings.matches(data, action.id));
}

/** Run a key action, reporting errors in the transcript. */
export async function runKeyAction(ctx: ModeContext, action: KeyActionDefinition): Promise<void> {
	try {
		await action.run(ctx);
	} catch (error) {
		ctx.showError(error instanceof Error ? error.message : String(error));
	}
}
