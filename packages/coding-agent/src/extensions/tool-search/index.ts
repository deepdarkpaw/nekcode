/** Built-in tool discovery extension. */

import type { ExtensionFactory, ToolNamespace } from "../../core/extensions/types.ts";
import {
	DEFAULT_SOURCE_WAIT_MS,
	getPendingDeferredSources,
	PENDING_SOURCES_CHANGED,
	waitForDeferredSources,
} from "./pending.ts";
import { createToolSearchDescription, createToolSearchToolDefinition, isToolSearchTool } from "./tool.ts";

/** Declare tool_search only while registered deferred tools remain inactive. */
export function createToolSearchExtension(options: { sourceWaitMs?: number } = {}): ExtensionFactory {
	return (pi) => {
		const definition = {
			...createToolSearchToolDefinition({
				tools: pi,
				beforeSearch: (signal) =>
					waitForDeferredSources(pi.events, options.sourceWaitMs ?? DEFAULT_SOURCE_WAIT_MS, signal),
			}),
			defaultActive: false,
		};
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
				const pending = getPendingDeferredSources(pi.events);
				const sources = new Map<string, ToolNamespace>(
					pending.map((source) => [source.namespace.name, source.namespace]),
				);
				for (const tool of deferred) {
					if (tool.namespace) sources.set(tool.namespace.name, tool.namespace);
				}
				const description = createToolSearchDescription([...sources.values()]);
				if (description !== definition.description) {
					definition.description = description;
					pi.registerTool({ ...definition });
				}
				const nextActive = pi.getActiveTools();
				const hasDeferred = pi
					.getAllTools()
					.some((tool) => tool.exposure === "deferred" && !nextActive.includes(tool.name));
				const hasPending = getPendingDeferredSources(pi.events).length > 0;
				const enabled = nextActive.includes(definition.name);
				if ((hasDeferred || hasPending) && !enabled) pi.setActiveTools([...nextActive, definition.name]);
				else if (!hasDeferred && !hasPending && enabled)
					pi.setActiveTools(nextActive.filter((name) => name !== definition.name));
			} finally {
				syncing = false;
			}
		};
		pi.on("session_start", sync);
		pi.events.on("tools_changed", sync);
		pi.events.on(PENDING_SOURCES_CHANGED, sync);
	};
}

export default createToolSearchExtension();
