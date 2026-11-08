import type { TruncationResult } from "./truncate.ts";
import type { WebSearchResult, WebSearchToolDetails } from "./web-search.ts";

const MAX_EXCERPT_BYTES = 4 * 1024;

function formatResults(results: readonly WebSearchResult[]): string {
	if (results.length === 0) return "No web search results found.";
	return results
		.map((result, index) => {
			const metadata = [result.published, result.author].filter(Boolean).join(" · ");
			return [`${index + 1}. [${result.title}](${result.url})`, metadata, result.highlights]
				.filter(Boolean)
				.join("\n");
		})
		.join("\n\n");
}

/** Clip only excerpts and auxiliary metadata, never source titles or URLs, at UTF-8 boundaries. */
function clipText(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text);
	if (bytes.length <= maxBytes) return text;
	if (maxBytes < 3) return "";
	let end = maxBytes - 3;
	while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
	return `${bytes.subarray(0, end).toString("utf8")}…`;
}

function lineCount(text: string): number {
	if (!text) return 0;
	let count = 1;
	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) count++;
	return count;
}

function truncationDetails(
	original: Pick<TruncationResult, "totalLines" | "totalBytes">,
	content: string,
	maxBytes: number,
): TruncationResult {
	return {
		content,
		truncated: true,
		truncatedBy: "bytes",
		totalLines: original.totalLines,
		totalBytes: original.totalBytes,
		outputLines: lineCount(content),
		outputBytes: Buffer.byteLength(content),
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines: Number.MAX_SAFE_INTEGER,
		maxBytes,
	};
}

/** Bound both serialized details (including truncation.content) and model content to maxBytes. */
export function formatWebSearchOutput(
	query: string,
	results: WebSearchResult[],
	count: number,
	maxBytes: number,
): { content: string; details: WebSearchToolDetails } {
	const original = formatResults(results);
	const originalSize = { totalLines: lineCount(original), totalBytes: Buffer.byteLength(original) };
	const selected = results.slice(0, count);
	const candidate = (excerptBytes: number) => {
		const bounded = selected.map((result) => {
			const published = result.published ? clipText(result.published, 128) : undefined;
			const author = result.author ? clipText(result.author, 512) : undefined;
			const highlights = result.highlights ? clipText(result.highlights, excerptBytes) : undefined;
			return {
				title: result.title,
				url: result.url,
				...(published ? { published } : {}),
				...(author ? { author } : {}),
				...(highlights ? { highlights } : {}),
			};
		});
		const content = formatResults(bounded);
		const details: WebSearchToolDetails = {
			query,
			results: bounded,
			...(content !== original ? { truncation: truncationDetails(originalSize, content, maxBytes) } : {}),
		};
		return { content, details };
	};
	const fits = (value: ReturnType<typeof candidate>) =>
		Buffer.byteLength(value.content) <= maxBytes && Buffer.byteLength(JSON.stringify(value.details)) <= maxBytes;
	const full = candidate(MAX_EXCERPT_BYTES);
	if (fits(full)) return full;
	let best = candidate(0);
	if (!fits(best))
		throw new Error("Web search source titles/URLs exceed the output size limit; request fewer results.");
	let low = 1;
	let high = MAX_EXCERPT_BYTES - 1;
	while (low <= high) {
		const middle = Math.floor((low + high) / 2);
		const next = candidate(middle);
		if (fits(next)) {
			best = next;
			low = middle + 1;
		} else {
			high = middle - 1;
		}
	}
	return best;
}
