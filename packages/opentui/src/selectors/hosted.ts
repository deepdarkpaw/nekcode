import type { Component } from "@earendil-works/pi-tui";
import type { FacadeTui } from "../bridge/facade-tui.ts";
import type { ComponentFactory, ModeContext } from "../mode/mode-context.ts";

/** Host an existing pi-tui selector while preserving its complete input behavior. */
export function openHosted<T>(
	ctx: ModeContext,
	build: (done: (value: T | undefined) => void, tui: FacadeTui) => Component,
): Promise<T | undefined> {
	const factory: ComponentFactory<T> = (done, tui) => build(done, tui);
	return ctx.showComponent(factory, { layout: { width: "90%", maxHeight: "90%" } });
}
