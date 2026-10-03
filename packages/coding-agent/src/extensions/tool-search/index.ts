/** Built-in tool discovery extension. */

import type { ExtensionFactory } from "../../core/extensions/types.ts";
import { createToolSearchToolDefinition } from "./tool.ts";

/** Register tool_search as a model-only tool; the session activates it when deferred tools exist. */
export function createToolSearchExtension(): ExtensionFactory {
	return (pi) => {
		pi.registerTool({ ...createToolSearchToolDefinition({ tools: pi }), defaultActive: false });
	};
}

export default createToolSearchExtension();
