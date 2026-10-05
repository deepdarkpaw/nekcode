/**
 * Fullscreen transcript behavior: keyboard scrolling, previous/next prompt jumps, transcript search
 * with match highlighting, the "jump to latest" indicator, transient flash messages, and mouse
 * selection copy. Keys follow the configurable `tui.altScreen.*` bindings, like pi-tui's
 * alternate-screen TUI.
 */

import type { KeybindingsManager } from "@earendil-works/pi-coding-agent/core/keybindings";
import { keyDisplayText } from "@earendil-works/pi-coding-agent/modes/interactive/components/keybinding-hints";
import { theme } from "@earendil-works/pi-coding-agent/modes/interactive/theme/theme";
import {
	AltScreenSearchComponent,
	AltScreenSearchIndex,
	type AltScreenSearchMatch,
	getAltScreenSearchMatchKey,
} from "@earendil-works/pi-tui/alt-screen-search";
import {
	BoxRenderable,
	type CliRenderer,
	type KeyEvent,
	type ScrollBoxRenderable,
	type Selection,
	TextAttributes,
	TextRenderable,
} from "@opentui/core";
import type { CellHighlight } from "../bridge/ansi.ts";
import { ComponentHostRenderable } from "../bridge/component-host.ts";
import type { FacadeTui } from "../bridge/facade-tui.ts";
import { matchFirstKeybinding } from "../bridge/input.ts";
import type { UiTheme } from "../theme/ui-theme.ts";
import type { OverlayHandle, OverlayStack } from "../ui/overlay-stack.ts";

/** Rows kept visible from the previous page when paging. */
const PAGE_SCROLL_OVERLAP = 2;
const FLASH_DURATION_MS = 1500;
const COPY_ERROR_FLASH_DURATION_MS = 4000;
const OSC133_PROMPT_START = /^\x1b\]133;A(?:\x07|\x1b\\)/;

const VIEWPORT_KEYS = [
	"tui.altScreen.pageUp",
	"tui.altScreen.pageDown",
	"tui.altScreen.halfPageUp",
	"tui.altScreen.halfPageDown",
	"tui.altScreen.lineUp",
	"tui.altScreen.lineDown",
	"tui.altScreen.previousPrompt",
	"tui.altScreen.nextPrompt",
	"tui.altScreen.top",
	"tui.altScreen.bottom",
] as const;

const SEARCH_KEYS = ["tui.altScreen.searchNext", "tui.altScreen.searchPrevious", "tui.altScreen.searchClose"] as const;

export type ScrollbarMode = "auto" | "always" | "hidden";

export interface ViewportOptions {
	renderer: CliRenderer;
	scrollBox: ScrollBoxRenderable;
	/** Positioned container of the transcript (holds the jump-to-latest indicator). */
	area: BoxRenderable;
	tui: FacadeTui;
	overlays: OverlayStack;
	keybindings: KeybindingsManager;
	uiTheme: () => UiTheme;
	/** Transcript hosts in display order (header, resources, chat). */
	hosts: () => readonly ComponentHostRenderable[];
	/** Copy text to the system clipboard. Resolves true, or an error message. */
	copyText: (text: string) => Promise<true | string>;
	getCopyOnSelect: () => boolean;
	/** Give pi-tui focus back to the prompt editor (after the search bar closes). */
	restoreEditorFocus: () => void;
}

interface ActiveSearch {
	readonly component: AltScreenSearchComponent;
	readonly index: AltScreenSearchIndex;
	readonly handle: OverlayHandle;
	query: string;
	matches: AltScreenSearchMatch[];
	selectedIndex: number;
	selectedKey: string | undefined;
	mode: "query" | "next" | "previous" | "retain";
	anchorRow: number;
	/** Row ranges of each host in the search corpus. */
	layout: Array<{ host: ComponentHostRenderable; start: number; count: number }>;
	highlighted: Set<ComponentHostRenderable>;
}

export class TranscriptViewport {
	private readonly options: ViewportOptions;
	private readonly indicator: TextRenderable;
	private readonly flashStack: BoxRenderable;
	private search: ActiveSearch | undefined;
	private readonly selectionHandler = (selection: Selection | null): void => this.handleSelection(selection);

	constructor(options: ViewportOptions) {
		this.options = options;
		const theme = options.uiTheme();
		this.indicator = new TextRenderable(options.renderer, {
			id: "jump-to-latest",
			position: "absolute",
			right: 1,
			bottom: 0,
			zIndex: 50,
			visible: false,
			selectable: false,
			fg: theme.text,
			bg: theme.overlay,
			content: "",
		});
		this.indicator.onMouseDown = () => this.scrollToBottom();
		this.indicator.onLifecyclePass = () => this.updateIndicator();
		options.area.add(this.indicator);
		this.flashStack = new BoxRenderable(options.renderer, {
			id: "flash-stack",
			position: "absolute",
			top: 1,
			right: 2,
			zIndex: 3000,
			flexDirection: "column",
			alignItems: "flex-end",
		});
		options.renderer.root.add(this.flashStack);
		options.renderer.on("selection", this.selectionHandler);
	}

