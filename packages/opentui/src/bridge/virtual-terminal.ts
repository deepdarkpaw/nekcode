/**
 * A pi-tui `Terminal` that never writes to the real terminal.
 *
 * The bridge facade TUI runs on this terminal: its size follows the OpenTUI renderer, its input is
 * fed by the bridge, and its output (cursor moves, clears, queries) goes to an optional sink.
 * OpenTUI owns the real terminal.
 */

import { isKittyProtocolActive, type Terminal } from "@earendil-works/pi-tui";

export interface TerminalSize {
	columns: number;
	rows: number;
}

export interface VirtualTerminalOptions {
	/** Current size, read on every access (follows the renderer). */
	size: () => TerminalSize;
	/** Receives everything pi-tui writes. Defaults to discarding it. */
	onWrite?: (data: string) => void;
	/** Window title requests (`setTitle`). */
	onTitle?: (title: string) => void;
	/** Progress indicator requests (OSC 9;4). */
	onProgress?: (active: boolean) => void;
}

export class VirtualTerminal implements Terminal {
	private readonly options: VirtualTerminalOptions;
	private inputHandler: ((data: string) => void) | undefined;
	private resizeHandler: (() => void) | undefined;
	private running = false;

	constructor(options: VirtualTerminalOptions) {
		this.options = options;
	}

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
		this.running = true;
	}

	stop(): void {
		this.running = false;
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	get isRunning(): boolean {
		return this.running;
	}

	async drainInput(): Promise<void> {}

	write(data: string): void {
		this.options.onWrite?.(data);
	}

	get columns(): number {
		return Math.max(1, Math.floor(this.options.size().columns));
	}

	get rows(): number {
		return Math.max(1, Math.floor(this.options.size().rows));
	}

	get kittyProtocolActive(): boolean {
		return isKittyProtocolActive();
	}

	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}

	setTitle(title: string): void {
		this.options.onTitle?.(title);
	}

	setProgress(active: boolean): void {
		this.options.onProgress?.(active);
	}

	/** Deliver input to the TUI running on this terminal (input listeners, then the focused component). */
	feedInput(data: string): void {
		this.inputHandler?.(data);
	}

	/** Tell the TUI that the size changed. */
	notifyResize(): void {
		this.resizeHandler?.();
	}
}
