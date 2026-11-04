import * as path from "node:path";
import type { ResourceDiagnostic } from "../../core/resource-loader.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import { parseGitUrl } from "../../utils/git.ts";

export type ResourceItem = { path: string; sourceInfo?: SourceInfo };
export type ScopeGroup = {
	scope: "user" | "project" | "path";
	paths: ResourceItem[];
	packages: Map<string, ResourceItem[]>;
};
export interface ResourcePaths {
	display(path: string): string;
	short(path: string, sourceInfo?: SourceInfo): string;
}
export type ResourceColor = (
	color: "accent" | "dim" | "mdLink" | "warning" | "success" | "error",
	text: string,
) => string;

/** Caller supplies home and presentation, so this module performs no IO or UI mutation. */
export function formatHomePath(value: string, home: string): string {
	return value.startsWith(home) ? `~${value.slice(home.length)}` : value;
}

function isPackageSource(sourceInfo?: SourceInfo): boolean {
	const source = sourceInfo?.source ?? "";
	return source.startsWith("npm:") || source.startsWith("git:");
}

/** Package-relative topology; undefined means the caller's ordinary display path applies. */
export function getPackageRelativePath(fullPath: string, sourceInfo?: SourceInfo): string | undefined {
	const normalized = fullPath.replace(/\\/g, "/");
	const base = sourceInfo?.baseDir;
	if (base && isPackageSource(sourceInfo)) {
		const normalizedBase = base.replace(/\\/g, "/");
		const npmRoot = normalizedBase.match(/^(.*\/node_modules)\/(@?[^/]+(?:\/[^/]+)?)$/);
		if (npmRoot?.[1] && normalized.startsWith(`${npmRoot[1]}/`))
			return path.posix.relative(normalizedBase, normalized);
		const relative = path.relative(path.resolve(base), path.resolve(fullPath));
		if (relative && relative !== "." && !relative.startsWith("..") && !path.isAbsolute(relative))
			return relative.replace(/\\/g, "/");
	}
	const source = sourceInfo?.source ?? "";
	const npm = normalized.match(/node_modules\/(@?[^/]+(?:\/[^/]+)?)\/(.*)/);
	if (npm && source.startsWith("npm:")) return npm[2];
	const git = normalized.match(/git\/[^/]+\/[^/]+\/(.*)/);
	if (git && source.startsWith("git:")) return git[1];
	return undefined;
}

function segments(value: string): string[] {
	return value
		.replace(/\\/g, "/")
		.split("/")
		.filter((part) => part.length > 0 && part !== "~");
}

export function getCompactPathLabel(item: ResourceItem, paths: ResourcePaths): string {
	const short = paths.short(item.path, item.sourceInfo);
	return segments(short).at(-1) ?? short;
}

function packageLabel(item: ResourceItem, paths: ResourcePaths): string {
	const source = item.sourceInfo?.source ?? "";
	const label = source.startsWith("npm:") ? source.slice(4) || source : parseGitUrl(source)?.path || source;
	if (!label) return getCompactPathLabel(item, paths);
	const short = paths.short(item.path, item.sourceInfo).replace(/\\/g, "/");
	const packagePath = short.startsWith("extensions/") ? short.slice("extensions/".length) : short;
	const parsed = path.posix.parse(packagePath);
	if (parsed.name === "index") return !parsed.dir || parsed.dir === "." ? label : `${label}:${parsed.dir}`;
	return `${label}:${packagePath}`;
}

/** Shortest unambiguous local suffix; package labels retain their source identity. */
export function getCompactExtensionLabels(items: readonly ResourceItem[], paths: ResourcePaths): string[] {
	const local = items
		.filter((item) => !isPackageSource(item.sourceInfo))
		.map((item) => {
			const parts = segments(paths.display(item.path));
			if (parts.length > 1 && (parts.at(-1) === "index.ts" || parts.at(-1) === "index.js")) parts.pop();
			return { path: item.path, parts };
		});
	return items.map((item) => {
		if (isPackageSource(item.sourceInfo)) return packageLabel(item, paths);
		const index = local.findIndex((entry) => entry.path === item.path);
		const parts = local[index]?.parts;
		if (!parts?.length) return getCompactPathLabel(item, paths);
		for (let count = 1; count <= parts.length; count++) {
			const label = parts.slice(-count).join("/");
			if (local.every((other, otherIndex) => index === otherIndex || other.parts.slice(-count).join("/") !== label))
				return label;
		}
		return parts.join("/");
	});
}

function scopeOf(info?: SourceInfo): ScopeGroup["scope"] {
	if (info?.source === "cli" || info?.scope === "temporary") return "path";
	const scope = info?.scope ?? "project";
	return scope === "user" || scope === "project" ? scope : "path";
}

