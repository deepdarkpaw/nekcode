/** BM25-based discovery over registered deferred tools. */

import { Text } from "@earendil-works/pi-tui";
import { type Static, Type } from "typebox";
import type {
	ExtensionAPI,
	ToolDefinition,
	ToolExposure,
	ToolInfo,
	ToolNamespace,
} from "../../core/extensions/types.ts";
import { formatToolHeader, getToolDisplayName } from "../../core/tools/renderers/tool-header.ts";
import type { Theme } from "../../modes/interactive/theme/theme.ts";

export const TOOL_SEARCH_TOOL_NAME = "tool_search";
export const DEFAULT_TOOL_SEARCH_LIMIT = 8;

export interface ToolSearchDocument {
	name: string;
	text: string;
}

export interface ToolSearchMatch {
	name: string;
	score: number;
}

export interface ToolRanker {
	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[];
}

const STOP_WORDS: ReadonlySet<string> = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"for",
	"from",
	"in",
	"is",
	"it",
	"of",
	"on",
	"or",
	"that",
	"the",
	"this",
	"to",
	"with",
]);

function stem(term: string): string {
	if (term.length > 4 && term.endsWith("ies")) return `${term.slice(0, -3)}y`;
	if (term.length > 4 && /(ches|shes|sses|xes|zes)$/.test(term)) return term.slice(0, -2);
	if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) return term.slice(0, -1);
	return term;
}

/** Lowercase terms, split camelCase and punctuation, remove stop words, and fold plurals. */
export function tokenize(text: string): string[] {
	return text
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length > 0 && !STOP_WORDS.has(term))
		.map(stem);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaText(schema: unknown, parts: string[]): void {
	if (!isObject(schema)) return;
	if (typeof schema.description === "string") parts.push(schema.description);
	if (isObject(schema.properties)) {
		for (const [name, property] of Object.entries(schema.properties)) {
			parts.push(name);
			schemaText(property, parts);
		}
	}
	schemaText(schema.items, parts);
	for (const key of ["anyOf", "oneOf", "allOf"]) {
		const variants = schema[key];
		if (Array.isArray(variants)) for (const variant of variants) schemaText(variant, parts);
	}
}

/** Build searchable metadata from a registered tool. */
export function createToolSearchDocument(
	tool: Pick<ToolInfo, "name" | "description" | "parameters">,
	namespace?: ToolNamespace,
): ToolSearchDocument {
	const parts = [tool.name, tool.name.replaceAll("_", " "), tool.description];
	schemaText(tool.parameters, parts);
	if (namespace) parts.push(namespace.name, namespace.description ?? "");
	return { name: tool.name, text: parts.filter((part) => part.trim()).join(" ") };
}

/** Okapi BM25 ranker. Ties retain registration order. */
export class Bm25Ranker implements ToolRanker {
	private readonly k1: number;
	private readonly b: number;

	constructor(options: { k1?: number; b?: number } = {}) {
		this.k1 = options.k1 ?? 1.2;
		this.b = options.b ?? 0.75;
	}

	rank(query: string, documents: readonly ToolSearchDocument[], limit: number): ToolSearchMatch[] {
		const queryTerms = [...new Set(tokenize(query))];
		if (queryTerms.length === 0 || documents.length === 0 || limit <= 0) return [];
		const termCounts = documents.map((document) => {
			const counts = new Map<string, number>();
			for (const term of tokenize(document.text)) counts.set(term, (counts.get(term) ?? 0) + 1);
			return counts;
		});
		const lengths = termCounts.map((counts) => [...counts.values()].reduce((sum, count) => sum + count, 0));
		const averageLength = lengths.reduce((sum, length) => sum + length, 0) / documents.length || 1;
		const idf = new Map(
			queryTerms.map((term) => {
				const frequency = termCounts.filter((counts) => counts.has(term)).length;
				return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))] as const;
			}),
		);
		const matches: ToolSearchMatch[] = [];
		documents.forEach((document, index) => {
			let score = 0;
			for (const term of queryTerms) {
				const count = termCounts[index].get(term);
				if (!count) continue;
				const norm = this.k1 * (1 - this.b + (this.b * lengths[index]) / averageLength);
				score += (idf.get(term) ?? 0) * ((count * (this.k1 + 1)) / (count + norm));
			}
			if (score > 0) matches.push({ name: document.name, score });
		});
		return matches.sort((a, b) => b.score - a.score).slice(0, limit);
	}
}

export const toolSearchSchema = Type.Object({
	query: Type.String({ description: "Search query for deferred tools." }),
	limit: Type.Optional(
		Type.Number({ description: `Maximum number of tools to return. Defaults to ${DEFAULT_TOOL_SEARCH_LIMIT}.` }),
	),
});

export type ToolSearchInput = Static<typeof toolSearchSchema>;

/** Whether a tool is the built-in tool_search definition. */
export function isToolSearchTool(tool: Pick<ToolInfo, "name" | "parameters">): boolean {
	return tool.name === TOOL_SEARCH_TOOL_NAME && tool.parameters === toolSearchSchema;
}

