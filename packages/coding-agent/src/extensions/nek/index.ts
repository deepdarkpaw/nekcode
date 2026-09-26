import { getAgentDir } from "../../config.ts";
import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { DEFAULT_NEK_CONFIG, loadNekConfig, type NekConfig } from "./config.ts";

/** `root` wires the main session; `subagent` wires a child session (no task/await, so no nesting). */
export type NekRole = "root" | "subagent";

/** Options for one nek extension instance. */
export interface NekExtensionOptions {
	role: NekRole;
	/** Fixed config, e.g. inherited by child sessions. When omitted, nek.yaml is loaded on session_start. */
	config?: NekConfig;
}

/** Per-instance state shared by the tools, hooks, and UI of one nek extension. */
export interface NekRuntime {
	role: NekRole;
	config: NekConfig;
}

/** Create the nek extension factory (todos, plan mode, subagents) for the given role. */
export function createNekExtension(options: NekExtensionOptions): ExtensionFactory {
	return (pi) => {
		const nek: NekRuntime = { role: options.role, config: options.config ?? DEFAULT_NEK_CONFIG };
		pi.on("session_start", (_event, ctx) => {
			if (options.config) return;
			nek.config = loadNekConfig(getAgentDir(), ctx.cwd, ctx.isProjectTrusted());
		});
	};
}
