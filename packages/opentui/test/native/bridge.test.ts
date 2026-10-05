import { afterEach, describe, expect, test } from "bun:test";
import { type Component, CURSOR_MARKER, type Focusable, Text } from "@earendil-works/pi-tui";
import { ComponentHostRenderable } from "../../src/bridge/component-host.ts";
import {
	keyToSequence,
	matchesKeybinding,
	PASTE_END,
	PASTE_START,
	pasteToSequence,
	RawInputRouter,
	runRawInputListeners,
} from "../../src/bridge/input.ts";
import { createTestUi, settle, type TestUi } from "./helpers.ts";

/** A component that records its inputs, render widths, and invalidations. */
class ProbeComponent implements Component, Focusable {
	focused = false;
	label = "probe";
	readonly inputs: string[] = [];
	readonly widths: number[] = [];
	invalidations = 0;

	render(width: number): string[] {
		this.widths.push(width);
		const cursor = this.focused ? CURSOR_MARKER : "";
		return [`\x1b[1m${this.label}\x1b[22m w=${width}${cursor}`, `inputs=${this.inputs.length}`];
	}

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	invalidate(): void {
		this.invalidations++;
	}
}

let ui: TestUi | undefined;

afterEach(() => {
	ui?.dispose();
	ui = undefined;
});

function host(testUi: TestUi, component: Component): ComponentHostRenderable {
	const renderable = new ComponentHostRenderable(testUi.renderer, { component, tui: testUi.tui });
	testUi.root.add(renderable);
	return renderable;
}

describe("raw input helpers", () => {
	test("keyToSequence prefers the raw sequence", () => {
		expect(keyToSequence({ raw: "\x1b[A", sequence: "up" })).toBe("\x1b[A");
		expect(keyToSequence({ raw: "", sequence: "a" })).toBe("a");
	});

	test("pasteToSequence wraps text in bracketed paste markers", () => {
		const bytes = new TextEncoder().encode("multi\nline");
		expect(pasteToSequence({ bytes })).toBe(`${PASTE_START}multi\nline${PASTE_END}`);
	});

	test("listeners consume or replace input in order", () => {
		const seen: string[] = [];
		const result = runRawInputListeners(
			[
				(data) => {
					seen.push(data);
					return { data: data.toUpperCase() };
				},
				(data) => {
					seen.push(data);
					return undefined;
				},
			],
			"x",
		);
		expect(result).toEqual({ consumed: false, data: "X" });
		expect(seen).toEqual(["x", "X"]);
		expect(runRawInputListeners([() => ({ consume: true })], "y")).toEqual({ consumed: true, data: "y" });
		expect(runRawInputListeners([() => ({ data: "" })], "z").consumed).toBe(true);
	});

	test("matchesKeybinding uses the configurable bindings", async () => {
		ui = await createTestUi();
		expect(matchesKeybinding(ui.keybindings, { raw: "\x1b", sequence: "\x1b" }, "app.interrupt")).toBe(true);
		expect(matchesKeybinding(ui.keybindings, { raw: "\r", sequence: "\r" }, "tui.input.submit")).toBe(true);
		expect(matchesKeybinding(ui.keybindings, { raw: "\r", sequence: "\r" }, "app.interrupt")).toBe(false);
		ui.keybindings.setUserBindings({ "app.interrupt": "ctrl+g" });
		expect(matchesKeybinding(ui.keybindings, { raw: "\x1b", sequence: "\x1b" }, "app.interrupt")).toBe(false);
		expect(matchesKeybinding(ui.keybindings, { raw: "\x07", sequence: "\x07" }, "app.interrupt")).toBe(true);
	});

	test("RawInputRouter consumes and rewrites input before key dispatch", async () => {
		ui = await createTestUi();
		const router = new RawInputRouter(ui.renderer);
		router.attach();
		const keys: string[] = [];
		ui.renderer.keyInput.on("keypress", (key) => keys.push(key.name));
		const remove = router.add((data) =>
			data === "a" ? { consume: true } : data === "b" ? { data: "c" } : undefined,
		);
		ui.mockInput.pressKey("a");
		ui.mockInput.pressKey("b");
		ui.mockInput.pressKey("d");
		await settle(ui);
		expect(keys).toEqual(["c", "d"]);
		remove();
		ui.mockInput.pressKey("a");
		await settle(ui);
		expect(keys).toEqual(["c", "d", "a"]);
		router.detach();
	});
});

describe("ComponentHostRenderable", () => {
	test("renders component lines as styled text at the layout width", async () => {
		ui = await createTestUi({ width: 40 });
		const component = new ProbeComponent();
		const renderable = host(ui, component);
		const frame = await settle(ui);
		expect(frame).toContain("probe w=40");
		expect(frame).toContain("inputs=0");
		expect(renderable.plainText).toBe("probe w=40\ninputs=0");
		expect(renderable.height).toBe(2);
	});

	test("re-renders on width changes and on tui.requestRender", async () => {
		ui = await createTestUi({ width: 40 });
		const component = new ProbeComponent();
		host(ui, component);
		await settle(ui);
		ui.resize(30, 20);
		expect(await settle(ui)).toContain("probe w=30");
		component.label = "changed";
		ui.tui.requestRender();
		expect(await settle(ui)).toContain("changed w=30");
	});

	test("tui.invalidate() invalidates hosted components", async () => {
		ui = await createTestUi();
		const component = new ProbeComponent();
		host(ui, component);
		await settle(ui);
		const before = component.invalidations;
		ui.tui.invalidate();
		await settle(ui);
		expect(component.invalidations).toBe(before + 1);
	});

	test("forwards keys and pastes to handleInput while focused", async () => {
		ui = await createTestUi();
		const component = new ProbeComponent();
		const renderable = host(ui, component);
		renderable.focus();
		expect(component.focused).toBe(true);
		expect(ui.tui.getFocusedComponent()).toBe(component);
		ui.mockInput.pressKey("x");
		ui.mockInput.pressArrow("up");
		await ui.mockInput.pasteBracketedText("pasted");
		const frame = await settle(ui);
		expect(component.inputs).toEqual(["x", "\x1b[A", `${PASTE_START}pasted${PASTE_END}`]);
		expect(frame).toContain("inputs=3");
		expect(renderable.cursor).toEqual({ row: 0, col: "probe w=60".length });
		renderable.blur();
		expect(component.focused).toBe(false);
	});

	test("disposes the component when destroyed", async () => {
		ui = await createTestUi();
		let disposed = false;
		const component = Object.assign(new Text("bye", 0, 0), {
			dispose: () => {
				disposed = true;
			},
		});
		const renderable = host(ui, component);
		await settle(ui);
		renderable.destroyRecursively();
		expect(disposed).toBe(true);
	});
});

describe("FacadeTui", () => {
	test("reports the renderer size and collects input listeners", async () => {
		ui = await createTestUi({ width: 50, height: 12 });
		expect(ui.tui.terminal.columns).toBe(50);
		expect(ui.tui.terminal.rows).toBe(12);
		const remove = ui.tui.addInputListener((data) => (data === "q" ? { consume: true } : undefined));
		expect(ui.tui.dispatchInput("q").consumed).toBe(true);
		expect(ui.tui.dispatchInput("w")).toEqual({ consumed: false, data: "w" });
		remove();
		expect(ui.tui.inputListenerCount).toBe(0);
	});

	test("render requests bump the render generation", async () => {
		ui = await createTestUi();
		const before = ui.tui.renderGeneration;
		ui.tui.requestRender();
		await settle(ui);
		expect(ui.tui.renderGeneration).toBeGreaterThan(before);
	});
});
