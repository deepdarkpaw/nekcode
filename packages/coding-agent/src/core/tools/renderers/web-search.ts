import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { ToolDefinition } from "../../extensions/types.ts";
import { getTextOutput } from "../render-utils.ts";
import type { WebSearchToolDetails } from "../web-search.ts";

const PREVIEW_RESULTS = 5;

type WebSearchRenderers = Pick<ToolDefinition<TSchema, WebSearchToolDetails>, "renderCall" | "renderResult">;

class LinesComponent extends Container {
	private readonly lines: readonly string[];

	constructor(lines: readonly string[]) {
		super();
		this.lines = lines;
	}

	override render(width: number): string[] {
		return this.lines.map((line) => truncateToWidth(line, width, ""));
	}
}

function queryFromArgs(args: unknown): string {
	if (typeof args !== "object" || args === null || !("query" in args)) return "";
	return typeof args.query === "string" ? args.query : "";
}

export const webSearchRenderers: WebSearchRenderers = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(`${theme.fg("toolTitle", theme.bold("web_search"))} ${theme.fg("text", queryFromArgs(args))}`);
		return text;
	},
	renderResult(result, options, theme, context) {
		const details = result.details;
		const output = getTextOutput(result, context.showImages).trim();
		if (context.isError || !details) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(`\n${theme.fg("error", output)}`);
			return text;
		}
		const results = details.results;
		const lines = [
			`${theme.fg("accent", `web_search · ${results.length} result${results.length === 1 ? "" : "s"}`)}`,
		];
		const visible = options.expanded ? results : results.slice(0, PREVIEW_RESULTS);
		lines.push(...visible.map((item, index) => `${index + 1}. ${item.title} ${theme.fg("muted", item.url)}`));
		if (!options.expanded && results.length > visible.length) {
			lines.push(theme.fg("muted", `... ${results.length - visible.length} more results (expand to view)`));
		}
		return new LinesComponent(lines);
	},
};
