/**
 * Contract for alternative interactive frontends.
 *
 * `main()` constructs the interactive mode through this factory when one is supplied (the OpenTUI
 * frontend passes it from its Bun entry), and otherwise uses the built-in `InteractiveMode`.
 */

import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type { InteractiveModeOptions } from "./interactive-mode.ts";

/** The lifecycle `main()` drives: `init()` for startup benchmarks, `run()` for the session, `stop()` on exit. */
export interface InteractiveModeLike {
	init(): Promise<void>;
	run(): Promise<void>;
	stop(): void;
}

/** Builds the interactive mode for a runtime. Receives the same options as `InteractiveMode`. */
export type CreateInteractiveMode = (
	runtime: AgentSessionRuntime,
	options: InteractiveModeOptions,
) => InteractiveModeLike;
