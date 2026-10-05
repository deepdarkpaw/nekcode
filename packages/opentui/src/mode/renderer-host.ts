/**
 * Owns the OpenTUI renderer for the whole process.
 *
 * The renderer is created lazily: startup prompts (before the interactive mode exists) and the
 * mode share one renderer, and runs that never show UI never take over the terminal. The host
 * restores the terminal on exit, signals, and uncaught errors, and keeps pi-tui's Kitty keyboard
 * flag in sync with the terminal so keybinding matching decodes the same sequences.
 */

import { setKittyProtocolActive } from "@earendil-works/pi-tui";
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
					screenMode: "alternate-screen",
					useMouse: this.options.useMouse ?? true,
					autoFocus: false,
					openConsoleOnError: false,
					consoleMode: "disabled",
				});
		this.renderer = renderer;
		this.syncKittyProtocol(renderer.capabilities);
		renderer.on(CliRenderEvents.CAPABILITIES, (capabilities: TerminalCapabilities) =>
			this.syncKittyProtocol(capabilities),
		);
		process.on("exit", this.exitHandler);
		return renderer;
	}

	private syncKittyProtocol(capabilities: TerminalCapabilities | null): void {
		setKittyProtocolActive(capabilities?.kitty_keyboard === true);
	}
}
