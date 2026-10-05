import type { Component } from "@earendil-works/pi-tui";
import type { FacadeTui } from "../bridge/facade-tui.ts";
import type { ComponentFactory, HostedComponent, ModeContext } from "../mode/mode-context.ts";

/**
 * Host an existing pi-tui selector while preserving its complete input behavior. Return a
 * `HostedComponent` to route keys to an inner component or to run cleanup on close, exactly like
 * the interactive mode's `showSelector` (`{ component, focus, dispose }`).
 */
export function openHosted<T>(
	ctx: ModeContext,
	build: (done: (value: T | undefined) => void, tui: FacadeTui) => Component | HostedComponent,
): Promise<T | undefined> {
	const factory: ComponentFactory<T> = (done, tui) => build(done, tui);
	return ctx.showComponent(factory, { layout: { width: "90%", maxHeight: "90%" } });
}
