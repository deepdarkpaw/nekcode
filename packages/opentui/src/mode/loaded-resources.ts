/**
 * Startup listing of loaded resources (context files, skills, prompts, extensions, themes) and their
 * diagnostics. Same output as the interactive mode's `showLoadedResources`.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent/core/agent-session";
import type { ResourceDiagnostic } from "@earendil-works/pi-coding-agent/core/resource-loader";
import type { SourceInfo } from "@earendil-works/pi-coding-agent/core/source-info";
import { type ThemeColor, theme } from "@earendil-works/pi-coding-agent/modes/interactive/theme/theme";
import { parseGitUrl } from "@earendil-works/pi-coding-agent/utils/git";
import { getCwdRelativePath } from "@earendil-works/pi-coding-agent/utils/paths";
import { type Container, Spacer, Text } from "@earendil-works/pi-tui";
import { ExpandableText } from "./expandable-text.ts";

type ResourceItem = { path: string; sourceInfo?: SourceInfo };
type ScopeGroup = {
	scope: "user" | "project" | "path";
	paths: ResourceItem[];
	packages: Map<string, ResourceItem[]>;
};

export interface LoadedResourcesOptions {
	session: AgentSession;
	/** Show the listing (not only diagnostics). */
	showListing: boolean;
	/** Show diagnostics. */
	showDiagnostics: boolean;
	/** Start sections expanded. */
	expanded: boolean;
	/** Extension diagnostics that only the frontend knows (built-in command conflicts). */
	extraExtensionDiagnostics: readonly ResourceDiagnostic[];
}

export function formatDisplayPath(p: string): string {
	const home = os.homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

function formatExtensionDisplayPath(p: string): string {
	return formatDisplayPath(p)
		.replace(/\/index\.ts$/, "")
		.replace(/\/index\.js$/, "");
}

function isPackageSource(sourceInfo?: SourceInfo): boolean {
	const source = sourceInfo?.source ?? "";
	return source.startsWith("npm:") || source.startsWith("git:");
}

function getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
	const normalizedFullPath = fullPath.replace(/\\/g, "/");
	const baseDir = sourceInfo?.baseDir;
	if (baseDir && isPackageSource(sourceInfo)) {
		const normalizedBaseDir = baseDir.replace(/\\/g, "/");
		const npmRootMatch = normalizedBaseDir.match(/^(.*\/node_modules)\/(@?[^/]+(?:\/[^/]+)?)$/);
		if (npmRootMatch?.[1] && normalizedFullPath.startsWith(`${npmRootMatch[1]}/`)) {
			return path.posix.relative(normalizedBaseDir, normalizedFullPath);
		}
		const relativePath = path.relative(path.resolve(baseDir), path.resolve(fullPath));
		if (
			relativePath &&
			relativePath !== "." &&
			!relativePath.startsWith("..") &&
			!relativePath.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relativePath)
		) {
			return relativePath.replace(/\\/g, "/");
		}
	}
	const source = sourceInfo?.source ?? "";
	const npmMatch = normalizedFullPath.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
	if (npmMatch?.[2] && source.startsWith("npm:")) return npmMatch[2];
	const gitMatch = normalizedFullPath.match(/git\/[^/]+\/[^/]+\/(.*)/);
	if (gitMatch?.[1] && source.startsWith("git:")) return gitMatch[1];
	return formatDisplayPath(fullPath);
}

function getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
	const shortPath = getShortPath(resourcePath, sourceInfo);
	const segments = shortPath
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== "~");
	return segments[segments.length - 1] ?? shortPath;
}

function getCompactPackageSourceLabel(sourceInfo?: SourceInfo): string {
	const source = sourceInfo?.source ?? "";
	if (source.startsWith("npm:")) return source.slice("npm:".length) || source;
	const gitSource = parseGitUrl(source);
	if (gitSource) return gitSource.path || source;
	return source;
}

function getCompactExtensionLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
	if (!isPackageSource(sourceInfo)) return getCompactPathLabel(resourcePath, sourceInfo);
	const sourceLabel = getCompactPackageSourceLabel(sourceInfo);
	if (!sourceLabel) return getCompactPathLabel(resourcePath, sourceInfo);
	const shortPath = getShortPath(resourcePath, sourceInfo).replace(/\\/g, "/");
	const packagePath = shortPath.startsWith("extensions/") ? shortPath.slice("extensions/".length) : shortPath;
	const parsedPath = path.posix.parse(packagePath);
	if (parsedPath.name === "index") {
		return !parsedPath.dir || parsedPath.dir === "." ? sourceLabel : `${sourceLabel}:${parsedPath.dir}`;
	}
	return `${sourceLabel}:${packagePath}`;
}

