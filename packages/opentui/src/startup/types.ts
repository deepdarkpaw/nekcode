/**
 * Startup and lifecycle flow contracts.
 *
 * Two kinds of startup UI exist:
 * - Prompts `main()` shows before the mode exists (first-time setup, `--resume` picker, `--session`
 *   fork confirmation, project trust, missing session cwd, deprecation warnings). They implement
 *   coding-agent `StartupUiHooks`; `createStartupUiHooks` builds them on the shared renderer. Hooks
 *   left out fall back to the pi-tui defaults, which only work before the renderer exists.
 * - Flows the mode runs itself (`ModeStartupFlow`): changelog, startup diagnostics, migration,
 *   model-fallback, models.json, and crash notices, the tmux keyboard check, the Anthropic
 *   subscription warning, and the model catalog refresh. The startup header, the loaded-resources
 *   listing, and the initial messages belong to the mode itself.
 *
 * This file is a contract shared by parallel work. Add members only; do not rename or remove them.
 */

import type { StartupUiHooks } from "@earendil-works/pi-coding-agent/cli/startup-ui-hooks";
import type { SettingsManager } from "@earendil-works/pi-coding-agent/core/settings-manager";
import type { InteractiveModeOptions } from "@earendil-works/pi-coding-agent/modes/interactive/interactive-mode";
import type { ModeContext } from "../mode/mode-context.ts";
import type { UiEnvironment } from "../ui/environment.ts";

/** Gives pre-mode prompts the shared renderer, overlay stack, keybindings, and theme. */
export interface StartupHost {
	/** Create the renderer if needed (initializing the theme from `settingsManager`) and return the UI environment. */
	environment(settingsManager: SettingsManager): Promise<UiEnvironment>;
}

/** Builds the pre-mode prompt hooks passed to `main(args, { startupUi })`. */
export type CreateStartupUiHooks = (host: StartupHost) => Partial<StartupUiHooks>;

/**
 * When a mode flow runs:
 * - `init`: during `init()`, after the shell is built and before the session is rendered.
 * - `ready`: during `init()`, after the session history is rendered.
 * - `run`: at the start of `run()`, before the initial messages are sent.
 */
export type ModeStartupPhase = "init" | "ready" | "run";

export interface ModeStartupFlow {
	readonly id: string;
	readonly phase: ModeStartupPhase;
	/** Errors are reported in the transcript and do not stop startup. */
	run(ctx: ModeContext, options: InteractiveModeOptions): void | Promise<void>;
}
