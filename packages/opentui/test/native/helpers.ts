/**
 * Shared setup for the native OpenTUI tests: an offscreen renderer, a facade TUI sized to it, and
 * a UI environment with the default keybindings and the dark theme.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KeybindingsManager } from "@earendil-works/pi-coding-agent/core/keybindings";
import { initTheme, theme } from "@earendil-works/pi-coding-agent/modes/interactive/theme/theme";
import { setKeybindings, setKittyProtocolActive } from "@earendil-works/pi-tui";
import { BoxRenderable } from "@opentui/core";
import { createTestRenderer, type TestRendererSetup } from "@opentui/core/testing";
import { FacadeTui } from "../../src/bridge/facade-tui.ts";
import { createUiTheme } from "../../src/theme/ui-theme.ts";
import type { UiEnvironment } from "../../src/ui/environment.ts";
import { OverlayStack } from "../../src/ui/overlay-stack.ts";

// Keep user configuration (keybindings.json, settings) out of the tests.
process.env.NEK_CODING_AGENT_DIR ??= mkdtempSync(join(tmpdir(), "nek-opentui-test-"));
// Never download managed tools (fd, rg) during tests.
process.env.NEK_OFFLINE ??= "1";

export interface TestUi extends TestRendererSetup {
	tui: FacadeTui;
	env: UiEnvironment;
	keybindings: KeybindingsManager;
	/** Full-screen container for test content. */
	root: BoxRenderable;
	dispose(): void;
}

export interface TestUiOptions {
	width?: number;
	height?: number;
	/** Encode keys with the Kitty keyboard protocol (needed for modified keys like shift+enter). */
	kittyKeyboard?: boolean;
}

export async function createTestUi(options: TestUiOptions = {}): Promise<TestUi> {
	initTheme("dark", false);
	setKittyProtocolActive(options.kittyKeyboard === true);
	const keybindings = new KeybindingsManager({});
	setKeybindings(keybindings);
	const setup = await createTestRenderer({
		width: options.width ?? 60,
		height: options.height ?? 20,
		kittyKeyboard: options.kittyKeyboard === true,
	});
	const { renderer } = setup;
	const tui = new FacadeTui({ size: () => ({ columns: renderer.width, rows: renderer.height }) });
	tui.bind({
		onRenderRequest: () => renderer.requestRender(),
		showOverlay: () => {
			throw new Error("not supported in tests");
		},
		hideTopOverlay: () => {},
		hasOverlay: () => false,
		onFocusRequest: () => {},
		onInvalidate: () => renderer.requestRender(),
	});
	tui.start();
	const root = new BoxRenderable(renderer, { width: "100%", height: "100%", flexDirection: "column" });
	renderer.root.add(root);
	const overlayHost = new BoxRenderable(renderer, {
		position: "absolute",
		top: 0,
		left: 0,
		width: "100%",
		height: "100%",
	});
	renderer.root.add(overlayHost);
	const overlays = new OverlayStack(renderer, overlayHost);
	const env: UiEnvironment = { renderer, overlays, keybindings, uiTheme: () => createUiTheme(theme) };
	return {
		...setup,
		tui,
		env,
		keybindings,
		root,
		dispose: () => {
			overlays.dispose();
			tui.stop();
			renderer.destroy();
		},
	};
}

/** Let promise continuations and throttled pi-tui render requests (16 ms) run, then render a frame. */
export async function settle(ui: TestUi): Promise<string> {
	await new Promise((resolve) => setTimeout(resolve, 20));
	await ui.renderOnce();
	await ui.renderOnce();
	return ui.captureCharFrame();
}
