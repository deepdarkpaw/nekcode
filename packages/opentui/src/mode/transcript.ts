/**
 * The transcript: a ScrollBox of blocks that follows new output.
 *
 * Blocks are native renderables or bridged pi-tui components. Spacing between blocks is a top
 * margin, so removing a block never leaves a stray spacer. A status line (`showStatus`) replaces the
 * previous status line when nothing was appended after it, like the interactive mode.
 */

import { getMarkdownTheme } from "@earendil-works/pi-coding-agent/modes/interactive/theme/theme";
import type { Component } from "@earendil-works/pi-tui";
import { Markdown } from "@earendil-works/pi-tui";
import {
	BoxRenderable,
	type CliRenderer,
	type Renderable,
	type ScrollBoxRenderable,
	TextAttributes,
	TextRenderable,
} from "@opentui/core";
import { ansiLinesToStyledText } from "../bridge/ansi.ts";
import { ComponentHostRenderable } from "../bridge/component-host.ts";
import type { FacadeTui } from "../bridge/facade-tui.ts";
import type { UiTheme } from "../theme/ui-theme.ts";
import type {
	NoticeTone,
	TranscriptApi,
	TranscriptBlockOptions,
	TranscriptMarkdownOptions,
	TranscriptTextOptions,
} from "./mode-context.ts";

const ESC = "\x1b";

export interface TranscriptViewOptions {
	renderer: CliRenderer;
	scrollBox: ScrollBoxRenderable;
	tui: FacadeTui;
	uiTheme: () => UiTheme;
	/** Rebuild the transcript from the session (the mode owns message rendering). */
	rebuild: () => void;
}

export class TranscriptView implements TranscriptApi {
	private readonly options: TranscriptViewOptions;
	private statusBlock: TextRenderable | undefined;

	constructor(options: TranscriptViewOptions) {
		this.options = options;
	}

	get blockCount(): number {
		return this.options.scrollBox.getChildren().length;
	}

	/** Blocks in order (for tests). */
	get blocks(): Renderable[] {
		return this.options.scrollBox.getChildren();
	}

	appendBlock(block: Renderable, options?: TranscriptBlockOptions): void {
		const scrollBox = this.options.scrollBox;
		const isFirst = scrollBox.getChildren().length === 0;
		block.marginTop = options?.spacing ?? (isFirst ? 0 : 1);
		block.flexShrink = 0;
		scrollBox.add(block);
		this.statusBlock = undefined;
		this.options.renderer.requestRender();
	}

	appendComponent(component: Component, options?: TranscriptBlockOptions): ComponentHostRenderable {
		const host = new ComponentHostRenderable(this.options.renderer, {
			component,
			tui: this.options.tui,
			focusable: false,
		});
		this.appendBlock(host, options);
		return host;
	}

	/** Remove a block (streaming components that end up empty). */
	removeBlock(block: Renderable): void {
		if (this.statusBlock === block) this.statusBlock = undefined;
		this.options.scrollBox.remove(block);
		block.destroyRecursively();
		this.options.renderer.requestRender();
	}

	appendText(text: string, options?: TranscriptTextOptions): void {
		this.appendBlock(this.createText(text, options), options);
	}

	appendMarkdown(markdown: string, options?: TranscriptMarkdownOptions): void {
		const theme = this.options.uiTheme();
		const container = new BoxRenderable(this.options.renderer, {
			flexDirection: "column",
			width: "100%",
			...(options?.bordered
				? { border: ["top", "bottom"] as const, borderStyle: "single" as const, borderColor: theme.borderMuted }
				: {}),
		});
		if (options?.title) {
			container.add(
				new TextRenderable(this.options.renderer, {
					content: options.title,
					fg: theme.accent,
					attributes: TextAttributes.BOLD,
					paddingX: 1,
					marginBottom: 1,
				}),
			);
		}
		container.add(
			new ComponentHostRenderable(this.options.renderer, {
				component: new Markdown(markdown.trim(), 1, 0, getMarkdownTheme()),
				tui: this.options.tui,
				focusable: false,
			}),
		);
		this.appendBlock(container, options);
	}

	/** Show a status line, replacing the previous one if it is still the last block. */
	showStatus(text: string): void {
		const status = this.statusBlock;
		if (status && !status.isDestroyed && this.isLastBlock(status)) {
			status.content = text;
			this.options.renderer.requestRender();
			return;
		}
		const block = this.createText(text, { tone: "dim" });
		this.appendBlock(block);
		this.statusBlock = block;
	}

	clear(): void {
		const scrollBox = this.options.scrollBox;
		for (const child of scrollBox.getChildren()) {
			scrollBox.remove(child);
			child.destroyRecursively();
		}
		this.statusBlock = undefined;
		this.options.renderer.requestRender();
	}

	rebuildFromSession(): void {
		this.clear();
		this.options.rebuild();
	}

	scrollToBottom(): void {
		const scrollBox = this.options.scrollBox;
		scrollBox.stickyScroll = true;
		scrollBox.scrollTo(scrollBox.scrollHeight);
		this.options.renderer.requestRender();
	}

	private isLastBlock(block: Renderable): boolean {
		const children = this.options.scrollBox.getChildren();
		return children[children.length - 1] === block;
	}

	private createText(text: string, options: TranscriptTextOptions | undefined): TextRenderable {
		const theme = this.options.uiTheme();
		const tone: NoticeTone = options?.tone ?? "text";
		return new TextRenderable(this.options.renderer, {
			content: text.includes(ESC) ? ansiLinesToStyledText(text.split("\n")) : text,
			fg: theme[tone],
			wrapMode: "word",
			selectable: true,
			paddingX: options?.paddingX ?? 1,
			width: "100%",
		});
	}
}
