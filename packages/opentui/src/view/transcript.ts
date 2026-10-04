/**
 * Transcript: a ScrollBox that sticks to the bottom while following.
 *
 * ScrollBox lays out every child each frame, so only the most recent blocks are mounted; older
 * ones collapse into one "N earlier messages" line.
 */

import { type CliRenderer, ScrollBoxRenderable, TextRenderable } from "@opentui/core";
import type { Block } from "../state/types.ts";
import type { Palette } from "../theme/palette.ts";
import { type BlockContext, type BlockView, createBlockView } from "./blocks.ts";
import { chunk, styled } from "./styled.ts";

/** Blocks mounted as renderables at once. */
export const MAX_MOUNTED_BLOCKS = 80;

export class Transcript {
	readonly root: ScrollBoxRenderable;
	private readonly placeholder: TextRenderable;
	private readonly palette: Palette;
	private views = new Map<string, BlockView>();
	/** Mounted block ids in display order. */
	private order: string[] = [];

	constructor(renderer: CliRenderer, palette: Palette) {
		this.palette = palette;
		this.root = new ScrollBoxRenderable(renderer, {
			id: "transcript",
			flexGrow: 1,
			flexShrink: 1,
			stickyScroll: true,
			stickyStart: "bottom",
			viewportCulling: true,
			backgroundColor: palette.base,
			contentOptions: { flexDirection: "column", paddingX: 1, paddingBottom: 1 },
			scrollbarOptions: {
				trackOptions: { foregroundColor: palette.borderMuted, backgroundColor: palette.base },
			},
		});
		this.placeholder = new TextRenderable(renderer, {
			id: "transcript-earlier",
			visible: false,
			wrapMode: "none",
			marginTop: 1,
		});
		this.root.add(this.placeholder);
	}

	/** Mount the most recent blocks and update changed ones. `dropped` counts blocks no longer in state. */
	sync(blocks: readonly Block[], dropped: number, ctx: BlockContext): void {
		const visible = blocks.slice(-MAX_MOUNTED_BLOCKS);
		const visibleIds = new Set(visible.map((block) => block.id));
		for (const id of this.order) {
			if (visibleIds.has(id)) continue;
			const view = this.views.get(id);
			if (view) {
				this.root.remove(view.root);
				view.destroy();
			}
			this.views.delete(id);
		}
		this.order = this.order.filter((id) => visibleIds.has(id));
		// Blocks are appended at the end, so new views go to the end too.
		for (const block of visible) {
			let view = this.views.get(block.id);
			if (!view) {
				view = createBlockView(block, ctx);
				this.views.set(block.id, view);
				this.order.push(block.id);
				this.root.add(view.root);
			}
			view.update(block, ctx);
		}
		const earlier = blocks.length - visible.length + dropped;
		this.placeholder.visible = earlier > 0;
		if (earlier > 0) {
			this.placeholder.content = styled([
				chunk(`  ··· ${earlier} earlier message${earlier === 1 ? "" : "s"} not shown ···`, {
					color: this.palette.dim,
				}),
			]);
		}
	}

	/** Remove every block, for example after the backend switched sessions. */
	reset(): void {
		for (const view of this.views.values()) {
			this.root.remove(view.root);
			view.destroy();
		}
		this.views.clear();
		this.order = [];
	}

	scrollPage(direction: 1 | -1): void {
		const page = Math.max(1, this.root.viewport.height - 2);
		this.root.scrollBy(direction * page);
	}

	scrollToTop(): void {
		this.root.scrollTo(0);
	}

	scrollToBottom(): void {
		this.root.scrollTo(this.root.scrollHeight);
	}
}
