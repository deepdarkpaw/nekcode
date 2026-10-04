/**
 * Screen layout of the OpenTUI mode.
 *
 * Top to bottom (the interactive mode's chat viewport order):
 *   header        startup header or extension `setHeader` component
 *   transcript    scrollable conversation (`base` shade), follows new output
 *   pending       queued steering/follow-up messages
 *   status        working/retry/compaction indicator
 *   widgetsAbove  extension widgets above the editor
 *   editor        prompt editor slot (`raised` shade, rounded border)
 *   widgetsBelow  extension widgets below the editor
 *   footer        session stats and extension statuses (`panel` shade)
 * The overlay layer is an absolute full-screen layer above everything (`OverlayStack`).
 */

import { BoxRenderable, type CliRenderer, ScrollBoxRenderable } from "@opentui/core";
import type { UiTheme } from "../theme/ui-theme.ts";

export class Shell {
	readonly root: BoxRenderable;
	readonly header: BoxRenderable;
	readonly transcript: ScrollBoxRenderable;
	readonly pending: BoxRenderable;
	readonly status: BoxRenderable;
	readonly widgetsAbove: BoxRenderable;
	readonly editor: BoxRenderable;
	readonly widgetsBelow: BoxRenderable;
	readonly footer: BoxRenderable;
	/** Parent of the overlay layers. */
	readonly overlayHost: BoxRenderable;

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
		this.header = fixed("header");
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
		this.pending = fixed("pending");
		this.status = fixed("status");
		this.widgetsAbove = fixed("widgets-above");
		this.editor = fixed("editor");
		this.widgetsBelow = fixed("widgets-below");
		this.footer = new BoxRenderable(renderer, {
			id: "footer",
			width: "100%",
			flexDirection: "column",
			flexShrink: 0,
			backgroundColor: theme.panel,
		});
		this.overlayHost = new BoxRenderable(renderer, {
			id: "overlays",
			position: "absolute",
			top: 0,
			left: 0,
			width: "100%",
			height: "100%",
			zIndex: 1000,
		});
		// The overlay host must not block clicks on the shell when empty.
		this.overlayHost.visible = false;
		for (const region of [
			this.header,
			this.transcript,
			this.pending,
			this.status,
			this.widgetsAbove,
			this.editor,
			this.widgetsBelow,
			this.footer,
			this.overlayHost,
		]) {
			this.root.add(region);
		}
	}

	/** Show the overlay host while overlays are open. */
	setOverlaysVisible(visible: boolean): void {
		this.overlayHost.visible = visible;
	}

	applyTheme(theme: UiTheme): void {
		this.root.backgroundColor = theme.base;
		this.footer.backgroundColor = theme.panel;
	}
}
