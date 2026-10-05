/**
 * Screen layout of the OpenTUI mode.
 *
 * Top to bottom (the interactive mode's fullscreen chat viewport order):
 *   transcript    scrollable document: header, loaded resources, chat (`base` shade)
 *   pending       queued steering/follow-up messages and deferred bash output
 *   status        working/retry/compaction indicator (when the editor does not embed it)
 *   widgetsAbove  extension widgets above the editor
 *   editor        prompt editor slot (`raised` shade); selectors and custom components replace it
 *   widgetsBelow  extension widgets below the editor
 *   footer        session stats and extension statuses (`panel` shade)
 * Overlays are layers on the renderer root above the shell (`OverlayStack`).
 */

import { BoxRenderable, type CliRenderer, ScrollBoxRenderable } from "@opentui/core";
import type { UiTheme } from "../theme/ui-theme.ts";

export class Shell {
	readonly root: BoxRenderable;
	/** Positioned container of the transcript (holds the jump-to-latest indicator). */
	readonly transcriptArea: BoxRenderable;
	readonly transcript: ScrollBoxRenderable;
	readonly pending: BoxRenderable;
	readonly status: BoxRenderable;
	readonly widgetsAbove: BoxRenderable;
	readonly editor: BoxRenderable;
	readonly widgetsBelow: BoxRenderable;
	readonly footer: BoxRenderable;

	constructor(renderer: CliRenderer, theme: UiTheme) {
		this.root = new BoxRenderable(renderer, {
			id: "shell",
			width: "100%",
			height: "100%",
			flexDirection: "column",
			backgroundColor: theme.base,
		});
		const fixed = (id: string) =>
			new BoxRenderable(renderer, { id, width: "100%", flexDirection: "column", flexShrink: 0 });
		this.transcriptArea = new BoxRenderable(renderer, {
			id: "transcript-area",
			width: "100%",
			flexGrow: 1,
			flexShrink: 1,
			flexDirection: "column",
		});
		this.transcript = new ScrollBoxRenderable(renderer, {
			id: "transcript",
			flexGrow: 1,
			flexShrink: 1,
			stickyScroll: true,
			stickyStart: "bottom",
			scrollY: true,
			scrollX: false,
			viewportCulling: true,
			contentOptions: { flexDirection: "column" },
		});
		this.transcriptArea.add(this.transcript);
		this.pending = fixed("pending");
		this.status = fixed("status");
		this.widgetsAbove = fixed("widgets-above");
		this.editor = new BoxRenderable(renderer, {
			id: "editor",
			width: "100%",
			flexDirection: "column",
			flexShrink: 0,
			backgroundColor: theme.raised,
		});
		this.widgetsBelow = fixed("widgets-below");
		this.footer = new BoxRenderable(renderer, {
			id: "footer",
			width: "100%",
			flexDirection: "column",
			flexShrink: 0,
			backgroundColor: theme.panel,
		});
		for (const region of [
			this.transcriptArea,
			this.pending,
			this.status,
			this.widgetsAbove,
			this.editor,
			this.widgetsBelow,
			this.footer,
		]) {
			this.root.add(region);
		}
	}

	applyTheme(theme: UiTheme): void {
		this.root.backgroundColor = theme.base;
		this.editor.backgroundColor = theme.raised;
		this.footer.backgroundColor = theme.panel;
	}
}
