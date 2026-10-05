/**
 * Prompts `main()` shows before the interactive mode starts: first-time setup, the `--resume`
 * session picker, the fork confirmation for `--session`, project trust prompts, the missing session
 * cwd prompt, and deprecation warnings.
 *
 * The defaults use pi-tui (and readline for the fork confirmation). Alternative frontends override
 * them through `MainOptions.startupUi` so every prompt renders in the same interface.
 */

import { createInterface } from "node:readline";
import type { SessionInfo, SessionListProgress } from "../core/session-manager.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { showDeprecationWarnings } from "../migrations.ts";
import { selectSession } from "./session-picker.ts";
import { showFirstTimeSetup, showStartupInput, showStartupSelector } from "./startup-ui.ts";

/** Loads sessions for the session picker, reporting progress. */
export type StartupSessionsLoader = (onProgress?: SessionListProgress, signal?: AbortSignal) => Promise<SessionInfo[]>;

/** One option of a startup selector. */
export interface StartupSelectOption<T> {
	label: string;
	value: T;
}

export interface StartupUiHooks {
	/** Show a single-choice selector. Resolves `undefined` when cancelled. */
	select<T>(
		settingsManager: SettingsManager,
		title: string,
		options: StartupSelectOption<T>[],
	): Promise<T | undefined>;
	/** Show a single-line text input. Resolves `undefined` when cancelled. */
	input(settingsManager: SettingsManager, title: string, placeholder?: string): Promise<string | undefined>;
	/** Ask a yes/no question (the `--session` fork prompt). */
	confirm(settingsManager: SettingsManager, message: string): Promise<boolean>;
	/** Run first-time setup (theme and analytics) and persist the result. */
	firstTimeSetup(settingsManager: SettingsManager): Promise<void>;
	/** Show the `--resume` session picker. Resolves the selected session path, or `null` when cancelled. */
	selectSession(
		currentSessionsLoader: StartupSessionsLoader,
		allSessionsLoader: StartupSessionsLoader,
		settingsManager: SettingsManager,
	): Promise<string | null>;
	/** Show extension-layout deprecation warnings and wait for acknowledgement. */
	showDeprecationWarnings(warnings: string[]): Promise<void>;
}

/** Readline yes/no prompt used by the default fork confirmation. */
async function promptConfirm(message: string): Promise<boolean> {
	return new Promise((resolve) => {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		rl.question(`${message} [y/N] `, (answer) => {
			rl.close();
			resolve(answer.toLowerCase() === "y" || answer.toLowerCase() === "yes");
		});
	});
}

/** The built-in pi-tui startup prompts. */
export const defaultStartupUiHooks: StartupUiHooks = {
	select: showStartupSelector,
	input: showStartupInput,
	confirm: (_settingsManager, message) => promptConfirm(message),
	firstTimeSetup: showFirstTimeSetup,
	selectSession,
	showDeprecationWarnings,
};

/** Defaults with `overrides` applied. */
export function resolveStartupUiHooks(overrides: Partial<StartupUiHooks> | undefined): StartupUiHooks {
	return { ...defaultStartupUiHooks, ...overrides };
}