function getCompactDisplayPathSegments(resourcePath: string): string[] {
	return formatDisplayPath(resourcePath)
		.replace(/\\/g, "/")
		.split("/")
		.filter((segment) => segment.length > 0 && segment !== "~");
}

function getCompactNonPackageExtensionLabel(
	resourcePath: string,
	index: number,
	allPaths: Array<{ path: string; segments: string[] }>,
): string {
	const segments = allPaths[index]?.segments;
	if (!segments || segments.length === 0) return getCompactPathLabel(resourcePath);
	for (let segmentCount = 1; segmentCount <= segments.length; segmentCount += 1) {
		const candidate = segments.slice(-segmentCount).join("/");
		const isUnique = allPaths.every(
			(item, itemIndex) => itemIndex === index || item.segments.slice(-segmentCount).join("/") !== candidate,
		);
		if (isUnique) return candidate;
	}
	return segments.join("/");
}

function getCompactExtensionLabels(extensions: readonly ResourceItem[]): string[] {
	const nonPackageExtensions = extensions
		.map((extension) => {
			const segments = getCompactDisplayPathSegments(extension.path);
			const lastSegment = segments[segments.length - 1];
			if (segments.length > 1 && (lastSegment === "index.ts" || lastSegment === "index.js")) segments.pop();
			return { path: extension.path, sourceInfo: extension.sourceInfo, segments };
		})
		.filter((extension) => !isPackageSource(extension.sourceInfo));
	return extensions.map((extension) => {
		if (isPackageSource(extension.sourceInfo)) return getCompactExtensionLabel(extension.path, extension.sourceInfo);
		const nonPackageIndex = nonPackageExtensions.findIndex((item) => item.path === extension.path);
		if (nonPackageIndex === -1) return getCompactPathLabel(extension.path, extension.sourceInfo);
		return getCompactNonPackageExtensionLabel(extension.path, nonPackageIndex, nonPackageExtensions);
	});
}

function getDisplaySourceInfo(sourceInfo?: SourceInfo): { label: string; scopeLabel?: string } {
	const source = sourceInfo?.source ?? "local";
	const scope = sourceInfo?.scope ?? "project";
	if (source === "local") {
		if (scope === "user") return { label: "user" };
		if (scope === "project") return { label: "project" };
		if (scope === "temporary") return { label: "path", scopeLabel: "temp" };
		return { label: "path" };
	}
	if (source === "cli") return { label: "path", scopeLabel: scope === "temporary" ? "temp" : undefined };
	const scopeLabel =
		scope === "user" ? "user" : scope === "project" ? "project" : scope === "temporary" ? "temp" : undefined;
	return { label: source, scopeLabel };
}

function getScopeGroup(sourceInfo?: SourceInfo): "user" | "project" | "path" {
	const source = sourceInfo?.source ?? "local";
	const scope = sourceInfo?.scope ?? "project";
	if (source === "cli" || scope === "temporary") return "path";
	if (scope === "user") return "user";
	if (scope === "project") return "project";
	return "path";
}

function buildScopeGroups(items: readonly ResourceItem[]): ScopeGroup[] {
	const groups: Record<ScopeGroup["scope"], ScopeGroup> = {
		user: { scope: "user", paths: [], packages: new Map() },
		project: { scope: "project", paths: [], packages: new Map() },
		path: { scope: "path", paths: [], packages: new Map() },
	};
	for (const item of items) {
		const group = groups[getScopeGroup(item.sourceInfo)];
		const source = item.sourceInfo?.source ?? "local";
		if (isPackageSource(item.sourceInfo)) {
			const list = group.packages.get(source) ?? [];
			list.push(item);
			group.packages.set(source, list);
		} else {
			group.paths.push(item);
		}
	}
	return [groups.project, groups.user, groups.path].filter(
		(group) => group.paths.length > 0 || group.packages.size > 0,
	);
}

function formatScopeGroups(
	groups: readonly ScopeGroup[],
	formatPath: (item: ResourceItem) => string,
	formatPackagePath: (item: ResourceItem) => string,
): string {
	const lines: string[] = [];
	for (const group of groups) {
		lines.push(`  ${theme.fg("accent", group.scope)}`);
		for (const item of [...group.paths].sort((a, b) => a.path.localeCompare(b.path))) {
			lines.push(theme.fg("dim", `    ${formatPath(item)}`));
		}
		const sortedPackages = Array.from(group.packages.entries()).sort(([a], [b]) => a.localeCompare(b));
		for (const [source, items] of sortedPackages) {
			lines.push(`    ${theme.fg("mdLink", source)}`);
			for (const item of [...items].sort((a, b) => a.path.localeCompare(b.path))) {
				lines.push(theme.fg("dim", `      ${formatPackagePath(item)}`));
			}
		}
	}
	return lines.join("\n");
}

