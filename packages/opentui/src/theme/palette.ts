/**
 * Palette for the OpenTUI frontend, derived from a nek interactive theme JSON (`dark.json`,
 * `light.json`, or a custom theme). Pure and Node-compatible.
 *
 * Depth comes from three background layers derived from one base color: `base` (transcript),
 * `panel` (footer, panels, tool rows), and `raised` (input, dialogs, user messages).
 */

export interface Palette {
	appearance: "dark" | "light";
	base: string;
	panel: string;
	raised: string;
	text: string;
	muted: string;
	dim: string;
	accent: string;
	border: string;
	borderMuted: string;
	borderAccent: string;
	success: string;
	warning: string;
	error: string;
	toolTitle: string;
	toolOutput: string;
	/** Blue used by Web Search and links. */
	link: string;
	thinking: string;
	heading: string;
	code: string;
	quote: string;
	selected: string;
	diffAdded: string;
	diffRemoved: string;
	label: string;
	toolPendingBg: string;
	toolSuccessBg: string;
	toolErrorBg: string;
	userBg: string;
}

interface ThemeJsonLike {
	vars?: Record<string, unknown>;
	colors?: Record<string, unknown>;
	export?: Record<string, unknown>;
}

const DARK_DEFAULTS = { fg: "#d4d4d4", bg: "#16161c" };
const LIGHT_DEFAULTS = { fg: "#2a2a2a", bg: "#fafafa" };

/** The 16 standard ANSI colors (xterm defaults), used for indexed theme values. */
const ANSI16 = [
	"#000000",
	"#cd0000",
	"#00cd00",
	"#cdcd00",
	"#0000ee",
	"#cd00cd",
	"#00cdcd",
	"#e5e5e5",
	"#7f7f7f",
	"#ff0000",
	"#00ff00",
	"#ffff00",
	"#5c5cff",
	"#ff00ff",
	"#00ffff",
	"#ffffff",
];

function hex2(value: number): string {
	return Math.max(0, Math.min(255, Math.round(value)))
		.toString(16)
		.padStart(2, "0");
}

/** xterm 256-color index to hex. */
export function indexedToHex(index: number): string {
	if (index < 16) return ANSI16[index] ?? "#000000";
	if (index < 232) {
		const i = index - 16;
		const level = (n: number) => (n === 0 ? 0 : 55 + n * 40);
		return `#${hex2(level(Math.floor(i / 36)))}${hex2(level(Math.floor(i / 6) % 6))}${hex2(level(i % 6))}`;
	}
	const gray = 8 + (index - 232) * 10;
	return `#${hex2(gray)}${hex2(gray)}${hex2(gray)}`;
}

function parseHex(color: string): [number, number, number] | undefined {
	const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
	if (!match) return undefined;
	const digits = match[1].length === 3 ? [...match[1]].map((d) => d + d).join("") : match[1];
	return [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16)) as [number, number, number];
}

/** Mix two hex colors; `amount` 0 returns `a`, 1 returns `b`. */
export function mix(a: string, b: string, amount: number): string {
	const ca = parseHex(a);
	const cb = parseHex(b);
	if (!ca || !cb) return a;
	return `#${ca.map((channel, i) => hex2(channel + (cb[i] - channel) * amount)).join("")}`;
}

/** Relative luminance (0 black .. 1 white). */
export function luminance(color: string): number {
	const c = parseHex(color);
	if (!c) return 0;
	const [r, g, b] = c.map((channel) => {
		const v = channel / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Resolve a theme value (hex, 256-color index, variable reference, or "") to hex. */
function resolveValue(value: unknown, vars: Record<string, unknown>, fallback: string, depth = 0): string {
	if (typeof value === "number") return indexedToHex(value);
	if (typeof value !== "string" || value === "" || depth > 16) return fallback;
	if (value.startsWith("#")) return parseHex(value) ? value : fallback;
	if (value in vars) return resolveValue(vars[value], vars, fallback, depth + 1);
	// oklch() and other notations are not converted; the fallback keeps the layout readable.
	return fallback;
}

/** Build the palette from a parsed theme JSON. Missing or unsupported values fall back per appearance. */
export function createPalette(theme: ThemeJsonLike): Palette {
	const vars = theme.vars ?? {};
	const colors = theme.colors ?? {};
	const exported = theme.export ?? {};
	const probeText = resolveValue(colors.text, vars, "");
	const probeBase = resolveValue(exported.pageBg, vars, "");
	const appearance: "dark" | "light" = probeBase
		? luminance(probeBase) < 0.4
			? "dark"
			: "light"
		: probeText && luminance(probeText) < 0.4
			? "light"
			: "dark";
	const defaults = appearance === "dark" ? DARK_DEFAULTS : LIGHT_DEFAULTS;
	const color = (token: string, fallback: string) => resolveValue(colors[token], vars, fallback);
	const text = color("text", defaults.fg);
	const base = probeBase || defaults.bg;
	// Dark themes raise layers toward the text color, light themes lower them.
	const toward = appearance === "dark" ? "#ffffff" : "#000000";
	const panel = mix(base, toward, appearance === "dark" ? 0.035 : 0.03);
	const raised = mix(base, toward, appearance === "dark" ? 0.075 : 0.06);
	const muted = color("muted", mix(text, base, 0.4));
	return {
		appearance,
		base,
		panel,
		raised,
		text,
		muted,
		dim: color("dim", mix(text, base, 0.55)),
		accent: color("accent", "#8abeb7"),
		border: color("border", "#5f87ff"),
		borderMuted: color("borderMuted", mix(text, base, 0.75)),
		borderAccent: color("borderAccent", "#00d7ff"),
		success: color("success", "#b5bd68"),
		warning: color("warning", "#f0c674"),
		error: color("error", "#cc6666"),
		toolTitle: color("toolTitle", text),
		toolOutput: color("toolOutput", muted),
		link: color("mdLink", color("border", "#81a2be")),
		thinking: color("thinkingText", muted),
		heading: color("mdHeading", "#f0c674"),
		code: color("mdCode", color("accent", "#8abeb7")),
		quote: color("mdQuote", muted),
		selected: color("selectedBg", raised),
		diffAdded: color("toolDiffAdded", "#b5bd68"),
		diffRemoved: color("toolDiffRemoved", "#cc6666"),
		label: color("customMessageLabel", "#9575cd"),
		toolPendingBg: mix(base, color("toolPendingBg", panel), 0.85),
		toolSuccessBg: mix(base, color("toolSuccessBg", panel), 0.85),
		toolErrorBg: mix(base, color("toolErrorBg", panel), 0.85),
		userBg: color("userMessageBg", raised),
	};
}
