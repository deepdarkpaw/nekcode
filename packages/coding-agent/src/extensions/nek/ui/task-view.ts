/**
 * Presentation of subagents: task/await tool rows, the `nek.task_notice` message, and the `/tasks` command.
 */

import { Box, type Component, Container, Markdown, Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type {
	ExtensionCommandContext,
	MessageRenderer,
	ToolDefinition,
	ToolRenderContext,
} from "../../../core/extensions/types.ts";
import { getTextOutput } from "../../../core/tools/render-utils.ts";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../../modes/interactive/theme/theme.ts";
import type { TaskRegistry } from "../services/task-registry.ts";
import type { AwaitToolData, TaskNoticeData, TaskRecord, TaskStatus, TaskToolData } from "../types.ts";

/** Status bar key of the running background task count. */
export const TASK_STATUS_KEY = "nek.tasks";

/** Custom message type of the background completion notice. */
export const TASK_NOTICE_TYPE = "nek.task_notice";

const STATUS_ICONS: Record<TaskStatus, string> = { running: "⧗", completed: "✓", errored: "✗", aborted: "■" };

function statusIcon(status: TaskStatus, theme: Theme): string {
	const color = status === "completed" ? "success" : status === "running" ? "accent" : "error";
	return theme.fg(color, STATUS_ICONS[status]);
}

/** Elapsed seconds of a record, e.g. `12s`. */
export function taskElapsed(record: TaskRecord, now = Date.now()): string {
	return `${Math.round(((record.endedAt ?? now) - record.startedAt) / 1000)}s`;
}

/** One-line summary: `✓ id · type · status · 12s · description`. */
export function taskLine(record: TaskRecord, theme: Theme): string {
	const meta = [record.id, record.type, record.status, taskElapsed(record)].join(" · ");
	return `${statusIcon(record.status, theme)} ${theme.fg("muted", meta)} · ${record.description}`;
}

function textComponent(context: ToolRenderContext, text: string): Text {
	const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
	component.setText(text);
	return component;
}

function formatTaskCall(args: unknown, theme: Theme): string {
	const input = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
	const type = typeof input.subagent_type === "string" ? input.subagent_type : "generalPurpose";
	let text = `${theme.fg("toolTitle", theme.bold("task"))} ${theme.fg("accent", type)}`;
	if (typeof input.description === "string") text += ` "${input.description}"`;
	if (typeof input.resume === "string") text += theme.fg("muted", ` (resume ${input.resume})`);
	if (input.run_in_background === true) text += theme.fg("muted", " (background)");
	return text;
}

function firstLine(text: string | undefined): string {
	return (text ?? "").split("\n").find((line) => line.trim() !== "") ?? "";
}

function taskResultComponent(record: TaskRecord, expanded: boolean, isPartial: boolean, theme: Theme): Component {
	if (isPartial) {
		const lines = record.progress.map((line) => theme.fg("toolOutput", line));
		if (record.tail) lines.push(theme.fg("dim", record.tail));
		lines.push(theme.fg("muted", `${taskElapsed(record)} · ${record.tokens} tokens`));
		return new Text(`\n${lines.join("\n")}`, 0, 0);
	}
	const summary = record.status === "errored" ? (record.error ?? "") : firstLine(record.finalText);
	const header = `${statusIcon(record.status, theme)} ${theme.fg("toolOutput", summary)}`;
	if (!expanded || !record.finalText) {
		const hint = record.finalText
			? ` ${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`
			: "";
		return new Text(`\n${header}${hint}`, 0, 0);
	}
	const view = new Container();
	view.addChild(new Text(`\n${header}`, 0, 0));
	view.addChild(new Markdown(record.finalText, 0, 0, getMarkdownTheme()));
	return view;
}

type TaskRenderers = Pick<ToolDefinition<TSchema, TaskToolData>, "renderCall" | "renderResult">;
type AwaitRenderers = Pick<ToolDefinition<TSchema, AwaitToolData>, "renderCall" | "renderResult">;

/** task rows: `task explore "Map auth flow" (background)`; progress while running; status + first line when done. */
export const taskRenderers: TaskRenderers = {
	renderCall: (args, theme, context) => textComponent(context, formatTaskCall(args, theme)),
	renderResult(result, options, theme, context) {
		const record = result.details?.task;
		if (context.isError || !record) {
			return textComponent(context, `\n${theme.fg("error", getTextOutput(result, context.showImages).trim())}`);
		}
		return taskResultComponent(record, options.expanded, options.isPartial, theme);
	},
};

/** await rows: one status line per returned task. */
export const awaitRenderers: AwaitRenderers = {
	renderCall(args, theme, context) {
		const input = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
		const target = typeof input.task_id === "string" ? input.task_id : "any";
		return textComponent(context, `${theme.fg("toolTitle", theme.bold("await"))} ${theme.fg("accent", target)}`);
	},
	renderResult(result, _options, theme, context) {
		const tasks = result.details?.tasks ?? [];
		const output = getTextOutput(result, context.showImages).trim();
		if (context.isError || tasks.length === 0) return textComponent(context, `\n${theme.fg("toolOutput", output)}`);
		return textComponent(context, `\n${tasks.map((task) => taskLine(task, theme)).join("\n")}`);
	},
};

/** `nek.task_notice`: one line `✓ subagent "desc" completed`; expanded shows the result as markdown. */
export const renderTaskNotice: MessageRenderer<TaskNoticeData> = (message, { expanded, outputPad }, theme) => {
	const record = message.details?.task;
	if (!record) return undefined;
	const box = new Box(outputPad, 0);
	const line = `${statusIcon(record.status, theme)} subagent "${record.description}" ${record.status}`;
	box.addChild(new Text(line, 0, 0));
	const body = record.status === "errored" ? record.error : record.finalText;
	if (expanded && body) box.addChild(new Markdown(body, 0, 0, getMarkdownTheme()));
	return box;
};

/** Running background count for the status bar, e.g. `⧗ 2 tasks`; undefined when none run. */
export function taskStatusText(records: readonly TaskRecord[]): string | undefined {
	const running = records.filter((record) => record.background && record.status === "running").length;
	if (running === 0) return undefined;
	return `⧗ ${running} ${running === 1 ? "task" : "tasks"}`;
}

/** `/tasks`: pick a task, then cancel it or show its result. */
export async function showTasks(ctx: ExtensionCommandContext, registry: TaskRegistry): Promise<void> {
	const records = registry.list();
	if (records.length === 0) {
		ctx.ui.notify("No subagents in this session.", "info");
		return;
	}
	const labels = records.map((record) => taskLine(record, ctx.ui.theme));
	const picked = records[labels.indexOf((await ctx.ui.select("Subagents", labels)) ?? "")];
	if (!picked) return;
	const actions = picked.status === "running" ? ["Cancel", "Show result"] : ["Show result"];
	const action = await ctx.ui.select(picked.description, actions);
	if (action === "Cancel") await registry.abort(picked.id);
	if (action === "Show result") await showTaskResult(ctx, picked);
}

async function showTaskResult(ctx: ExtensionCommandContext, record: TaskRecord): Promise<void> {
	const text = record.status === "errored" ? (record.error ?? "") : (record.finalText ?? "(no result yet)");
	if (ctx.mode !== "tui") {
		ctx.ui.notify(text, "info");
		return;
	}
	await ctx.ui.custom<void>((_tui, theme, keybindings, done) => {
		const view = new Container();
		view.addChild(new DynamicBorder((line: string) => theme.fg("accent", line)));
		view.addChild(new Text(taskLine(record, theme), 1, 0));
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
