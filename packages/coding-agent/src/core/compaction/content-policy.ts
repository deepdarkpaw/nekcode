import type { ToolResultMessage } from "@earendil-works/pi-ai";

/** Character budgets apply to summary input, never to signed provider thinking blocks. */
export interface CompactionContentSettings {
	thinkingMaxChars: number;
	thinkingTotalMaxChars: number;
	toolResultMaxChars: number;
	toolErrorMaxChars: number;
	toolArgumentMaxChars: number;
	pruneToolResults: boolean;
	protectedRecentTokens: number;
	protectedToolResults: number;
}

export const DEFAULT_COMPACTION_CONTENT_SETTINGS: Readonly<CompactionContentSettings> = {
	thinkingMaxChars: 3000,
	thinkingTotalMaxChars: 24000,
	toolResultMaxChars: 2000,
	toolErrorMaxChars: 6000,
	toolArgumentMaxChars: 2000,
	pruneToolResults: true,
	protectedRecentTokens: 8000,
	protectedToolResults: 6,
};

/** Reject malformed settings rather than silently discarding the user's budget. */
export function resolveCompactionContentSettings(
	value?: Partial<CompactionContentSettings>,
): CompactionContentSettings {
	if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) {
		throw new Error("Invalid compaction.content setting: expected an object");
	}
	const result = { ...DEFAULT_COMPACTION_CONTENT_SETTINGS };
	for (const key of Object.keys(value ?? {})) {
		if (!(key in DEFAULT_COMPACTION_CONTENT_SETTINGS)) {
			throw new Error(`Unknown compaction.content setting: ${key}`);
		}
	}
	for (const key of Object.keys(result) as (keyof CompactionContentSettings)[]) {
		const configured = value?.[key];
		if (configured === undefined) continue;
		if (key === "pruneToolResults") {
			if (typeof configured !== "boolean") throw new Error(`Invalid compaction.content.${key}: expected a boolean`);
			result[key] = configured;
			continue;
		}
		const minimum =
			key === "toolResultMaxChars" || key === "toolErrorMaxChars" || key === "toolArgumentMaxChars" ? 256 : 0;
		if (typeof configured !== "number" || !Number.isSafeInteger(configured) || configured < minimum) {
			throw new Error(`Invalid compaction.content.${key}: expected a safe integer >= ${minimum}`);
		}
		result[key] = configured;
	}
	return result;
}

/** Keep exact excerpts; an omission marker makes a folded excerpt distinguishable from complete evidence. */
export function foldText(text: string, maxChars: number, tailFraction = 0.5): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 0) return `[${text.length} characters omitted]`;
	const marker = (omitted: number) => `\n[... ${omitted} characters omitted ...]\n`;
	const available = Math.max(2, maxChars - 48);
	let headEnd = Math.floor(available * (1 - tailFraction));
	let tailStart = text.length - (available - headEnd);
	const headBreak = text.lastIndexOf("\n", headEnd);
	if (headBreak >= headEnd / 2) headEnd = headBreak;
	const tailBreak = text.indexOf("\n", tailStart);
	if (tailBreak >= 0 && tailBreak <= tailStart + (text.length - tailStart) / 2) tailStart = tailBreak + 1;
	/** Do not cut a UTF-16 surrogate pair at either excerpt boundary. */
	if (headEnd > 0 && /[\uD800-\uDBFF]/.test(text[headEnd - 1])) headEnd--;
	if (/[\uDC00-\uDFFF]/.test(text[tailStart])) tailStart++;
	let result = `${text.slice(0, headEnd)}${marker(tailStart - headEnd)}${text.slice(tailStart)}`;
	if (result.length > maxChars) {
		const overflow = result.length - maxChars;
		const adjustedTailStart = Math.min(text.length, tailStart + overflow);
		result = `${text.slice(0, headEnd)}${marker(adjustedTailStart - headEnd)}${text.slice(adjustedTailStart)}`;
	}
	return result;
}

/** Preserve final reasoning paragraphs, with a small opening excerpt for scope and premises. */
export function foldThinking(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const tailBudget = Math.floor(maxChars * 0.85);
	const start = text.length - tailBudget;
	const paragraph = text.indexOf("\n\n", start);
	if (paragraph >= 0 && paragraph - start < tailBudget / 2) {
		const tail = text.slice(paragraph + 2);
		const head = text.slice(0, Math.max(0, Math.floor(maxChars * 0.15)));
		return `${head}\n[... ${text.length - head.length - tail.length} thinking characters omitted; final paragraphs follow ...]\n${tail}`;
	}
	return foldText(text, maxChars, 0.85).replace("characters omitted", "thinking characters omitted");
}

/** Extract bounded diagnostics from the middle of logs; not a parser or an assertion that a command failed. */
function diagnosticExcerpt(text: string, budget: number): string {
	const excerpts: string[] = [];
	let used = 0;
	for (const match of text.matchAll(
		/^.*(?:\berror\b|\bfailed\b|\bfatal\b|\bexception\b|\bpanic\b|\bassertion\b|\bexit code\b|\btests?\s+(?:passed|failed)\b|完整输出|full output|saved to).*/gim,
	)) {
		if (used >= budget) break;
		const line = match[0].slice(0, budget - used);
		excerpts.push(line);
		used += line.length + 1;
	}
	return excerpts.join("\n");
}

/** Reuse the read tool's recorded AST chunk map; never parse or reread a potentially changed file. */
function readChunkOutline(details: unknown, budget: number): string {
	if (!details || typeof details !== "object" || !("chunks" in details) || !Array.isArray(details.chunks)) return "";
	const lines: string[] = [];
	let used = 0;
	for (const chunk of details.chunks as unknown[]) {
		if (
			!chunk ||
			typeof chunk !== "object" ||
			!("startLine" in chunk) ||
			typeof chunk.startLine !== "number" ||
			!("endLine" in chunk) ||
			typeof chunk.endLine !== "number" ||
			!("label" in chunk) ||
			typeof chunk.label !== "string"
		)
			continue;
		const line = `${chunk.startLine}-${chunk.endLine}: ${chunk.label}`;
		if (used + line.length + 1 > budget) {
			lines.push("[Further chunk labels omitted]");
			break;
		}
		lines.push(line);
		used += line.length + 1;
	}
	return lines.join("\n");
}

/** Fold observed tool text without reading today's files or running tools during summarization. */
export function foldToolResult(
	message: Pick<ToolResultMessage, "toolName" | "isError" | "details">,
	text: string,
	settings: CompactionContentSettings,
): string {
	const shell = message.toolName === "bash" || message.toolName === "powershell";
	const maxChars = message.isError ? settings.toolErrorMaxChars : settings.toolResultMaxChars;
	if (text.length <= maxChars) return text;
	const diagnostics = shell || message.isError ? diagnosticExcerpt(text, Math.floor(maxChars / 3)) : "";
	const outline = message.toolName === "read" ? readChunkOutline(message.details, Math.floor(maxChars / 3)) : "";
	const excerpts = foldText(text, Math.max(0, maxChars - diagnostics.length - outline.length), shell ? 0.65 : 0.35);
	return [
		outline ? `[Recorded source chunks]\n${outline}` : "",
		excerpts,
		diagnostics ? `[Selected diagnostic lines from full output]\n${diagnostics}` : "",
	]
		.filter(Boolean)
		.join("\n");
}
