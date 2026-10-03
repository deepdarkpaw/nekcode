/**
 * Presentation for the nek tools. Tool files spread these into their definitions, like the core tools.
 * Every renderer truncates to the render width, because the TUI aborts the session on an overwide line.
 */

import { Container, Markdown, Spacer, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { ToolDefinition, ToolRenderContext, ToolRenderResultOptions } from "../../../core/extensions/types.ts";
import { getTextOutput } from "../../../core/tools/render-utils.ts";
import { renderDiff } from "../../../modes/interactive/components/diff.ts";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../../modes/interactive/theme/theme.ts";
import type { PlanData, TodoListData } from "../types.ts";
import { renderTodoLines } from "./todo-widget.ts";

/** Maximum diff lines shown while a plan update is collapsed. */
const UPDATE_PLAN_PREVIEW_LINES = 12;

type TodoWriteRenderers = Pick<ToolDefinition<TSchema, TodoListData | undefined>, "renderCall" | "renderResult">;
type SwitchModeRenderers = Pick<ToolDefinition<TSchema, undefined>, "renderCall" | "renderResult">;

function switchTarget(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null || !("target_mode_id" in args)) return undefined;
	const target = (args as { target_mode_id?: unknown }).target_mode_id;
	return target === "plan" || target === "agent" ? target : undefined;
}

/** Compact switch_mode display; the full mode reminder remains in the tool result sent to the model. */
export const switchModeRenderers: SwitchModeRenderers = {
	renderCall(args, theme) {
		const target = switchTarget(args);
		return new LinesComponent([
			theme.fg("toolTitle", theme.bold("switch_mode")) + (target ? theme.fg("accent", ` → ${target}`) : ""),
		]);
	},
	renderResult(result, _options, theme, context) {
		const output = getTextOutput(result, context.showImages).trim();
		if (context.isError) return new LinesComponent([theme.fg("error", output)]);
		const compact = output.split("\n\n", 1)[0] || "Mode switch complete.";
		return new LinesComponent([theme.fg("toolOutput", compact)]);
	},
};

function formatTodoWriteCall(args: unknown, theme: Theme): string {
	const input = typeof args === "object" && args !== null ? (args as { merge?: unknown; todos?: unknown }) : {};
	const count = Array.isArray(input.todos) ? input.todos.length : 0;
	let text = theme.fg("toolTitle", theme.bold("todo_write"));
	if (typeof input.merge === "boolean") text += ` ${theme.fg("accent", input.merge ? "merge" : "replace")}`;
	return text + theme.fg("toolOutput", ` ${count} ${count === 1 ? "item" : "items"}`);
}

