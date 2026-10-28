/**
 * `list_builtin_tools`: the built-in tools a settings page can select in `defaultTools`.
 *
 * The names and their order come from `core/tool-names.ts`, and each description from the tool's own
 * definition in `core/tools/index.ts`, so a new built-in tool appears here without a second list.
 */

import { allToolNames, DEFAULT_ACTIVE_TOOL_NAMES } from "../../../core/tool-names.ts";
import { createAllToolDefinitions } from "../../../core/tools/index.ts";
import type { GuiContext } from "./context.ts";
import type { RpcBuiltinTool } from "./protocol.ts";

/** Every built-in tool in nek's enumeration order, with its description and whether it is active by default. */
export function listBuiltinTools(ctx: GuiContext): RpcBuiltinTool[] {
	const definitions = createAllToolDefinitions(ctx.cwd);
	return [...allToolNames].map((name) => ({
		name,
		description: definitions[name].description,
		defaultActive: DEFAULT_ACTIVE_TOOL_NAMES.includes(name),
	}));
}
