/**
 * What UI primitives need from the running mode: the renderer, the overlay stack, the configurable
 * keybindings, and the current theme colors. `ModeContext` extends this, so every primitive accepts
 * a mode context directly.
 */

import { formatKeyText } from "@earendil-works/pi-coding-agent/modes/interactive/components/keybinding-hints";
import type { Keybinding, KeybindingsManager } from "@earendil-works/pi-tui";
import type { CliRenderer } from "@opentui/core";
import type { UiTheme } from "../theme/ui-theme.ts";
import type { OverlayStack } from "./overlay-stack.ts";

export interface UiEnvironment {
	readonly renderer: CliRenderer;
	readonly overlays: OverlayStack;
	readonly keybindings: KeybindingsManager;
	/** Current theme colors. Read on every build; the theme can change at runtime. */
	uiTheme(): UiTheme;
}

/** Display text of a keybinding's keys (`ctrl+o`, `escape/ctrl+c`), or "" when unbound. */
export function keyLabel(keybindings: Pick<KeybindingsManager, "getKeys">, id: Keybinding): string {
	return formatKeyText(keybindings.getKeys(id).join("/"));
}

/** `"<keys> <description>"` hint parts joined with " · ", skipping unbound keys. */
export function keyHints(
	keybindings: Pick<KeybindingsManager, "getKeys">,
	hints: ReadonlyArray<readonly [Keybinding, string]>,
): string {
	return hints
		.map(([id, description]) => {
			const label = keyLabel(keybindings, id);
			return label ? `${label} ${description}` : "";
		})
		.filter((hint) => hint.length > 0)
		.join(" · ");
}