	dispose(): void {
		this.closeSearch();
		this.options.renderer.off("selection", this.selectionHandler);
	}

	setScrollbar(mode: ScrollbarMode): void {
		const bar = this.options.scrollBox.verticalScrollBar;
		bar.visible = mode !== "hidden";
		const theme = this.options.uiTheme();
		bar.trackOptions = {
			backgroundColor: theme.token("scrollbarTrack"),
			foregroundColor: theme.token("scrollbarThumb"),
		};
	}

	get viewportHeight(): number {
		return Math.max(1, this.options.scrollBox.viewport.height);
	}

	get maxScrollTop(): number {
		return Math.max(0, this.options.scrollBox.scrollHeight - this.options.scrollBox.viewport.height);
	}

	isAtBottom(): boolean {
		return this.options.scrollBox.scrollTop >= this.maxScrollTop - 1;
	}

	scrollBy(lines: number): void {
		const scrollBox = this.options.scrollBox;
		scrollBox.scrollTop = Math.max(0, Math.min(this.maxScrollTop, scrollBox.scrollTop + lines));
		this.options.renderer.requestRender();
	}

	scrollTo(row: number): void {
		this.options.scrollBox.scrollTop = Math.max(0, Math.min(this.maxScrollTop, row));
		this.options.renderer.requestRender();
	}

	scrollToTop(): void {
		this.scrollTo(0);
	}

	/** Scroll to the newest content and follow new output again. */
	scrollToBottom(): void {
		const scrollBox = this.options.scrollBox;
		scrollBox.stickyScroll = true;
		scrollBox.scrollTop = this.maxScrollTop;
		this.options.renderer.requestRender();
	}

	/** Handle transcript keys (scrolling, prompt jumps, search). Returns true when the key was used. */
	handleKey(key: KeyEvent): boolean {
		const keybindings = this.options.keybindings;
		if (matchFirstKeybinding(keybindings, key, ["tui.altScreen.search"])) {
			this.toggleSearch();
			return true;
		}
		if (this.search?.handle.isFocused()) {
			const searchAction = matchFirstKeybinding(keybindings, key, SEARCH_KEYS);
			if (searchAction === "tui.altScreen.searchNext") this.navigateSearch(1);
			else if (searchAction === "tui.altScreen.searchPrevious") this.navigateSearch(-1);
			else if (searchAction === "tui.altScreen.searchClose") this.closeSearch();
			if (searchAction) return true;
		}
		const action = matchFirstKeybinding(keybindings, key, VIEWPORT_KEYS);
		const page = this.viewportHeight;
		switch (action) {
			case "tui.altScreen.pageUp":
				this.scrollBy(-Math.max(1, page - PAGE_SCROLL_OVERLAP));
				return true;
			case "tui.altScreen.pageDown":
				this.scrollBy(Math.max(1, page - PAGE_SCROLL_OVERLAP));
				return true;
			case "tui.altScreen.halfPageUp":
				this.scrollBy(-Math.max(1, Math.floor(page / 2)));
				return true;
			case "tui.altScreen.halfPageDown":
				this.scrollBy(Math.max(1, Math.floor(page / 2)));
				return true;
			case "tui.altScreen.lineUp":
				this.scrollBy(-1);
				return true;
			case "tui.altScreen.lineDown":
				this.scrollBy(1);
				return true;
			case "tui.altScreen.previousPrompt":
				this.scrollToPrompt(-1);
				return true;
			case "tui.altScreen.nextPrompt":
				this.scrollToPrompt(1);
				return true;
			case "tui.altScreen.top":
				this.scrollToTop();
				return true;
			case "tui.altScreen.bottom":
				this.scrollToBottom();
				return true;
			default:
				return false;
		}
	}

	/** Content row of a host's first line. */
	private hostTop(host: ComponentHostRenderable): number {
		return host.y - this.options.scrollBox.content.y;
	}

	/** Content rows of user prompts (OSC 133 prompt zones). */
	promptRows(): number[] {
		const rows: number[] = [];
		for (const host of this.options.hosts()) {
			const top = this.hostTop(host);
			host.renderedLines.forEach((line, index) => {
				if (OSC133_PROMPT_START.test(line)) rows.push(top + index);
			});
		}
		return rows;
	}

