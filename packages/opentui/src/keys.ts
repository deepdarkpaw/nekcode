/**
 * Key bindings of the OpenTUI frontend. All key checks go through this table, so keys can be
 * changed in one place. Pure and Node-compatible.
 */

export type KeyAction =
	| "submit"
	| "submitFollowUp"
	| "newline"
	| "abort"
	| "clearOrExit"
	| "exit"
	| "scrollPageUp"
	| "scrollPageDown"
	| "scrollTop"
	| "scrollBottom"
	| "toggleTools"
	| "toggleThinking"
	| "dialogUp"
	| "dialogDown"
	| "dialogAccept"
	| "dialogCancel"
	| "dialogYes"
	| "dialogNo"
	| "editorSubmit";

/** A key in `ctrl+alt+shift+name` form, as in `"alt+return"`. */
export type KeySpec = string;

export const DEFAULT_KEYBINDINGS: Readonly<Record<KeyAction, readonly KeySpec[]>> = {
	submit: ["return"],
	submitFollowUp: ["alt+return"],
	newline: ["shift+return", "linefeed", "ctrl+j"],
	abort: ["escape"],
	clearOrExit: ["ctrl+c"],
	exit: ["ctrl+d"],
	scrollPageUp: ["pageup"],
	scrollPageDown: ["pagedown"],
	// Plain Home/End scroll only while the input is empty; otherwise they move the cursor.
	scrollTop: ["ctrl+home", "home"],
	scrollBottom: ["ctrl+end", "end"],
	toggleTools: ["ctrl+o"],
	toggleThinking: ["ctrl+t"],
	dialogUp: ["up", "ctrl+p"],
	dialogDown: ["down", "ctrl+n"],
	dialogAccept: ["return"],
	dialogCancel: ["escape"],
	dialogYes: ["y"],
	dialogNo: ["n"],
	editorSubmit: ["ctrl+s", "alt+return"],
};

/** The modifier and key fields of an OpenTUI key event. */
export interface KeyLike {
	name: string;
	ctrl?: boolean;
	meta?: boolean;
	option?: boolean;
	shift?: boolean;
}

interface ParsedSpec {
	name: string;
	ctrl: boolean;
	alt: boolean;
	shift: boolean;
}

function parseSpec(spec: KeySpec): ParsedSpec {
	const parts = spec.toLowerCase().split("+");
	const name = parts.pop() ?? "";
	return { name, ctrl: parts.includes("ctrl"), alt: parts.includes("alt"), shift: parts.includes("shift") };
}

/** Whether a key event matches one spec exactly (modifiers included). */
export function matchesSpec(key: KeyLike, spec: KeySpec): boolean {
	const parsed = parseSpec(spec);
	const alt = key.meta === true || key.option === true;
	return (
		key.name.toLowerCase() === parsed.name &&
		(key.ctrl === true) === parsed.ctrl &&
		alt === parsed.alt &&
		(key.shift === true) === parsed.shift
	);
}

export function matchesAction(
	key: KeyLike,
	action: KeyAction,
	bindings: Readonly<Record<KeyAction, readonly KeySpec[]>> = DEFAULT_KEYBINDINGS,
): boolean {
	return bindings[action].some((spec) => matchesSpec(key, spec));
}

/** Human-readable first binding of an action, such as `Alt+Enter`. */
export function keyLabel(
	action: KeyAction,
	bindings: Readonly<Record<KeyAction, readonly KeySpec[]>> = DEFAULT_KEYBINDINGS,
): string {
	const spec = bindings[action][0] ?? "";
	return spec
		.split("+")
		.map((part) =>
			part === "return"
				? "Enter"
				: part === "escape"
					? "Esc"
					: part.length === 1
						? part.toUpperCase()
						: part[0].toUpperCase() + part.slice(1),
		)
		.join("+");
}
