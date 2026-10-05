/**
 * Regular TUI mode (`tuiMode: "regular"`): the transcript lives in the terminal's own scrollback,
 * and only the editor area is redrawn.
 *
 * The renderer runs in OpenTUI's `split-footer` screen mode. The renderable surface is a footer
 * pinned to the bottom of the terminal, and output written with `writeToScrollback` lands above it
 * as normal terminal lines.
 *
 * Transcript blocks are committed to scrollback in order once they are done changing. Blocks that
 * still change (the streaming reply, running tools, a running `!` command, the latest status line)
 * stay in the footer, above the editor, until they are done. The footer grows with that live
 * content and fills the terminal while a dialog is open; closing the last dialog replays the
 * transcript so it is on screen again.
 *
 * Scrollback cannot be edited. When committed output must change, everything is replayed: the
 * terminal and its scrollback are cleared and the whole transcript is written again. This happens
 * on a width change, a theme change, the tool-expansion and thinking toggles, and a rebuilt chat.
 * The built-in main-screen TUI does the same full redraw (`\x1b[2J\x1b[H\x1b[3J`).
 */

import type { Component } from "@earendil-works/pi-tui";
import { type CliRenderer, type Renderable, TextRenderable } from "@opentui/core";
import { ansiLinesToStyledText } from "../bridge/ansi.ts";
import type { ComponentHostRenderable } from "../bridge/component-host.ts";
import type { FacadeTui } from "../bridge/facade-tui.ts";
import type { OverlayStack } from "../ui/overlay-stack.ts";
import type { Shell } from "./shell.ts";
import type { TranscriptView } from "./transcript.ts";

export interface RegularScreenOptions {
	renderer: CliRenderer;
	shell: Shell;
	transcript: TranscriptView;
	overlays: OverlayStack;
	tui: FacadeTui;
	/** Whether a transcript component may still change; live components stay in the footer. */
	isLive: (component: Component) => boolean;
}

export class RegularScreen {
	private readonly options: RegularScreenOptions;
	private readonly committed = new Set<Component>();
	private active = false;
	private committedWidth = -1;
	private seenInvalidation = -1;
	private seenClear = -1;
	private updateScheduled = false;
	private replayRequested = false;
	private dialogOpen = false;

	constructor(options: RegularScreenOptions) {
		this.options = options;
	}

	get isActive(): boolean {
		return this.active;
	}

	/** Start managing the footer and commit the transcript to scrollback. */
	activate(): void {
		this.active = true;
		this.committed.clear();
		this.committedWidth = this.options.renderer.width;
		this.seenInvalidation = this.options.tui.invalidationGeneration;
		this.seenClear = this.options.transcript.chat.clearGeneration;
		this.scheduleUpdate();
	}

	/** Stop managing the footer; every transcript block shows in the transcript view again. */
	deactivate(): void {
		this.active = false;
		this.committed.clear();
		for (const host of this.options.transcript.hosts()) host.visible = true;
	}

	/** Write the whole transcript to scrollback again (after a change to committed output). */
	replay(): void {
		if (!this.active) return;
		this.replayRequested = true;
		this.scheduleUpdate();
	}

	/** Called once per frame (lifecycle pass). Work runs after the frame: it resizes the renderer. */
	onFrame(): void {
		if (this.active) this.scheduleUpdate();
	}

	/** Commit everything that is left, live blocks included (exit). */
	flush(): void {
		if (!this.active) return;
		this.commitPending(true);
	}

	private scheduleUpdate(): void {
		if (this.updateScheduled) return;
		this.updateScheduled = true;
		setImmediate(() => {
			this.updateScheduled = false;
			if (this.active && !this.options.renderer.isDestroyed) this.update();
		});
	}

	private update(): void {
		const { renderer, tui, transcript } = this.options;
		// A dialog grows the footer to the full screen, which scrolls the transcript out of view.
		// When the last one closes, replay so the transcript is back on screen above the footer.
		const dialogOpen = this.options.overlays.size > 0;
		if (this.dialogOpen && !dialogOpen) this.replayRequested = true;
		this.dialogOpen = dialogOpen;
		const invalidation = tui.invalidationGeneration;
		const cleared = transcript.chat.clearGeneration;
		const replay =
			this.replayRequested ||
			renderer.width !== this.committedWidth ||
			invalidation !== this.seenInvalidation ||
			cleared !== this.seenClear;
		if (replay) {
			// Settle the footer size first: replayed lines written while the footer still fills the
			// screen would scroll straight into history.
			if (this.updateFooterHeight()) {
				this.replayRequested = true;
				this.scheduleUpdate();
				return;
			}
			this.replayRequested = false;
			this.committedWidth = renderer.width;
			this.seenInvalidation = invalidation;
			this.seenClear = cleared;
			// Nothing written yet (startup): there is nothing to replace.
			if (this.committed.size > 0) {
				this.committed.clear();
				renderer.resetSplitFooterForReplay({ clearSavedLines: true });
			}
		}
		this.commitPending(false);
		this.updateFooterHeight();
	}

	/** Commit transcript blocks in order up to the first live one. */
	private commitPending(includeLive: boolean): void {
		const width = this.options.renderer.width;
		const lines: string[] = [];
		for (const host of this.options.transcript.hosts()) {
			const component = host.component;
			if (this.committed.has(component)) {
				host.visible = false;
				continue;
			}
			if (!includeLive && this.options.isLive(component)) break;
			lines.push(...component.render(width));
			this.committed.add(component);
			host.visible = false;
		}
		if (lines.length > 0) this.writeLines(lines);
		for (const host of this.liveHosts()) host.visible = true;
	}

	private liveHosts(): ComponentHostRenderable[] {
		return this.options.transcript.hosts().filter((host) => !this.committed.has(host.component));
	}

	private writeLines(lines: readonly string[]): void {
		this.options.renderer.writeToScrollback((context) => {
			const root: Renderable = new TextRenderable(context.renderContext, {
				content: ansiLinesToStyledText(lines),
				width: context.width,
				height: lines.length,
				wrapMode: "none",
			});
			return { root, width: context.width, height: lines.length, startOnNewLine: true, trailingNewline: true };
		});
	}

	/** Footer = chrome (editor, footer, widgets, status) + live transcript blocks; full height for dialogs. */
	private updateFooterHeight(): boolean {
		const { renderer, shell, overlays } = this.options;
		const terminalHeight = Math.max(1, renderer.terminalHeight);
		let desired = terminalHeight;
		if (overlays.size === 0) {
			const chrome = shell.chromeRegions().reduce((sum, region) => sum + region.height, 0);
			const live = this.liveHosts().reduce((sum, host) => sum + host.height, 0);
			desired = Math.min(terminalHeight, Math.max(1, chrome + live));
		}
		if (renderer.footerHeight === desired) return false;
		renderer.footerHeight = desired;
		return true;
	}
}
