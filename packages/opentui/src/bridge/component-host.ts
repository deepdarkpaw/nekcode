/**
 * OpenTUI renderable that hosts a pi-tui `Component`.
 *
 * The component renders ANSI lines for the host's layout width. The host parses them into styled
 * text (a selectable `TextRenderable`, so transcript selection includes bridged content), forwards
 * keys and pastes through the facade TUI's input pipeline to the focused pi-tui component, mirrors
 * focus to the facade TUI (so focusable components draw their cursor), and re-renders when the
 * width changes or the facade TUI receives a render request (spinners, async results).
 */

import type { Component } from "@earendil-works/pi-tui";
import {
	type KeyEvent,
	type PasteEvent,
	Renderable,
	type RenderableOptions,
	type RenderContext,
	type RGBA,
	TextRenderable,
} from "@opentui/core";
import { ansiLinesToStyledText, type LineHighlights, parseAnsiLine, parseAnsiLines } from "./ansi.ts";
import type { FacadeTui } from "./facade-tui.ts";
import { keyToSequence, pasteToSequence } from "./input.ts";

export interface ComponentHostOptions extends Omit<RenderableOptions<ComponentHostRenderable>, "width" | "height"> {
	component: Component;
	tui: FacadeTui;
	/** Foreground for text without an explicit color. */
	fg?: RGBA | string;
	/** Background behind the component's lines. Transparent by default. */
	bg?: RGBA | string;
	/** Width in cells or percent. Defaults to the full parent width. */
	width?: number | `${number}%`;
	/** Accept keyboard focus. Defaults to whether the component has `handleInput`. */
	focusable?: boolean;
	/** Call the component's `dispose()` when the host is destroyed. Defaults to true. */
	disposeComponent?: boolean;
	/** Allow mouse text selection. Defaults to true. */
	selectable?: boolean;
	/**
	 * Which pi-tui component becomes the facade's focused component when this host gains OpenTUI
	 * focus: `true` (default) for `component`, `false` for none, or a function for region hosts
	 * (the editor slot) whose focus target is a component inside them.
	 */
	syncFocus?: boolean | (() => Component | null);
	/**
	 * Hide leading and trailing full-width `─` rule lines. pi-tui selectors frame themselves with
	 * such rules; inside a rounded panel the panel border replaces them.
	 */
	trimRules?: boolean;
}

const RULE_LINE = /^─+$/;

function plainText(line: string): string {
	return parseAnsiLine(line)
		.segments.map((segment) => segment.text)
		.join("")
		.trim();
}

/**
 * `lines` without the outer rule lines (see `ComponentHostOptions.trimRules`): leading rules and
 * the blank lines before them, and trailing rules and the blank lines after them. Blank lines
 * between a rule and the content stay (they are the component's own padding).
 */
export function trimRuleLines(lines: readonly string[]): string[] {
	const text = lines.map(plainText);
	let start = 0;
	let end = lines.length;
	let next = start;
	while (next < end && text[next] === "") next++;
	if (next < end && RULE_LINE.test(text[next] ?? "")) {
		start = next;
		while (start < end && RULE_LINE.test(text[start] ?? "")) start++;
	}
	let previous = end;
	while (previous > start && text[previous - 1] === "") previous--;
	if (previous > start && RULE_LINE.test(text[previous - 1] ?? "")) {
		end = previous;
		while (end > start && RULE_LINE.test(text[end - 1] ?? "")) end--;
	}
	return lines.slice(start, end);
}

export class ComponentHostRenderable extends Renderable {
	readonly component: Component;
	private readonly tui: FacadeTui;
	private readonly text: TextRenderable;
	private readonly disposeComponent: boolean;
	private readonly focusTarget: (() => Component | null) | undefined;
	private readonly trimRules: boolean;
	private renderedWidth = -1;
	private renderedGeneration = -1;
	private seenInvalidation: number;
	private renderedKey = "";
	private forceRender = false;
	private lastLines: string[] = [];
	private highlights: LineHighlights | undefined;
	private contentVersion = 0;
	private cursorPosition: { row: number; col: number } | undefined;

