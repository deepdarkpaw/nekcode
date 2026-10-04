/** Panels above the input (todos, subagents, widgets), the footer, and toasts. */

import { BoxRenderable, type CliRenderer, type TextChunk, TextRenderable } from "@opentui/core";
import { formatAgo, formatElapsed, formatTokens, shortenHome } from "../state/format.ts";
import { runningSubagents } from "../state/reducer.ts";
import type { SubagentView, Toast, TodoItem, ViewState } from "../state/types.ts";
import type { Palette } from "../theme/palette.ts";
import { chunk, styled } from "./styled.ts";

/** Todo rows shown at once; the rest are summarized. */
const MAX_TODO_ROWS = 8;
const MAX_SUBAGENT_ROWS = 4;

const TODO_GLYPH: Record<TodoItem["status"], string> = {
	pending: "○",
	in_progress: "◐",
	completed: "●",
	cancelled: "⊘",
};

function newline(palette: Palette): TextChunk {
	return chunk("\n", { color: palette.text });
}

/** Visible window of todos: everything unfinished first in order, completed ones trimmed from the top. */
function visibleTodos(todos: readonly TodoItem[]): { rows: TodoItem[]; hidden: number } {
	if (todos.length <= MAX_TODO_ROWS) return { rows: [...todos], hidden: 0 };
	const current = todos.findIndex((todo) => todo.status === "in_progress" || todo.status === "pending");
	const start = Math.max(
		0,
		Math.min(current === -1 ? todos.length - MAX_TODO_ROWS : current - 1, todos.length - MAX_TODO_ROWS),
	);
	return { rows: todos.slice(start, start + MAX_TODO_ROWS), hidden: todos.length - MAX_TODO_ROWS };
}

export function todoChunks(palette: Palette, todos: readonly TodoItem[]): TextChunk[] {
	const done = todos.filter((todo) => todo.status === "completed").length;
	const chunks: TextChunk[] = [
		chunk("Todos", { color: palette.toolTitle, bold: true }),
		chunk(`  ${done}/${todos.length} done`, { color: palette.muted }),
	];
	const { rows, hidden } = visibleTodos(todos);
	for (const todo of rows) {
		const color =
			todo.status === "in_progress" ? palette.text : todo.status === "pending" ? palette.toolOutput : palette.dim;
		const glyphColor =
			todo.status === "in_progress" ? palette.accent : todo.status === "completed" ? palette.success : palette.dim;
		chunks.push(newline(palette), chunk(`${TODO_GLYPH[todo.status]} `, { color: glyphColor }));
		chunks.push(chunk(todo.content, { color, bold: todo.status === "in_progress" }));
	}
	if (hidden > 0) chunks.push(newline(palette), chunk(`  … ${hidden} more`, { color: palette.dim }));
	return chunks;
}

function subagentTokens(subagent: SubagentView): string | undefined {
	if (subagent.usage) return `↑${formatTokens(subagent.usage.input)} ↓${formatTokens(subagent.usage.output)}`;
	if (subagent.totalTokens !== undefined) return `${formatTokens(subagent.totalTokens)} tok`;
	return undefined;
}

export function subagentChunks(palette: Palette, subagents: readonly SubagentView[], now: number): TextChunk[] {
	const chunks: TextChunk[] = [
		chunk("Subagents", { color: palette.toolTitle, bold: true }),
		chunk(`  ${subagents.length} running`, { color: palette.muted }),
	];
	for (const subagent of subagents.slice(0, MAX_SUBAGENT_ROWS)) {
		const model = subagent.model?.split("/").pop();
		const meta = [
			model,
			subagent.type,
			subagentTokens(subagent),
			subagent.startedAt !== undefined ? formatElapsed(now - subagent.startedAt) : undefined,
		].filter((part): part is string => part !== undefined && part !== "");
		chunks.push(newline(palette), chunk("◐ ", { color: palette.accent }));
		chunks.push(chunk(subagent.description || subagent.type, { color: palette.text }));
		chunks.push(chunk(`  ${meta.join(" · ")}`, { color: palette.muted }));
		if (subagent.activity) {
			const ago = subagent.lastActivityAt !== undefined ? ` · ${formatAgo(now - subagent.lastActivityAt)}` : "";
			chunks.push(newline(palette), chunk(`  ${subagent.activity}${ago}`, { color: palette.dim }));
		}
	}
	if (subagents.length > MAX_SUBAGENT_ROWS) {
		chunks.push(newline(palette), chunk(`  … ${subagents.length - MAX_SUBAGENT_ROWS} more`, { color: palette.dim }));
	}
	return chunks;
}

