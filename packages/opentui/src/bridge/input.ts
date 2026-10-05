/**
 * Input forwarding between OpenTUI and pi-tui.
 *
 * pi-tui components and the keybinding manager work on raw terminal sequences (`handleInput(data)`,
 * `keybindings.matches(data, id)`). OpenTUI parses stdin into `KeyEvent`s but keeps the raw
 * sequence, so the bridge forwards `key.raw` unchanged. Bracketed pastes arrive as `PasteEvent`s
 * and are re-wrapped in paste markers, which pi-tui editors use to collapse large pastes.
 *
 * `RawInputRouter` runs raw-sequence listeners (extension `onTerminalInput`) before OpenTUI
 * dispatches a key, with pi-tui semantics: a listener may consume the input or replace it.
 */

import type { Keybinding, KeybindingsManager } from "@earendil-works/pi-tui";
import type { CliRenderer, KeyEvent, PasteEvent } from "@opentui/core";
import { decodePasteBytes, parseKeypress } from "@opentui/core";

export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

/** The raw terminal sequence of a key event, as pi-tui expects it. */
export function keyToSequence(key: Pick<KeyEvent, "raw" | "sequence">): string {
	return key.raw || key.sequence;
}

/** A bracketed paste sequence with the pasted text. */
export function pasteToSequence(event: Pick<PasteEvent, "bytes">): string {
	return `${PASTE_START}${decodePasteBytes(event.bytes)}${PASTE_END}`;
}

/** Whether a key event matches a configured keybinding (`app.*` or `tui.*`). Never hardcode keys. */
export function matchesKeybinding(
	keybindings: Pick<KeybindingsManager, "matches">,
	key: Pick<KeyEvent, "raw" | "sequence">,
	id: Keybinding,
): boolean {
	return keybindings.matches(keyToSequence(key), id);
}

/** The first keybinding of `ids` that matches the key. */
export function matchFirstKeybinding<T extends Keybinding>(
	keybindings: Pick<KeybindingsManager, "matches">,
	key: Pick<KeyEvent, "raw" | "sequence">,
	ids: readonly T[],
): T | undefined {
	const data = keyToSequence(key);
	return ids.find((id) => keybindings.matches(data, id));
}

/** Result of a raw input listener: consume the input, or replace it with `data`. */
export type RawInputListenerResult = { consume?: boolean; data?: string } | undefined;
export type RawInputListener = (data: string) => RawInputListenerResult;

/** Outcome of running listeners on one sequence. */
export interface RawInputDispatch {
	consumed: boolean;
	data: string;
}

/** Run listeners in order. Mirrors pi-tui `TUI` input listener semantics. */
export function runRawInputListeners(listeners: Iterable<RawInputListener>, data: string): RawInputDispatch {
	let current = data;
	for (const listener of listeners) {
		const result = listener(current);
		if (result?.consume) return { consumed: true, data: current };
		if (result?.data !== undefined) current = result.data;
	}
	return { consumed: current.length === 0, data: current };
}

/**
 * Raw-sequence listeners in front of OpenTUI's key dispatch. Attach once per renderer.
 * Replaced input is parsed again and dispatched as a key event.
 */
export class RawInputRouter {
	private readonly renderer: CliRenderer;
	private readonly listeners = new Set<RawInputListener>();
	private attached = false;
	private readonly handler = (sequence: string): boolean => this.handle(sequence);

	constructor(renderer: CliRenderer) {
		this.renderer = renderer;
	}

	attach(): void {
		if (this.attached) return;
		this.attached = true;
		this.renderer.prependInputHandler(this.handler);
	}

	detach(): void {
		if (!this.attached) return;
		this.attached = false;
		this.renderer.removeInputHandler(this.handler);
	}

	/** Add a listener. Returns its unsubscribe function. */
	add(listener: RawInputListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	get size(): number {
		return this.listeners.size;
	}

	clear(): void {
		this.listeners.clear();
	}

	private handle(sequence: string): boolean {
		if (this.listeners.size === 0) return false;
		const result = runRawInputListeners([...this.listeners], sequence);
		if (result.consumed) return true;
		if (result.data === sequence) return false;
		const parsed = parseKeypress(result.data);
		if (parsed) this.renderer.keyInput.processParsedKey(parsed);
		return true;
	}
}
