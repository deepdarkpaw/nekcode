import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { Text } from "@earendil-works/pi-tui";
import { createFixture, frame, type ModeFixture, waitForFrame } from "./mode-fixture.ts";

let fixture: ModeFixture | undefined;

afterEach(async () => {
	await fixture?.cleanup();
	fixture = undefined;
});

/** Scrollback text written so far (accumulated across calls). */
function scrollback(f: ModeFixture, seen: string[]): string {
	seen.push(f.setup.externalOutput.takeText());
	return seen.join("\n");
}

async function waitForScrollback(f: ModeFixture, seen: string[], needle: string): Promise<string> {
	for (let attempt = 0; attempt < 150; attempt++) {
		await frame(f);
		const text = scrollback(f, seen);
		if (text.includes(needle)) return text;
	}
	throw new Error(`scrollback never contained ${JSON.stringify(needle)}:\n${seen.join("\n")}`);
}

describe("regular TUI mode", () => {
	test("commits the transcript to scrollback and keeps only the editor area in the footer", async () => {
		fixture = await createFixture({ tuiMode: "regular", height: 30 });
		const f = fixture;
		const seen: string[] = [];
		expect(f.mode.getTuiMode()).toBe("regular");
		expect(f.setup.renderer.screenMode).toBe("split-footer");
		expect(f.setup.renderer.useMouse).toBe(false);
		f.faux.setResponses([fauxAssistantMessage("Hello from the faux model")]);
		const run = f.mode.run();
		await frame(f);
		// Startup header goes to scrollback once startup is done.
		await waitForScrollback(f, seen, "nek");
		await f.setup.mockInput.typeText("hi there");
		f.setup.mockInput.pressEnter();
		const text = await waitForScrollback(f, seen, "Hello from the faux model");
		expect(text).toContain("hi there");
		const footer = await waitForFrame(f, (value) => value.includes("faux-1"));
		// The footer holds the editor and status line, not the transcript.
		expect(footer).not.toContain("Hello from the faux model");
		expect(f.setup.renderer.footerHeight).toBeLessThan(30);
		f.mode.stop("transcript");
		await run;
	});

	test("switches between regular and fullscreen, refused while pi-tui overlays are open", async () => {
		fixture = await createFixture({ tuiMode: "regular", height: 30 });
		const f = fixture;
		const seen: string[] = [];
		f.mode.transcript.appendText("transcript marker line");
		await waitForScrollback(f, seen, "transcript marker line");

		const handle = f.mode.tui.showOverlay(new Text("overlay body", 1, 0), { anchor: "center", width: 30 });
		await frame(f);
		expect(f.mode.switchTuiMode("fullscreen")).toBe(false);
		expect(f.mode.getTuiMode()).toBe("regular");
		handle.hide();
		await frame(f);

		expect(f.mode.switchTuiMode("fullscreen")).toBe(true);
		expect(f.setup.renderer.screenMode).toBe("alternate-screen");
		// Fullscreen shows the whole transcript in the viewport again.
		await waitForFrame(f, (value) => value.includes("transcript marker line"));

		expect(f.mode.switchTuiMode("regular")).toBe(true);
		expect(f.setup.renderer.screenMode).toBe("split-footer");
		const footer = await waitForFrame(f, (value) => !value.includes("transcript marker line"));
		expect(footer).toContain("faux-1");
	});

	test("changing committed output replays the scrollback", async () => {
		fixture = await createFixture({ tuiMode: "regular", height: 30 });
		const f = fixture;
		f.mode.transcript.appendText("replayed marker line");
		await waitForScrollback(f, [], "replayed marker line");
		// Tool expansion changes blocks already in scrollback: the transcript is written again.
		f.mode.setToolsExpanded(true);
		await waitForScrollback(f, [], "replayed marker line");
	});

	test("live blocks stay in the footer until done; exit flushes them", async () => {
		fixture = await createFixture({ tuiMode: "regular", height: 30 });
		const f = fixture;
		f.mode.showStatus("latest status");
		// The latest status line can still be replaced, so it stays above the editor.
		await waitForFrame(f, (value) => value.includes("latest status"));
		const seen: string[] = [];
		expect(scrollback(f, seen)).not.toContain("latest status");
		f.mode.stop("transcript");
		expect(scrollback(f, seen)).toContain("latest status");
	});

	test("dialogs get the full terminal height", async () => {
		fixture = await createFixture({ tuiMode: "regular", height: 30 });
		const f = fixture;
		await frame(f);
		const choice = f.ui().select("Pick one", ["alpha", "beta"]);
		await waitForFrame(f, (value) => value.includes("Pick one") && value.includes("beta"));
		expect(f.setup.renderer.footerHeight).toBe(30);
		f.setup.mockInput.pressEscape();
		expect(await choice).toBeUndefined();
		await waitForFrame(f, () => f.setup.renderer.footerHeight < 30);
	});
});