/** One rounded panel with a text body. Hidden when it has no content. */
class Panel {
	readonly root: BoxRenderable;
	private readonly text: TextRenderable;

	constructor(renderer: CliRenderer, palette: Palette, id: string) {
		this.root = new BoxRenderable(renderer, {
			id,
			border: true,
			borderStyle: "rounded",
			borderColor: palette.borderMuted,
			backgroundColor: palette.panel,
			paddingX: 1,
			marginTop: 1,
			flexShrink: 0,
			visible: false,
		});
		this.text = new TextRenderable(renderer, { id: `${id}-text`, wrapMode: "none", truncate: true });
		this.root.add(this.text);
	}

	set(chunks: TextChunk[] | undefined): void {
		this.root.visible = chunks !== undefined;
		if (chunks) this.text.content = styled(chunks);
	}
}

/** The stack of panels between the transcript and the input. */
export class PanelStack {
	readonly root: BoxRenderable;
	private readonly todos: Panel;
	private readonly subagents: Panel;
	private readonly widgets: Panel;
	private readonly queue: TextRenderable;
	private readonly palette: Palette;

	constructor(renderer: CliRenderer, palette: Palette) {
		this.palette = palette;
		this.root = new BoxRenderable(renderer, { id: "panels", flexDirection: "column", flexShrink: 0, paddingX: 1 });
		this.widgets = new Panel(renderer, palette, "panel-widgets");
		this.subagents = new Panel(renderer, palette, "panel-subagents");
		this.todos = new Panel(renderer, palette, "panel-todos");
		this.queue = new TextRenderable(renderer, {
			id: "queue",
			wrapMode: "none",
			truncate: true,
			visible: false,
			paddingX: 1,
		});
		this.root.add(this.widgets.root);
		this.root.add(this.subagents.root);
		this.root.add(this.todos.root);
		this.root.add(this.queue);
	}

	update(state: ViewState, now: number): void {
		const palette = this.palette;
		const showTodos =
			state.todos.length > 0 &&
			state.todos.some((todo) => todo.status !== "completed" && todo.status !== "cancelled");
		this.todos.set(showTodos ? todoChunks(palette, state.todos) : undefined);
		const running = runningSubagents(state);
		this.subagents.set(running.length > 0 ? subagentChunks(palette, running, now) : undefined);
		// The todo and subagent widgets of the built-in TUI are component factories, not sent over RPC.
		const widgetLines = Object.values(state.widgets)
			.filter((widget) => widget.placement === "aboveEditor")
			.flatMap((widget) => widget.lines);
		this.widgets.set(
			widgetLines.length > 0
				? widgetLines.flatMap((line, index) => [
						...(index > 0 ? [newline(palette)] : []),
						chunk(line, { color: palette.toolOutput }),
					])
				: undefined,
		);
		const queued = [
			...state.queue.steering.map((text) => ({ label: "steer", text })),
			...state.queue.followUp.map((text) => ({ label: "follow-up", text })),
		];
		this.queue.visible = queued.length > 0;
		if (queued.length > 0) {
			const chunks: TextChunk[] = [];
			for (const [index, entry] of queued.entries()) {
				if (index > 0) chunks.push(newline(palette));
				chunks.push(
					chunk(`↳ ${entry.label} `, { color: palette.dim }),
					chunk(entry.text.split("\n")[0] ?? "", { color: palette.muted }),
				);
			}
			this.queue.content = styled(chunks);
		}
	}
}

export interface FooterInfo {
	state: ViewState;
	home: string;
	hints: string;
}