function findSourceInfoForPath(p: string, sourceInfos: Map<string, SourceInfo>): SourceInfo | undefined {
	const exact = sourceInfos.get(p);
	if (exact) return exact;
	let current = p;
	while (current.includes("/")) {
		current = current.substring(0, current.lastIndexOf("/"));
		const parent = sourceInfos.get(current);
		if (parent) return parent;
	}
	return undefined;
}

function formatPathWithSource(p: string, sourceInfo?: SourceInfo): string {
	if (!sourceInfo) return formatDisplayPath(p);
	const { label, scopeLabel } = getDisplaySourceInfo(sourceInfo);
	return `${scopeLabel ? `${label} (${scopeLabel})` : label} ${getShortPath(p, sourceInfo)}`;
}

export function formatDiagnostics(
	diagnostics: readonly ResourceDiagnostic[],
	sourceInfos: Map<string, SourceInfo>,
): string {
	const lines: string[] = [];
	const collisions = new Map<string, ResourceDiagnostic[]>();
	const otherDiagnostics: ResourceDiagnostic[] = [];
	for (const d of diagnostics) {
		if (d.type === "collision" && d.collision) {
			const list = collisions.get(d.collision.name) ?? [];
			list.push(d);
			collisions.set(d.collision.name, list);
		} else {
			otherDiagnostics.push(d);
		}
	}
	for (const [name, collisionList] of collisions) {
		const first = collisionList[0]?.collision;
		if (!first) continue;
		lines.push(theme.fg("warning", `  "${name}" collision:`));
		const winner = formatPathWithSource(first.winnerPath, findSourceInfoForPath(first.winnerPath, sourceInfos));
		lines.push(theme.fg("dim", `    ${theme.fg("success", "✓")} ${winner}`));
		for (const d of collisionList) {
			if (!d.collision) continue;
			const loser = formatPathWithSource(
				d.collision.loserPath,
				findSourceInfoForPath(d.collision.loserPath, sourceInfos),
			);
			lines.push(theme.fg("dim", `    ${theme.fg("warning", "✗")} ${loser} (skipped)`));
		}
	}
	for (const d of otherDiagnostics) {
		const color = d.type === "error" ? "error" : "warning";
		if (d.path) {
			lines.push(theme.fg(color, `  ${formatPathWithSource(d.path, findSourceInfoForPath(d.path, sourceInfos))}`));
			lines.push(theme.fg(color, `    ${d.message}`));
		} else {
			lines.push(theme.fg(color, `  ${d.message}`));
		}
	}
	return lines.join("\n");
}