function formatTodoWriteResult(
	result: { content: Array<{ type: string; text?: string }>; details?: TodoListData },
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ToolRenderContext,
): string {
	const output = getTextOutput(result, context.showImages).trim();
	if (context.isError) return `\n${theme.fg("error", output)}`;
	const todos = result.details?.todos ?? [];
	if (options.expanded && todos.length > 0) return `\n${renderTodoLines(todos, theme).join("\n")}`;
	let text = `\n${theme.fg("toolOutput", output)}`;
	if (todos.length > 0) {
		text += ` ${theme.fg("muted", "(")}${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
	}
	return text;
}

/** renderCall/renderResult of todo_write: call shows merge/replace and item count; expanded result shows the list. */
export const todoWriteRenderers: TodoWriteRenderers = {
	renderCall(args, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatTodoWriteCall(args, theme));
		return text;
	},
	renderResult(result, options, theme, context) {
		const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
		text.setText(formatTodoWriteResult(result, options, theme, context));
		return text;
	},
};

/** A block of pre-styled lines truncated to the render width on each frame. */
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

type CreatePlanRenderers = Pick<ToolDefinition<TSchema, PlanData>, "renderShell" | "renderCall" | "renderResult">;

/** Include the saved summary and implementation todos in the document under review. */
export function formatPlanDocument(snapshot: PlanData): string {
	const tasks = snapshot.plan.todos.map((todo) => `- ${todo.content}`).join("\n");
	return [snapshot.plan.overview, snapshot.markdown, ...(tasks ? [`## Implementation Tasks\n\n${tasks}`] : [])]
		.filter((part) => part.trim())
		.join("\n\n");
}

/** ` PLAN ` badge and the bold plan name with a muted revision. */
function planHeading(name: string, revision: number, theme: Theme): string {
	return (
		theme.style(" PLAN ", { fg: "borderAccent", bold: true, inverse: true }) +
		` ${theme.style(name, { fg: "text", bold: true })}` +
		theme.fg("muted", `  Revision ${revision}`)
	);
}

/** A plan is a document, not a collapsible tool log. All body sources belong to this historical call. */
export const createPlanRenderers: CreatePlanRenderers = {
	renderShell: "self",
	renderCall(args: unknown, theme, context) {
		if (!context.isPartial) return new Container();
		const name = typeof args === "object" && args !== null && "name" in args ? args.name : undefined;
		return new LinesComponent([
			theme.style(" PLAN ", { fg: "borderAccent", bold: true, inverse: true }) +
				(typeof name === "string" ? ` ${theme.fg("text", name)}` : ""),
		]);
	},
	renderResult(result, _options, theme, context) {
		const output = getTextOutput(result, context.showImages).trim();
		if (context.isError) return new LinesComponent([` ${theme.fg("error", output)}`]);
		const details = result.details;
		if (!details || typeof details.markdown !== "string" || typeof details.plan?.revision !== "number") {
			return new LinesComponent([
				` ${theme.fg(
					context.isPartial ? "muted" : "error",
					context.isPartial ? "Saving plan..." : "Saved plan snapshot is missing.",
				)}`,
			]);
		}
		const record = details.plan;
		const view = new Container();
		view.addChild(new DynamicBorder((text) => theme.fg("borderAccent", text)));
		view.addChild(new LinesComponent([planHeading(record.name, record.revision, theme)]));
		view.addChild(new LinesComponent([theme.fg("dim", record.path)]));
		view.addChild(new Spacer(1));
		view.addChild(new Markdown(formatPlanDocument(details), 1, 0, getMarkdownTheme()));
		view.addChild(new DynamicBorder((text) => theme.fg("borderAccent", text)));
		return view;
	},
};

type UpdatePlanData = PlanData & { diff: string };
type UpdatePlanRenderers = Pick<ToolDefinition<TSchema, UpdatePlanData>, "renderShell" | "renderCall" | "renderResult">;

function updatePlanExplanation(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null || !("explanation" in args)) return undefined;
	const explanation = (args as { explanation?: unknown }).explanation;
	return typeof explanation === "string" && explanation.trim() ? explanation.trim() : undefined;
}

/**
 * Collapse a long diff to a preview plus a hint. `renderDiff` colors the lines and handles context keywords; the
 * returned block is truncated per line by `LinesComponent`.
 */
export function updatePlanDiffLines(diff: string, expanded: boolean, theme: Theme): string[] {
	if (!diff) return [theme.fg("muted", "No changes to the plan.")];
	const colored = renderDiff(diff).split("\n");
	if (expanded || colored.length <= UPDATE_PLAN_PREVIEW_LINES) return colored;
	const shown = colored.slice(0, UPDATE_PLAN_PREVIEW_LINES);
	return [
		...shown,
		`${theme.fg("muted", `... +${colored.length - UPDATE_PLAN_PREVIEW_LINES} more lines,`)} ${keyHint("app.tools.expand", "to expand")}`,
	];
}

/**
 * update_plan presentation: the PLAN badge with revision, the explanation, and the colored document diff. Collapsed
 * shows a diff preview; expanded shows the full diff and the full plan document.
 */
export const updatePlanRenderers: UpdatePlanRenderers = {
	renderShell: "self",
	renderCall(args, theme, context) {
		if (!context.isPartial) return new Container();
		const explanation = updatePlanExplanation(args);
		return new LinesComponent([
			theme.style(" PLAN ", { fg: "borderAccent", bold: true, inverse: true }) +
				(explanation ? ` ${theme.fg("text", explanation)}` : ""),
		]);
	},
	renderResult(result, options, theme, context) {
		const output = getTextOutput(result, context.showImages).trim();
		if (context.isError) return new LinesComponent([theme.fg("error", output)]);
		const details = result.details;
		if (!details || typeof details.diff !== "string" || typeof details.plan?.revision !== "number") {
			return new LinesComponent([
				theme.fg(
					context.isPartial ? "muted" : "error",
					context.isPartial ? "Saving plan..." : "Saved plan update is missing.",
				),
			]);
		}
		const explanation = updatePlanExplanation(context.args);
		const lines = [
			planHeading(details.plan.name, details.plan.revision, theme),
			...(explanation ? [theme.fg("muted", explanation)] : []),
			...updatePlanDiffLines(details.diff, options.expanded, theme),
		];
		const view = new Container();
		view.addChild(new LinesComponent(lines));
		if (options.expanded) {
			view.addChild(new Spacer(1));
			view.addChild(new Markdown(formatPlanDocument(details), 1, 0, getMarkdownTheme()));
		}
		return view;
	},
};
