import { canonicalizePath } from "../utils/paths.ts";
import type { ResourceDiagnostic } from "./diagnostics.ts";

/** First name wins in loader order. Skills also silently deduplicate aliases of the same file. */
export function dedupeNamedResources<T extends { name: string; filePath: string }>(
	resources: T[],
	resourceType: "skill" | "prompt",
): { resources: T[]; diagnostics: ResourceDiagnostic[] } {
	const byName = new Map<string, T>();
	const skillPaths = new Set<string>();
	const diagnostics: ResourceDiagnostic[] = [];
	for (const resource of resources) {
		const skillPath = resourceType === "skill" ? canonicalizePath(resource.filePath) : undefined;
		if (skillPath !== undefined && skillPaths.has(skillPath)) continue;
		const existing = byName.get(resource.name);
		if (existing) {
			const prefix = resourceType === "prompt" ? "/" : "";
			diagnostics.push({
				type: "collision",
				message: `name "${prefix}${resource.name}" collision`,
				path: resource.filePath,
				collision: {
					resourceType,
					name: resource.name,
					winnerPath: existing.filePath,
					loserPath: resource.filePath,
				},
			});
			continue;
		}
		byName.set(resource.name, resource);
		if (skillPath !== undefined) skillPaths.add(skillPath);
	}
	return { resources: [...byName.values()], diagnostics };
}