	private scrollToPrompt(direction: -1 | 1): void {
		const current = this.options.scrollBox.scrollTop;
		const rows = this.promptRows();
		const target = direction < 0 ? rows.filter((row) => row < current).pop() : rows.find((row) => row > current);
		if (target !== undefined) this.scrollTo(target);
	}

	// --- Search ----------------------------------------------------------------------------------

	get isSearchOpen(): boolean {
		return this.search !== undefined;
	}

	toggleSearch(): void {
		if (this.search) {
			this.closeSearch();
			return;
		}
		const { renderer, tui, overlays } = this.options;
		const component = new AltScreenSearchComponent(
			(query) => this.updateSearchQuery(query),
			(text, hovered) => (hovered ? theme.underline(text) : text),
		);
		const host = new ComponentHostRenderable(renderer, { component, tui, focusable: true, selectable: false });
		const box = new BoxRenderable(renderer, {
			backgroundColor: this.options.uiTheme().raised,
			flexDirection: "column",
		});
		box.add(host);
		box.onLifecyclePass = () => this.refreshSearch();
		const handle = overlays.open({
			root: box,
			focusTarget: host,
			modal: true,
			backdrop: false,
			layout: {
				anchor: "top",
				align: "right",
				width: "40%",
				minWidth: 32,
				maxWidth: 80,
				margin: { top: 1, right: 1 },
			},
			handleKey: (key) => this.handleKey(key),
			dispose: () => {
				this.clearHighlights();
				this.search = undefined;
				this.options.restoreEditorFocus();
			},
		});
		this.search = {
			component,
			index: new AltScreenSearchIndex(),
			handle,
			query: "",
			matches: [],
			selectedIndex: -1,
			selectedKey: undefined,
			mode: "query",
			anchorRow: this.options.scrollBox.scrollTop,
			layout: [],
			highlighted: new Set(),
		};
	}

	closeSearch(): void {
		this.search?.handle.close();
	}

	private updateSearchQuery(query: string): void {
		const search = this.search;
		if (!search || query === search.query) return;
		const selected = search.matches[search.selectedIndex];
		search.anchorRow = selected ? this.matchRow(search, selected) : this.options.scrollBox.scrollTop;
		search.query = query;
		search.mode = "query";
		search.component.setResult(-1, 0);
		this.refreshSearch();
	}

	private navigateSearch(direction: -1 | 1): void {
		const search = this.search;
		if (!search?.query) return;
		search.mode = direction < 0 ? "previous" : "next";
		this.refreshSearch();
	}

	/** Content row of a match (its first segment). */
	private matchRow(search: ActiveSearch, match: AltScreenSearchMatch): number {
		const row = match.segments[0]?.row ?? 0;
		const part = search.layout.find((entry) => row >= entry.start && row < entry.start + entry.count);
		return part ? this.hostTop(part.host) + row - part.start : 0;
	}

	private refreshSearch(): void {
		const search = this.search;
		if (!search) return;
		const lines: string[] = [];
		search.layout = [];
		for (const host of this.options.hosts()) {
			const hostLines = host.renderedLines;
			search.layout.push({ host, start: lines.length, count: hostLines.length });
			lines.push(...hostLines);
		}
		if (!search.query.trim()) {
			search.matches = [];
			search.selectedIndex = -1;
			search.selectedKey = undefined;
			search.mode = "retain";
			search.component.setResult(-1, 0);
			this.clearHighlights();
			return;
		}
		const result = search.index.search(lines, search.query);
		if (!result.changed && search.mode === "retain") return;
		const reveal = search.mode !== "retain";
		const matches = result.matches;
		search.matches = matches;
		search.selectedIndex = this.selectMatch(search, matches, result.changed);
		search.selectedKey =
			search.selectedIndex >= 0
				? getAltScreenSearchMatchKey(matches[search.selectedIndex] as AltScreenSearchMatch)
				: undefined;
		search.mode = "retain";
		search.component.setResult(search.selectedIndex, matches.length);
		this.applyHighlights(search);
		const selected = matches[search.selectedIndex];
		if (reveal && selected) this.reveal(search, selected);
		this.options.tui.requestRender();
	}

	private selectMatch(search: ActiveSearch, matches: readonly AltScreenSearchMatch[], changed: boolean): number {
		if (matches.length === 0) return -1;
		const exact = changed
			? search.selectedKey
				? matches.findIndex((match) => getAltScreenSearchMatchKey(match) === search.selectedKey)
				: -1
			: search.selectedIndex;
		const base = exact >= 0 ? exact : Math.min(search.selectedIndex, matches.length - 1);
		switch (search.mode) {
			case "query": {
				const index = matches.findIndex((match) => this.matchRow(search, match) >= search.anchorRow);
				return index === -1 ? 0 : index;
			}
			case "next":
				return base < 0 ? 0 : (base + 1) % matches.length;
			case "previous":
				return base < 0 ? matches.length - 1 : (base - 1 + matches.length) % matches.length;
			default:
				return exact >= 0 ? exact : Math.min(Math.max(0, search.selectedIndex), matches.length - 1);
		}
	}