export interface ToolSearchResultTool {
	name: string;
	description: string;
}

export interface ToolSearchToolDetails {
	loaded: string[];
}

export interface ToolSearchToolOptions {
	tools?: Pick<ExtensionAPI, "getAllTools" | "getActiveTools" | "setActiveTools">;
	/** Wait for registered background sources before taking the searchable tool snapshot. */
	beforeSearch?: (signal: AbortSignal | undefined) => Promise<void>;
}

function isSearchable(exposure: ToolExposure): boolean {
	return exposure === "deferred";
}

function searchAndLoad(
	tools: NonNullable<ToolSearchToolOptions["tools"]>,
	query: string,
	limit: number,
): ToolSearchResultTool[] {
	const active = tools.getActiveTools();
	const candidates = tools.getAllTools().filter((tool) => isSearchable(tool.exposure) && !active.includes(tool.name));
	const documents = candidates.map((tool) => createToolSearchDocument(tool, tool.namespace));
	const matches = new Bm25Ranker().rank(query, documents, limit);
	if (matches.length > 0) tools.setActiveTools([...active, ...matches.map((match) => match.name)]);
	return matches.map((match) => ({
		name: match.name,
		description: candidates.find((tool) => tool.name === match.name)?.description ?? "",
	}));
}

/** Description shown when tool_search is active. */
export function createToolSearchDescription(sources: readonly ToolNamespace[] = []): string {
	const listed =
		sources.length === 0
			? "None currently enabled."
			: sources
					.map((source) => {
						const description = source.description?.trim().split(/\r?\n/)[0];
						return description ? `- ${source.name}: ${description}` : `- ${source.name}`;
					})
					.join("\n");
	return `# Tool discovery\n\nSearches over deferred tool metadata with BM25 and exposes matching tools for the next model call.\n\nYou have access to tools from the following sources:\n${listed}\n\nSome tools may not have been provided upfront; use \`${TOOL_SEARCH_TOOL_NAME}\` to search for required tools.`;
}

/** `Tool Search <query> limit N`. */
export function formatToolSearchCall(args: unknown, theme: Theme): string {
	const input =
		typeof args === "object" && args !== null ? (args as Partial<Record<keyof ToolSearchInput, unknown>>) : {};
	const query = typeof input.query === "string" ? input.query : "";
	return formatToolHeader(theme, {
		name: getToolDisplayName(TOOL_SEARCH_TOOL_NAME),
		arg: query ? theme.fg("accent", query) : theme.fg("toolOutput", "..."),
		meta: [typeof input.limit === "number" && `limit ${input.limit}`],
	});
}

/** A muted count followed by the display names of the loaded tools, or the error text. */
export function formatToolSearchResult(
	result: { content: Array<{ type: string; text?: string }>; details?: ToolSearchToolDetails },
	isError: boolean,
	theme: Theme,
): string {
	if (isError || !result.details) {
		const output = result.content
			.filter((block) => block.type === "text")
			.map((block) => block.text ?? "")
			.join("\n")
			.trim();
		return output ? `\n${theme.fg(isError ? "error" : "toolOutput", output)}` : "";
	}
	const loaded = result.details.loaded;
	if (loaded.length === 0) return `\n${theme.fg("muted", "No matching tools")}`;
	const count = theme.fg("muted", `Loaded ${loaded.length} tool${loaded.length === 1 ? "" : "s"}`);
	const names = loaded.map((name) => getToolDisplayName(name)).join(", ");
	return `\n${count} ${theme.fg("toolOutput", names)}`;
}

export function createToolSearchToolDefinition(
	options: ToolSearchToolOptions = {},
): ToolDefinition<typeof toolSearchSchema, ToolSearchToolDetails> {
	return {
		name: TOOL_SEARCH_TOOL_NAME,
		label: getToolDisplayName(TOOL_SEARCH_TOOL_NAME),
		description: createToolSearchDescription(),
		promptSnippet: "Search for tools that are not loaded yet and load the matches",
		parameters: toolSearchSchema,
		exposure: "model-only",
		renderCall(args, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(formatToolSearchCall(args, theme));
			return text;
		},
		renderResult(result, _options, theme, context) {
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(formatToolSearchResult(result, context.isError, theme));
			return text;
		},
		async execute(_toolCallId, { query, limit }, signal) {
			if (query.trim() === "") throw new Error("query must not be empty");
			const max = limit ?? DEFAULT_TOOL_SEARCH_LIMIT;
			if (!Number.isInteger(max) || max <= 0) throw new Error("limit must be a positive integer");
			await options.beforeSearch?.(signal);
			signal?.throwIfAborted();
			const tools = options.tools ? searchAndLoad(options.tools, query, max) : [];
			const text =
				tools.length === 0
					? "No matching tools found."
					: `Loaded ${tools.length} tool${tools.length === 1 ? "" : "s"}. They are available from your next call:\n${tools
							.map((tool) => `- ${tool.name}: ${tool.description.trim().split(/\r?\n/)[0]}`)
							.join("\n")}`;
			return { content: [{ type: "text", text }], details: { loaded: tools.map((tool) => tool.name) } };
		},
	};
}
