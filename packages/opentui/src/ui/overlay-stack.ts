/**
 * Modal overlay stack.
 *
 * Every selector, dialog, and overlay-mode extension component opens through this stack. An
 * overlay is a renderable placed in a layer above the shell. The topmost visible overlay sees every
 * key first (`handleKey`), then its focused renderable; modal overlays (the default) keep keys away
 * from the layers below. Closing an overlay restores focus to the next overlay or to whatever was
 * focused before it opened.
 *
 * Layers with a backdrop cover the whole screen (mouse input stays inside the dialog). Layers
 * without one only cover the overlay's own rows, so the transcript below keeps scrolling with the
 * mouse wheel (the transcript search bar, pi-tui overlays).
 */

import { BoxRenderable, type CliRenderer, type KeyEvent, type Renderable } from "@opentui/core";

export type OverlayAnchor = "center" | "top" | "bottom";
export type OverlayAlign = "left" | "center" | "right";
export type OverlaySize = number | `${number}%`;

export interface OverlayMargins {
	top?: number;
	right?: number;
	bottom?: number;
	left?: number;
}

export interface OverlayLayout {
	/** Width in cells or percent of the screen. Default `"70%"`, at most `maxWidth`. */
	width?: OverlaySize;
	/** Upper bound for the width in cells. Default 100. */
	maxWidth?: number;
	/** Lower bound for the width in cells. */
	minWidth?: number;
	/** Maximum height in cells or percent of the screen. Default `"85%"`. */
	maxHeight?: OverlaySize;
	/** Vertical placement. Default `"center"`. */
	anchor?: OverlayAnchor;
	/** Horizontal placement. Default `"center"`. */
	align?: OverlayAlign;
	/** Cells between the screen edges and the overlay. A number applies to all sides (default 1 vertically). */
	margin?: number | OverlayMargins;
	/** Shift from the anchored position (positive = right/down). */
	offsetX?: number;
	offsetY?: number;
	/** Absolute row (cells or percent); overrides the vertical anchor. */
	row?: OverlaySize;
	/** Absolute column (cells or percent); overrides the horizontal alignment. */
	col?: OverlaySize;
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
	/** Cover the whole screen so mouse input stays in the overlay. Default: same as `modal`. */
	readonly backdrop?: boolean;
}

export interface OverlayHandle {
	/** Remove the overlay. Idempotent. */
	close(): void;
	readonly isOpen: boolean;
	/** Bring the overlay to the front and focus it. */
	focus(): void;
	/** Give focus back to the layer below without hiding the overlay. */
	unfocus(): void;
	/** Whether keyboard focus is inside the overlay. */
	isFocused(): boolean;
	/** Temporarily hide or show the overlay. Hidden overlays get no keys. */
	setHidden(hidden: boolean): void;
	isHidden(): boolean;
	/** Screen rectangle of the overlay root from the last layout. */
	getBounds(): { row: number; col: number; width: number; height: number } | undefined;
}

interface OverlayEntry {
	readonly content: OverlayContent;
	readonly layer: BoxRenderable;
	readonly preFocus: Renderable | null;
	order: number;
	hidden: boolean;
	open: boolean;
	/** Released with `unfocus()`: keys go to the layers below until it is focused again. */
	released: boolean;
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

	/** Whether a visible modal overlay holds keyboard focus. */
	hasModal(): boolean {
		return this.entries.some((entry) => this.isActiveModal(entry));
	}

	/** Whether any visible overlay is open. */
	hasVisible(): boolean {
		return this.entries.some((entry) => !entry.hidden);
	}

	/** Content of the topmost visible overlay. */
	top(): OverlayContent | undefined {
		return this.topVisible()?.content;
	}