	private reveal(search: ActiveSearch, match: AltScreenSearchMatch): void {
		const first = this.matchRow(search, match);
		const last = first + Math.max(0, match.segments.length - 1);
		const top = this.options.scrollBox.scrollTop;
		const bottom = top + this.viewportHeight - 1;
		if (first < top || last > bottom) this.scrollTo(first - Math.floor(this.viewportHeight / 3));
	}

	private applyHighlights(search: ActiveSearch): void {
		const theme = this.options.uiTheme();
		const base: Omit<CellHighlight, "startCol" | "endCol"> = {
			fg: theme.token("searchMatchText"),
			bg: theme.token("searchMatchBg"),
			attributes: TextAttributes.UNDERLINE,
		};
		const current: Omit<CellHighlight, "startCol" | "endCol"> = {
			...base,
			attributes: TextAttributes.BOLD | TextAttributes.INVERSE,
		};
		const perHost = new Map<ComponentHostRenderable, Map<number, CellHighlight[]>>();
		search.matches.forEach((match, matchIndex) => {
			const style = matchIndex === search.selectedIndex ? current : base;
			for (const segment of match.segments) {
				const part = search.layout.find(
					(entry) => segment.row >= entry.start && segment.row < entry.start + entry.count,
				);
				if (!part) continue;
				const rows = perHost.get(part.host) ?? new Map<number, CellHighlight[]>();
				const localRow = segment.row - part.start;
				const ranges = rows.get(localRow) ?? [];
				ranges.push({ ...style, startCol: segment.startCol, endCol: segment.endCol });
				rows.set(localRow, ranges);
				perHost.set(part.host, rows);
			}
		});
		for (const host of search.highlighted) if (!perHost.has(host)) host.setHighlights(undefined);
		for (const [host, rows] of perHost) host.setHighlights(rows);
		search.highlighted = new Set(perHost.keys());
	}

	private clearHighlights(): void {
		const search = this.search;
		if (!search) return;
		for (const host of search.highlighted) if (!host.isDestroyed) host.setHighlights(undefined);
		search.highlighted.clear();
	}

	// --- Indicator, flash, selection --------------------------------------------------------------

	private updateIndicator(): void {
		const show = this.maxScrollTop > 0 && !this.isAtBottom();
		if (show) {
			const shortcut = keyDisplayText("tui.altScreen.bottom");
			const label = ` ↓ Jump to latest message${shortcut ? ` · ${shortcut}` : ""} `;
			if (this.indicator.plainText !== label) this.indicator.content = label;
			const theme = this.options.uiTheme();
			this.indicator.fg = theme.text;
			this.indicator.bg = theme.token("selectedBg");
		}
		if (this.indicator.visible !== show) this.indicator.visible = show;
	}

	/** Show a transient message in the top-right corner. */
	flash(message: string, durationMs = FLASH_DURATION_MS): void {
		const theme = this.options.uiTheme();
		const toast = new BoxRenderable(this.options.renderer, {
			border: true,
			borderStyle: "rounded",
			borderColor: theme.borderAccent,
			backgroundColor: theme.raised,
			paddingX: 1,
			marginBottom: 0,
		});
		toast.add(new TextRenderable(this.options.renderer, { content: message, fg: theme.text, selectable: false }));
		this.flashStack.add(toast);
		this.options.renderer.requestRender();
		setTimeout(() => {
			if (toast.isDestroyed) return;
			this.flashStack.remove(toast);
			toast.destroyRecursively();
			this.options.renderer.requestRender();
		}, durationMs).unref?.();
	}

	hasSelection(): boolean {
		return this.selectedText() !== undefined;
	}

	selectedText(): string | undefined {
		const text = this.options.renderer.getSelection()?.getSelectedText();
		return text && text.length > 0 ? text : undefined;
	}

	/** Copy the mouse selection. Returns false when nothing is selected. */
	async copySelection(): Promise<boolean> {
		const text = this.selectedText();
		if (!text) return false;
		const result = await this.options.copyText(text);
		if (result === true) this.flash("Copied!");
		else this.flash(result, COPY_ERROR_FLASH_DURATION_MS);
		return result === true;
	}

	private handleSelection(selection: Selection | null): void {
		if (!selection || selection.isDragging || !this.options.getCopyOnSelect()) return;
		void this.copySelection();
	}
}
