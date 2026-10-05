import { describe, expect, test } from "bun:test";
import { initTheme, theme } from "@earendil-works/pi-coding-agent/modes/interactive/theme/theme";
import { createUiTheme } from "../../src/theme/ui-theme.ts";

function luminance(color: { r: number; g: number; b: number }): number {
	return color.r + color.g + color.b;
}

describe("createUiTheme", () => {
	test("dark theme layers lift from the page background", () => {
		initTheme("dark", false);
		const ui = createUiTheme(theme);
		expect(ui.appearance).toBe("dark");
		expect(ui.base.toInts().slice(0, 3)).toEqual([0x18, 0x18, 0x1e]);
		expect(luminance(ui.panel)).toBeGreaterThan(luminance(ui.base));
		expect(luminance(ui.raised)).toBeGreaterThan(luminance(ui.panel));
		expect(luminance(ui.overlay)).toBeGreaterThan(luminance(ui.raised));
	});

	test("light theme layers darken from the page background", () => {
		initTheme("light", false);
		const ui = createUiTheme(theme);
		expect(ui.appearance).toBe("light");
		expect(luminance(ui.panel)).toBeLessThan(luminance(ui.base));
		expect(luminance(ui.raised)).toBeLessThan(luminance(ui.panel));
		initTheme("dark", false);
	});

	test("tokens map to theme colors; links and Web Search use the mdLink blue", () => {
		initTheme("dark", false);
		const ui = createUiTheme(theme);
		expect(ui.link.equals(ui.token("mdLink"))).toBe(true);
		expect(ui.link.b).toBeGreaterThan(ui.link.r);
		expect(ui.muted.equals(ui.token("muted"))).toBe(true);
		expect(ui.thinkingBorder("high").equals(ui.token("thinkingHigh"))).toBe(true);
	});
});
