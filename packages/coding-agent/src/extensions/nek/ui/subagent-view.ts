/**
 * Presentation of subagents: subagent/await tool rows, the `nek.subagent_notice` message, the `/subagents` command,
 * and the running-subagent list above the editor. Cards follow the Cursor layout: a status icon and description with
 * muted metadata on the first line, the current action or a one-line result below.
 */

import { Box, type Component, Container, Markdown, Text, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { ExtensionCommandContext, MessageRenderer, ToolDefinition } from "../../../core/extensions/types.ts";
import { getTextOutput } from "../../../core/tools/render-utils.ts";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../../modes/interactive/theme/theme.ts";
import type { SubagentRegistry } from "../services/subagent-registry.ts";
import type { AwaitToolData, SubagentNoticeData, SubagentRecord, SubagentStatus, SubagentToolData } from "../types.ts";

/** Widget key of the running background subagent list above the editor. */
export const SUBAGENT_WIDGET_KEY = "nek.subagents";

/** Custom message type of the background subagent completion notice. */
export const SUBAGENT_NOTICE_TYPE = "nek.subagent_notice";

/** Spinner frames of a running subagent (the tui Loader sequence). */
export const SUBAGENT_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Left padding of a card's first line, matching the surrounding tool rows. */
const CARD_PAD = 1;

/** Left padding of a card's second line, so it sits under the description. */
const DETAIL_PAD = 3;

const STATUS_ICONS: Record<SubagentStatus, string> = { running: "⠋", completed: "✓", errored: "✗", aborted: "✗" };

/** State a card keeps between renders so its timer can be cancelled on dispose. */
interface CardState {
	interval?: ReturnType<typeof setInterval>;
}

/** Collapse dynamic card text to the single-line form expected by the TUI row renderer. */
function oneLine(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function iconColor(status: SubagentStatus): "success" | "accent" | "error" {
	if (status === "completed") return "success";
	if (status === "running") return "accent";
	return "error";
}

/** Spinner frame of a running record, derived from elapsed time so it animates without a timer. */
function spinnerFrame(record: SubagentRecord, now: number): string {
	const index = Math.floor(Math.max(0, now - record.startedAt) / 80) % SUBAGENT_SPINNER_FRAMES.length;
	return SUBAGENT_SPINNER_FRAMES[index] ?? SUBAGENT_SPINNER_FRAMES[0];
}

function statusIcon(record: SubagentRecord, theme: Theme, now: number): string {
	const icon = record.status === "running" ? spinnerFrame(record, now) : STATUS_ICONS[record.status];
	return theme.fg(iconColor(record.status), icon);
}

/** Elapsed seconds of a record, e.g. `12s`; minutes are shown once a run passes a minute. */
export function subagentElapsed(record: SubagentRecord, now = Date.now()): string {
	const seconds = Math.max(0, Math.round(((record.endedAt ?? now) - record.startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

/** Model id without the provider prefix (`anthropic/claude` -> `claude`). */
function modelId(record: SubagentRecord): string {
	if (!record.model) return "unknown model";
	const slash = record.model.lastIndexOf("/");
	return oneLine(slash === -1 ? record.model : record.model.slice(slash + 1));
}

/** Token count, e.g. `3.2k tokens`. */
function tokenText(tokens: number): string {
	if (tokens < 1000) return `${tokens} tokens`;
	if (tokens < 10000) return `${(tokens / 1000).toFixed(1)}k tokens`;
	if (tokens < 1000000) return `${Math.round(tokens / 1000)}k tokens`;
	return `${(tokens / 1000000).toFixed(1)}M tokens`;
}

/**
 * First line of a subagent card, shared by tool rows, the completion notice, `/subagents`, and the running list:
 * `⠋ <description>  <model> · <type> · <elapsed>` while running, and the same metadata plus tokens once finished.
 */
export function subagentLine(record: SubagentRecord, theme: Theme, now = Date.now()): string {
	const meta = [`${modelId(record)} · ${oneLine(record.type)}`, subagentElapsed(record, now)];
	if (record.status !== "running") meta.push(tokenText(record.tokens));
	return `${statusIcon(record, theme, now)} ${oneLine(record.description)}  ${theme.fg("muted", meta.join(" · "))}`;
}

/** First non-empty line of a result body, used as the second card line. */
function firstLine(text: string | undefined): string | undefined {
	const line = text
		?.split("\n")
		.map((value) => value.trim())
		.find((value) => value.length > 0);
	return line === undefined ? undefined : oneLine(line);
}

/** Head lines of a card (without indentation) for the current record state. */
function cardLines(record: SubagentRecord, theme: Theme): string[] {
	const head = [subagentLine(record, theme)];
	if (record.status === "running") {
		if (record.activity) head.push(theme.fg("dim", oneLine(record.activity)));
		return head;
	}
	if (record.status === "errored" || record.status === "aborted") {
		const error = oneLine(record.error ?? "");
		head.push(theme.fg("error", error || firstLine(record.finalText) || "The subagent run failed."));
		return head;
	}
	if (record.finalText) {
		head[0] += ` ${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
		const summary = firstLine(record.finalText);
		if (summary) head.push(theme.fg("dim", summary));
	}
	return head;
}

/** First line and detail line, indented, truncated to the render width. */
function renderCardLines(record: SubagentRecord, theme: Theme, width: number): string[] {
	return cardLines(record, theme).map((line, index) =>
		truncateToWidth(`${" ".repeat(index === 0 ? CARD_PAD : DETAIL_PAD)}${oneLine(line)}`, width, ""),
	);
}

/** Card component: renders the record live, keeps the elapsed timer, and cleans it up on dispose. */
class SubagentCardComponent extends Container {
	private readonly state: CardState;
	private record: SubagentRecord;
	private expanded: boolean;
	private readonly theme: Theme;

	constructor(state: CardState, record: SubagentRecord, expanded: boolean, theme: Theme) {
		super();
		this.state = state;
		this.record = record;
		this.expanded = expanded;
		this.theme = theme;
	}

	/** Refresh the component when a partial result or expansion setting changes. */
	update(record: SubagentRecord, expanded: boolean): void {
		this.record = record;
		this.expanded = expanded;
	}

	override render(width: number): string[] {
		const lines = renderCardLines(this.record, this.theme, width);
		if (this.expanded && this.record.finalText) {
			lines.push(...new Markdown(this.record.finalText, 1, 0, getMarkdownTheme()).render(width));
		}
		return lines.map((line) => oneLine(line));
	}

	dispose(): void {
		if (this.state.interval) clearInterval(this.state.interval);
		this.state.interval = undefined;
	}
}

/** Start or stop the one-second invalidate timer that keeps a running card's elapsed time fresh. */
function syncCardTimer(state: CardState, running: boolean, invalidate: () => void): void {
	if (running && !state.interval) state.interval = setInterval(invalidate, 1000);
	if (!running && state.interval) {
		clearInterval(state.interval);
		state.interval = undefined;
	}
}

type SubagentRenderers = Pick<ToolDefinition<TSchema, SubagentToolData>, "renderCall" | "renderResult">;
type AwaitRenderers = Pick<ToolDefinition<TSchema, AwaitToolData>, "renderCall" | "renderResult">;

/** Subagent card: a call title while streaming, then the live card and the finished result. */
export const subagentRenderers: SubagentRenderers = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		const input = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
		const description = typeof input.description === "string" ? oneLine(input.description) : "subagent";
		text.setText(`${theme.fg("toolTitle", theme.bold("subagent"))} ${theme.fg("text", description)}`);
		return text;
	},
	renderResult(result, options, theme, context) {
		const record = result.details?.subagent;
		if (context.isError || !record) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			text.setText(`\n${theme.fg("error", oneLine(getTextOutput(result, context.showImages)))}`);
			return text;
		}
		const state = context.state as CardState;
		syncCardTimer(state, record.status === "running" && options.isPartial, () => context.invalidate());
		const existing = context.lastComponent instanceof SubagentCardComponent ? context.lastComponent : undefined;
		if (existing) {
			existing.update(record, options.expanded);
			return existing;
		}
		return new SubagentCardComponent(state, record, options.expanded, theme);
	},
};

/** Renderer variant that resolves retained records so background cards do not freeze at their start snapshot. */
export function createSubagentRenderers(getRegistry: () => SubagentRegistry): SubagentRenderers {
	return {
		...subagentRenderers,
		renderResult(result, options, theme, context) {
			const snapshot = result.details?.subagent;
			const live = snapshot ? getRegistry().get(snapshot.id) : undefined;
			const record = live && live.startedAt === snapshot?.startedAt ? live : snapshot;
			const renderResult = subagentRenderers.renderResult;
			if (!renderResult) return new Text("", 0, 0);
			if (!record) return renderResult(result, options, theme, context);
			return renderResult(
				{ ...result, details: { subagent: record } },
				{ ...options, isPartial: options.isPartial || record.status === "running" },
				theme,
				context,
			);
		},
	};
}

/** Await rows: resolve an id to its current description when the registry still retains it. */
export function awaitRenderers(getRegistry: () => SubagentRegistry): AwaitRenderers {
	return {
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const input = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
			const id = typeof input.subagent_id === "string" ? input.subagent_id : undefined;
			const description = id ? oneLine(getRegistry().get(id)?.description ?? id) : "any subagent";
			text.setText(`${theme.fg("toolTitle", theme.bold("await"))} ${theme.fg("accent", description)}`);
			return text;
		},
		renderResult(result, _options, theme, context) {
			const subagents = result.details?.subagents ?? [];
			const running = result.details?.running ?? [];
			const output = oneLine(getTextOutput(result, context.showImages));
			if (context.isError) {
				const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
				text.setText(`\n${theme.fg("error", output)}`);
				return text;
			}
			const lines = [
				...subagents.map((subagent) => `${" ".repeat(CARD_PAD)}${subagentLine(subagent, theme)}`),
				...running.map(
					(subagent) =>
						`${" ".repeat(CARD_PAD)}${theme.fg("muted", `${subagentLine(subagent, theme)} · still running`)}`,
				),
			];
			if (lines.length === 0) return new LinesComponent([theme.fg("muted", ` ${output}`)]);
			if (result.details?.timedOut)
				lines.push(theme.fg("muted", " await timed out; subagents above were not stopped"));
			if (result.details?.interrupted)
				lines.push(theme.fg("muted", " wait ended after a user message; subagents keep running"));
			return new LinesComponent(lines);
		},
	};
}

/** A plain block of styled lines, truncated to the render width on each frame. */
class LinesComponent extends Container {
	private readonly lines: readonly string[];

	constructor(lines: readonly string[]) {
		super();
		this.lines = lines;
	}

	override render(width: number): string[] {
		return this.lines.map((line) => truncateToWidth(oneLine(line), width, ""));
	}
}

/** `nek.subagent_notice`: one summary line; expanded shows the result as markdown. */
export const renderSubagentNotice: MessageRenderer<SubagentNoticeData> = (message, { expanded, outputPad }, theme) => {
	const record = message.details?.subagent;
	if (!record) return undefined;
	const box = new Box(outputPad, 0);
	box.addChild(new Text(subagentLine(record, theme), 0, 0));
	const body = record.status === "errored" ? record.error : record.finalText;
	if (expanded && body) box.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
	return box;
};

/**
 * Running background summaries for the widget above the editor, one line per running background subagent.
 * Undefined when none run, so the caller removes the widget key.
 */
export function subagentWidgetLines(
	records: readonly SubagentRecord[],
	theme: Theme,
	now = Date.now(),
): string[] | undefined {
	const running = records.filter((record) => record.background && record.status === "running");
	if (running.length === 0) return undefined;
	return running.map((record) => subagentLine(record, theme, now));
}

/** Widget component for the running list; refreshes elapsed every second while it is mounted. */
class SubagentWidgetComponent extends Container {
	private readonly records: readonly SubagentRecord[];
	private readonly theme: Theme;
	private readonly interval: ReturnType<typeof setInterval>;

	constructor(records: readonly SubagentRecord[], theme: Theme, requestRender: () => void) {
		super();
		this.records = records;
		this.theme = theme;
		this.interval = setInterval(requestRender, 1000);
	}

	override render(width: number): string[] {
		const now = Date.now();
		return this.records
			.filter((record) => record.background && record.status === "running")
			.map((record) => truncateToWidth(subagentLine(record, this.theme, now), width, ""));
	}

	dispose(): void {
		clearInterval(this.interval);
	}
}

/**
 * Show or hide the running-subagent widget above the editor. The widget refreshes its own elapsed time every second
 * through the TUI it is mounted on, so the caller only re-applies it when the set of running subagents changes.
 */
export function applySubagentWidget(
	ui: {
		setWidget(key: string, content: ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined): void;
	},
	records: readonly SubagentRecord[],
	theme: Theme,
): void {
	if (!subagentWidgetLines(records, theme)) {
		ui.setWidget(SUBAGENT_WIDGET_KEY, undefined);
		return;
	}
	ui.setWidget(
		SUBAGENT_WIDGET_KEY,
		(tui, widgetTheme) => new SubagentWidgetComponent(records, widgetTheme, () => tui.requestRender()),
	);
}

/** `/subagents`: pick a subagent, then cancel it or show its result. */
export async function showSubagents(ctx: ExtensionCommandContext, registry: SubagentRegistry): Promise<void> {
	const records = registry.list();
	if (records.length === 0) {
		ctx.ui.notify("No subagents in this session.", "info");
		return;
	}
	const labels = records.map((record) => subagentLine(record, ctx.ui.theme));
	const picked = records[labels.indexOf((await ctx.ui.select("Subagents", labels)) ?? "")];
	if (!picked) return;
	const actions = picked.status === "running" ? ["Cancel", "Show result"] : ["Show result"];
	const action = await ctx.ui.select(picked.description, actions);
	if (action === "Cancel") await registry.abort(picked.id);
	if (action === "Show result") await showSubagentResult(ctx, picked);
}

async function showSubagentResult(ctx: ExtensionCommandContext, record: SubagentRecord): Promise<void> {
	const text = record.status === "errored" ? (record.error ?? "") : (record.finalText ?? "(no result yet)");
	if (ctx.mode !== "tui") {
		ctx.ui.notify(text, "info");
		return;
	}
	await ctx.ui.custom<void>((_tui, theme, keybindings, done) => {
		const view = new Container();
		view.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		view.addChild(new Text(subagentLine(record, theme), 1, 0));
		view.addChild(new Markdown(text, 1, 1, getMarkdownTheme()));
		view.addChild(new Text(keyHint("tui.select.cancel", "close"), 1, 0));
		view.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		return {
			render: (width) => view.render(width),
			invalidate: () => view.invalidate(),
			handleInput: (data) => {
				if (keybindings.matches(data, "tui.select.cancel")) done();
			},
		};
	});
}
