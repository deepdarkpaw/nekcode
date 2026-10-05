/**
 * A real pi-tui `TUI` for components and extensions hosted inside OpenTUI.
 *
 * Extension factories receive a `tui` (`ctx.ui.custom`, `setWidget`, `setHeader`, `setFooter`,
 * `setEditorComponent`) and call `requestRender`, `showOverlay`, `setFocus`, `terminal.columns`, and
 * so on. This facade is a pi-tui `TuiMainScreen` on a `VirtualTerminal`: it never draws. Its render
 * requests, overlays, focus changes, and invalidation are forwarded to the OpenTUI host through
 * `FacadeTuiHooks`.
 *
 * Keyboard input for pi-tui components goes through `feedInput`, which runs pi-tui's own input
 * pipeline (debug key, overlay focus repair, key-release filtering) and delivers the sequence to
 * the focused pi-tui component, exactly as a real terminal would.
 */

import {
	type Component,
	type OverlayHandle,
	type OverlayOptions,
	type TuiInputListener,
	TuiMainScreen,
} from "@earendil-works/pi-tui";
import { type RawInputDispatch, runRawInputListeners } from "./input.ts";
import { type TerminalSize, VirtualTerminal, type VirtualTerminalOptions } from "./virtual-terminal.ts";

export interface FacadeTuiHooks {
	/** A component or extension requested a repaint. */
	onRenderRequest(): void;
	/** Show a pi-tui component as an overlay in the OpenTUI overlay layer. */
	showOverlay(component: Component, options: OverlayOptions | undefined): OverlayHandle;
	/** Hide the topmost pi-tui overlay. */
	hideTopOverlay(): void;
	/** Whether any pi-tui overlay is visible. */
	hasOverlay(): boolean;
	/** A component asked for focus (`tui.setFocus`). The host focuses the renderable that hosts it. */
	onFocusRequest(component: Component | null): void;
	/** `tui.invalidate()` (theme changes): every hosted component must re-render from scratch. */
	onInvalidate(): void;
}

const NOOP_HOOKS: FacadeTuiHooks = {
	onRenderRequest: () => {},
	showOverlay: () => {
		throw new Error("The OpenTUI overlay layer is not ready");
	},
	hideTopOverlay: () => {},
	hasOverlay: () => false,
	onFocusRequest: () => {},
	onInvalidate: () => {},
};

export interface FacadeTuiOptions extends Omit<VirtualTerminalOptions, "size"> {
	size: () => TerminalSize;
	showHardwareCursor?: boolean;
}

/** What a host registers so focus requests can find the renderable that shows a component. */
export interface FacadeHost {
	focus(): void;
	readonly isDestroyed: boolean;
}

export class FacadeTui extends TuiMainScreen {
	readonly virtualTerminal: VirtualTerminal;
	private hooks: FacadeTuiHooks = NOOP_HOOKS;
	private readonly listeners = new Set<TuiInputListener>();
	private readonly hosts = new Map<Component, FacadeHost>();
	private generation = 0;
	private invalidations = 0;

	constructor(options: FacadeTuiOptions) {
		const terminal = new VirtualTerminal(options);
		super(terminal, options.showHardwareCursor ?? false);
		this.virtualTerminal = terminal;
	}

	/** Connect the facade to the OpenTUI host. */
	bind(hooks: FacadeTuiHooks): void {
		this.hooks = hooks;
	}

	/** Increments on every render request; hosts re-render their component when it changes. */
	get renderGeneration(): number {
		return this.generation;
	}

	/** Increments on every `invalidate()`; hosts invalidate their component when it changes. */
	get invalidationGeneration(): number {
		return this.invalidations;
	}

	protected override doRender(): void {
		this.generation++;
		this.hooks.onRenderRequest();
	}

	override showOverlay(component: Component, options?: OverlayOptions): OverlayHandle {
		return this.hooks.showOverlay(component, options);
	}

	override hideOverlay(): void {
		this.hooks.hideTopOverlay();
	}

	override hasOverlay(): boolean {
		return this.hooks.hasOverlay();
	}

	override get hasOverlayEntries(): boolean {
		return this.hooks.hasOverlay();
	}

	override setFocus(component: Component | null): void {
		super.setFocus(component);
		this.hooks.onFocusRequest(component);
	}

	/** Record focus moved by the host (OpenTUI focus), without asking the host to move it again. */
	syncFocus(component: Component | null): void {
		super.setFocus(component);
	}

	override invalidate(): void {
		super.invalidate();
		this.invalidations++;
		this.generation++;
		this.hooks.onInvalidate();
	}

	override addInputListener(listener: TuiInputListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	override removeInputListener(listener: TuiInputListener): void {
		this.listeners.delete(listener);
	}

	/** Run `addInputListener` listeners on raw input. */
	dispatchInput(data: string): RawInputDispatch {
		return runRawInputListeners(this.listeners, data);
	}

	get inputListenerCount(): number {
		return this.listeners.size;
	}

	/** Deliver a key or paste sequence to the focused pi-tui component (pi-tui input pipeline). */
	feedInput(data: string): void {
		this.virtualTerminal.feedInput(data);
	}

	/** Register the renderable that shows `component`. */
	registerHost(component: Component, host: FacadeHost): void {
		this.hosts.set(component, host);
	}

	unregisterHost(component: Component, host: FacadeHost): void {
		if (this.hosts.get(component) === host) this.hosts.delete(component);
	}

	/** The renderable that shows `component` directly, if any. */
	hostFor(component: Component): FacadeHost | undefined {
		const host = this.hosts.get(component);
		return host && !host.isDestroyed ? host : undefined;
	}
}
