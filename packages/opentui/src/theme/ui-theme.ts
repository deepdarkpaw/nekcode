/**
 * OpenTUI colors from the active pi theme.
 *
 * Every pi theme token (`theme.colors`) maps to an OpenTUI `RGBA`. On top of the tokens, the UI uses
 * three layered background shades derived from the theme's page background, so surfaces read as
 * stacked: `base` (transcript), `panel` (footer, widgets, tool rows), and `raised` (editor, dialogs,
 * user messages). Dark themes lift layers toward white, light themes lower them toward black.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	getThemeExportColors,
	type Theme,
	type ThemeColor,
	type ThemeToken,
} from "@earendil-works/pi-coding-agent/modes/interactive/theme/theme";
import { type Color, colorToHex, mixColors, parseColor } from "@earendil-works/pi-tui";
import { RGBA } from "@opentui/core";

/** Page backgrounds used when a theme declares no `export.pageBg`. */
const DEFAULT_PAGE_BG = { dark: "#18181e", light: "#f8f8f8" } as const;

/** How far each layer moves from the page background toward the contrast color. */
const LAYER_STEPS = {
	dark: { panel: 0.045, raised: 0.09, overlay: 0.13 },
	light: { panel: 0.035, raised: 0.07, overlay: 0.1 },
} as const;

export interface UiTheme {
	/** Theme name (`dark`, `light`, or a custom name). */
	readonly name: string | undefined;
	readonly appearance: "dark" | "light";
	/** Transcript background. */
	readonly base: RGBA;
	/** Footer, widgets, panels, and tool rows. */
	readonly panel: RGBA;
	/** Editor, user messages, and dialogs. */
	readonly raised: RGBA;
	/** Selected rows and nested surfaces inside dialogs. */
	readonly overlay: RGBA;
	/** Body text. */
	readonly text: RGBA;
	/** Secondary text. */
	readonly muted: RGBA;
	/** Tertiary text (hints, timestamps). */
	readonly dim: RGBA;
	readonly accent: RGBA;
	readonly border: RGBA;
	readonly borderMuted: RGBA;
	readonly borderAccent: RGBA;
	readonly success: RGBA;
	readonly warning: RGBA;
	readonly error: RGBA;
	/** Links and Web Search (the theme's `mdLink` blue). */
	readonly link: RGBA;
	/** Color of a theme token (any `ThemeColor` or `ThemeBg`). */
	token(name: ThemeToken): RGBA;
	/** Hex string of a theme token. */
	hex(name: ThemeToken): string;
	/** Editor border color for a thinking level (`thinkingOff` ... `thinkingMax`). */
	thinkingBorder(level: ThinkingLevel | "off"): RGBA;
}

const THINKING_TOKENS: Record<ThinkingLevel | "off", ThemeColor> = {
	off: "thinkingOff",
	minimal: "thinkingMinimal",
	low: "thinkingLow",
	medium: "thinkingMedium",
	high: "thinkingHigh",
	xhigh: "thinkingXhigh",
	max: "thinkingMax",
};

function toRgba(color: Color): RGBA {
	return RGBA.fromHex(colorToHex(color));
}

/** The theme's page background: `export.pageBg`, else a default for its appearance. */
function resolvePageBackground(theme: Theme): Color {
	const exported = theme.name ? getThemeExportColors(theme.name).pageBg : undefined;
	if (exported) {
		try {
			return parseColor(exported);
		} catch {
			// Fall through to the appearance default for unparsable export colors.
		}
	}
	return parseColor(DEFAULT_PAGE_BG[theme.appearance]);
}

/** Build OpenTUI colors from a pi theme. Call again after the theme changes. */
export function createUiTheme(theme: Theme): UiTheme {
	const appearance = theme.appearance;
	const colors = theme.colors;
	const page = resolvePageBackground(theme);
	const contrast = parseColor(appearance === "dark" ? "#ffffff" : "#000000");
	const steps = LAYER_STEPS[appearance];
	const layer = (amount: number) => toRgba(mixColors(page, contrast, amount, "srgb"));
	const cache = new Map<ThemeToken, RGBA>();
	const token = (name: ThemeToken): RGBA => {
		let value = cache.get(name);
		if (!value) {
			value = toRgba(colors[name]);
			cache.set(name, value);
		}
		return value;
	};
	return {
		name: theme.name,
		appearance,
		base: toRgba(page),
		panel: layer(steps.panel),
		raised: layer(steps.raised),
		overlay: layer(steps.overlay),
		text: token("text"),
		muted: token("muted"),
		dim: token("dim"),
		accent: token("accent"),
		border: token("border"),
		borderMuted: token("borderMuted"),
		borderAccent: token("borderAccent"),
		success: token("success"),
		warning: token("warning"),
		error: token("error"),
		link: token("mdLink"),
		token,
		hex: (name) => colorToHex(colors[name]),
		thinkingBorder: (level) => token(THINKING_TOKENS[level] ?? "thinkingOff"),
	};
}
