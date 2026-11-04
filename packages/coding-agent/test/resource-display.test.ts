import { describe, expect, it } from "vitest";
import type { ResourceDiagnostic } from "../src/core/resource-loader.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import {
	buildScopeGroups,
	formatDiagnostics,
	formatHomePath,
	formatScopeGroups,
	getCompactExtensionLabels,
	getPackageRelativePath,
	type ResourceItem,
	type ResourcePaths,
} from "../src/modes/interactive/resource-display.ts";

const paths: ResourcePaths = {
	display: (p) => formatHomePath(p, "/home/user"),
	short: (p, info) => getPackageRelativePath(p, info) ?? paths.display(p),
};
const plain = (_color: string, text: string) => text;
const info = (path: string, source = "local", scope: "project" | "user" | "temporary" = "project", baseDir?: string) =>
	createSyntheticSourceInfo(path, { source, scope, baseDir });

describe("shared resource display", () => {
	it("retains package topology and disambiguates local index extensions", () => {
		const base = "/workspace/node_modules/pkg";
		expect(
			getPackageRelativePath("/workspace/node_modules/dependency/a.ts", info(base, "npm:pkg", "project", base)),
		).toBe("../dependency/a.ts");
		expect(
			getCompactExtensionLabels(
				[
					{ path: "/workspace/one/same/index.ts" },
					{ path: "/workspace/two/same/index.js" },
					{ path: `${base}/extensions/sub/index.ts`, sourceInfo: info(base, "npm:pkg", "project", base) },
				],
				paths,
			),
		).toEqual(["one/same", "two/same", "pkg:sub"]);
	});
	it("groups project, user and temporary sources without mutating input order", () => {
		const items: ResourceItem[] = [
			{ path: "/home/user/skill", sourceInfo: info("/home/user/skill", "local", "user") },
			{ path: "/workspace/z" },
			{ path: "/workspace/a" },
			{ path: "/tmp/extension", sourceInfo: info("/tmp/extension", "cli", "temporary") },
		];
		const before = structuredClone(items);
		const groups = buildScopeGroups(items);
		expect(groups.map((group) => group.scope)).toEqual(["project", "user", "path"]);
		expect(
			formatScopeGroups(
				groups,
				(item) => paths.display(item.path),
				(item) => paths.short(item.path, item.sourceInfo),
				plain,
			),
		).toBe("  project\n    /workspace/a\n    /workspace/z\n  user\n    ~/skill\n  path\n    /tmp/extension");
		expect(items).toEqual(before);
	});
	it("keeps collision winner/loser and path diagnostics text", () => {
		const diagnostics: ResourceDiagnostic[] = [
			{ type: "error", path: "/tmp/broken.ts", message: "failed" },
			{
				type: "collision",
				message: "duplicate",
				collision: {
					resourceType: "skill",
					name: "skill",
					winnerPath: "/home/user/skill/a",
					loserPath: "/workspace/skill/b",
				},
			},
		];
		const sources = new Map([["/home/user/skill", info("/home/user/skill", "local", "user")]]);
		expect(formatDiagnostics(diagnostics, sources, paths, plain)).toBe(
			'  "skill" collision:\n    ✓ user ~/skill/a\n    ✗ /workspace/skill/b (skipped)\n  /tmp/broken.ts\n    failed',
		);
	});
});
