import { type Component, Container } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

function fixture() {
	const editor = { render: () => [], invalidate() {}, getText: () => "draft", setText: vi.fn() };
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		extensionDialogs: [],
		editor,
		defaultEditor: { ...editor },
		editorContainer: new Container(),
		ui: { setFocus: vi.fn(), requestRender: vi.fn() },
		disposeActiveSelector: vi.fn(),
		updateEditorBorderColor: vi.fn(),
	});
	const open = (signal?: AbortSignal) => {
		let finish!: (value: string | undefined) => void;
		const component: Component & { dispose(): void } = { render: () => [], invalidate() {}, dispose: vi.fn() };
		const promise: Promise<string | undefined> = mode.showExtensionDialog((done: typeof finish) => {
			finish = done;
			return component;
		}, signal);
		return { finish: (value?: string) => finish(value), component, promise };
	};
	return { mode, open, editor };
}

beforeAll(() => initTheme("dark", false));
describe("independent extension dialog lifetimes", () => {
	it("restores the previous pending dialog after closing the top one", async () => {
		const { mode, open, editor } = fixture();
		const first = open();
		const second = open();
		expect(mode.editorContainer.children).toEqual([second.component]);
		second.finish("two");
		expect(await second.promise).toBe("two");
		expect(mode.editorContainer.children).toEqual([first.component]);
		first.finish("one");
		expect(await first.promise).toBe("one");
		expect(mode.editorContainer.children).toEqual([editor]);
	});
	it("cancels a hidden dialog without changing focus or settling its sibling", async () => {
		const { mode, open } = fixture();
		const controller = new AbortController();
		const first = open(controller.signal);
		const second = open();
		mode.ui.setFocus.mockClear();
		controller.abort();
		expect(await first.promise).toBeUndefined();
		expect(mode.editorContainer.children).toEqual([second.component]);
		expect(mode.ui.setFocus).not.toHaveBeenCalled();
		first.finish("late");
		expect(first.component.dispose).toHaveBeenCalledTimes(1);
		second.finish();
		await second.promise;
	});
	it("keeps an open dialog visible when the base editor is replaced", async () => {
		const { mode, open } = fixture();
		const dialog = open();
		mode.setCustomEditorComponent(undefined);
		expect(mode.editorContainer.children).toEqual([dialog.component]);
		dialog.finish();
		await dialog.promise;
		expect(mode.editorContainer.children).toEqual([mode.defaultEditor]);
	});
	it("settles every pending dialog on UI cancellation, ignoring late answers", async () => {
		const { mode, open } = fixture();
		const first = open();
		const second = open();
		for (const dialog of [...mode.extensionDialogs]) dialog.cancel();
		expect(await Promise.all([first.promise, second.promise])).toEqual([undefined, undefined]);
		first.finish("late");
		second.finish("late");
		expect(mode.extensionDialogs).toEqual([]);
	});
});
