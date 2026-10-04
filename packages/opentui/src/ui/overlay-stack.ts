/**
 * Modal overlay stack.
 *
 * Every selector, dialog, and overlay-mode extension component opens through this stack. An
 * overlay is a renderable placed in a full-screen layer above the shell. The topmost visible
 * overlay sees every key first (`handleKey`), then its focused renderable; modal overlays (the
 * default) keep keys away from the layers below. Closing an overlay restores focus to the next
 * overlay or to whatever was focused before it opened.
 */

import { BoxRenderable, type CliRenderer, type KeyEvent, type Renderable } from "@opentui/core";

export type OverlayAnchor = "center" | "top" | "bottom";

export interface OverlayLayout {
	/** Width in cells or percent of the screen. Default `"70%"`, at most `maxWidth`. */
	width?: number | `${number}%`;
	/** Upper bound for the width in cells. Default 100. */
	maxWidth?: number;
	/** Lower bound for the width in cells. */
	minWidth?: number;
	/** Maximum height in cells or percent of the screen. Default `"85%"`. */
	maxHeight?: number | `${number}%`;
	/** Vertical placement. Default `"center"`. */
	anchor?: OverlayAnchor;
	/** Rows between the screen edge and a top/bottom anchored overlay. Default 1. */
	margin?: number;
}

export interface OverlayContent {
	/** The overlay's renderable (usually a `DialogFrame` root). Destroyed when the overlay closes. */
	readonly root: Renderable;
	/** Renderable that receives keyboard focus. Defaults to `root` when it is focusable. */
	readonly focusTarget?: Renderable;
	/** Sees every key while this overlay is on top, before the focused renderable. Return true to consume. */
	handleKey?(key: KeyEvent): boolean;
	/** Called once after the overlay is removed. */
	dispose?(): void;
	readonly layout?: OverlayLayout;
	/** Modal overlays (default) take focus and block keys to layers below. */
	readonly modal?: boolean;
}

export interface OverlayHandle {
	/** Remove the overlay. Idempotent. */
	close(): void;
	readonly isOpen: boolean;
	/** Bring the overlay to the front and focus it. */
	focus(): void;
	/** Temporarily hide or show the overlay. Hidden overlays get no keys. */
	setHidden(hidden: boolean): void;
	isHidden(): boolean;
}

interface OverlayEntry {
	readonly content: OverlayContent;
	readonly layer: BoxRenderable;
	readonly preFocus: Renderable | null;
	order: number;
	hidden: boolean;
	open: boolean;
}

const OVERLAY_Z_INDEX = 1000;

export class OverlayStack {
	private readonly renderer: CliRenderer;
	private readonly parent: Renderable;
	private readonly entries: OverlayEntry[] = [];
	private order = 0;
	private readonly listeners = new Set<() => void>();
	private readonly keyHandler = (key: KeyEvent): void => this.handleKey(key);

	constructor(renderer: CliRenderer, parent: Renderable) {
		this.renderer = renderer;
		this.parent = parent;
		this.renderer.keyInput.on("keypress", this.keyHandler);
	}

	/** Number of open overlays, hidden ones included. */
	get size(): number {
		return this.entries.length;
	}

	/** Whether a visible modal overlay is open. */
	hasModal(): boolean {
		return this.entries.some((entry) => !entry.hidden && entry.content.modal !== false);
	}

	/** Whether any visible overlay is open. */
	hasVisible(): boolean {
		return this.entries.some((entry) => !entry.hidden);
	}

	/** Called whenever an overlay opens, closes, or changes visibility. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	open(content: OverlayContent): OverlayHandle {
		const layer = new BoxRenderable(this.renderer, {
			position: "absolute",
			top: 0,
			left: 0,
			width: "100%",
			height: "100%",
			zIndex: OVERLAY_Z_INDEX + this.order + 1,
			flexDirection: "column",
			alignItems: "center",
			justifyContent: anchorJustify(content.layout?.anchor),
			paddingTop: content.layout?.anchor === "top" ? (content.layout.margin ?? 1) : 0,
			paddingBottom: content.layout?.anchor === "bottom" ? (content.layout.margin ?? 1) : 0,
		});
		applyLayout(content.root, content.layout);
		layer.add(content.root);
		const entry: OverlayEntry = {
			content,
			layer,
			preFocus: this.renderer.currentFocusedRenderable,
			order: ++this.order,
			hidden: false,
			open: true,
		};
		this.entries.push(entry);
		this.parent.add(layer);
		if (content.modal !== false) this.focusEntry(entry);
		this.emitChange();
		this.renderer.requestRender();
		return {
			close: () => this.close(entry),
			get isOpen() {
				return entry.open;
			},
			focus: () => {
				if (!entry.open || entry.hidden) return;
				entry.order = ++this.order;
				entry.layer.zIndex = OVERLAY_Z_INDEX + entry.order;
				this.focusEntry(entry);
				this.renderer.requestRender();
			},
			setHidden: (hidden) => {
				if (!entry.open || entry.hidden === hidden) return;
				entry.hidden = hidden;
				entry.layer.visible = !hidden;
				if (hidden) this.restoreFocusAfter(entry);
				else if (entry.content.modal !== false) this.focusEntry(entry);
				this.emitChange();
				this.renderer.requestRender();
			},
			isHidden: () => entry.hidden,
		};
	}

	/** Close the topmost visible overlay. */
	closeTop(): void {
		const top = this.topVisible();
		if (top) this.close(top);
	}