	constructor(ctx: RenderContext, options: ComponentHostOptions) {
		const {
			component,
			tui,
			fg,
			bg,
			width,
			focusable,
			disposeComponent,
			selectable,
			syncFocus,
			trimRules,
			...renderableOptions
		}: ComponentHostOptions = options;
		super(ctx, {
			flexDirection: "column",
			flexShrink: 0,
			...renderableOptions,
			width: width ?? "100%",
			height: "auto",
		});
		this.component = component;
		this.tui = tui;
		this.disposeComponent = disposeComponent ?? true;
		this.trimRules = trimRules ?? false;
		this.focusTarget =
			typeof syncFocus === "function" ? syncFocus : syncFocus === false ? undefined : () => component;
		this.seenInvalidation = tui.invalidationGeneration;
		this._focusable = focusable ?? typeof component.handleInput === "function";
		this.text = new TextRenderable(ctx, {
			width: "100%",
			wrapMode: "none",
			selectable: selectable ?? true,
			...(fg === undefined ? {} : { fg }),
			...(bg === undefined ? {} : { bg }),
		});
		this.add(this.text);
		tui.registerHost(component, this);
		this.onLifecyclePass = () => this.refresh();
	}

	/** Lines from the last component render (with escape sequences). */
	get renderedLines(): readonly string[] {
		return this.lastLines;
	}

	/** Increments whenever the displayed lines change. */
	get version(): number {
		return this.contentVersion;
	}

	/** Cursor marker position from the last render, relative to the host. */
	get cursor(): { row: number; col: number } | undefined {
		return this.cursorPosition;
	}

	/** Plain text of the hosted lines (for tests and copy). */
	get plainText(): string {
		return this.text.plainText;
	}

	/** Draw cell ranges with an overriding style (search matches). Pass undefined to clear. */
	setHighlights(highlights: LineHighlights | undefined): void {
		if (!highlights && !this.highlights) return;
		this.highlights = highlights;
		this.renderedKey = "";
		this.forceRender = true;
		this.requestRender();
	}

	/** Re-render the component now if its width or the facade render generation changed. */
	refresh(): void {
		const width = Math.floor(this.width);
		if (width <= 0) return;
		const invalidation = this.tui.invalidationGeneration;
		if (invalidation !== this.seenInvalidation) {
			// `tui.invalidate()` (theme change): drop the component cache before rendering.
			this.seenInvalidation = invalidation;
			this.component.invalidate();
			this.forceRender = true;
		}
		const generation = this.tui.renderGeneration;
		if (!this.forceRender && width === this.renderedWidth && generation === this.renderedGeneration) return;
		const force = this.forceRender;
		this.forceRender = false;
		this.renderedWidth = width;
		this.renderedGeneration = generation;
		const lines = this.component.render(width);
		if (!force && lines === this.lastLines) return;
		this.lastLines = lines;
		const key = lines.join("\n");
		if (key === this.renderedKey) return;
		this.renderedKey = key;
		this.contentVersion++;
		const shown = this.trimRules ? trimRuleLines(lines) : lines;
		this.cursorPosition = parseAnsiLines(shown).cursor;
		this.text.content = ansiLinesToStyledText(shown, this.highlights);
	}

	/** Drop cached output: the component re-renders on the next frame. */
	invalidateComponent(): void {
		this.component.invalidate();
		this.forceRender = true;
		this.renderedKey = "";
		this.requestRender();
	}

	protected override onResize(width: number, height: number): void {
		super.onResize(width, height);
		if (Math.floor(width) !== this.renderedWidth) {
			// Resize runs during the render pass; render the new width on the next frame.
			process.nextTick(() => this.requestRender());
		}
	}

	override focus(): void {
		super.focus();
		if (this.focused && this.focusTarget) this.tui.syncFocus(this.focusTarget());
	}

	override blur(): void {
		super.blur();
		this.releaseFacadeFocus();
	}

	private releaseFacadeFocus(): void {
		if (!this.focusTarget) return;
		const focused = this.tui.getFocusedComponent();
		if (focused !== null && focused === this.focusTarget()) this.tui.syncFocus(null);
	}

	override handleKeyPress(key: KeyEvent): boolean {
		this.tui.feedInput(keyToSequence(key));
		return true;
	}

	override handlePaste(event: PasteEvent): void {
		event.preventDefault();
		const sequence = pasteToSequence(event);
		// Raw input listeners (extension `onTerminalInput`) see pastes too.
		const dispatch = this.tui.dispatchInput(sequence);
		if (dispatch.consumed) return;
		this.tui.feedInput(dispatch.data);
	}

	protected override destroySelf(): void {
		this.tui.unregisterHost(this.component, this);
		this.releaseFacadeFocus();
		if (this.disposeComponent) {
			const disposable = this.component as Component & { dispose?: () => void };
			disposable.dispose?.();
		}
		super.destroySelf();
	}
}