export function footerChunks(palette: Palette, info: FooterInfo): { left: TextChunk[]; right: TextChunk[] } {
	const { state } = info;
	const { footer } = state;
	const plan = state.mode === "plan";
	const badge = chunk(plan ? " PLAN " : " AGENT ", { color: plan ? palette.warning : palette.accent, bold: true });
	const left: TextChunk[] = [badge, chunk(` ${shortenHome(state.cwd, info.home)}`, { color: palette.muted })];
	if (state.sessionName) left.push(chunk(` · ${state.sessionName}`, { color: palette.dim }));
	const right: TextChunk[] = [];
	if (footer.inputTokens > 0 || footer.outputTokens > 0) {
		right.push(
			chunk(`↑${formatTokens(footer.inputTokens)} ↓${formatTokens(footer.outputTokens)}`, { color: palette.dim }),
		);
	}
	if (footer.contextPercent !== undefined) {
		const percent = footer.contextPercent;
		const color = percent >= 90 ? palette.error : percent >= 70 ? palette.warning : palette.dim;
		const shown = percent > 0 && percent < 1 ? "<1" : percent.toFixed(0);
		right.push(chunk(`${right.length > 0 ? "  " : ""}${shown}% ctx`, { color }));
	}
	if (footer.model) {
		right.push(chunk(`${right.length > 0 ? "  " : ""}${footer.model}`, { color: palette.muted }));
		if (footer.thinkingLevel && footer.thinkingLevel !== "off") {
			right.push(chunk(` · ${footer.thinkingLevel}`, { color: palette.dim }));
		}
	}
	return { left, right };
}

export class Footer {
	readonly root: BoxRenderable;
	private readonly left: TextRenderable;
	private readonly right: TextRenderable;
	private readonly hints: TextRenderable;
	private readonly palette: Palette;

	constructor(renderer: CliRenderer, palette: Palette) {
		this.palette = palette;
		this.root = new BoxRenderable(renderer, {
			id: "footer",
			flexDirection: "column",
			flexShrink: 0,
			backgroundColor: palette.panel,
			paddingX: 1,
		});
		const row = new BoxRenderable(renderer, {
			id: "footer-row",
			flexDirection: "row",
			justifyContent: "space-between",
		});
		this.left = new TextRenderable(renderer, { id: "footer-left", wrapMode: "none", truncate: true, flexShrink: 1 });
		this.right = new TextRenderable(renderer, { id: "footer-right", wrapMode: "none", flexShrink: 0 });
		this.hints = new TextRenderable(renderer, { id: "footer-hints", wrapMode: "none", truncate: true });
		row.add(this.left);
		row.add(this.right);
		this.root.add(row);
		this.root.add(this.hints);
	}

	update(info: FooterInfo): void {
		const { left, right } = footerChunks(this.palette, info);
		this.left.content = styled(left);
		this.right.content = styled(right);
		this.hints.content = styled([chunk(info.hints, { color: this.palette.dim })]);
	}
}

/** Toasts in the top-right corner, newest last. */
export class Toasts {
	readonly root: BoxRenderable;
	private readonly renderer: CliRenderer;
	private readonly palette: Palette;
	private readonly views = new Map<string, BoxRenderable>();

	constructor(renderer: CliRenderer, palette: Palette) {
		this.renderer = renderer;
		this.palette = palette;
		this.root = new BoxRenderable(renderer, {
			id: "toasts",
			position: "absolute",
			top: 1,
			right: 2,
			flexDirection: "column",
			alignItems: "flex-end",
			zIndex: 50,
			maxWidth: "60%",
		});
	}

	update(toasts: readonly Toast[]): void {
		const ids = new Set(toasts.map((toast) => toast.id));
		for (const [id, view] of this.views) {
			if (ids.has(id)) continue;
			view.destroyRecursively();
			this.views.delete(id);
		}
		for (const toast of toasts) {
			if (this.views.has(toast.id)) continue;
			const palette = this.palette;
			const color =
				toast.level === "error" ? palette.error : toast.level === "warning" ? palette.warning : palette.accent;
			const box = new BoxRenderable(this.renderer, {
				id: `toast-${toast.id}`,
				border: true,
				borderStyle: "rounded",
				borderColor: color,
				backgroundColor: palette.raised,
				paddingX: 1,
				marginBottom: 0,
			});
			box.add(
				new TextRenderable(this.renderer, {
					id: `toast-${toast.id}-text`,
					content: styled([chunk(toast.text, { color: palette.text })]),
					wrapMode: "word",
				}),
			);
			this.views.set(toast.id, box);
			this.root.add(box);
		}
	}
}
