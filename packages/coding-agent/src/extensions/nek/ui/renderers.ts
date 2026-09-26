/**
 * Presentation for the nek tools. Tool files spread these into their definitions, like the core tools.
 */

import { Text } from "@earendil-works/pi-tui";
import type { TSchema } from "typebox";
import type { ToolDefinition, ToolRenderContext, ToolRenderResultOptions } from "../../../core/extensions/types.ts";
import { getTextOutput } from "../../../core/tools/render-utils.ts";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import type { TodoListData } from "../types.ts";
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
