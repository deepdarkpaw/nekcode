/** GUI command acceptance through the real dispatcher and a faux-backed session; external IO is local or intercepted. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuthEvent, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { LATEST_PROTOCOL_VERSION } from "@earendil-works/pi-mcp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createGuiContext, type GuiContext } from "../../src/modes/rpc/gui/context.ts";
import { createGuiDeps, handleGuiCommand } from "../../src/modes/rpc/gui/handlers.ts";
import type { RpcGuiCommand, RpcGuiResponseData } from "../../src/modes/rpc/gui/protocol.ts";
import { createUiRequester } from "../../src/modes/rpc/gui/ui-requests.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("GUI RPC faux acceptance", () => {
	let root: string;
	let harness: Harness;
	let ctx: GuiContext;
	let records: Array<Record<string, unknown>>;
	let busy: boolean;

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "nek-rpc-acceptance-"));
		harness = await createHarness({
			sessionManager: SessionManager.create(root, join(root, "sessions")),
			settings: { sessionDir: join(root, "sessions") },
			responses: [fauxAssistantMessage("Faux acceptance response")],
		});
		records = [];
		busy = false;
		ctx = createGuiContext({
			mode: "session",
			cwd: root,
			agentDir: root,
			settingsManager: harness.settingsManager,
			modelRuntime: harness.session.modelRuntime,
			session: harness.session,
			emit: (record) => records.push(record as Record<string, unknown>),
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await harness.session.dispose();
		harness.cleanup();
		rmSync(root, { recursive: true, force: true });
	});

	async function request<T extends RpcGuiCommand["type"]>(
		command: Extract<RpcGuiCommand, { type: T }>,
	): Promise<RpcGuiResponseData[T]> {
		const response = await handleGuiCommand(
			{ id: "acceptance", ...command },
			ctx,
			createGuiDeps(
				() => ctx,
				() => busy,
			),
		);
		expect(response).toMatchObject({ type: "response", id: "acceptance", command: command.type, success: true });
		if (!response?.success || !("data" in response)) throw new Error(JSON.stringify(response));
		return response.data as RpcGuiResponseData[T];
	}

	it("answers runtime, catalog, mention, tool and auth queries with a faux session", async () => {
		expect(await request({ type: "get_info" })).toMatchObject({
			mode: "session",
			protocolVersion: 1,
			agentDir: root,
		});
		expect((await request({ type: "get_changelog" })).markdown.length).toBeGreaterThan(0);
		expect(await request({ type: "validate_config" })).toEqual({ diagnostics: [] });
		expect((await request({ type: "get_mention_targets" })).targets).toEqual(
			expect.arrayContaining([expect.objectContaining({ kind: "agent", name: "explorer" })]),
		);
		expect((await request({ type: "list_builtin_tools" })).tools).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "read", defaultActive: true })]),
		);
		expect((await request({ type: "auth_status" })).providers).toEqual(
			expect.arrayContaining([expect.objectContaining({ provider: harness.getModel().provider, state: "ok" })]),
		);
		expect((await request({ type: "get_model_catalog", provider: harness.getModel().provider })).models).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: harness.getModel().id })]),
		);
	});

	it("reports invalid configuration diagnostics rather than hiding them", async () => {
		writeFileSync(join(root, "models.json"), "{ invalid");
		expect((await request({ type: "validate_config" })).diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ file: join(root, "models.json"), severity: "error" })]),
		);
	});

	it("reloads immediately and defers a busy reload until the faux turn settles", async () => {
		const reload = vi.spyOn(harness.session, "reload");
		const deps = createGuiDeps(
			() => ctx,
			() => busy,
		);
		expect(await handleGuiCommand({ type: "reload" }, ctx, deps)).toMatchObject({
			success: true,
			data: { deferred: false, diagnostics: [] },
		});
		expect(reload).toHaveBeenCalledTimes(1);
		busy = true;
		for (let i = 0; i < 2; i++) {
			expect(await handleGuiCommand({ type: "reload" }, ctx, deps)).toMatchObject({
				success: true,
				data: { deferred: true },
			});
		}
		expect(reload).toHaveBeenCalledTimes(1);
		await harness.session.prompt("Settle the pending reload");
		await vi.waitFor(() => expect(reload).toHaveBeenCalledTimes(2));
	});

	it("lists, snapshots, renames, imports and deletes a faux-generated session", async () => {
		await harness.session.prompt("Persist this faux conversation");
		await harness.sessionManager.flush();
		const source = harness.sessionManager.getSessionFile();
		if (!source) throw new Error("Missing persisted session");
		expect((await request({ type: "list_sessions", all: true })).sessions).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: source, firstMessage: "Persist this faux conversation", locked: true }),
			]),
		);
		const snapshot = await request({ type: "read_session_snapshot", sessionPath: source });
		expect(JSON.stringify(snapshot.messages)).toContain("Faux acceptance response");
		const exported = await request({
			type: "export_session",
			format: "jsonl",
			outputPath: join(root, "source.jsonl"),
		});
		const imported = await request({ type: "import_session", inputPath: exported.path, cwd: root });
		expect(imported.sessionPath).not.toBe(source);
		await request({ type: "rename_session", sessionPath: imported.sessionPath, name: "Imported faux" });
		expect((await request({ type: "read_session_snapshot", sessionPath: imported.sessionPath })).session.name).toBe(
			"Imported faux",
		);
		await request({ type: "delete_session", sessionPath: imported.sessionPath });
		expect(existsSync(imported.sessionPath)).toBe(false);
		expect(existsSync(source)).toBe(true);
	});

	it("exports both formats, labels entries and navigates a faux conversation", async () => {
		await harness.session.prompt("First branch");
		const leaf = harness.sessionManager.getLeafId();
		if (!leaf) throw new Error("Missing leaf");
		await request({ type: "set_entry_label", entryId: leaf, label: "checkpoint" });
		expect(harness.sessionManager.getLabel(leaf)).toBe("checkpoint");
		for (const format of ["jsonl", "html"] as const) {
			const outputPath = join(root, `export.${format}`);
			expect(await request({ type: "export_session", format, outputPath })).toEqual({ path: outputPath });
			const output = readFileSync(outputPath, "utf8");
			const data =
				format === "html"
					? Buffer.from(
							output.match(/<script id="session-data" type="application\/json">([^<]+)<\/script>/)?.[1] ?? "",
							"base64",
						).toString("utf8")
					: output;
			expect(data).toContain("Faux acceptance response");
		}
		harness.setResponses([fauxAssistantMessage("Second branch")]);
		await harness.session.prompt("Second input");
		expect(await request({ type: "navigate_tree", entryId: leaf })).toMatchObject({ cancelled: false });
		expect(harness.sessionManager.getLeafId()).toBe(leaf);
		await request({ type: "set_entry_label", entryId: leaf });
		expect(harness.sessionManager.getLabel(leaf)).toBeUndefined();
	});

	it("shares a faux transcript through an intercepted artifact upload", async () => {
		await harness.session.prompt("Share this faux transcript");
		const runtime = harness.session.modelRuntime;
		vi.spyOn(runtime, "getAuth").mockResolvedValue({ auth: { apiKey: "fake-artifact-token" }, source: "stored" });
		const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
			expect(String(url)).toContain("/v1/artifacts");
			expect(init?.method).toBe("POST");
			expect(String(init?.body)).toContain("Faux acceptance response");
			return Response.json({ artifact: { canonical_url: "https://share.example.test/faux" } });
		});
		expect(await request({ type: "share_session" })).toEqual({ url: "https://share.example.test/faux" });
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("persists project trust decisions and reports discovered resources", async () => {
		mkdirSync(join(root, ".nek"));
		writeFileSync(join(root, ".nek", "settings.json"), "{}");
		expect(await request({ type: "get_project_trust", cwd: root })).toMatchObject({
			trusted: null,
			resources: [expect.objectContaining({ kind: "settings" })],
		});
		for (const trusted of [true, false]) {
			await request({ type: "set_project_trust", cwd: root, trusted });
			expect(await request({ type: "get_project_trust", cwd: root })).toMatchObject({ trusted });
		}
	});

	it("tests the faux provider and dispatches model discovery without a model API", async () => {
		expect(
			await request({
				type: "test_provider",
				provider: harness.getModel().provider,
				modelId: harness.getModel().id,
			}),
		).toMatchObject({ ok: true });
		expect(harness.getPendingResponseCount()).toBe(0);
		const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ data: [{ id: "local-model" }] }));
		expect(
			await request({
				type: "fetch_provider_models",
				draft: { api: "openai-completions", baseUrl: "https://catalog.example.test/v1" },
			}),
		).toMatchObject({
			ok: true,
			models: [{ id: "local-model" }],
		});
		expect(fetch).toHaveBeenCalledTimes(1);
	});

	it("round-trips login prompts, auth events and logout with a faux auth method", async () => {
		const runtime = harness.session.modelRuntime;
		const provider = runtime.getProvider(harness.getModel().provider);
		if (!provider) throw new Error("Missing faux provider");
		const events: AuthEvent[] = [
			{ type: "info", message: "Local sign in", links: [{ url: "https://auth.example.test" }] },
			{ type: "auth_url", url: "https://auth.example.test" },
			{ type: "device_code", userCode: "FAUX", verificationUri: "https://auth.example.test" },
			{ type: "progress", message: "Waiting" },
		];
		runtime.registerNativeProvider({
			...provider,
			auth: {
				apiKey: {
					name: "Faux key",
					login: async (interaction) => {
						for (const event of events) interaction.notify(event);
						const key = await interaction.prompt({
							type: "secret",
							message: "Faux key",
							signal: interaction.signal,
						});
						return { type: "api_key", key };
					},
					check: async ({ credential }) => (credential ? { type: "api_key", source: "stored" } : undefined),
					resolve: async ({ credential }) =>
						credential ? { auth: { apiKey: credential.key }, source: "stored" } : undefined,
				},
			},
		});
		const ui = createUiRequester((record) => records.push(record as Record<string, unknown>));
		ctx = { ...ctx, requestStructured: ui.requestStructured };
		const login = request({ type: "auth_login", provider: provider.id, method: "api_key" });
		await vi.waitFor(() => expect(records).toContainEqual(expect.objectContaining({ kind: "auth.prompt" })));
		const dialog = records.find((record) => "kind" in record) as { id: string };
		ui.respond({ type: "extension_ui_response", id: dialog.id, result: { value: "faux-login-key" } });
		await login;
		expect(await harness.authStorage.read(provider.id)).toEqual({ type: "api_key", key: "faux-login-key" });
		for (const event of events) expect(records).toContainEqual({ type: "auth_event", provider: provider.id, event });
		await request({ type: "auth_logout", provider: provider.id });
		expect(await harness.authStorage.read(provider.id)).toBeUndefined();
		const command: RpcGuiCommand = { type: "auth_login", provider: provider.id };
		const cancelled = handleGuiCommand(
			command,
			ctx,
			createGuiDeps(
				() => ctx,
				() => false,
			),
		);
		await vi.waitFor(() => expect(records.filter((record) => "kind" in record)).toHaveLength(2));
		const dialogs = records.filter((record) => "kind" in record) as Array<{ id: string }>;
		ui.respond({ type: "extension_ui_response", id: dialogs[1].id, cancelled: true });
		expect(await cancelled).toMatchObject({ success: false, error: expect.stringContaining("Login cancelled") });
	});

	it("probes web search and MCP with intercepted JSON-RPC transports", async () => {
		harness.settingsManager.applyOverrides({ webSearch: { provider: "exa" } });
		const calls: string[] = [];
		vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
			if (init?.method === "DELETE") return new Response(null, { status: 204 });
			if (init?.method === "GET") return new Response(null, { status: 405 });
			const message = JSON.parse(String(init?.body)) as { id?: number; method: string };
			calls.push(message.method);
			if (message.id === undefined) return new Response(null, { status: 202 });
			const result =
				message.method === "initialize"
					? {
							protocolVersion: LATEST_PROTOCOL_VERSION,
							capabilities: { tools: {} },
							serverInfo: { name: "local", version: "1" },
						}
					: message.method === "tools/list"
						? { tools: [{ name: "search", description: "Local search", inputSchema: { type: "object" } }] }
						: { content: [{ type: "text", text: "Title: Faux result\nURL: https://result.example.test" }] };
			return Response.json({ jsonrpc: "2.0", id: message.id, result });
		});
		expect(await request({ type: "mcp_test", config: { url: "https://mcp.example.test" } })).toMatchObject({
			ok: true,
			tools: [{ name: "search" }],
		});
		expect(await request({ type: "test_web_search", query: "faux acceptance" })).toMatchObject({
			ok: true,
			resultCount: 1,
		});
		expect(calls).toContain("tools/call");
		vi.mocked(globalThis.fetch).mockRejectedValue(new Error("Local transport failed"));
		expect(await request({ type: "mcp_test", config: { url: "https://mcp.example.test" } })).toMatchObject({
			ok: false,
			message: expect.stringContaining("Local transport failed"),
		});
		expect(await request({ type: "test_web_search", query: "failure" })).toMatchObject({
			ok: false,
			message: "Exa web search connection failed.",
		});
	});
});
