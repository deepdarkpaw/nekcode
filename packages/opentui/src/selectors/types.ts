/**
 * Selector contract.
 *
 * A selector is a modal overlay that resolves one result: model, thinking level, session, tree
 * node, settings, OAuth provider, theme, and so on. Build selectors from the primitives:
 * - `ctx.dialogs.select(...)` for plain lists (fuzzy filter, highlight callback, extra keys);
 * - `DialogFrame` + `SelectList` + `openDialog` (`ui/`) for custom layouts;
 * - `ctx.showComponent(...)` to host an existing pi-tui selector component unchanged.
 *
 * Keys come from the configurable keybindings (`tui.select.*`, `app.models.*`, `app.tree.*`,
 * `app.session.*`); match them with `matchesKeybinding` from `bridge/input.ts`.
 *
 * This file is a contract shared by parallel work. Add members only; do not rename or remove them.
 */

import type { ModeContext } from "../mode/mode-context.ts";

export interface SelectorDefinition<TArgs, TResult> {
	/** Stable id (`model`, `session`, `tree`, ...). */
	readonly id: string;
	/** Open the selector. Resolves `undefined` when cancelled. */
	open(ctx: ModeContext, args: TArgs): Promise<TResult | undefined>;
}

/** Define a selector with type inference for its argument and result. */
export function defineSelector<TArgs, TResult>(
	definition: SelectorDefinition<TArgs, TResult>,
): SelectorDefinition<TArgs, TResult> {
	return definition;
}
