/**
 * Keyboard-driven list with optional fuzzy filtering: the building block of every selector.
 *
 * Navigation uses the configurable `tui.select.*` keybindings. With `filter: true`, a single-line
 * input above the list receives typed text and narrows the items with pi-tui `fuzzyFilter`.
 * Rows show a label and an optional muted description; the highlighted row sits on the `overlay`
 * shade with an accent marker.
 */

import { fuzzyFilter } from "@earendil-works/pi-tui";
import {
	BoxRenderable,
	InputRenderable,
	InputRenderableEvents,
	type KeyEvent,
	type Renderable,
	StyledText,
	type TextChunk,
	TextRenderable,
} from "@opentui/core";
import { matchFirstKeybinding } from "../bridge/input.ts";
import type { UiEnvironment } from "./environment.ts";

export interface SelectItem<T> {
	value: T;
	label: string;
	/** Muted text after the label. */
	description?: string;
	/** Extra text used for filtering only. */
	searchText?: string;
}

export interface SelectListOptions<T> {
	items: readonly SelectItem<T>[];
	/** Index of the initially highlighted item. */
	initialIndex?: number;
	/** Rows shown at once. Default 10. */
	maxVisible?: number;
	/** Show a filter input. */
	filter?: boolean;
	/** Initial filter text. */
	initialQuery?: string;
	filterPlaceholder?: string;
	/** Text shown when no item matches. */
	emptyText?: string;
	onConfirm?: (item: SelectItem<T>, index: number) => void;
	onCancel?: () => void;
	/** Called when the highlighted item changes. */
	onHighlight?: (item: SelectItem<T> | undefined) => void;
}

const NAVIGATION_KEYS = [
	"tui.select.up",
	"tui.select.down",
	"tui.select.pageUp",
	"tui.select.pageDown",
	"tui.select.confirm",
	"tui.select.cancel",
] as const;

export class SelectList<T> {
	readonly root: BoxRenderable;
	/** Focus this when the list is shown (the filter input, or the list itself). */
	readonly focusTarget: Renderable;
	private readonly env: UiEnvironment;
	private readonly options: SelectListOptions<T>;
	private readonly rows: BoxRenderable;
	private readonly status: TextRenderable;
	private readonly input: InputRenderable | undefined;
	private items: readonly SelectItem<T>[];
	private visibleItems: readonly SelectItem<T>[];
	private selectedIndex: number;
	private scrollTop = 0;
	private query: string;

	constructor(env: UiEnvironment, options: SelectListOptions<T>) {
		this.env = env;
		this.options = options;
		this.items = options.items;
		this.query = options.initialQuery ?? "";
		const theme = env.uiTheme();
		this.root = new BoxRenderable(env.renderer, { flexDirection: "column", flexShrink: 1 });
		if (options.filter) {
			this.input = new InputRenderable(env.renderer, {
				value: this.query,
				placeholder: options.filterPlaceholder ?? "Type to filter",
				backgroundColor: theme.overlay,
				focusedBackgroundColor: theme.overlay,
				textColor: theme.text,
				focusedTextColor: theme.text,
				placeholderColor: theme.dim,
				marginBottom: 1,
			});
			this.input.on(InputRenderableEvents.INPUT, (value: string) => this.setQuery(value));
			this.root.add(this.input);
		}
		this.rows = new BoxRenderable(env.renderer, {
			flexDirection: "column",
			flexShrink: 1,
			focusable: !options.filter,
		});
		this.status = new TextRenderable(env.renderer, { fg: theme.dim, visible: false });
		this.root.add(this.rows);
		this.root.add(this.status);
		this.focusTarget = this.input ?? this.rows;
		this.visibleItems = this.filterItems();
		this.selectedIndex = clampIndex(options.initialIndex ?? 0, this.visibleItems.length);
		this.ensureVisible();
		this.rebuildRows();
	}

	/** The highlighted item. */
	get selected(): SelectItem<T> | undefined {
		return this.visibleItems[this.selectedIndex];
	}

	get selectedIndexInView(): number {
		return this.selectedIndex;
	}

	/** Items after filtering. */
	get filteredItems(): readonly SelectItem<T>[] {
		return this.visibleItems;
	}

