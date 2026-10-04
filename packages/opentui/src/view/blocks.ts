/** Renderables for transcript blocks. Each view owns one block and updates in place when it changes. */

import {
	BoxRenderable,
	type CliRenderer,
	MarkdownRenderable,
	type Renderable,
	SyntaxStyle,
	type TextChunk,
	TextRenderable,
} from "@opentui/core";
import { formatElapsed } from "../state/format.ts";
import { describeToolCall, describeToolResult } from "../state/tool-display.ts";
import type { AssistantBlock, Block, NoticeBlock, ToolBlock, UserBlock } from "../state/types.ts";
import type { Palette } from "../theme/palette.ts";
import { chunk, segmentChunks, styled } from "./styled.ts";

export interface BlockContext {
	renderer: CliRenderer;
	palette: Palette;
	syntax: SyntaxStyle;
	cwd: string;
	now: number;
	toolExpanded: (id: string) => boolean;
	thinkingExpanded: boolean;
	/** Hint for expanding collapsed rows, such as `Ctrl+O`. */
	expandKey: string;
	thinkingKey: string;
	onToggle: (id: string) => void;
}

export function createMarkdownSyntax(palette: Palette): SyntaxStyle {
	return SyntaxStyle.fromStyles({
		default: { fg: palette.text },
		conceal: { fg: palette.dim },
		"markup.heading": { fg: palette.heading, bold: true },
		"markup.strong": { bold: true },
		"markup.italic": { italic: true },
		"markup.strikethrough": { dim: true },
		"markup.raw": { fg: palette.code },
		"markup.raw.block": { fg: palette.text },
		"markup.link": { fg: palette.link, underline: true },
		"markup.link.label": { fg: palette.link },
		"markup.link.url": { fg: palette.dim },
		"markup.quote": { fg: palette.quote, italic: true },
		"markup.list": { fg: palette.accent },
	});
}

export interface BlockView {
	readonly root: Renderable;
	update(block: Block, ctx: BlockContext): void;
	destroy(): void;
}

let renderableSeq = 0;
function rid(prefix: string): string {
	renderableSeq++;
	return `${prefix}-${renderableSeq}`;
}

// ============================================================================
// User
// ============================================================================

class UserView implements BlockView {
	readonly root: BoxRenderable;
	private readonly text: TextRenderable;
	private last: UserBlock | undefined;

	constructor(ctx: BlockContext) {
		const { renderer, palette } = ctx;
		this.root = new BoxRenderable(renderer, {
			id: rid("user"),
			marginTop: 1,
			border: ["left"],
			borderStyle: "heavy",
			borderColor: palette.accent,
			backgroundColor: palette.userBg,
			paddingX: 1,
			flexShrink: 0,
		});
		this.text = new TextRenderable(renderer, { id: rid("user-text"), fg: palette.text, wrapMode: "word" });
		this.root.add(this.text);
	}

	update(block: Block, ctx: BlockContext): void {
		if (block.kind !== "user" || block === this.last) return;
		this.last = block;
		const chunks = [chunk(block.text, { color: ctx.palette.text })];
		if (block.images > 0) {
			chunks.push(chunk(`  [${block.images} image${block.images === 1 ? "" : "s"}]`, { color: ctx.palette.muted }));
		}
		this.text.content = styled(chunks);
	}

	destroy(): void {
		this.root.destroyRecursively();
	}
}

// ============================================================================
// Assistant: markdown text and collapsible thinking
// ============================================================================

interface PartView {
	type: "text" | "thinking";
	renderable: MarkdownRenderable | TextRenderable;
	text: string;
	streaming: boolean;
	expanded: boolean;
}

class AssistantView implements BlockView {
	readonly root: BoxRenderable;
	private readonly parts = new Map<number, PartView>();
	private errorText: TextRenderable | undefined;
	private last: AssistantBlock | undefined;
	private lastThinkingExpanded: boolean | undefined;

	constructor(ctx: BlockContext) {
		this.root = new BoxRenderable(ctx.renderer, {
			id: rid("assistant"),
			marginTop: 1,
			flexDirection: "column",
			paddingX: 1,
			flexShrink: 0,
		});
	}

	update(block: Block, ctx: BlockContext): void {
		if (block.kind !== "assistant") return;
		if (block === this.last && ctx.thinkingExpanded === this.lastThinkingExpanded) return;
		this.last = block;
		this.lastThinkingExpanded = ctx.thinkingExpanded;
		for (const part of block.parts) {
			const existing = this.parts.get(part.index);
			if (part.type === "text") this.updateText(part.index, part.text, block.streaming, existing, ctx);
			else this.updateThinking(part.index, part.text, block.streaming, existing, ctx);
		}
		this.updateError(block.error, ctx);
		this.root.visible = block.parts.some((part) => part.text.trim() !== "") || block.error !== undefined;
	}