	/** Close every overlay (session switch, shutdown). */
	closeAll(): void {
		for (const entry of [...this.entries].reverse()) this.close(entry);
	}

	dispose(): void {
		this.closeAll();
		this.renderer.keyInput.off("keypress", this.keyHandler);
		this.listeners.clear();
	}

	private topVisible(): OverlayEntry | undefined {
		let top: OverlayEntry | undefined;
		for (const entry of this.entries) {
			if (entry.hidden) continue;
			if (!top || entry.order > top.order) top = entry;
		}
		return top;
	}

	private topVisibleModal(): OverlayEntry | undefined {
		let top: OverlayEntry | undefined;
		for (const entry of this.entries) {
			if (entry.hidden || entry.content.modal === false) continue;
			if (!top || entry.order > top.order) top = entry;
		}
		return top;
	}

	private close(entry: OverlayEntry): void {
		if (!entry.open) return;
		entry.open = false;
		const index = this.entries.indexOf(entry);
		if (index !== -1) this.entries.splice(index, 1);
		const hadFocus = this.containsFocus(entry);
		this.parent.remove(entry.layer);
		entry.layer.destroyRecursively();
		if (hadFocus || entry.content.modal !== false) this.restoreFocusAfter(entry);
		try {
			entry.content.dispose?.();
		} finally {
			this.emitChange();
			this.renderer.requestRender();
		}
	}

	private focusEntry(entry: OverlayEntry): void {
		const target = entry.content.focusTarget ?? (entry.content.root.focusable ? entry.content.root : undefined);
		if (target && !target.isDestroyed) {
			target.focus();
			return;
		}
		// Nothing focusable: blur the layer below so it does not receive keys.
		this.renderer.currentFocusedRenderable?.blur();
	}

	private restoreFocusAfter(entry: OverlayEntry): void {
		const next = this.topVisibleModal();
		if (next) {
			this.focusEntry(next);
			return;
		}
		const previous = entry.preFocus;
		if (previous && !previous.isDestroyed && !this.isInsideOverlay(previous)) previous.focus();
	}

	private containsFocus(entry: OverlayEntry): boolean {
		const focused = this.renderer.currentFocusedRenderable;
		return focused !== null && isDescendant(entry.layer, focused);
	}

	private isInsideOverlay(renderable: Renderable): boolean {
		return this.entries.some((entry) => isDescendant(entry.layer, renderable));
	}

	private handleKey(key: KeyEvent): void {
		const top = this.topVisible();
		if (!top) return;
		if (top.content.handleKey?.(key)) {
			key.preventDefault();
			key.stopPropagation();
			return;
		}
		if (top.content.modal === false) return;
		// Keep focus inside the modal: a key must never reach the layers below.
		if (!this.containsFocus(top)) {
			this.focusEntry(top);
			if (!this.containsFocus(top)) key.preventDefault();
		}
	}

	private emitChange(): void {
		for (const listener of this.listeners) listener();
	}
}

function anchorJustify(anchor: OverlayAnchor | undefined): "center" | "flex-start" | "flex-end" {
	if (anchor === "top") return "flex-start";
	if (anchor === "bottom") return "flex-end";
	return "center";
}

function applyLayout(root: Renderable, layout: OverlayLayout | undefined): void {
	root.width = layout?.width ?? "70%";
	root.maxWidth = layout?.maxWidth ?? 100;
	if (layout?.minWidth !== undefined) root.minWidth = layout.minWidth;
	root.maxHeight = layout?.maxHeight ?? "85%";
	root.flexShrink = 1;
}

function isDescendant(ancestor: Renderable, node: Renderable): boolean {
	let current: Renderable | null = node;
	while (current) {
		if (current === ancestor) return true;
		current = current.parent;
	}
	return false;
}
