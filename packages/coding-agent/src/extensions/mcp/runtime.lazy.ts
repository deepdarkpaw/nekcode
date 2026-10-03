/** Runtime entry adapter. MCP connections are created only when a server is enabled. */
import * as runtime from "./runtime.ts";

export const loadMcpRuntime = () => Promise.resolve(runtime);
