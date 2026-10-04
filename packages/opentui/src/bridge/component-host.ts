/**
 * OpenTUI renderable that hosts a pi-tui `Component`.
 *
 * The component renders ANSI lines for the host's layout width. The host parses them into styled
 * text (a selectable `TextRenderable`, so transcript selection includes bridged content), forwards
 * keys and pastes as raw sequences to `handleInput`, mirrors focus to the facade TUI (so focusable
 * components draw their cursor), and re-renders when the width changes or the facade TUI receives a
 * render request (spinners, async results).
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
import { ansiLinesToStyledText, parseAnsiLines } from "./ansi.ts";
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
}

export class ComponentHostRenderable extends Renderable {
	readonly component: Component;
	private readonly tui: FacadeTui;
	private readonly text: TextRenderable;
	private readonly disposeComponent: boolean;
	private renderedWidth = -1;
	private renderedGeneration = -1;
	private seenInvalidation: number;
	private renderedKey = "";
	private forceRender = false;
	private lastLines: string[] = [];
	private cursorPosition: { row: number; col: number } | undefined;

	constructor(ctx: RenderContext, options: ComponentHostOptions) {
		const { component, tui, fg, bg, width, focusable, disposeComponent, ...renderableOptions }: ComponentHostOptions =
			options;
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
		this.seenInvalidation = tui.invalidationGeneration;
		this._focusable = focusable ?? typeof component.handleInput === "function";
		this.text = new TextRenderable(ctx, {
			width: "100%",
			wrapMode: "none",
			selectable: true,
			...(fg === undefined ? {} : { fg }),
			...(bg === undefined ? {} : { bg }),
		});
		this.add(this.text);
		this.onLifecyclePass = () => this.refresh();
	}

	/** Lines from the last component render (with escape sequences). */
	get renderedLines(): readonly string[] {
		return this.lastLines;
	}

	/** Cursor marker position from the last render, relative to the host. */
	get cursor(): { row: number; col: number } | undefined {
		return this.cursorPosition;
	}

	/** Plain text of the hosted lines (for tests and copy). */
	get plainText(): string {
		return this.text.plainText;
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
		this.forceRender = false;
		this.renderedWidth = width;
		this.renderedGeneration = generation;
		const lines = this.component.render(width);
		this.lastLines = lines;
		const key = lines.join("\n");
		if (key === this.renderedKey) return;
		this.renderedKey = key;
		this.cursorPosition = parseAnsiLines(lines).cursor;
		this.text.content = ansiLinesToStyledText(lines);
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
		if (this.focused) this.tui.syncFocus(this.component);
	}

	override blur(): void {
		super.blur();
		if (this.tui.getFocusedComponent() === this.component) this.tui.syncFocus(null);
	}

	override handleKeyPress(key: KeyEvent): boolean {
		const handleInput = this.component.handleInput;
		if (!handleInput) return false;
		handleInput.call(this.component, keyToSequence(key));
		this.tui.requestRender();
		return true;
	}

	override handlePaste(event: PasteEvent): void {
		const handleInput = this.component.handleInput;
		if (!handleInput) return;
		event.preventDefault();
		handleInput.call(this.component, pasteToSequence(event));
		this.tui.requestRender();
	}

	protected override destroySelf(): void {
		if (this.tui.getFocusedComponent() === this.component) this.tui.syncFocus(null);
		if (this.disposeComponent) {
			const disposable = this.component as Component & { dispose?: () => void };
			disposable.dispose?.();
		}
		super.destroySelf();
	}
}
