import type { InlineExtension } from "../core/extensions/types.ts";
import llamaExtension from "./llama/index.ts";
import mcpExtension from "./mcp/index.ts";
import { createNekExtension } from "./nek/index.ts";
import toolSearchExtension from "./tool-search/index.ts";

export const builtInExtensions: InlineExtension[] = [
	{ name: "llama.cpp", factory: llamaExtension, hidden: true },
	{ name: "nek", factory: createNekExtension({ role: "root" }), hidden: true },
	{ name: "mcp", factory: mcpExtension, hidden: true },
	{ name: "tool-search", factory: toolSearchExtension, hidden: true },
];
