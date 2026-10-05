import { afterEach, describe, expect, test } from "bun:test";
import { ModelSelectorComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/model-selector";
import { Container } from "@earendil-works/pi-tui";
import { trimRuleLines } from "../../src/bridge/component-host.ts";
import { createFixture, frame, isFocused, type ModeFixture, waitForFrame } from "./mode-fixture.ts";

let fixture: ModeFixture | undefined;

afterEach(async () => {
	await fixture?.cleanup();
	fixture = undefined;
});

async function runCommand(f: ModeFixture, text: string): Promise<void> {
	f.mode.editor.setText(text);
	f.setup.mockInput.pressEnter();
	await frame(f);
}

function fillTranscript(f: ModeFixture): void {
	for (let index = 0; index < 40; index++) f.mode.transcript.appendText("z".repeat(78));
}

describe("hosted selectors", () => {
	test("hosted selectors are opaque rounded panels over the transcript", async () => {
		fixture = await createFixture({ height: 30 });
		const f = fixture;
		fillTranscript(f);
		await runCommand(f, "/thinking");
		const text = await waitForFrame(f, (value) => value.includes("Thinking Level"));
		const rows = text.split("\n");
		const top = rows.findIndex((row) => row.includes("╭"));
		const bottom = rows.findIndex((row) => row.includes("╰"));
		expect(top).toBeGreaterThanOrEqual(0);
		expect(bottom).toBeGreaterThan(top);
		const left = rows[top]?.indexOf("╭") ?? -1;
		const right = rows[top]?.indexOf("╮") ?? -1;
		for (const row of rows.slice(top, bottom + 1)) {
			// No transcript cell shows through anywhere inside the panel rectangle.
			expect(row.slice(left, right + 1)).not.toContain("z");
		}
		// The selector's own `─` rules are replaced by the panel border.
		expect(rows[top + 1]?.slice(left + 1, right)).not.toContain("─");
		f.setup.mockInput.pressEscape();
		await waitForFrame(f, (value) => !value.includes("Thinking Level"));
	});

	test("/settings routes keys to the settings list: type to filter, Esc closes", async () => {
		fixture = await createFixture({ height: 30 });
		const f = fixture;
		await runCommand(f, "/settings");
		await waitForFrame(f, (value) => value.includes("Auto-compact"));
		await f.setup.mockInput.typeText("theme");
		const filtered = await waitForFrame(f, (value) => value.includes("> theme"));
		expect(filtered).toContain("Theme");
		expect(filtered).not.toContain("Auto-compact");
		f.setup.mockInput.pressEscape();
		await waitForFrame(f, (value) => !value.includes("Type to search"));
		expect(f.mode.overlays.size).toBe(0);
		expect(isFocused(f.mode.editorComponent)).toBe(true);
		await f.setup.mockInput.typeText("after");
		await frame(f);
		expect(f.mode.editor.getText()).toBe("after");
	});

	test("/fork routes keys to the message list", async () => {
		fixture = await createFixture({
			height: 30,
			seed: (sessionManager) => {
				for (const text of ["first question", "second question"]) {
					sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
				}
			},
		});
		const f = fixture;
		await runCommand(f, "/fork");
		await waitForFrame(f, (value) => value.includes("second question"));
		f.setup.mockInput.pressEscape();
		await waitForFrame(f, () => f.mode.overlays.size === 0);
		expect(isFocused(f.mode.editorComponent)).toBe(true);
	});

	test("/model runs the selector dispose when the overlay closes", async () => {
		fixture = await createFixture({ height: 30 });
		const f = fixture;
		const original = ModelSelectorComponent.prototype.dispose;
		let disposed = 0;
		ModelSelectorComponent.prototype.dispose = function (this: ModelSelectorComponent) {
			disposed++;
			original.call(this);
		};
		try {
			await runCommand(f, "/model");
			await waitForFrame(f, () => f.mode.overlays.size === 1);
			f.setup.mockInput.pressEscape();
			await waitForFrame(f, () => f.mode.overlays.size === 0);
			// The selector disposes itself on cancel; the hosted dispose runs again on close, as in `showSelector`.
			expect(disposed).toBe(2);
		} finally {
			ModelSelectorComponent.prototype.dispose = original;
		}
	});

	test("/scoped-models closes with Esc", async () => {
		fixture = await createFixture({ height: 30 });
		const f = fixture;
		await runCommand(f, "/scoped-models");
		await waitForFrame(f, () => f.mode.overlays.size === 1);
		f.setup.mockInput.pressEscape();
		await waitForFrame(f, () => f.mode.overlays.size === 0);
		expect(isFocused(f.mode.editorComponent)).toBe(true);
	});

	test("showComponent honors a HostedComponent focus target and dispose", async () => {
		fixture = await createFixture({ height: 30 });
		const f = fixture;
		const received: string[] = [];
		const inner = {
			render: () => ["inner list"],
			invalidate: () => {},
			handleInput: (data: string) => {
				received.push(data);
			},
		};
		const outer = new Container();
		outer.addChild(inner);
		let outerDisposed = 0;
		let hostedDisposed = 0;
		Object.assign(outer, { dispose: () => outerDisposed++ });
		let finish: ((value: string | undefined) => void) | undefined;
		const result = f.mode.showComponent<string>((done) => {
			finish = done;
			return { component: outer, focus: inner, dispose: () => hostedDisposed++ };
		});
		await waitForFrame(f, (value) => value.includes("inner list"));
		await f.setup.mockInput.typeText("ab");
		await frame(f);
		expect(received.join("")).toBe("ab");
		finish?.("done");
		expect(await result).toBe("done");
		await frame(f);
		expect(hostedDisposed).toBe(1);
		expect(outerDisposed).toBe(0);
		expect(isFocused(f.mode.editorComponent)).toBe(true);
	});

	test("trimRuleLines drops only leading and trailing rules", () => {
		const rule = "\x1b[38;5;240m────────\x1b[39m";
		expect(trimRuleLines([rule, "", "body ─", rule, rule])).toEqual(["", "body ─"]);
		expect(trimRuleLines(["body"])).toEqual(["body"]);
	});
});
