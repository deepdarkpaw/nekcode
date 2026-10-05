import { afterEach, describe, expect, test } from "bun:test";
import { InputRenderable, TextareaRenderable } from "@opentui/core";
import { DialogFrame } from "../../src/ui/dialog-frame.ts";
import {
	openDialog,
	showConfirmDialog,
	showEditorDialog,
	showInputDialog,
	showSelectDialog,
} from "../../src/ui/dialogs.ts";
import { keyHints } from "../../src/ui/environment.ts";
import { createTestUi, settle, type TestUi } from "./helpers.ts";

let ui: TestUi | undefined;

afterEach(() => {
	ui?.dispose();
	ui = undefined;
});

const items = [
	{ value: "alpha", label: "Alpha", description: "first" },
	{ value: "beta", label: "Beta", description: "second" },
	{ value: "gamma", label: "Gamma", description: "third" },
];

describe("OverlayStack", () => {
	test("modal overlays take focus and restore it on close", async () => {
		ui = await createTestUi();
		const below = new InputRenderable(ui.renderer, { value: "" });
		ui.root.add(below);
		below.focus();
		const first = new InputRenderable(ui.renderer, { value: "" });
		const firstHandle = ui.env.overlays.open({ root: first });
		expect(first.focused).toBe(true);
		const second = new InputRenderable(ui.renderer, { value: "" });
		const secondHandle = ui.env.overlays.open({ root: second });
		expect(second.focused).toBe(true);
		expect(ui.env.overlays.size).toBe(2);
		secondHandle.close();
		expect(first.focused).toBe(true);
		firstHandle.close();
		expect(below.focused).toBe(true);
		expect(ui.env.overlays.hasModal()).toBe(false);
	});

	test("the topmost overlay sees keys first and keys never reach layers below", async () => {
		ui = await createTestUi();
		const below = new InputRenderable(ui.renderer, { value: "" });
		ui.root.add(below);
		below.focus();
		const seen: string[] = [];
		const frame = new DialogFrame(ui.env, { title: "Keys" });
		ui.env.overlays.open({
			root: frame.root,
			handleKey: (key) => {
				seen.push(key.name);
				return key.name === "x";
			},
		});
		ui.mockInput.pressKey("x");
		ui.mockInput.pressKey("y");
		await settle(ui);
		expect(seen).toEqual(["x", "y"]);
		expect(below.value).toBe("");
	});

	test("hidden overlays get no keys and give focus back", async () => {
		ui = await createTestUi();
		const below = new InputRenderable(ui.renderer, { value: "" });
		ui.root.add(below);
		below.focus();
		const overlay = new InputRenderable(ui.renderer, { value: "" });
		const handle = ui.env.overlays.open({ root: overlay });
		handle.setHidden(true);
		expect(below.focused).toBe(true);
		ui.mockInput.typeText("ab");
		await settle(ui);
		expect(below.value).toBe("ab");
		handle.setHidden(false);
		expect(overlay.focused).toBe(true);
		handle.close();
		expect(handle.isOpen).toBe(false);
	});
});