	private updateText(
		index: number,
		text: string,
		streaming: boolean,
		existing: PartView | undefined,
		ctx: BlockContext,
	): void {
		if (existing && existing.renderable instanceof MarkdownRenderable) {
			if (existing.text !== text) existing.renderable.content = text;
			if (existing.streaming !== streaming) existing.renderable.streaming = streaming;
			existing.text = text;
			existing.streaming = streaming;
			return;
		}
		const renderable = new MarkdownRenderable(ctx.renderer, {
			id: rid("md"),
			content: text,
			syntaxStyle: ctx.syntax,
			streaming,
			fg: ctx.palette.text,
			conceal: true,
		});
		this.insertPart(index, { type: "text", renderable, text, streaming, expanded: false });
	}

	private updateThinking(
		index: number,
		text: string,
		streaming: boolean,
		existing: PartView | undefined,
		ctx: BlockContext,
	): void {
		const { palette } = ctx;
		const expanded = ctx.thinkingExpanded;
		const body = text.trim();
		const lines = body === "" ? 0 : body.split("\n").length;
		const content = expanded
			? styled([chunk(body, { color: palette.thinking, italic: true })])
			: styled([
					chunk(streaming ? "Thinking…" : "Thought", { color: palette.thinking, italic: true }),
					chunk(` · ${lines} line${lines === 1 ? "" : "s"} · ${ctx.thinkingKey} to show`, { color: palette.dim }),
				]);
		if (existing && existing.renderable instanceof TextRenderable) {
			if (existing.text !== text || existing.expanded !== expanded || existing.streaming !== streaming) {
				existing.renderable.content = content;
				existing.renderable.wrapMode = expanded ? "word" : "none";
			}
			existing.text = text;
			existing.expanded = expanded;
			existing.streaming = streaming;
			existing.renderable.visible = body !== "";
			return;
		}
		const renderable = new TextRenderable(ctx.renderer, {
			id: rid("thinking"),
			content,
			wrapMode: expanded ? "word" : "none",
			truncate: true,
			visible: body !== "",
		});
		this.insertPart(index, { type: "thinking", renderable, text, streaming, expanded });
	}

	private insertPart(index: number, view: PartView): void {
		this.parts.set(index, view);
		const later = [...this.parts.entries()].filter(([other]) => other > index).sort((a, b) => a[0] - b[0])[0];
		if (later) this.root.insertBefore(view.renderable, later[1].renderable);
		else if (this.errorText) this.root.insertBefore(view.renderable, this.errorText);
		else this.root.add(view.renderable);
	}

	private updateError(error: string | undefined, ctx: BlockContext): void {
		if (!error) {
			if (this.errorText) this.errorText.visible = false;
			return;
		}
		if (!this.errorText) {
			this.errorText = new TextRenderable(ctx.renderer, { id: rid("assistant-error"), wrapMode: "word" });
			this.root.add(this.errorText);
		}
		this.errorText.visible = true;
		this.errorText.content = styled([chunk(error, { color: ctx.palette.error })]);
	}

	destroy(): void {
		this.root.destroyRecursively();
	}
}

// ============================================================================
// Tool rows
// ============================================================================

const STATUS_GLYPH: Record<ToolBlock["status"], string> = {
	pending: "○",
	running: "◐",
	done: "●",
	error: "✕",
};

class ToolView implements BlockView {
	readonly root: BoxRenderable;
	private readonly header: TextRenderable;
	private readonly body: TextRenderable;
	private readonly hint: TextRenderable;
	private last: ToolBlock | undefined;
	private lastExpanded: boolean | undefined;
	private lastSecond: number | undefined;

	constructor(ctx: BlockContext, id: string) {
		const { renderer, palette } = ctx;
		this.root = new BoxRenderable(renderer, {
			id: rid("tool"),
			marginTop: 1,
			flexDirection: "column",
			border: ["left"],
			borderColor: palette.borderMuted,
			backgroundColor: palette.panel,
			paddingX: 1,
			flexShrink: 0,
			onMouseDown: () => ctx.onToggle(id),
		});
		this.header = new TextRenderable(renderer, { id: rid("tool-head"), wrapMode: "none", truncate: true });
		this.body = new TextRenderable(renderer, {
			id: rid("tool-body"),
			wrapMode: "none",
			truncate: true,
			visible: false,
		});
		this.hint = new TextRenderable(renderer, {
			id: rid("tool-hint"),
			wrapMode: "none",
			truncate: true,
			visible: false,
		});
		this.root.add(this.header);
		this.root.add(this.body);
		this.root.add(this.hint);
	}

