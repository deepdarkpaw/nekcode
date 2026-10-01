/**
 * Presentation for the nek tools. Tool files spread these into their definitions, like the core tools.
 */

import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { ToolDefinition, ToolRenderContext, ToolRenderResultOptions } from "../../../core/extensions/types.ts";
import { getTextOutput } from "../../../core/tools/render-utils.ts";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../../modes/interactive/theme/theme.ts";
import type { PlanData, TodoListData } from "../types.ts";
import { renderTodoLines } from "./todo-widget.ts";

type TodoWriteRenderers = Pick<ToolDefinition<TSchema, TodoListData | undefined>, "renderCall" | "renderResult">;

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

type CreatePlanRenderers = Pick<ToolDefinition<TSchema, PlanData>, "renderShell" | "renderCall" | "renderResult">;

/** Include the saved summary and implementation todos in the document under review. */
export function formatPlanDocument(snapshot: PlanData): string {
	const tasks = snapshot.plan.todos.map((todo) => `- ${todo.content}`).join("\n");
	return [snapshot.plan.overview, snapshot.markdown, ...(tasks ? [`## Implementation Tasks\n\n${tasks}`] : [])]
		.filter((part) => part.trim())
		.join("\n\n");
}

/** A plan is a document, not a collapsible tool log. All body sources belong to this historical call. */
export const createPlanRenderers: CreatePlanRenderers = {
	renderShell: "self",
	renderCall(args: unknown, theme, context) {
		if (!context.isPartial) return new Container();
		const name = typeof args === "object" && args !== null && "name" in args ? args.name : undefined;
		return new Text(
			theme.style(" PLAN ", { fg: "borderAccent", bold: true, inverse: true }) +
				(typeof name === "string" ? ` ${theme.fg("text", name)}` : ""),
			1,
			0,
		);
	},
	renderResult(result, _options, theme, context) {
		const output = getTextOutput(result, context.showImages).trim();
		if (context.isError) return new Text(theme.fg("error", output), 1, 0);
		const details = result.details;
		if (!details || typeof details.markdown !== "string" || typeof details.plan?.revision !== "number") {
			return new Text(
				theme.fg(
					context.isPartial ? "muted" : "error",
					context.isPartial ? "Saving plan..." : "Saved plan snapshot is missing.",
				),
				1,
				0,
			);
		}
		const record = details.plan;
		const view = new Container();
		view.addChild(new DynamicBorder((text) => theme.fg("borderAccent", text)));
		view.addChild(
			new Text(
				theme.style(" PLAN ", { fg: "borderAccent", bold: true, inverse: true }) +
					` ${theme.style(record.name, { fg: "text", bold: true })}` +
					theme.fg("muted", `  Revision ${record.revision}`),
				1,
				0,
			),
		);
		view.addChild(new Text(theme.fg("dim", record.path), 1, 0));
		view.addChild(new Spacer(1));
		view.addChild(new Markdown(formatPlanDocument(details), 1, 0, getMarkdownTheme()));
		view.addChild(new DynamicBorder((text) => theme.fg("borderAccent", text)));
		return view;
	},
};