describe("dialogs", () => {
	test("select dialog renders a rounded panel and resolves the highlighted item", async () => {
		ui = await createTestUi();
		const result = showSelectDialog(ui.env, { title: "Pick one", items });
		const frame = await settle(ui);
		expect(frame).toContain("Pick one");
		expect(frame).toContain("› Alpha");
		expect(frame).toContain("╭");
		ui.mockInput.pressArrow("down");
		ui.mockInput.pressEnter();
		expect(await result).toBe("beta");
		expect(ui.env.overlays.size).toBe(0);
	});

	test("select dialog wraps around and cancels with the cancel binding", async () => {
		ui = await createTestUi();
		const highlighted: Array<string | undefined> = [];
		const result = showSelectDialog(ui.env, {
			title: "Pick",
			items,
			onHighlight: (item) => highlighted.push(item?.value),
		});
		ui.mockInput.pressArrow("up");
		await settle(ui);
		expect(highlighted.at(-1)).toBe("gamma");
		ui.mockInput.pressEscape();
		expect(await result).toBeUndefined();
	});

	test("select dialog filters with fuzzy matching", async () => {
		ui = await createTestUi();
		const result = showSelectDialog(ui.env, { title: "Filter", items, filter: true });
		await settle(ui);
		await ui.mockInput.typeText("gam");
		const frame = await settle(ui);
		expect(frame).toContain("Gamma");
		expect(frame).not.toContain("Beta");
		ui.mockInput.pressEnter();
		expect(await result).toBe("gamma");
	});

	test("confirm dialog resolves true for Yes and false on cancel", async () => {
		ui = await createTestUi();
		const yes = showConfirmDialog(ui.env, { title: "Delete?", message: "This cannot be undone" });
		expect(await settle(ui)).toContain("This cannot be undone");
		ui.mockInput.pressEnter();
		expect(await yes).toBe(true);
		const no = showConfirmDialog(ui.env, { title: "Again?", message: "Sure" });
		await settle(ui);
		ui.mockInput.pressEscape();
		expect(await no).toBe(false);
	});

	test("input dialog submits the typed text", async () => {
		ui = await createTestUi();
		const result = showInputDialog(ui.env, { title: "Name", placeholder: "session name" });
		await settle(ui);
		await ui.mockInput.typeText("my session");
		ui.mockInput.pressEnter();
		expect(await result).toBe("my session");
	});

	test("editor dialog inserts newlines and submits multi-line text", async () => {
		ui = await createTestUi({ kittyKeyboard: true });
		const result = showEditorDialog(ui.env, { title: "Edit", prefill: "one" });
		await settle(ui);
		const top = ui.renderer.currentFocusedRenderable;
		expect(top).toBeInstanceOf(TextareaRenderable);
		ui.mockInput.pressEnter({ shift: true });
		await ui.mockInput.typeText("two");
		ui.mockInput.pressEnter();
		expect(await result).toBe("one\ntwo");
	});

	test("dialogs resolve undefined on abort and timeout", async () => {
		ui = await createTestUi();
		const controller = new AbortController();
		const aborted = showInputDialog(ui.env, { title: "Abort me", signal: controller.signal });
		await settle(ui);
		controller.abort();
		expect(await aborted).toBeUndefined();
		const timedOut = showSelectDialog(ui.env, { title: "Timeout", items, timeoutMs: 30 });
		expect(await settle(ui)).toContain("Timeout (1s)");
		expect(await timedOut).toBeUndefined();
		expect(ui.env.overlays.size).toBe(0);
		const preAborted = new AbortController();
		preAborted.abort();
		expect(
			await openDialog(ui.env, () => ({ root: new DialogFrame(ui!.env).root }), { signal: preAborted.signal }),
		).toBe(undefined);
	});

	test("key hints come from the configured keybindings", async () => {
		ui = await createTestUi();
		expect(keyHints(ui.keybindings, [["tui.select.confirm", "select"]])).toBe("enter select");
		ui.keybindings.setUserBindings({ "tui.select.confirm": "ctrl+y" });
		expect(keyHints(ui.keybindings, [["tui.select.confirm", "select"]])).toBe("ctrl+y select");
		ui.keybindings.setUserBindings({ "tui.select.confirm": [] });
		expect(keyHints(ui.keybindings, [["tui.select.confirm", "select"]])).toBe("");
	});

	test("the select dialog hint names each key once", async () => {
		ui = await createTestUi({ width: 120 });
		const env = ui.env;
		const choice = showSelectDialog(env, { title: "Select provider", items });
		const text = await settle(ui);
		// Regression: the hint read "up up · down down · enter select".
		expect(text).toContain("up/down navigate · enter select · escape/ctrl+c cancel");
		expect(text).not.toContain("up up");
		ui.mockInput.pressEscape();
		expect(await choice).toBeUndefined();
	});
});