	update(block: Block, ctx: BlockContext): void {
		if (block.kind !== "tool") return;
		const expanded = ctx.toolExpanded(block.id);
		// Running rows tick once per second for the elapsed time.
		const second = block.status === "running" ? Math.floor(ctx.now / 1000) : undefined;
		if (block === this.last && expanded === this.lastExpanded && second === this.lastSecond) return;
		this.last = block;
		this.lastExpanded = expanded;
		this.lastSecond = second;
		const { palette } = ctx;

		const statusColor =
			block.status === "error"
				? palette.error
				: block.status === "running"
					? palette.accent
					: block.status === "done"
						? palette.dim
						: palette.borderMuted;
		this.root.borderColor =
			block.status === "error" ? palette.error : block.status === "running" ? palette.accent : palette.borderMuted;

		const header = describeToolCall(block.name, block.args, ctx.cwd);
		const chunks: TextChunk[] = [
			chunk(`${STATUS_GLYPH[block.status]} `, { color: statusColor }),
			chunk(header.name, { color: header.nameTone === "link" ? palette.link : palette.toolTitle, bold: true }),
		];
		if (header.arg) chunks.push(chunk(" ", { color: palette.text }), ...segmentChunks(palette, [header.arg]));
		const meta = [...header.meta];
		if (
			block.startedAt !== undefined &&
			(block.status === "running" || (block.endedAt ?? 0) - block.startedAt >= 1000)
		) {
			meta.push(formatElapsed((block.endedAt ?? ctx.now) - block.startedAt));
		}
		if (meta.length > 0) chunks.push(chunk(`  ${meta.join(" · ")}`, { color: palette.muted }));
		this.header.content = styled(chunks);

		const preview = describeToolResult(block, expanded);
		if (preview.lines.length === 0) {
			this.body.visible = false;
		} else {
			const bodyChunks: TextChunk[] = [];
			for (const [index, line] of preview.lines.entries()) {
				if (index > 0) bodyChunks.push(chunk("\n", { color: palette.text }));
				bodyChunks.push(...segmentChunks(palette, line));
			}
			this.body.content = styled(bodyChunks);
			this.body.wrapMode = expanded ? "char" : "none";
			this.body.visible = true;
		}
		if (preview.hidden > 0) {
			this.hint.content = styled([
				chunk(
					`… ${preview.hidden} ${preview.hiddenAt === "start" ? "earlier" : "more"} line${preview.hidden === 1 ? "" : "s"} · ${ctx.expandKey} or click to expand`,
					{
						color: palette.dim,
					},
				),
			]);
			this.hint.visible = true;
			// Shell output keeps its last lines, so the hint about earlier ones goes above them.
			this.root.remove(this.hint);
			if (preview.hiddenAt === "start") this.root.insertBefore(this.hint, this.body);
			else this.root.add(this.hint);
		} else {
			this.hint.visible = false;
		}
	}

	destroy(): void {
		this.root.destroyRecursively();
	}
}

// ============================================================================
// Notices
// ============================================================================

class NoticeView implements BlockView {
	readonly root: TextRenderable;
	private last: NoticeBlock | undefined;

	constructor(ctx: BlockContext) {
		this.root = new TextRenderable(ctx.renderer, {
			id: rid("notice"),
			marginTop: 1,
			paddingX: 1,
			wrapMode: "word",
			flexShrink: 0,
		});
	}

	update(block: Block, ctx: BlockContext): void {
		if (block.kind !== "notice" || block === this.last) return;
		this.last = block;
		const { palette } = ctx;
		const color =
			block.level === "error" ? palette.error : block.level === "warning" ? palette.warning : palette.muted;
		const chunks: TextChunk[] = [];
		if (block.label) chunks.push(chunk(`${block.label} `, { color: palette.dim }));
		chunks.push(chunk(block.text, { color }));
		this.root.content = styled(chunks);
	}

	destroy(): void {
		this.root.destroyRecursively();
	}
}

export function createBlockView(block: Block, ctx: BlockContext): BlockView {
	switch (block.kind) {
		case "user":
			return new UserView(ctx);
		case "assistant":
			return new AssistantView(ctx);
		case "tool":
			return new ToolView(ctx, block.id);
		case "notice":
			return new NoticeView(ctx);
	}
}
