/** Load the palette from the theme JSON chosen by the launcher, falling back to the built-in dark theme. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPalette, type Palette } from "./palette.ts";

/** Built-in themes of the coding-agent package, next to this package in the source checkout. */
const BUILTIN_DARK = fileURLToPath(
	new URL("../../../coding-agent/src/modes/interactive/theme/dark.json", import.meta.url),
);

function readJson(path: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(path, "utf8"));
		return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export function loadPalette(themePath: string | undefined): Palette {
	const theme = (themePath ? readJson(themePath) : undefined) ?? readJson(BUILTIN_DARK) ?? {};
	return createPalette(theme);
}
