import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme, ThemeColor } from "../../../modes/interactive/theme/theme.ts";
import type { ToolDefinition } from "../../extensions/types.ts";
import { getTextOutput } from "../render-utils.ts";
import type { WebSearchResult, WebSearchToolDetails } from "../web-search.ts";
import { formatToolHeader, getToolDisplayName } from "./tool-header.ts";

const PREVIEW_RESULTS = 5;
/** Web Search is drawn in blue. `mdLink` is the softer of the existing blue tokens in both built-in themes. */
const WEB_SEARCH_COLOR: ThemeColor = "mdLink";

type WebSearchRenderers = Pick<ToolDefinition<TSchema, WebSearchToolDetails>, "renderCall" | "renderResult">;

/** Lines cut to the row width instead of wrapped, so each result stays on one line. */
class LinesComponent extends Container {
	private readonly lines: readonly string[];

	constructor(lines: readonly string[]) {
		super();
		this.lines = lines;
	}

	override render(width: number): string[] {
		return this.lines.map((line) => truncateToWidth(line, width, "…"));
	}
}

function queryFromArgs(args: unknown): string {
	if (typeof args !== "object" || args === null || !("query" in args)) return "";
	return typeof args.query === "string" ? args.query : "";
}

/** Hostname without `www.`, or the raw URL when it does not parse. */
export function formatResultDomain(url: string): string {
	if (!URL.canParse(url)) return url;
	return new URL(url).hostname.replace(/^www\./, "");
}

/** Collapsed and expanded result lines: a muted summary, then `N. title domain`. */
export function formatWebSearchResultLines(
	results: readonly WebSearchResult[],
	expanded: boolean,
	theme: Theme,
): string[] {
	const count = `${results.length} result${results.length === 1 ? "" : "s"}`;
	if (results.length === 0) return [theme.fg("muted", "No results")];
	const visible = expanded ? results : results.slice(0, PREVIEW_RESULTS);
	const lines = [theme.fg("muted", count)];
	const indexWidth = String(visible.length).length;
	for (const [index, item] of visible.entries()) {
		const number = theme.fg("dim", `${String(index + 1).padStart(indexWidth)}.`);
		const title = theme.fg(WEB_SEARCH_COLOR, item.title.replace(/\s+/g, " ").trim());
		lines.push(`${number} ${title} ${theme.fg("muted", formatResultDomain(item.url))}`);
	}
	if (results.length > visible.length) {
		const hidden = results.length - visible.length;
		lines.push(`${theme.fg("muted", `… ${hidden} more,`)} ${keyHint("app.tools.expand", "to expand")}`);
	}
	return lines;
}

export const webSearchRenderers: WebSearchRenderers = {
	renderCall(args, theme, context) {
		const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
		const query = queryFromArgs(args);
		text.setText(
			formatToolHeader(theme, {
				name: getToolDisplayName("web_search"),
				nameColor: WEB_SEARCH_COLOR,
				arg: query ? theme.fg("text", query) : theme.fg("toolOutput", "..."),
			}),
		);
		return text;
	},
	renderResult(result, options, theme, context) {
		const details = result.details;
		if (context.isError || !details) {
			// Errors wrap instead of being cut, so the whole message stays readable.
			const output = getTextOutput(result, context.showImages).trim();
			const text = context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
			text.setText(output ? `\n${theme.fg("error", output)}` : "");
			return text;
		}
		return new LinesComponent(["", ...formatWebSearchResultLines(details.results, options.expanded, theme)]);
	},
};
