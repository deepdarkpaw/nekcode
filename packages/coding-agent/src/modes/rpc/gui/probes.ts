/**
 * Probes the settings page needs: does web search work, and does an MCP server answer with tools.
 *
 * Both run the real code paths (the Exa MCP tool and the MCP client) with a bounded timeout. Failures are
 * data, not RPC errors: the GUI shows them next to the field the user is editing.
 */

import { resolve } from "node:path";
import { McpClient, type McpTransport, StdioTransport, StreamableHttpTransport } from "@earendil-works/pi-mcp";
import { APP_NAME, VERSION } from "../../../config.ts";
import { type McpServerConfig, validateMcpServerConfig } from "../../../core/mcp-servers.ts";
import { resolveConfigValueOrThrow, resolveHeadersOrThrow } from "../../../core/resolve-config-value.ts";
import { createWebSearchToolDefinition } from "../../../core/tools/web-search.ts";
import { loadMcpConfig } from "../../../extensions/mcp/config.ts";
import { resolvePath } from "../../../utils/paths.ts";
import { isProjectTrusted } from "./config.ts";
import type { GuiContext } from "./context.ts";
import type { RpcMcpTestResult, RpcTestWebSearchResult } from "./protocol.ts";
import { errorMessage } from "./response.ts";

const WEB_SEARCH_TEST_TIMEOUT_MS = 25_000;
const DEFAULT_MCP_TIMEOUT_SECONDS = 60;

/** Run one web search with the configured endpoint, key, and default result count. */
export async function testWebSearch(ctx: GuiContext, query: string): Promise<RpcTestWebSearchResult> {
	const settings = ctx.settingsManager.getWebSearchSettings();
	const tool = createWebSearchToolDefinition({
		endpoint: settings?.endpoint,
		apiKey: settings?.apiKey,
		defaultResults: settings?.numResults,
		timeoutMs: WEB_SEARCH_TEST_TIMEOUT_MS,
	});
	const signal = AbortSignal.timeout(WEB_SEARCH_TEST_TIMEOUT_MS);
	const started = Date.now();
	try {
		// The probe only exercises the search itself; tool-call updates and an extension context have no meaning here.
		const result = await tool.execute("gui-test-web-search", { query }, signal, undefined, undefined as never);
		return { ok: true, latencyMs: Date.now() - started, resultCount: result.details?.results.length ?? 0 };
	} catch (error: unknown) {
		return { ok: false, message: errorMessage(error) };
	}
}

/** Look up a server by name in the global `mcp.json` and, for a trusted project, the project one. */
function findMcpServer(ctx: GuiContext, name: string, cwd: string): McpServerConfig | undefined {
	const { servers } = loadMcpConfig({ agentDir: ctx.agentDir, cwd, projectTrusted: isProjectTrusted(ctx, cwd) });
	return servers.find((server) => server.name === name)?.config;
}

/** Transport for one server, resolving `${NAME}`/`!cmd` values like the MCP extension does. */
function createProbeTransport(name: string, config: McpServerConfig, cwd: string): McpTransport {
	if ("url" in config) {
		return new StreamableHttpTransport({
			url: config.url,
			headers: resolveHeadersOrThrow(config.headers, `MCP server "${name}"`),
		});
	}
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(config.env ?? {})) {
		env[key] = resolveConfigValueOrThrow(value, `MCP server "${name}" env "${key}"`);
	}
	return new StdioTransport({
		command: config.command,
		args: config.args,
		cwd: resolve(cwd, config.cwd ?? "."),
		env,
		stderr: "pipe",
	});
}

/** Connect, list the server's tools, and disconnect. */
export async function mcpTest(
	ctx: GuiContext,
	command: { name?: string; config?: McpServerConfig; cwd?: string },
): Promise<RpcMcpTestResult> {
	const cwd = command.cwd === undefined ? ctx.cwd : resolvePath(command.cwd);
	const name = command.name ?? "config";
	let config = command.config;
	if (config === undefined) {
		if (command.name === undefined) throw new Error("mcp_test needs a server name or a config");
		const found = findMcpServer(ctx, command.name, cwd);
		if (!found) throw new Error(`MCP server not found: ${command.name}`);
		config = found;
	}
	const validated = validateMcpServerConfig(name, config);
	if (typeof validated === "string") throw new Error(validated);

	const timeoutMs = (validated.timeout ?? DEFAULT_MCP_TIMEOUT_SECONDS) * 1000;
	const client = new McpClient({ name: APP_NAME, version: VERSION, requestTimeoutMs: timeoutMs });
	const started = Date.now();
	try {
		await client.connect(createProbeTransport(name, validated, cwd));
		const tools = await client.listTools({ timeoutMs });
		return {
			ok: true,
			latencyMs: Date.now() - started,
			tools: tools.map((tool) => ({
				name: tool.name,
				...(tool.description === undefined ? {} : { description: tool.description }),
			})),
		};
	} catch (error: unknown) {
		return { ok: false, message: errorMessage(error) };
	} finally {
		await client.close().catch(() => {});
	}
}
