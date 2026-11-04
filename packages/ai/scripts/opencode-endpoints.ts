import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	createModelDataManifest,
	MODEL_DATA_MANIFEST_FILE,
	MODEL_DATA_SCHEMA_VERSION,
	type ModelDataManifest,
	readModelDataProviderIds,
	readModelDataStructure,
	validateModelDataDirectory,
} from "./model-data.ts";

export const OPENCODE_BASE_PATHS = {
	opencode: "https://opencode.ai/inference",
	"opencode-go": "https://opencode.ai/inference/go",
} as const;

/** Protocol paths from pi 195120a91 + 177e2ad7e4, kept identical for generation and offline regeneration. */
export function getOpenCodeBaseUrl(basePath: string, api: string): string {
	const suffix: Record<string, string> = {
		"openai-responses": "/openai/v1",
		"openai-completions": "/openai/v1",
		"anthropic-messages": "/anthropic",
		"google-generative-ai": "/google/v1beta",
		"typesafe-system-one": "/systemone/v1",
	};
	if (!Object.hasOwn(suffix, api)) throw new Error(`Unsupported OpenCode API: ${api}`);
	return basePath + suffix[api];
}

interface EndpointModel {
	id: string;
	api: string;
	baseUrl: string;
	compat?: Record<string, unknown>;
}
type ProviderData = Record<string, Record<string, EndpointModel>>;

/** Rebuild only routing fields; retain IDs, prices, limits and all other model metadata. */
export function updateOpenCodeEndpoints(provider: keyof typeof OPENCODE_BASE_PATHS, data: ProviderData): ProviderData {
	const groups = new Map<string, Array<[string, EndpointModel]>>();
	for (const entries of Object.values(data)) {
		for (const [key, model] of Object.entries(entries)) {
			const api = provider === "opencode-go" && model.id === "minimax-m2.7" ? "anthropic-messages" : model.api;
			const next = { ...model, api, baseUrl: getOpenCodeBaseUrl(OPENCODE_BASE_PATHS[provider], api) };
			if (provider === "opencode" && model.id === "deepseek-v4.1-flash") {
				next.compat = { ...model.compat, supportsLongCacheRetention: false };
			}
			const group = groups.get(api) ?? [];
			group.push([key, next]);
			groups.set(api, group);
		}
	}
	return Object.fromEntries([...groups].map(([api, entries]) => [api, Object.fromEntries(entries)]));
}

/** Offline regeneration from existing catalog values, with schema/hash validation before replacing any data. */
export function refreshOpenCodeModelData(packageRoot: string): void {
	const dataDir = join(packageRoot, "src/providers/data");
	const structure = readModelDataStructure(packageRoot);
	const previous: ModelDataManifest = JSON.parse(readFileSync(join(dataDir, MODEL_DATA_MANIFEST_FILE), "utf8"));
	if (previous.schemaVersion !== MODEL_DATA_SCHEMA_VERSION) throw new Error("Unsupported model data manifest version");
	const files: Record<string, string> = {};
	const changed: string[] = [];
	for (const provider of readModelDataProviderIds(packageRoot)) {
		const file = `${provider}.json`;
		const original = readFileSync(join(dataDir, file), "utf8");
		files[file] = original;
		if (provider !== "opencode" && provider !== "opencode-go") continue;
		const input = JSON.parse(original);
		const data = updateOpenCodeEndpoints(provider, input);
		if (JSON.stringify(data) === JSON.stringify(input)) continue;
		files[file] = `${JSON.stringify(data, null, 2)}\n`;
		structure[provider] = Object.fromEntries(
			Object.entries(data).flatMap(([api, entries]) => Object.keys(entries).map((key) => [key, api])),
		);
		changed.push(file);
	}
	if (!changed.length) return;
	const staged = mkdtempSync(join(packageRoot, "src/providers/.model-generation-"));
	try {
		for (const [file, content] of Object.entries(files)) writeFileSync(join(staged, file), content);
		const manifest = createModelDataManifest(structure, files, new Date().toISOString());
		writeFileSync(join(staged, MODEL_DATA_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
		validateModelDataDirectory(structure, staged);
		for (const file of [...changed, MODEL_DATA_MANIFEST_FILE]) renameSync(join(staged, file), join(dataDir, file));
	} finally {
		rmSync(staged, { recursive: true, force: true });
	}
}