	setItems(items: readonly SelectItem<T>[], keepValue = true): void {
		const current = keepValue ? this.selected?.value : undefined;
		this.items = items;
		this.visibleItems = this.filterItems();
		const kept = current === undefined ? -1 : this.visibleItems.findIndex((item) => item.value === current);
		this.selectedIndex = clampIndex(kept === -1 ? this.selectedIndex : kept, this.visibleItems.length);
		this.ensureVisible();
		this.rebuildRows();
	}

	setQuery(query: string): void {
		if (query === this.query) return;
		this.query = query;
		this.visibleItems = this.filterItems();
		this.selectedIndex = 0;
		this.scrollTop = 0;
		this.rebuildRows();
	}

	/** Move the highlight. Wraps around at both ends. */
	move(delta: number): void {
		const count = this.visibleItems.length;
		if (count === 0) return;
		this.selectedIndex = (((this.selectedIndex + delta) % count) + count) % count;
		this.ensureVisible();
		this.rebuildRows();
	}

	/** Handle navigation keys. Returns true when the key was used. */
	handleKey(key: KeyEvent): boolean {
		const action = matchFirstKeybinding(this.env.keybindings, key, NAVIGATION_KEYS);
		const page = this.maxVisible;
		switch (action) {
			case "tui.select.up":
				this.move(-1);
				return true;
			case "tui.select.down":
				this.move(1);
				return true;
			case "tui.select.pageUp":
				this.selectedIndex = Math.max(0, this.selectedIndex - page);
				this.ensureVisible();
				this.rebuildRows();
				return true;
			case "tui.select.pageDown":
				this.selectedIndex = clampIndex(this.selectedIndex + page, this.visibleItems.length);
				this.ensureVisible();
				this.rebuildRows();
				return true;
			case "tui.select.confirm": {
				const item = this.selected;
				if (item) this.options.onConfirm?.(item, this.selectedIndex);
				return true;
			}
			case "tui.select.cancel":
				this.options.onCancel?.();
				return true;
			default:
				return false;
		}
	}

	private get maxVisible(): number {
		return Math.max(1, this.options.maxVisible ?? 10);
	}

	private filterItems(): readonly SelectItem<T>[] {
		if (!this.query.trim()) return this.items;
		return fuzzyFilter([...this.items], this.query, (item) =>
			[item.label, item.description ?? "", item.searchText ?? ""].join(" "),
		);
	}

	private ensureVisible(): void {
		const max = this.maxVisible;
		if (this.selectedIndex < this.scrollTop) this.scrollTop = this.selectedIndex;
		if (this.selectedIndex >= this.scrollTop + max) this.scrollTop = this.selectedIndex - max + 1;
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, this.visibleItems.length - max)));
	}

	private rebuildRows(): void {
		const theme = this.env.uiTheme();
		for (const child of this.rows.getChildren()) {
			this.rows.remove(child);
			child.destroyRecursively();
		}
		const max = this.maxVisible;
		const window = this.visibleItems.slice(this.scrollTop, this.scrollTop + max);
		window.forEach((item, offset) => {
			const index = this.scrollTop + offset;
			const selected = index === this.selectedIndex;
			const chunks: TextChunk[] = [
				{ __isChunk: true, text: selected ? "› " : "  ", fg: selected ? theme.accent : theme.dim },
				{ __isChunk: true, text: item.label, fg: theme.text },
			];
			if (item.description) chunks.push({ __isChunk: true, text: `  ${item.description}`, fg: theme.muted });
			const row = new BoxRenderable(this.env.renderer, {
				flexDirection: "row",
				height: 1,
				flexShrink: 0,
				paddingX: 1,
				backgroundColor: selected ? theme.overlay : "transparent",
			});
			row.add(new TextRenderable(this.env.renderer, { content: new StyledText(chunks), wrapMode: "none" }));
			this.rows.add(row);
		});
		const total = this.visibleItems.length;
		if (total === 0) {
			this.status.content = this.options.emptyText ?? "No matches";
			this.status.visible = true;
		} else if (total > max) {
			this.status.content = `  ${this.selectedIndex + 1}/${total}`;
			this.status.visible = true;
		} else {
			this.status.visible = false;
		}
		this.options.onHighlight?.(this.selected);
		this.env.renderer.requestRender();
	}
}

function clampIndex(index: number, count: number): number {
	if (count <= 0) return 0;
	return Math.max(0, Math.min(index, count - 1));
}