	/** Called whenever an overlay opens, closes, or changes visibility. */
	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	open(content: OverlayContent): OverlayHandle {
		const backdrop = content.backdrop ?? content.modal !== false;
		const layer = backdrop
			? createBackdropLayer(this.renderer, content, this.order + 1)
			: createPlacedLayer(this.renderer, content, this.order + 1);
		layer.add(content.root);
		const entry: OverlayEntry = {
			content,
			layer,
			preFocus: this.renderer.currentFocusedRenderable,
			order: ++this.order,
			hidden: false,
			open: true,
			released: content.modal === false,
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
				entry.released = false;
				entry.layer.zIndex = OVERLAY_Z_INDEX + entry.order;
				this.focusEntry(entry);
				this.renderer.requestRender();
			},
			unfocus: () => {
				if (!entry.open || entry.released) return;
				entry.released = true;
				this.restoreFocusAfter(entry);
				this.emitChange();
			},
			isFocused: () => entry.open && this.containsFocus(entry),
			setHidden: (hidden) => {
				if (!entry.open || entry.hidden === hidden) return;
				entry.hidden = hidden;
				entry.layer.visible = !hidden;
				if (hidden) this.restoreFocusAfter(entry);
				else if (entry.content.modal !== false && !entry.released) this.focusEntry(entry);
				this.emitChange();
				this.renderer.requestRender();
			},
			isHidden: () => entry.hidden,
			getBounds: () => {
				const root = entry.content.root;
				if (!entry.open || entry.hidden || root.isDestroyed) return undefined;
				return { row: root.y, col: root.x, width: root.width, height: root.height };
			},
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

	private isActiveModal(entry: OverlayEntry): boolean {
		return !entry.hidden && entry.content.modal !== false && !entry.released;
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
			if (!this.isActiveModal(entry)) continue;
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
		if (hadFocus || this.isActiveModal(entry)) this.restoreFocusAfter(entry);
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
		if (next && next !== entry) {
			this.focusEntry(next);
			return;
		}
		const previous = this.findRestoreTarget(entry);
		if (previous) previous.focus();
	}

	/** The pre-focus of `entry`, or of the overlays below it when that one is gone. */
	private findRestoreTarget(entry: OverlayEntry): Renderable | undefined {
		const candidates = [entry.preFocus, ...this.entries.map((other) => other.preFocus).reverse()];
		for (const candidate of candidates) {
			if (candidate && !candidate.isDestroyed && !this.isInsideOverlay(candidate)) return candidate;
		}
		return undefined;
	}

	private containsFocus(entry: OverlayEntry): boolean {
		const focused = this.renderer.currentFocusedRenderable;
		return focused !== null && isDescendant(entry.layer, focused);
	}

	private isInsideOverlay(renderable: Renderable): boolean {
		return this.entries.some((entry) => isDescendant(entry.layer, renderable));
	}

	private handleKey(key: KeyEvent): void {
		const top = this.topVisibleModal() ?? this.topVisible();
		if (!top) return;
		if (top.content.handleKey?.(key)) {
			key.preventDefault();
			key.stopPropagation();
			return;
		}
		if (!this.isActiveModal(top)) return;
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

function marginsOf(layout: OverlayLayout | undefined, backdrop: boolean): Required<OverlayMargins> {
	const margin = layout?.margin;
	if (typeof margin === "object") {
		return {
			top: Math.max(0, margin.top ?? 0),
			right: Math.max(0, margin.right ?? 0),
			bottom: Math.max(0, margin.bottom ?? 0),
			left: Math.max(0, margin.left ?? 0),
		};
	}
	// Dialogs keep one free row above and below by default.
	const vertical = Math.max(0, margin ?? (backdrop ? 1 : 0));
	const horizontal = Math.max(0, margin ?? 0);
	return { top: vertical, right: horizontal, bottom: vertical, left: horizontal };
}

function alignItems(align: OverlayAlign | undefined): "center" | "flex-start" | "flex-end" {
	if (align === "left") return "flex-start";
	if (align === "right") return "flex-end";
	return "center";
}

function justifyContent(anchor: OverlayAnchor | undefined): "center" | "flex-start" | "flex-end" {
	if (anchor === "top") return "flex-start";
	if (anchor === "bottom") return "flex-end";
	return "center";
}

/** Cells for a size relative to `total`. */
export function resolveOverlaySize(size: OverlaySize, total: number): number {
	if (typeof size === "number") return size;
	return Math.floor((total * Number.parseFloat(size)) / 100);
}

/** Screen rectangle of a placed (backdrop-free) overlay. */
export interface OverlayPlacement {
	row: number;
	col: number;
	width: number;
	maxHeight: number | undefined;
}

/**
 * Where a backdrop-free overlay goes, given its rendered height. Same rules as pi-tui overlays:
 * percent rows/columns keep the overlay inside the margins, anchors align inside the margins, and
 * offsets shift the result.
 */
export function resolveOverlayPlacement(
	layout: OverlayLayout | undefined,
	height: number,
	screenWidth: number,
	screenHeight: number,
): OverlayPlacement {
	const margins = marginsOf(layout, false);
	const availWidth = Math.max(1, screenWidth - margins.left - margins.right);
	const availHeight = Math.max(1, screenHeight - margins.top - margins.bottom);
	let width = layout?.width === undefined ? Math.min(80, availWidth) : resolveOverlaySize(layout.width, screenWidth);
	if (layout?.maxWidth !== undefined) width = Math.min(width, layout.maxWidth);
	if (layout?.minWidth !== undefined) width = Math.max(width, layout.minWidth);
	width = Math.max(1, Math.min(width, availWidth));
	let maxHeight = layout?.maxHeight === undefined ? undefined : resolveOverlaySize(layout.maxHeight, screenHeight);
	if (maxHeight !== undefined) maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
	const effectiveHeight = maxHeight === undefined ? height : Math.min(height, maxHeight);
	const row = resolveAxis(layout?.row, layout?.anchor, effectiveHeight, availHeight, margins.top);
	const col = resolveAxis(layout?.col, alignAsAnchor(layout?.align), width, availWidth, margins.left);
	return {
		row: Math.max(0, Math.min(row + (layout?.offsetY ?? 0), screenHeight - 1)),
		col: Math.max(0, Math.min(col + (layout?.offsetX ?? 0), screenWidth - 1)),
		width,
		maxHeight,
	};
}

function alignAsAnchor(align: OverlayAlign | undefined): OverlayAnchor {
	if (align === "left") return "top";
	if (align === "right") return "bottom";
	return "center";
}

/** Start of an overlay on one axis: explicit position, percent position, or anchor ("top" = start). */
function resolveAxis(
	position: OverlaySize | undefined,
	anchor: OverlayAnchor | undefined,
	size: number,
	available: number,
	margin: number,
): number {
	const free = Math.max(0, available - size);
	if (typeof position === "number") return position;
	if (typeof position === "string") return margin + Math.floor((free * Number.parseFloat(position)) / 100);
	if (anchor === "top") return margin;
	if (anchor === "bottom") return margin + free;
	return margin + Math.floor(free / 2);
}

/** Full-screen layer that lays out a dialog with flexbox (backdrop overlays). */
function createBackdropLayer(renderer: CliRenderer, content: OverlayContent, order: number): BoxRenderable {
	const layout = content.layout;
	const margins = marginsOf(layout, true);
	const layer = new BoxRenderable(renderer, {
		position: "absolute",
		left: 0,
		top: 0,
		width: "100%",
		height: "100%",
		zIndex: OVERLAY_Z_INDEX + order,
		flexDirection: "column",
		alignItems: layout?.col === undefined ? alignItems(layout?.align) : "flex-start",
		justifyContent: layout?.row === undefined ? justifyContent(layout?.anchor) : "flex-start",
		paddingTop: layout?.row === undefined ? margins.top : 0,
		paddingBottom: margins.bottom,
		paddingLeft: margins.left,
		paddingRight: margins.right,
	});
	const root = content.root;
	root.width = layout?.width ?? "70%";
	root.maxWidth = layout?.maxWidth ?? 100;
	if (layout?.minWidth !== undefined) root.minWidth = layout.minWidth;
	root.maxHeight = layout?.maxHeight ?? "85%";
	root.flexShrink = 1;
	if (layout?.row !== undefined) root.marginTop = layout.row;
	if (layout?.col !== undefined) root.marginLeft = layout.col;
	if (layout?.offsetX) root.translateX = layout.offsetX;
	if (layout?.offsetY) root.translateY = layout.offsetY;
	return layer;
}

/**
 * Layer that covers only the overlay rectangle (no backdrop): the rest of the screen keeps its
 * mouse input. The rectangle is recomputed every frame from the rendered height and screen size.
 */
function createPlacedLayer(renderer: CliRenderer, content: OverlayContent, order: number): BoxRenderable {
	const layout = content.layout;
	const root = content.root;
	const place = (): OverlayPlacement =>
		resolveOverlayPlacement(layout, Math.max(1, Math.round(root.height)), renderer.width, renderer.height);
	const initial = place();
	const layer = new BoxRenderable(renderer, {
		position: "absolute",
		left: initial.col,
		top: initial.row,
		width: initial.width,
		zIndex: OVERLAY_Z_INDEX + order,
		flexDirection: "column",
	});
	root.width = "100%";
	root.flexShrink = 1;
	if (initial.maxHeight !== undefined) root.maxHeight = initial.maxHeight;
	let last = initial;
	layer.onLifecyclePass = () => {
		const next = place();
		if (
			next.row === last.row &&
			next.col === last.col &&
			next.width === last.width &&
			next.maxHeight === last.maxHeight
		) {
			return;
		}
		last = next;
		layer.left = next.col;
		layer.top = next.row;
		layer.width = next.width;
		if (next.maxHeight !== undefined) root.maxHeight = next.maxHeight;
		renderer.requestRender();
	};
	return layer;
}

function isDescendant(ancestor: Renderable, node: Renderable): boolean {
	let current: Renderable | null = node;
	while (current) {
		if (current === ancestor) return true;
		current = current.parent;
	}
	return false;
}
