/**
 * Owns the OpenTUI renderer for the whole process.
 *
 * The renderer is created lazily: startup prompts (before the interactive mode exists) and the
 * mode share one renderer, and runs that never show UI never take over the terminal. The host
 * restores the terminal on exit, signals, and uncaught errors, and keeps pi-tui's Kitty keyboard
 * flag in sync with the terminal so keybinding matching decodes the same sequences.
 *
 * The TUI mode picks the screen: `fullscreen` uses the alternate screen with mouse tracking;
 * `regular` uses OpenTUI's `split-footer` screen (a footer below the terminal's own scrollback,
 * see `regular-screen.ts`) without mouse tracking, so the wheel scrolls the terminal as usual.
 */

import { setKittyProtocolActive, type TuiMode } from "@earendil-works/pi-tui";
import { CliRenderEvents, type CliRenderer, createCliRenderer, type TerminalCapabilities } from "@opentui/core";

export interface RendererHostOptions {
	/** Use mouse tracking (scroll wheel, selection). Default true. */
	useMouse?: boolean;
	/** Create the renderer with this factory (tests use `createTestRenderer`). */
	create?: () => Promise<CliRenderer>;
}

export class RendererHost {
	private readonly options: RendererHostOptions;
	private renderer: CliRenderer | undefined;
	private pending: Promise<CliRenderer> | undefined;
	private readonly exitHandler = (): void => this.destroy();
	private tuiMode: TuiMode = "fullscreen";
	/** `process.stdout.write` before any renderer: bypasses the regular screen's stdout capture. */
	private readonly rawWrite = process.stdout.write.bind(process.stdout);

	constructor(options: RendererHostOptions = {}) {
		this.options = options;
	}

	/** The renderer if it exists. */
	get current(): CliRenderer | undefined {
		return this.renderer;
	}

	/** The renderer, created on first use. */
	get(): Promise<CliRenderer> {
		if (this.renderer) return Promise.resolve(this.renderer);
		this.pending ??= this.create();
		return this.pending;
	}

	get mode(): TuiMode {
		return this.tuiMode;
	}

	/** Select the screen for `mode`. Applies to the current renderer, or to the next one created. */
	setTuiMode(mode: TuiMode): void {
		this.tuiMode = mode;
		if (this.renderer && !this.renderer.isDestroyed) this.applyTuiMode(this.renderer);
	}

	/**
	 * Write control sequences (terminal progress) straight to the terminal. In regular mode the
	 * renderer captures `process.stdout` and would print them into the scrollback as text.
	 */
	writeTerminal(data: string): void {
		this.rawWrite(data);
	}

	/** Restore the terminal. The next `get()` creates a new renderer. */
	destroy(): void {
		const renderer = this.renderer;
		this.renderer = undefined;
		this.pending = undefined;
		process.off("exit", this.exitHandler);
		if (renderer && !renderer.isDestroyed) renderer.destroy();
	}

	private async create(): Promise<CliRenderer> {
		const renderer = this.options.create
			? await this.options.create()
			: await createCliRenderer({
					exitOnCtrlC: false,
					// The mode handles signals itself (graceful shutdown); the host restores the terminal on exit.
					exitSignals: [],
					screenMode: this.tuiMode === "regular" ? "split-footer" : "alternate-screen",
					externalOutputMode: this.tuiMode === "regular" ? "capture-stdout" : "passthrough",
					footerHeight: Math.max(1, Math.min(12, process.stdout.rows || 12)),
					// In split-footer mode OpenTUI's shutdown clear resets the render offset to 0 and wipes the
					// top of the screen (the transcript). Leave the last frame instead, like the built-in TUI.
					clearOnShutdown: this.tuiMode !== "regular",
					useMouse: this.tuiMode === "regular" ? false : (this.options.useMouse ?? true),
					autoFocus: false,
					openConsoleOnError: false,
					consoleMode: "disabled",
				});
		this.renderer = renderer;
		this.applyTuiMode(renderer);
		this.syncKittyProtocol(renderer.capabilities);
		renderer.on(CliRenderEvents.CAPABILITIES, (capabilities: TerminalCapabilities) =>
			this.syncKittyProtocol(capabilities),
		);
		process.on("exit", this.exitHandler);
		return renderer;
	}

	private applyTuiMode(renderer: CliRenderer): void {
		if (this.tuiMode === "regular") {
			if (renderer.screenMode !== "split-footer") renderer.screenMode = "split-footer";
			if (renderer.externalOutputMode !== "capture-stdout") renderer.externalOutputMode = "capture-stdout";
			renderer.useMouse = false;
			return;
		}
		// Only leave the split footer: test renderers run on the main screen and stay there.
		if (renderer.screenMode !== "split-footer") return;
		renderer.externalOutputMode = "passthrough";
		renderer.screenMode = "alternate-screen";
		renderer.useMouse = this.options.useMouse ?? true;
	}

	private syncKittyProtocol(capabilities: TerminalCapabilities | null): void {
		setKittyProtocolActive(capabilities?.kitty_keyboard === true);
	}
}
