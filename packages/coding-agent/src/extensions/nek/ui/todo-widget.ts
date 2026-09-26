import { type Component, Container, Text } from "@earendil-works/pi-tui";
import type { ExtensionCommandContext, ExtensionContext } from "../../../core/extensions/types.ts";
import type { KeybindingsManager } from "../../../core/keybindings.ts";
import { DynamicBorder } from "../../../modes/interactive/components/dynamic-border.ts";
import { keyHint } from "../../../modes/interactive/components/keybinding-hints.ts";
import type { Theme } from "../../../modes/interactive/theme/theme.ts";
import { openTodos, todoProgress } from "../state/todos.ts";
import type { Todo } from "../types.ts";

/** Widget and status key of the todo list. */
export const TODO_UI_KEY = "nek.todos";

/** One styled todo line: `✓` completed (dim, struck through), `▶` in progress (accent), `○` pending, `✗` cancelled. */
export function renderTodoLine(todo: Todo, theme: Theme): string {
	switch (todo.status) {
		case "completed":
			return `${theme.fg("dim", "✓")} ${theme.fg("dim", theme.strikethrough(todo.content))}`;
		case "in_progress":
			return `${theme.fg("accent", "▶")} ${theme.fg("accent", todo.content)}`;
		case "cancelled":
			return `${theme.fg("dim", "✗")} ${theme.fg("dim", todo.content)}`;
		case "pending":
			return `${theme.fg("muted", "○")} ${todo.content}`;
	}
}

/** Styled todo lines. Lists longer than `maxLines` show `maxLines - 1` items and a `... +N more` line. */
export function renderTodoLines(todos: readonly Todo[], theme: Theme, maxLines = Number.POSITIVE_INFINITY): string[] {
	if (todos.length <= maxLines) return todos.map((todo) => renderTodoLine(todo, theme));
	const shown = Math.max(0, maxLines - 1);
	const lines = todos.slice(0, shown).map((todo) => renderTodoLine(todo, theme));
	lines.push(theme.fg("muted", `... +${todos.length - shown} more`));
	return lines;
}

/** Show the list above the editor while todos are open, and `done/total` in the status bar while the list is non-empty. */
export function syncTodoUi(ctx: ExtensionContext, todos: readonly Todo[], maxLines: number): void {
	if (!ctx.hasUI) return;
	const lines = openTodos(todos).length > 0 ? renderTodoLines(todos, ctx.ui.theme, maxLines) : undefined;
	ctx.ui.setWidget(TODO_UI_KEY, lines);
	ctx.ui.setStatus(TODO_UI_KEY, todos.length > 0 ? todoProgress(todos) : undefined);
}

/** `/todos`: show the full list of the current branch until the user closes it. */
export async function showTodoList(ctx: ExtensionCommandContext, todos: readonly Todo[]): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/todos is available in interactive mode", "warning");
		return;
	}
	await ctx.ui.custom<void>((_tui, theme, keybindings, done) => createTodoListView(todos, theme, keybindings, done));
}

function createTodoListView(
	todos: readonly Todo[],
	theme: Theme,
	keybindings: KeybindingsManager,
	close: () => void,
): Component {
	const view = new Container();
	const title = todos.length > 0 ? `Todos ${todoProgress(todos)}` : "Todos";
	const body =
		todos.length > 0 ? renderTodoLines(todos, theme).join("\n") : theme.fg("dim", "No todos on this branch.");
	view.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	view.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
	view.addChild(new Text(body, 1, 1));
	view.addChild(new Text(keyHint("tui.select.cancel", "close"), 1, 0));
	view.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
	return {
		render: (width) => view.render(width),
		invalidate: () => view.invalidate(),
		handleInput: (data) => {
			if (keybindings.matches(data, "tui.select.cancel")) close();
		},
	};
}
