/**
 * pi-tui overlays (`tui.showOverlay`, `ctx.ui.custom({ overlay: true })`) on the OpenTUI overlay
 * stack.
 *
 * Each overlay component gets its own bridge host in a placed layer, positioned with the same rules
 * as pi-tui (`OverlayOptions` width, anchor, margins, offsets, rows/columns, `visible`). Capturing
 * overlays take keyboard focus; `nonCapturing` overlays only draw. Closing an overlay gives pi-tui
 * focus back to the component that had it.
 */

import type { Component, OverlayOptions, OverlayHandle as PiOverlayHandle } from "@earendil-works/pi-tui";
import { BoxRenderable, type CliRenderer } from "@opentui/core";
import { ComponentHostRenderable } from "../bridge/component-host.ts";
import type { FacadeTui } from "../bridge/facade-tui.ts";
import type { UiTheme } from "../theme/ui-theme.ts";
import type { OverlayAlign, OverlayAnchor, OverlayHandle, OverlayLayout, OverlayStack } from "../ui/overlay-stack.ts";

export interface PiOverlayHost {
	renderer: CliRenderer;
	overlays: OverlayStack;
	tui: FacadeTui;
	uiTheme: () => UiTheme;
}

const ANCHORS: Record<NonNullable<OverlayOptions["anchor"]>, { anchor: OverlayAnchor; align: OverlayAlign }> = {
	center: { anchor: "center", align: "center" },
	"top-left": { anchor: "top", align: "left" },
	"top-right": { anchor: "top", align: "right" },
	"bottom-left": { anchor: "bottom", align: "left" },
	"bottom-right": { anchor: "bottom", align: "right" },
	"top-center": { anchor: "top", align: "center" },
	"bottom-center": { anchor: "bottom", align: "center" },
	"left-center": { anchor: "center", align: "left" },
	"right-center": { anchor: "center", align: "right" },
};

/** Translate pi-tui overlay options to the overlay stack layout. */
export function piOverlayLayout(options: OverlayOptions | undefined): OverlayLayout {
	const placement = ANCHORS[options?.anchor ?? "center"];
	return {
		width: options?.width,
		minWidth: options?.minWidth,
		maxHeight: options?.maxHeight,
		anchor: placement.anchor,
		align: placement.align,
		margin: options?.margin ?? 0,
		offsetX: options?.offsetX,
		offsetY: options?.offsetY,
		row: options?.row,
		col: options?.col,
	};
}

/** Tracks open pi-tui overlays for `hideOverlay` and `hasOverlay`. */
export class PiOverlayRegistry {
	private readonly host: PiOverlayHost;
	private readonly open: PiOverlayHandle[] = [];

	constructor(host: PiOverlayHost) {
		this.host = host;
	}

	show(component: Component, options: OverlayOptions | undefined): PiOverlayHandle {
		const { renderer, overlays, tui } = this.host;
		const capturing = options?.nonCapturing !== true;
		const preFocus = tui.getFocusedComponent();
		const host = new ComponentHostRenderable(renderer, {
			component,
			tui,
			focusable: capturing,
			disposeComponent: false,
		});
		const root = new BoxRenderable(renderer, {
			flexDirection: "column",
			backgroundColor: this.host.uiTheme().raised,
			overflow: "hidden",
		});
		root.add(host);
		let userHidden = false;
		let sizeHidden = false;
		let stackHandle: OverlayHandle | undefined;
		const applyHidden = () => stackHandle?.setHidden(userHidden || sizeHidden);
		const visible = options?.visible;
		if (visible) {
			sizeHidden = !visible(renderer.width, renderer.height);
			root.onLifecyclePass = () => {
				const hidden = !visible(renderer.width, renderer.height);
				if (hidden === sizeHidden) return;
				sizeHidden = hidden;
				applyHidden();
			};
		}
		const piHandle: PiOverlayHandle = {
			hide: () => stackHandle?.close(),
			setHidden: (hidden) => {
				userHidden = hidden;
				applyHidden();
			},
			isHidden: () => userHidden,
			focus: () => stackHandle?.focus(),
			unfocus: (unfocusOptions) => {
				stackHandle?.unfocus();
				if (unfocusOptions) tui.setFocus(unfocusOptions.target);
			},
			isFocused: () => stackHandle?.isFocused() ?? false,
			getBounds: () => stackHandle?.getBounds(),
		};
		stackHandle = overlays.open({
			root,
			focusTarget: capturing ? host : undefined,
			modal: capturing,
			backdrop: false,
			layout: piOverlayLayout(options),
			dispose: () => {
				const index = this.open.indexOf(piHandle);
				if (index !== -1) this.open.splice(index, 1);
				// Give pi-tui focus back unless another overlay already took it.
				if (capturing && tui.getFocusedComponent() === null && preFocus) tui.syncFocus(preFocus);
				tui.requestRender();
			},
		});
		if (sizeHidden) applyHidden();
		this.open.push(piHandle);
		return piHandle;
	}

	/** `tui.hideOverlay()`: close the most recent pi-tui overlay. */
	hideTop(): void {
		this.open[this.open.length - 1]?.hide();
	}

	/** Open pi-tui overlays, hidden ones included. */
	get size(): number {
		return this.open.length;
	}

	hasVisible(): boolean {
		return this.open.some((handle) => !handle.isHidden());
	}

	closeAll(): void {
		for (const handle of [...this.open].reverse()) handle.hide();
	}
}
