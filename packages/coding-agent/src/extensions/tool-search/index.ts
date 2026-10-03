/** Built-in tool discovery extension. */

import type { ExtensionFactory, ToolNamespace } from "../../core/extensions/types.ts";
import { createToolSearchDescription, createToolSearchToolDefinition, isToolSearchTool } from "./tool.ts";

/** Declare tool_search only while registered deferred tools remain inactive. */
export function createToolSearchExtension(): ExtensionFactory {
	return (pi) => {
		const definition = { ...createToolSearchToolDefinition({ tools: pi }), defaultActive: false };
		pi.registerTool(definition);
		let syncing = false;
		const sync = (): void => {
			if (syncing) return;
			const registered = pi.getAllTools();
			const search = registered.find(isToolSearchTool);
			if (!search || search.exposure === "hidden") return;
			syncing = true;
			try {
				const active = pi.getActiveTools();
				const deferred = registered.filter((tool) => tool.exposure === "deferred" && !active.includes(tool.name));
				const sources = new Map<string, ToolNamespace>();
				for (const tool of deferred) {
					if (tool.namespace) sources.set(tool.namespace.name, tool.namespace);
				}
				const description = createToolSearchDescription([...sources.values()]);
				if (description !== definition.description) {
					definition.description = description;
					pi.registerTool({ ...definition });
				}
				const enabled = active.includes(definition.name);
				if (deferred.length > 0 && !enabled) pi.setActiveTools([...active, definition.name]);
				else if (deferred.length === 0 && enabled)
					pi.setActiveTools(active.filter((name) => name !== definition.name));
			} finally {
				syncing = false;
			}
		};
		pi.on("session_start", sync);
		pi.events.on("tools_changed", sync);
	};
}

export default createToolSearchExtension();
