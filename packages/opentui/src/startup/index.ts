/**
 * Startup flows and pre-mode prompt hooks. Stubs: no OpenTUI startup prompts yet (pi-tui defaults
 * run before the renderer starts) and no mode flows.
 */

import type { CreateStartupUiHooks, ModeStartupFlow } from "./types.ts";

export const createStartupUiHooks: CreateStartupUiHooks = () => ({});

export const MODE_STARTUP_FLOWS: readonly ModeStartupFlow[] = [];
