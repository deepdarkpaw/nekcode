import { type JsonRpcRequest, LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import { describe, expect, it } from "vitest";
import { createMcpExtension } from "../../src/extensions/mcp/index.ts";
import { createNekExtension, DEFAULT_NEK_CONFIG } from "../../src/extensions/nek/index.ts";
import { createHarness, createTestUiContext } from "./harness.ts";

describe("RPC extension surfaces", () => {
	it("exposes nek state and control methods and emits state changes", async () => {
		const harness = await createHarness({
			extensionFactories: [createNekExtension({ role: "root", config: DEFAULT_NEK_CONFIG })],
		});
		const records: Array<{ name: string; payload: unknown }> = [];
		harness.session.resourceLoader.getExtensions().runtime.emitRpcEvent = (name, payload) =>
			records.push({ name, payload });
		await harness.session.bindExtensions({ mode: "rpc", uiContext: createTestUiContext() });

		const state = await harness.session.extensionRunner.callRpcHandler("nek.get_state", undefined);
		expect(state).toMatchObject({ mode: "agent", todos: [], plans: [], subagents: [] });
		const changed = await harness.session.extensionRunner.callRpcHandler("nek.set_mode", { mode: "plan" });
		expect(changed).toMatchObject({ mode: "plan" });
		expect(records.some((record) => record.name === "nek.state")).toBe(true);
		expect(await harness.session.extensionRunner.callRpcHandler("nek.list_agent_types", undefined)).toMatchObject({
			types: expect.arrayContaining([expect.objectContaining({ name: "explorer" })]),
		});
		await expect(
			harness.session.extensionRunner.callRpcHandler("nek.get_subagent_transcript", { id: "missing" }),
		).rejects.toThrow("Unknown subagent");
		harness.cleanup();
	});

	it("reports MCP status and reconnects through extension_call", async () => {
		const servers: Array<ReturnType<typeof createInMemoryTransportPair>["server"]> = [];
		const harness = await createHarness({
			extensionFactories: [
				createMcpExtension({
					loadConfig: () => ({
						servers: [{ name: "docs", scope: "global", source: "test", config: { command: "docs" } }],
						errors: [],
					}),
					createTransport: () => {
						const pair = createInMemoryTransportPair();
						servers.push(pair.server);
						pair.server.onMessage((message) => {
							if (!("id" in message) || !("method" in message)) return;
							const request = message as JsonRpcRequest;
							const result =
								request.method === "initialize"
									? {
											protocolVersion: LATEST_PROTOCOL_VERSION,
											capabilities: { tools: {} },
											serverInfo: { name: "docs", version: "1" },
										}
									: request.method === "tools/list"
										? { tools: [{ name: "search", inputSchema: { type: "object" } }] }
										: {};
							void pair.server.send({ jsonrpc: "2.0", id: request.id, result });
						});
						void pair.server.start();
						return pair.client;
					},
				}),
			],
		});
		const records: string[] = [];
		harness.session.resourceLoader.getExtensions().runtime.emitRpcEvent = (name) => records.push(name);
		await harness.session.bindExtensions({ mode: "rpc", uiContext: createTestUiContext() });
		const status = await harness.session.extensionRunner.callRpcHandler("mcp.status", undefined);
		expect(status).toMatchObject({ servers: [expect.objectContaining({ name: "docs", transport: "stdio" })] });
		const reconnected = await harness.session.extensionRunner.callRpcHandler("mcp.reconnect", { name: "docs" });
		expect(reconnected).toMatchObject({ server: { name: "docs", state: "connected", tools: [{ name: "search" }] } });
		expect(records).toContain("mcp.status_changed");
		harness.cleanup();
	});
});
