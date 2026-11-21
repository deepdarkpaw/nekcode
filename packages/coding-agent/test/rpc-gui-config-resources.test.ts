/** Workspace resource and model-scope RPCs through both dispatchers, without provider requests. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";
import { handleControlCommand } from "../src/modes/rpc/control-mode.ts";
import { createGuiContext, type GuiContext } from "../src/modes/rpc/gui/context.ts";
import { createGuiDeps, type GuiDeps, handleGuiCommand } from "../src/modes/rpc/gui/handlers.ts";
import type { RpcGuiCommand, RpcGuiResponseData } from "../src/modes/rpc/gui/protocol.ts";

function write(path: string, content: string): string {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
	return path;
}

function skill(path: string, name: string): string {
	return write(path, `---\nname: ${name}\ndescription: Description of ${name}\n---\n`);
}

function saveSettings(dir: string, settings: Settings): string {
	return write(join(dir, "settings.json"), JSON.stringify(settings));
}

const controlDeps: GuiDeps = {
	reload: async () => {
		throw new Error("A control resource edit must not reload a session");
	},
};

async function request<T extends RpcGuiCommand["type"]>(
	ctx: GuiContext,
	command: Extract<RpcGuiCommand, { type: T }>,
	deps = controlDeps,
): Promise<RpcGuiResponseData[T]> {
	const input = { id: "fixture", ...command };
	const response = ctx.session
		? await handleGuiCommand(input, ctx, deps)
		: await handleControlCommand(input, ctx, deps);
	expect(response).toMatchObject({ id: "fixture", type: "response", command: command.type, success: true });
	if (!response || !("data" in response)) throw new Error(JSON.stringify(response));
	return response.data as RpcGuiResponseData[T];
}

async function makeModelRuntime(): Promise<ModelRuntime> {
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	for (const [provider, ids, apiKey] of [
		["fixture-a", ["fixture-shared", "fixture-alpha"], "fixture-key"],
		["fixture-b", ["fixture-shared"], "fixture-key"],
		["fixture-noauth", ["fixture-private"], undefined],
	] as const) {
		runtime.registerProvider(provider, {
			baseUrl: "http://127.0.0.1:1/v1",
			api: "openai-completions",
			apiKey,
			models: ids.map((id) => ({
				id,
				name: id,
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 100_000,
				maxTokens: 4096,
			})),
		});
	}
	await runtime.refresh({ allowNetwork: false });
	return runtime;
}

describe("workspace configuration RPC", () => {
	let root: string;
	let agentDir: string;
	let cwd: string;
	let projectDir: string;
	let session: AgentSession | undefined;

	beforeEach(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "nek-config-rpc-")));
		agentDir = join(root, "agent");
		cwd = join(root, "project");
		projectDir = join(cwd, ".nek");
		mkdirSync(cwd, { recursive: true });
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		rmSync(root, { recursive: true, force: true });
	});

	function control(modelRuntime = {} as ModelRuntime): GuiContext {
		return createGuiContext({
			mode: "control",
			cwd: root,
			agentDir,
			settingsManager: SettingsManager.create(root, agentDir, { projectTrusted: false }),
			modelRuntime,
			emit: () => {},
		});
	}

	async function sessionContext(options: { trusted: boolean; cliSkill?: string; extensionSkill?: string }) {
		const modelRuntime = await makeModelRuntime();
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: options.trusted });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			additionalSkillPaths: options.cliSkill ? [options.cliSkill] : [],
			extensionFactories: [
				(pi) => {
					pi.on("resources_discover", () => ({
						skillPaths: options.extensionSkill ? [options.extensionSkill] : [],
					}));
				},
			],
		});
		await resourceLoader.reload();
		const created = await createAgentSession({
			cwd,
			agentDir,
			model: modelRuntime.getModel("fixture-a", "fixture-alpha"),
			modelRuntime,
			settingsManager,
			resourceLoader,
			sessionManager: SessionManager.inMemory(cwd),
		});
		session = created.session;
		await session.bindExtensions({
			mode: "rpc",
			onError: ({ error }) => {
				throw new Error(error);
			},
		});
		const ctx = createGuiContext({
			mode: "session",
			cwd,
			agentDir,
			settingsManager,
			modelRuntime,
			session,
			emit: () => {},
		});
		return {
			ctx,
			deps: createGuiDeps(
				() => ctx,
				() => false,
			),
			resourceLoader,
		};
	}

	it("lists disabled, explicit and package skills and matches a session's completion rules", async () => {
		const user = skill(join(agentDir, "skills", "shared", "SKILL.md"), "shared");
		const project = skill(join(projectDir, "skills", "singleton.md"), "shared");
		const ignored = skill(join(agentDir, "skills", "ignored", "SKILL.md"), "ignored");
		const invalid = write(join(agentDir, "skills", "broken", "SKILL.md"), "No description\n");
		const external = skill(join(root, "extra", "external", "SKILL.md"), "external");
		const packageDir = join(root, "package");
		const packaged = skill(join(packageDir, "skills", "packaged", "SKILL.md"), "packaged");
		const packageDisabled = skill(join(packageDir, "skills", "package-off", "SKILL.md"), "package-off");
		const packageSource = "../package";
		skill(join(cwd, ".agents", "skills", "legacy", "SKILL.md"), "legacy");
		saveSettings(agentDir, {
			skills: ["!skills/ignored", "../extra"],
			packages: [{ source: packageSource, skills: ["packaged"] }],
		});
		saveSettings(projectDir, { skills: [`-${user.replaceAll("\\", "/")}`] }); // Cannot override a user skill from this scope.
		new ProjectTrustStore(agentDir).set(cwd, true);
		const ctx = control();

		const listed = await request(ctx, { type: "list_resources", resourceType: "skills", cwd });
		expect(listed.projectTrusted).toBe(true);
		expect(listed.resources).toHaveLength(6);
		expect(listed.resources).toEqual(
			expect.arrayContaining([
				{
					resourceType: "skills",
					path: project,
					name: "shared",
					description: "Description of shared",
					scope: "project",
					source: "auto",
					enabled: true,
					toggleable: true,
				},
				{
					resourceType: "skills",
					path: user,
					name: "shared",
					description: "Description of shared",
					scope: "user",
					source: "auto",
					enabled: true,
					toggleable: true,
				},
				expect.objectContaining({ path: ignored, enabled: false, toggleable: true }),
				expect.objectContaining({
					path: external,
					scope: "temporary",
					source: "local",
					enabled: true,
					toggleable: false,
				}),
				expect.objectContaining({
					path: packaged,
					scope: "temporary",
					source: packageSource,
					enabled: true,
					toggleable: false,
				}),
				expect.objectContaining({
					path: packageDisabled,
					scope: "temporary",
					source: packageSource,
					enabled: false,
					toggleable: false,
				}),
			]),
		);
		expect(listed.diagnostics).toEqual([
			{ type: "warning", path: invalid, message: expect.any(String) },
			{ type: "collision", path: user, message: 'name "shared" collision' },
		]);
		const { ctx: live } = await sessionContext({ trusted: true });
		const controlTargets = (await request(ctx, { type: "get_mention_targets", cwd })).targets;
		const liveTargets = (await request(live, { type: "get_mention_targets" })).targets;
		expect(controlTargets).toEqual(liveTargets);
		expect(controlTargets.filter(({ kind }) => kind === "skill").map(({ location }) => location)).toEqual([
			project,
			external,
			packaged,
		]);
		const command = { type: "set_resource_enabled", resourceType: "skills", cwd, path: packaged, enabled: false };
		const forbidden = await handleControlCommand(command, ctx, controlDeps);
		expect(forbidden).toMatchObject({ success: false, error: expect.stringContaining("not toggleable") });
	});

	it("round-trips an exact user skill override without growing the rules", async () => {
		const path = skill(join(agentDir, "skills", "review", "SKILL.md"), "review");
		const settingsPath = saveSettings(agentDir, {
			skills: ["!skills/*", "-./skills/review", "-skills/review/SKILL.md"],
			prompts: ["elsewhere"],
		});
		const ctx = control();
		const toggle = (enabled: boolean) =>
			request(ctx, { type: "set_resource_enabled", cwd, resourceType: "skills", path, enabled });
		const readSettings = () => JSON.parse(readFileSync(settingsPath, "utf8"));
		expect(await toggle(true)).toEqual({ settingsScope: "global", enabled: true });
		expect(readSettings()).toEqual({ skills: ["!skills/*", "+skills/review/SKILL.md"], prompts: ["elsewhere"] });
		for (let i = 0; i < 2; i++) {
			expect(await toggle(false)).toEqual({ settingsScope: "global", enabled: false });
		}
		expect(readSettings().skills).toEqual(["!skills/*", "+skills/review/SKILL.md", "-skills/review/SKILL.md"]);
		expect((await request(ctx, { type: "list_resources", cwd, resourceType: "skills" })).resources[0].enabled).toBe(
			false,
		);
		expect(await toggle(true)).toEqual({ settingsScope: "global", enabled: true });
		expect(readSettings().skills).toEqual(["!skills/*", "+skills/review/SKILL.md"]);
	});

	it("rejects untrusted project writes, then persists only the trusted project's prompt array", async () => {
		const path = write(
			join(projectDir, "prompts", "review.md"),
			"---\ndescription: Review a change\n---\nDetails.\n",
		);
		const projectSettings = saveSettings(projectDir, { quietStartup: true });
		const globalSettings = saveSettings(agentDir, { prompts: ["!prompts/*"] });
		const ctx = control();
		const list = () => request(ctx, { type: "list_resources", cwd, resourceType: "prompts" });
		const command = { type: "set_resource_enabled", cwd, resourceType: "prompts", path, enabled: false } as const;
		expect(await list()).toEqual({ resources: [], diagnostics: [], projectTrusted: false });
		expect(await handleControlCommand(command, ctx, controlDeps)).toMatchObject({
			success: false,
			error: expect.stringContaining("Resource not found"),
		});
		expect(JSON.parse(readFileSync(projectSettings, "utf8"))).toEqual({ quietStartup: true });

		await request(ctx, { type: "set_project_trust", cwd, trusted: true });
		expect(await list()).toEqual({
			resources: [
				{
					resourceType: "prompts",
					name: "review",
					description: "Review a change",
					path,
					scope: "project",
					source: "auto",
					enabled: true,
					toggleable: true,
				},
			],
			diagnostics: [],
			projectTrusted: true,
		});
		expect(await request(ctx, command)).toEqual({ settingsScope: "project", enabled: false });
		expect(JSON.parse(readFileSync(projectSettings, "utf8"))).toEqual({
			quietStartup: true,
			prompts: ["-prompts/review.md"],
		});
		expect(await request(ctx, { ...command, enabled: true })).toEqual({ settingsScope: "project", enabled: true });
		expect(JSON.parse(readFileSync(projectSettings, "utf8"))).toEqual({ quietStartup: true, prompts: [] });
		expect(JSON.parse(readFileSync(globalSettings, "utf8"))).toEqual({ prompts: ["!prompts/*"] });
	});

	it("preserves distinct overrides when control requests overlap", async () => {
		const paths = ["one", "two"].map((name) => write(join(agentDir, "prompts", `${name}.md`), name));
		const replies = await Promise.all(
			paths.map((path) =>
				request(control(), { type: "set_resource_enabled", resourceType: "prompts", path, enabled: false }),
			),
		);
		expect(replies).toEqual(paths.map(() => ({ settingsScope: "global", enabled: false })));
		const { prompts } = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		expect([...prompts].sort()).toEqual(["-prompts/one.md", "-prompts/two.md"]);
	});

	it("does not overwrite malformed settings when a resource is toggled", async () => {
		const path = skill(join(agentDir, "skills", "review", "SKILL.md"), "review");
		const settingsPath = write(join(agentDir, "settings.json"), "{invalid");
		const ctx = control();
		expect((await request(ctx, { type: "list_resources", resourceType: "skills" })).diagnostics).toEqual([
			{ type: "error", message: expect.any(String), path: settingsPath },
		]);
		const command = { type: "set_resource_enabled", resourceType: "skills", path, enabled: false };
		expect(await handleControlCommand(command, ctx, controlDeps)).toMatchObject({ success: false });
		expect(readFileSync(settingsPath, "utf8")).toBe("{invalid");
	});

	it("uses the live session's trust and resources and reloads after a session edit", async () => {
		const project = skill(join(projectDir, "skills", "local", "SKILL.md"), "local");
		const cliSkill = skill(join(root, "cli", "SKILL.md"), "cli");
		const extensionSkill = skill(join(root, "extension", "SKILL.md"), "extension");
		new ProjectTrustStore(agentDir).set(cwd, false);
		const { ctx, deps, resourceLoader } = await sessionContext({ trusted: true, cliSkill, extensionSkill });
		const list = () => request(ctx, { type: "list_resources", resourceType: "skills", cwd });
		expect(await list()).toMatchObject({
			projectTrusted: true,
			resources: [
				{ path: project, scope: "project", enabled: true, toggleable: true },
				{ path: cliSkill, scope: "temporary", source: "cli", enabled: true, toggleable: false },
				{
					path: extensionSkill,
					scope: "temporary",
					source: "extension:inline:1",
					enabled: true,
					toggleable: false,
				},
			],
		});
		const command = { type: "set_resource_enabled", resourceType: "skills", path: project, enabled: false } as const;
		expect(await request(ctx, command, deps)).toEqual({ settingsScope: "project", enabled: false });
		expect(resourceLoader.getSkills().skills.map(({ filePath }) => filePath)).toEqual([cliSkill, extensionSkill]);
		expect((await list()).resources.find(({ path }) => path === project)).toMatchObject({ enabled: false });
		expect(await request(ctx, { ...command, enabled: true }, deps)).toEqual({
			settingsScope: "project",
			enabled: true,
		});
		expect(resourceLoader.getSkills().skills.map(({ filePath }) => filePath)).toEqual([
			project,
			cliSkill,
			extensionSkill,
		]);
	});

	it("does not offer a toggle when an explicit session path keeps the resource loaded", async () => {
		const path = skill(join(agentDir, "skills", "forced", "SKILL.md"), "forced");
		const { ctx, deps } = await sessionContext({ trusted: true, cliSkill: path });
		const { resources } = await request(ctx, { type: "list_resources", resourceType: "skills" });
		expect(resources).toMatchObject([{ path, source: "auto", enabled: true, toggleable: false }]);
		const command = { type: "set_resource_enabled", resourceType: "skills", path, enabled: false };
		expect(await handleGuiCommand(command, ctx, deps)).toMatchObject({
			success: false,
			error: expect.stringContaining("not toggleable"),
		});
	});

	it("uses the control model snapshot and trusted effective enabledModels", async () => {
		const globalPatterns = ["fixture-a/fixture-alpha:high"];
		const projectPatterns = ["fixture-b/*:low", "fixture-shared", "fixture-a/fixture-alpha:bogus", "fixture-private"];
		saveSettings(agentDir, { enabledModels: globalPatterns });
		saveSettings(projectDir, { enabledModels: projectPatterns });
		const ctx = control(await makeModelRuntime());
		const {
			data: { models: available },
		} = (await handleControlCommand({ type: "get_available_models" }, ctx, controlDeps)) as {
			data: { models: readonly Model<Api>[] };
		};
		const scope = () => request(ctx, { type: "get_model_scope", cwd });
		expect(await scope()).toEqual({
			patterns: globalPatterns,
			models: [{ provider: "fixture-a", id: "fixture-alpha", thinkingLevel: "high" }],
			diagnostics: [],
		});
		await request(ctx, { type: "set_project_trust", cwd, trusted: true });
		const result = await scope();
		expect(result.patterns).toEqual(projectPatterns);
		expect(result.models).toEqual([
			{ provider: "fixture-b", id: "fixture-shared", thinkingLevel: "low" },
			{ provider: "fixture-a", id: "fixture-shared" },
			{ provider: "fixture-a", id: "fixture-alpha" },
		]);
		for (const { provider, id } of result.models)
			expect(available.some((model) => model.provider === provider && model.id === id)).toBe(true);
		expect(result.diagnostics).toEqual([
			{ code: "ambiguous", pattern: "fixture-shared", message: expect.any(String) },
			{ code: "invalid-thinking-level", pattern: "fixture-a/fixture-alpha:bogus", message: expect.any(String) },
			{ code: "no-match", pattern: "fixture-private", message: expect.any(String) },
		]);
		saveSettings(projectDir, { enabledModels: [] });
		expect(await scope()).toEqual({ patterns: [], models: [], diagnostics: [] });
	});

	it("uses live session settings for its cwd and disk settings for another workspace", async () => {
		saveSettings(agentDir, { enabledModels: ["fixture-a/fixture-alpha"] });
		saveSettings(projectDir, { enabledModels: ["fixture-b/fixture-shared"] });
		const otherCwd = join(root, "other");
		saveSettings(join(otherCwd, ".nek"), { enabledModels: ["fixture-a/fixture-shared:medium"] });
		await request(control(), { type: "set_project_trust", cwd, trusted: true });
		await request(control(), { type: "set_project_trust", cwd: otherCwd, trusted: true });
		const path = skill(join(projectDir, "skills", "local", "SKILL.md"), "local");
		const { ctx, deps } = await sessionContext({ trusted: false });
		expect(await request(ctx, { type: "list_resources", resourceType: "skills", cwd })).toEqual({
			resources: [],
			diagnostics: [],
			projectTrusted: false,
		});
		const command = { type: "set_resource_enabled", cwd, resourceType: "skills", path, enabled: false };
		expect(await handleGuiCommand(command, ctx, deps)).toMatchObject({
			success: false,
			error: expect.stringContaining("Resource not found"),
		});
		expect(await request(ctx, { type: "get_model_scope", cwd })).toEqual({
			patterns: ["fixture-a/fixture-alpha"],
			models: [{ provider: "fixture-a", id: "fixture-alpha" }],
			diagnostics: [],
		});
		expect(await request(ctx, { type: "get_model_scope", cwd: otherCwd })).toEqual({
			patterns: ["fixture-a/fixture-shared:medium"],
			models: [{ provider: "fixture-a", id: "fixture-shared", thinkingLevel: "medium" }],
			diagnostics: [],
		});
	});
});
