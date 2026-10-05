/**
 * A pi-tui-`Container`-like list of transcript blocks backed by OpenTUI renderables.
 *
 * The transcript code follows the interactive mode, which appends pi-tui components to a chat
 * container (`addChild(new Spacer(1))`, `addChild(new Text(...))`, ...). Here every child gets its
 * own `ComponentHostRenderable` in the transcript ScrollBox, so each block re-renders, culls, and
 * selects on its own. Native OpenTUI blocks can be mixed in with `addRenderable`.
 */

import type { Component } from "@earendil-works/pi-tui";
import type { CliRenderer, Renderable, ScrollBoxRenderable } from "@opentui/core";
import { ComponentHostRenderable } from "../bridge/component-host.ts";
import type { FacadeTui } from "../bridge/facade-tui.ts";

interface ChatEntry {
	readonly component: Component | undefined;
	readonly renderable: Renderable;
}

export class ChatList {
	private readonly renderer: CliRenderer;
	private readonly parent: ScrollBoxRenderable;
	private readonly tui: FacadeTui;
	private readonly entries: ChatEntry[] = [];
	private clears = 0;

	constructor(renderer: CliRenderer, parent: ScrollBoxRenderable, tui: FacadeTui) {
		this.renderer = renderer;
		this.parent = parent;
		this.tui = tui;
	}

	/** Hosted pi-tui components in order (native blocks excluded). */
	get children(): readonly Component[] {
		const children: Component[] = [];
		for (const entry of this.entries) if (entry.component) children.push(entry.component);
		return children;
	}

	/** Number of blocks, native ones included. */
	get length(): number {
		return this.entries.length;
	}

	/** Hosts of the pi-tui components, in order. */
	get hosts(): readonly ComponentHostRenderable[] {
		const hosts: ComponentHostRenderable[] = [];
		for (const entry of this.entries) {
			if (entry.renderable instanceof ComponentHostRenderable) hosts.push(entry.renderable);
		}
		return hosts;
	}

	/** The last block's component (undefined for native blocks or an empty list). */
	get last(): Component | undefined {
		return this.entries[this.entries.length - 1]?.component;
	}

	addChild(component: Component): ComponentHostRenderable {
		const host = this.createHost(component);
		this.entries.push({ component, renderable: host });
		this.parent.add(host);
		this.renderer.requestRender();
		return host;
	}

	/** Insert `component` before `before`; appends when `before` is not in the list. */
	insertBefore(component: Component, before: Component): ComponentHostRenderable {
		const index = this.entries.findIndex((entry) => entry.component === before);
		if (index === -1) return this.addChild(component);
		const host = this.createHost(component);
		const anchor = this.entries[index]?.renderable;
		this.entries.splice(index, 0, { component, renderable: host });
		this.parent.insertBefore(host, anchor);
		this.renderer.requestRender();
		return host;
	}

	/** Append a native OpenTUI block. */
	addRenderable(renderable: Renderable): void {
		this.entries.push({ component: undefined, renderable });
		this.parent.add(renderable);
		this.renderer.requestRender();
	}

	removeChild(component: Component): void {
		const index = this.entries.findIndex((entry) => entry.component === component);
		if (index !== -1) this.removeAt(index);
	}

	removeRenderable(renderable: Renderable): void {
		const index = this.entries.findIndex((entry) => entry.renderable === renderable);
		if (index !== -1) this.removeAt(index);
	}

	indexOf(component: Component): number {
		return this.children.indexOf(component);
	}

	hostOf(component: Component): ComponentHostRenderable | undefined {
		const entry = this.entries.find((candidate) => candidate.component === component);
		return entry?.renderable instanceof ComponentHostRenderable ? entry.renderable : undefined;
	}

	/** Increments on every `clear()` (the regular screen replays its scrollback after a rebuild). */
	get clearGeneration(): number {
		return this.clears;
	}

	clear(): void {
		this.clears++;
		while (this.entries.length > 0) this.removeAt(this.entries.length - 1);
	}

	private removeAt(index: number): void {
		const [entry] = this.entries.splice(index, 1);
		if (!entry) return;
		this.parent.remove(entry.renderable);
		entry.renderable.destroyRecursively();
		this.renderer.requestRender();
	}

	private createHost(component: Component): ComponentHostRenderable {
		// Transcript blocks never take keyboard focus; input reaches pi-tui through the editor slot.
		return new ComponentHostRenderable(this.renderer, {
			component,
			tui: this.tui,
			focusable: false,
			syncFocus: false,
			// Components outlive their host when they move to another list (pending bash output).
			disposeComponent: false,
		});
	}
}
