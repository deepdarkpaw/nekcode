/**
 * The transcript: the scrolling document (startup header, loaded resources, chat) in the shell's
 * ScrollBox.
 *
 * The document follows the interactive mode's `documentContainer`: a header container, a
 * loaded-resources container, and the chat. The chat is a `ChatList` (one bridge host per block)
 * that the mode fills with the same components, spacers, and notices as the interactive mode. The
 * `TranscriptApi` methods used by commands append pi-tui `Text`/`Markdown` blocks, so everything in
 * the transcript is searchable and selectable the same way.
 */

import { DynamicBorder } from "@earendil-works/pi-coding-agent/modes/interactive/components/dynamic-border";
import { getMarkdownTheme, theme } from "@earendil-works/pi-coding-agent/modes/interactive/theme/theme";
import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import type { CliRenderer, Renderable, ScrollBoxRenderable } from "@opentui/core";
import { ComponentHostRenderable } from "../bridge/component-host.ts";
import type { FacadeTui } from "../bridge/facade-tui.ts";
import { ChatList } from "./chat-list.ts";
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
	/** Rebuild the chat from the session (the mode owns message rendering). */
	rebuild: () => void;
	/** Scroll to the newest content and follow output again. */
	scrollToBottom: () => void;
	/** Code block indent for markdown blocks. */
	codeBlockIndent: () => string;
}

const TONE_COLORS: Record<Exclude<NoticeTone, "text">, Parameters<typeof theme.fg>[0]> = {
	muted: "muted",
	dim: "dim",
	accent: "accent",
	success: "success",
	warning: "warning",
	error: "error",
};

export class TranscriptView implements TranscriptApi {
	/** Built-in or extension header (`setHeader`). */
	readonly headerContainer = new Container();
	/** Loaded resources and diagnostics; not cleared with the chat. */
	readonly resourcesContainer = new Container();
	readonly chat: ChatList;
	private readonly options: TranscriptViewOptions;
	private readonly headerHost: ComponentHostRenderable;
	private readonly resourcesHost: ComponentHostRenderable;
	private lastStatusSpacer: Spacer | undefined;
	private lastStatusText: Text | undefined;

	constructor(options: TranscriptViewOptions) {
		this.options = options;
		const host = (component: Component) =>
			new ComponentHostRenderable(options.renderer, {
				component,
				tui: options.tui,
				focusable: false,
				syncFocus: false,
				disposeComponent: false,
			});
		this.headerHost = host(this.headerContainer);
		this.resourcesHost = host(this.resourcesContainer);
		options.scrollBox.add(this.headerHost);
		options.scrollBox.add(this.resourcesHost);
		this.chat = new ChatList(options.renderer, options.scrollBox, options.tui);
	}

	/** Every transcript host in display order (search, prompt jumps, debug output). */
	hosts(): ComponentHostRenderable[] {
		return [this.headerHost, this.resourcesHost, ...this.chat.hosts];
	}

	/** Rendered transcript lines (debug log, exit output). */
	renderedLines(): string[] {
		return this.hosts().flatMap((host) => [...host.renderedLines]);
	}

	appendBlock(block: Renderable, options?: TranscriptBlockOptions): void {
		this.addSpacing(options);
		this.chat.addRenderable(block);
	}

	appendComponent(component: Component, options?: TranscriptBlockOptions): ComponentHostRenderable {
		this.addSpacing(options);
		return this.chat.addChild(component);
	}

	appendText(text: string, options?: TranscriptTextOptions): void {
		this.appendComponent(new Text(this.colorize(text, options?.tone), options?.paddingX ?? 1, 0), options);
	}

	appendMarkdown(markdown: string, options?: TranscriptMarkdownOptions): void {
		this.addSpacing(options);
		if (options?.bordered) this.chat.addChild(new DynamicBorder());
		if (options?.title) {
			this.chat.addChild(new Text(theme.bold(theme.fg("accent", options.title)), 1, 0));
			this.chat.addChild(new Spacer(1));
		}
		const markdownTheme = { ...getMarkdownTheme(), codeBlockIndent: this.options.codeBlockIndent() };
		this.chat.addChild(new Markdown(markdown.trim(), 1, 0, markdownTheme));
		if (options?.bordered) {
			this.chat.addChild(new Spacer(1));
			this.chat.addChild(new DynamicBorder());
		}
	}

	/**
	 * Dim status line. Back-to-back status lines (nothing appended in between) replace each other,
	 * like the interactive mode.
	 */
	showStatus(message: string): void {
		const children = this.chat.children;
		const last = children[children.length - 1];
		const secondLast = children[children.length - 2];
		const statusText = this.lastStatusText;
		if (statusText && this.chat.last === last && last === statusText && secondLast === this.lastStatusSpacer) {
			statusText.setText(theme.fg("dim", message));
			this.options.tui.requestRender();
			return;
		}
		const spacer = new Spacer(1);
		const text = new Text(theme.fg("dim", message), 1, 0);
		this.chat.addChild(spacer);
		this.chat.addChild(text);
		this.lastStatusSpacer = spacer;
		this.lastStatusText = text;
	}

	/** Whether `component` is the latest status line, which the next status replaces in place. */
	isReplaceableStatus(component: Component): boolean {
		return component === this.lastStatusText && this.chat.last === component;
	}

	/** Forget the status line so the next status appends (managed-tool output). */
	resetStatusLine(): void {
		this.lastStatusSpacer = undefined;
		this.lastStatusText = undefined;
	}

	clear(): void {
		this.chat.clear();
		this.resetStatusLine();
	}

	rebuildFromSession(): void {
		this.clear();
		this.options.rebuild();
	}

	scrollToBottom(): void {
		this.options.scrollToBottom();
	}

	private addSpacing(options: TranscriptBlockOptions | undefined): void {
		const spacing = options?.spacing ?? (this.chat.length === 0 ? 0 : 1);
		if (spacing > 0) this.chat.addChild(new Spacer(spacing));
	}

	private colorize(text: string, tone: NoticeTone | undefined): string {
		if (text.includes(ESC) || tone === undefined || tone === "text") return text;
		return theme.fg(TONE_COLORS[tone], text);
	}
}
