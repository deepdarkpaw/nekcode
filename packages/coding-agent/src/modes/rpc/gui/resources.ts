/** Workspace resource inspection and settings overrides, without loading extensions in the control process. */

import { isAbsolute, join } from "node:path";
import { CONFIG_DIR_NAME } from "../../../config.ts";
import type { ResourceDiagnostic } from "../../../core/diagnostics.ts";
import {
	DefaultPackageManager,
	type ResolvedPaths,
	type ResolvedResource,
	updateAutoResourceOverride,
} from "../../../core/package-manager.ts";
import { loadPromptTemplates } from "../../../core/prompt-templates.ts";
import { dedupeNamedResources } from "../../../core/resource-name-resolution.ts";
import { loadSkillCandidates, loadSkills, type Skill } from "../../../core/skills.ts";
import { canonicalizePath, getPathComparisonKey, pathsEqual } from "../../../utils/paths.ts";
import { type GuiWorkspace, resolveGuiWorkspace } from "./config.ts";
import type { GuiContext } from "./context.ts";
import type {
	RpcGuiCommand,
	RpcListResourcesResult,
	RpcReloadResult,
	RpcResourceInfo,
	RpcResourceType,
	RpcSetResourceEnabledResult,
} from "./protocol.ts";

async function resolveConfiguredResources(
	workspace: GuiWorkspace,
	diagnostics?: ResourceDiagnostic[],
): Promise<ResolvedPaths> {
	return new DefaultPackageManager(workspace).resolve(async (source) => {
		diagnostics?.push({ type: "warning", message: `Package is not installed as configured: ${source}` });
		return "skip";
	});
}

/** Resolve the skills a new session would load, without session-only arguments or extension hooks. */
export async function loadWorkspaceSkills(workspace: GuiWorkspace): Promise<Skill[]> {
	const { skills } = await resolveConfiguredResources(workspace);
	return loadSkills({
		cwd: workspace.cwd,
		agentDir: workspace.agentDir,
		skillPaths: skills.filter((resource) => resource.enabled).map((resource) => resource.path),
		includeDefaults: false,
	}).skills;
}

function validateResourceType(resourceType: RpcResourceType): void {
	if (resourceType !== "skills" && resourceType !== "prompts") {
		throw new Error('resourceType must be "skills" or "prompts"');
	}
}

interface ResourceInput {
	resource: ResolvedResource;
	active: boolean;
}

/** Active inputs are ordered like the session loader; disabled inputs are still available for inspection. */
function resourceInputs(
	workspace: GuiWorkspace,
	resourceType: RpcResourceType,
	configured: ResolvedResource[],
): ResourceInput[] {
	const session = workspace.session?.resourceLoader.getSessionResourceInputs?.(resourceType);
	const inputs = [
		...(session?.beforeSettings ?? []).map((resource) => ({ resource, active: resource.enabled })),
		...configured.map((resource) => ({ resource, active: resource.enabled && (session?.loadConfigured ?? true) })),
		...(session?.afterSettings ?? []).map((resource) => ({ resource, active: resource.enabled })),
	];
	return [...inputs.filter((input) => input.active), ...inputs.filter((input) => !input.active)];
}

function readResource(workspace: GuiWorkspace, resourceType: RpcResourceType, path: string) {
	const options = { cwd: workspace.cwd, agentDir: workspace.agentDir, includeDefaults: false };
	if (resourceType === "skills") {
		const { skills, diagnostics } = loadSkillCandidates({ ...options, skillPaths: [path] });
		return { candidates: skills, diagnostics };
	}
	const { templates, diagnostics } = loadPromptTemplates({ ...options, promptPaths: [path] });
	return { candidates: templates, diagnostics };
}

async function inspectResources(
	workspace: GuiWorkspace,
	resourceType: RpcResourceType,
): Promise<RpcListResourcesResult> {
	const diagnostics: ResourceDiagnostic[] = [];
	if (!workspace.session) {
		for (const { path, error } of workspace.settingsManager.drainErrors()) {
			diagnostics.push({ type: "error", message: error.message, path });
		}
	}
	const resolved = await resolveConfiguredResources(workspace, diagnostics);
	const resources = new Map<string, RpcResourceInfo>();
	const active: Array<{ name: string; filePath: string }> = [];
	for (const { resource, active: isActive } of resourceInputs(workspace, resourceType, resolved[resourceType])) {
		const loaded = readResource(workspace, resourceType, resource.path);
		for (const diagnostic of loaded.diagnostics) diagnostics.push(diagnostic);
		const { source, scope: sourceScope, origin } = resource.metadata;
		const scope = origin === "top-level" && source === "auto" ? sourceScope : "temporary";
		for (const { name, description, filePath } of loaded.candidates) {
			const key = getPathComparisonKey(canonicalizePath(filePath));
			const existing = resources.get(key);
			if (existing) {
				// A session-only source can keep a file loaded despite its settings override.
				if (isActive && scope === "temporary") existing.toggleable = false;
				continue;
			}
			if (isActive) active.push({ name, filePath });
			resources.set(key, {
				resourceType,
				name,
				description,
				path: filePath,
				scope,
				source,
				enabled: resource.enabled,
				toggleable: scope !== "temporary",
			});
		}
	}
	const collisions = dedupeNamedResources(active, resourceType === "skills" ? "skill" : "prompt").diagnostics;
	return {
		resources: [...resources.values()],
		diagnostics: [...diagnostics, ...collisions].map(({ type, message, path }) => ({ type, message, path })),
		projectTrusted: workspace.settingsManager.isProjectTrusted(),
	};
}

export function listResources(
	ctx: GuiContext,
	cwd: string | undefined,
	resourceType: RpcResourceType,
): Promise<RpcListResourcesResult> {
	validateResourceType(resourceType);
	return inspectResources(resolveGuiWorkspace(ctx, cwd), resourceType);
}

/** Persist a single exact override, then read back its resolved state. */
export async function setResourceEnabled(
	ctx: GuiContext,
	command: Extract<RpcGuiCommand, { type: "set_resource_enabled" }>,
	reload: () => Promise<RpcReloadResult>,
): Promise<RpcSetResourceEnabledResult> {
	const { cwd, resourceType, path, enabled } = command;
	validateResourceType(resourceType);
	if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
	if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
		throw new Error("path must be an absolute path returned by list_resources");
	}
	const workspace = resolveGuiWorkspace(ctx, cwd);
	const findResource = ({ resources }: RpcListResourcesResult) =>
		resources.find((resource) => pathsEqual(resource.path, path));
	const resource = findResource(await inspectResources(workspace, resourceType));
	if (!resource) throw new Error(`Resource not found for this workspace: ${path}`);
	if (!resource.toggleable) throw new Error(`Resource is not toggleable: ${resource.path}`);

	const settingsScope = resource.scope === "user" ? "global" : "project";
	const baseDir = settingsScope === "global" ? ctx.agentDir : join(workspace.cwd, CONFIG_DIR_NAME);
	await workspace.settingsManager.updateResourcePaths(settingsScope, resourceType, (current) =>
		updateAutoResourceOverride(resource.path, current, baseDir, enabled),
	);
	const result = findResource(await listResources(ctx, cwd, resourceType));
	if (!result) throw new Error(`Resource no longer found after updating settings: ${resource.path}`);
	if (ctx.session && (settingsScope === "global" || workspace.session)) await reload();
	return { settingsScope, enabled: result.enabled };
}