/** Fill `container` with the resource listing and diagnostics. Clears it first. */
export function renderLoadedResources(container: Container, options: LoadedResourcesOptions): void {
	container.clear();
	const { session, showListing, showDiagnostics } = options;
	if (!showListing && !showDiagnostics) return;
	const loader = session.resourceLoader;
	const cwd = path.resolve(session.sessionManager.getCwd());
	const formatContextPath = (p: string): string => {
		const absolutePath = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);
		return getCwdRelativePath(absolutePath, cwd) ?? formatDisplayPath(absolutePath);
	};
	const sectionHeader = (name: string, color: ThemeColor) => theme.fg(color, `[${name}]`);
	const formatCompactList = (items: readonly string[], sort = true): string => {
		const labels = items.map((item) => item.trim()).filter((item) => item.length > 0);
		if (sort) labels.sort((a, b) => a.localeCompare(b));
		return theme.fg("dim", `  ${labels.join(", ")}`);
	};
	const addSection = (name: string, collapsedBody: string, expandedBody: string, color: ThemeColor = "mdHeading") => {
		container.addChild(
			new ExpandableText(
				() => `${sectionHeader(name, color)}\n${collapsedBody}`,
				() => `${sectionHeader(name, color)}\n${expandedBody}`,
				options.expanded,
				0,
				0,
			),
		);
		container.addChild(new Spacer(1));
	};
	const addDiagnostics = (label: string, diagnostics: readonly ResourceDiagnostic[]) => {
		if (diagnostics.length === 0) return;
		container.addChild(
			new Text(`${theme.fg("warning", `[${label}]`)}\n${formatDiagnostics(diagnostics, sourceInfos)}`, 0, 0),
		);
		container.addChild(new Spacer(1));
	};

	const skillsResult = loader.getSkills();
	const promptsResult = loader.getPrompts();
	const themesResult = loader.getThemes();
	const extensions: ResourceItem[] = loader
		.getExtensions()
		.extensions.filter((extension) => !extension.hidden)
		.map((extension) => ({ path: extension.path, sourceInfo: extension.sourceInfo }));
	const sourceInfos = new Map<string, SourceInfo>();
	for (const extension of extensions) if (extension.sourceInfo) sourceInfos.set(extension.path, extension.sourceInfo);
	for (const skill of skillsResult.skills) if (skill.sourceInfo) sourceInfos.set(skill.filePath, skill.sourceInfo);
	for (const prompt of promptsResult.prompts)
		if (prompt.sourceInfo) sourceInfos.set(prompt.filePath, prompt.sourceInfo);
	for (const loadedTheme of themesResult.themes) {
		if (loadedTheme.sourcePath && loadedTheme.sourceInfo)
			sourceInfos.set(loadedTheme.sourcePath, loadedTheme.sourceInfo);
	}

	if (showListing) {
		const systemPromptSource = loader.getSystemPromptSource();
		const contextFiles = [
			...(systemPromptSource ? [systemPromptSource] : []),
			...loader.getAppendSystemPromptSources(),
			...loader.getAgentsFiles().agentsFiles,
		];
		if (contextFiles.length > 0) {
			container.addChild(new Spacer(1));
			addSection(
				"Context",
				formatCompactList(
					contextFiles.map((file) => formatContextPath(file.path)),
					false,
				),
				contextFiles.map((file) => theme.fg("dim", `  ${formatDisplayPath(file.path)}`)).join("\n"),
			);
		}
		const skills = skillsResult.skills;
		if (skills.length > 0) {
			const groups = buildScopeGroups(
				skills.map((skill) => ({ path: skill.filePath, sourceInfo: skill.sourceInfo })),
			);
			addSection(
				"Skills",
				formatCompactList(skills.map((skill) => skill.name)),
				formatScopeGroups(
					groups,
					(item) => formatDisplayPath(item.path),
					(item) => getShortPath(item.path, item.sourceInfo),
				),
			);
		}
		const templates = session.promptTemplates;
		if (templates.length > 0) {
			const groups = buildScopeGroups(
				templates.map((template) => ({ path: template.filePath, sourceInfo: template.sourceInfo })),
			);
			const templateByPath = new Map(templates.map((template) => [template.filePath, template]));
			const formatTemplate = (item: ResourceItem) => {
				const template = templateByPath.get(item.path);
				return template ? `/${template.name}` : formatDisplayPath(item.path);
			};
			addSection(
				"Prompts",
				formatCompactList(templates.map((template) => `/${template.name}`)),
				formatScopeGroups(groups, formatTemplate, formatTemplate),
			);
		}
		if (extensions.length > 0) {
			addSection(
				"Extensions",
				formatCompactList(getCompactExtensionLabels(extensions)),
				formatScopeGroups(
					buildScopeGroups(extensions),
					(item) => formatExtensionDisplayPath(item.path),
					(item) => formatExtensionDisplayPath(getShortPath(item.path, item.sourceInfo)),
				),
			);
		}
		const customThemes = themesResult.themes.filter((loadedTheme) => loadedTheme.sourcePath);
		if (customThemes.length > 0) {
			const items = customThemes.map((loadedTheme) => ({
				path: loadedTheme.sourcePath ?? "",
				sourceInfo: loadedTheme.sourceInfo,
			}));
			addSection(
				"Themes",
				formatCompactList(
					customThemes.map(
						(loadedTheme) =>
							loadedTheme.name ?? getCompactPathLabel(loadedTheme.sourcePath ?? "", loadedTheme.sourceInfo),
					),
				),
				formatScopeGroups(
					buildScopeGroups(items),
					(item) => formatDisplayPath(item.path),
					(item) => getShortPath(item.path, item.sourceInfo),
				),
			);
		}
	}

	if (showDiagnostics) {
		addDiagnostics("Skill conflicts", skillsResult.diagnostics);
		addDiagnostics("Prompt conflicts", promptsResult.diagnostics);
		const extensionsResult = loader.getExtensions();
		const extensionDiagnostics: ResourceDiagnostic[] = [
			...extensionsResult.errors.map((error) => ({
				type: "error" as const,
				message: error.error,
				path: error.path,
			})),
			...(extensionsResult.warnings ?? []).map((warning) => ({
				type: "warning" as const,
				message: warning.warning,
				path: warning.path,
			})),
			...session.extensionRunner.getCommandDiagnostics(),
			...options.extraExtensionDiagnostics,
			...session.extensionRunner.getShortcutDiagnostics(),
		];
		addDiagnostics("Extension issues", extensionDiagnostics);
		addDiagnostics("Theme conflicts", themesResult.diagnostics);
	}
}