export function buildScopeGroups(items: readonly ResourceItem[]): ScopeGroup[] {
	const groups: Record<ScopeGroup["scope"], ScopeGroup> = {
		project: { scope: "project", paths: [], packages: new Map() },
		user: { scope: "user", paths: [], packages: new Map() },
		path: { scope: "path", paths: [], packages: new Map() },
	};
	for (const item of items) {
		const group = groups[scopeOf(item.sourceInfo)];
		if (!isPackageSource(item.sourceInfo)) {
			group.paths.push(item);
			continue;
		}
		const source = item.sourceInfo!.source;
		const list = group.packages.get(source) ?? [];
		list.push(item);
		group.packages.set(source, list);
	}
	return [groups.project, groups.user, groups.path].filter(
		(group) => group.paths.length > 0 || group.packages.size > 0,
	);
}

export function formatScopeGroups(
	groups: readonly ScopeGroup[],
	formatPath: (item: ResourceItem) => string,
	formatPackagePath: (item: ResourceItem, source: string) => string,
	fg: ResourceColor,
): string {
	const lines: string[] = [];
	for (const group of groups) {
		lines.push(`  ${fg("accent", group.scope)}`);
		for (const item of [...group.paths].sort((a, b) => a.path.localeCompare(b.path)))
			lines.push(fg("dim", `    ${formatPath(item)}`));
		for (const [source, items] of [...group.packages].sort(([a], [b]) => a.localeCompare(b))) {
			lines.push(`    ${fg("mdLink", source)}`);
			for (const item of [...items].sort((a, b) => a.path.localeCompare(b.path)))
				lines.push(fg("dim", `      ${formatPackagePath(item, source)}`));
		}
	}
	return lines.join("\n");
}

function sourceInfoFor(value: string, infos: ReadonlyMap<string, SourceInfo>): SourceInfo | undefined {
	const exact = infos.get(value);
	if (exact) return exact;
	let parent = value;
	while (parent.includes("/")) {
		parent = parent.substring(0, parent.lastIndexOf("/"));
		const info = infos.get(parent);
		if (info) return info;
	}
	return undefined;
}

function pathWithSource(value: string, infos: ReadonlyMap<string, SourceInfo>, paths: ResourcePaths): string {
	const info = sourceInfoFor(value, infos);
	if (!info) return paths.display(value);
	const source = info.source ?? "local";
	const scope = info.scope ?? "project";
	const scopeLabel = scope === "temporary" ? "temp" : scope === "user" || scope === "project" ? scope : undefined;
	const label =
		source === "local"
			? scope === "user" || scope === "project"
				? scope
				: "path"
			: source === "cli"
				? "path"
				: source;
	const suffix = source === "local" || source === "cli" ? (scope === "temporary" ? "temp" : undefined) : scopeLabel;
	return `${suffix ? `${label} (${suffix})` : label} ${paths.short(value, info)}`;
}

/** Render diagnostics with the caller's colors and path conventions; do not own containers or focus. */
export function formatDiagnostics(
	diagnostics: readonly ResourceDiagnostic[],
	infos: ReadonlyMap<string, SourceInfo>,
	paths: ResourcePaths,
	fg: ResourceColor,
): string {
	const lines: string[] = [];
	const collisions = new Map<string, ResourceDiagnostic[]>();
	const other: ResourceDiagnostic[] = [];
	for (const diagnostic of diagnostics) {
		if (diagnostic.type !== "collision" || !diagnostic.collision) {
			other.push(diagnostic);
			continue;
		}
		const list = collisions.get(diagnostic.collision.name) ?? [];
		list.push(diagnostic);
		collisions.set(diagnostic.collision.name, list);
	}
	for (const [name, list] of collisions) {
		const first = list[0]?.collision;
		if (!first) continue;
		lines.push(fg("warning", `  "${name}" collision:`));
		lines.push(fg("dim", `    ${fg("success", "✓")} ${pathWithSource(first.winnerPath, infos, paths)}`));
		for (const item of list)
			if (item.collision)
				lines.push(
					fg(
						"dim",
						`    ${fg("warning", "✗")} ${pathWithSource(item.collision.loserPath, infos, paths)} (skipped)`,
					),
				);
	}
	for (const item of other) {
		const color = item.type === "error" ? "error" : "warning";
		if (item.path) lines.push(fg(color, `  ${pathWithSource(item.path, infos, paths)}`));
		lines.push(fg(color, `${item.path ? "    " : "  "}${item.message}`));
	}
	return lines.join("\n");
}
