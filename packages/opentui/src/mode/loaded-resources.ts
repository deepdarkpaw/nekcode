/**
 * Startup listing of loaded resources (context files, skills, prompts, extensions, themes) and their
 * diagnostics. Same output as the interactive mode's `showLoadedResources`.
 */

import * as os from "node:os";
import * as path from "node:path";
import type { AgentSession } from "@earendil-works/pi-coding-agent/core/agent-session";
import type { ResourceDiagnostic } from "@earendil-works/pi-coding-agent/core/resource-loader";
import type { SourceInfo } from "@earendil-works/pi-coding-agent/core/source-info";
import * as ResourceDisplay from "@earendil-works/pi-coding-agent/modes/interactive/resource-display";
import { type ThemeColor, theme } from "@earendil-works/pi-coding-agent/modes/interactive/theme/theme";
import { getCwdRelativePath } from "@earendil-works/pi-coding-agent/utils/paths";
import { type Container, Spacer, Text } from "@earendil-works/pi-tui";
import { ExpandableText } from "./expandable-text.ts";

type ResourceItem = ResourceDisplay.ResourceItem;
type ScopeGroup = ResourceDisplay.ScopeGroup;
const resourcePaths: ResourceDisplay.ResourcePaths = { display: formatDisplayPath, short: getShortPath };
const buildScopeGroups = ResourceDisplay.buildScopeGroups;

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
	return ResourceDisplay.formatHomePath(p, os.homedir());
}

function formatExtensionDisplayPath(p: string): string {
	return formatDisplayPath(p)
		.replace(/\/index\.ts$/, "")
		.replace(/\/index\.js$/, "");
}

function getShortPath(fullPath: string, sourceInfo?: SourceInfo): string {
	return ResourceDisplay.getPackageRelativePath(fullPath, sourceInfo) || formatDisplayPath(fullPath);
}

function getCompactPathLabel(resourcePath: string, sourceInfo?: SourceInfo): string {
	return ResourceDisplay.getCompactPathLabel({ path: resourcePath, sourceInfo }, resourcePaths);
}

function getCompactExtensionLabels(extensions: readonly ResourceItem[]): string[] {
	return ResourceDisplay.getCompactExtensionLabels(extensions, resourcePaths);
}

function formatScopeGroups(
	groups: readonly ScopeGroup[],
	formatPath: (item: ResourceItem) => string,
	formatPackagePath: (item: ResourceItem) => string,
): string {
	return ResourceDisplay.formatScopeGroups(groups, formatPath, formatPackagePath, (color, text) =>
		theme.fg(color, text),
	);
}

export function formatDiagnostics(
	diagnostics: readonly ResourceDiagnostic[],
	sourceInfos: Map<string, SourceInfo>,
): string {
	return ResourceDisplay.formatDiagnostics(diagnostics, sourceInfos, resourcePaths, (color, text) =>
		theme.fg(color, text),
	);
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
