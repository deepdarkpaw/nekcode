import { afterEach, describe, expect, test } from "bun:test";
import { hotkeysMarkdown } from "../../src/commands/hotkeys.ts";
import { createFixture, type ModeFixture, waitForFrame } from "./mode-fixture.ts";

let fixture: ModeFixture | undefined;

afterEach(async () => {
	await fixture?.cleanup();
	fixture = undefined;
});

describe("/hotkeys", () => {
	test("matches the interactive mode's table, including extension shortcuts", async () => {
		fixture = await createFixture({
			height: 40,
			extension: (pi) => pi.registerShortcut("alt+m", { description: "Toggle demo mode", handler: () => {} }),
		});
		const f = fixture;
		const markdown = hotkeysMarkdown(f.mode, "win32");
		expect(markdown).toContain("| `Enter` | Send message |");
		expect(markdown).toContain("New line (Ctrl+Enter on Windows Terminal) |");
		expect(markdown).toContain("` / `");
		expect(markdown).toMatch(/\| `[^`]+` \/ `[^`]+` \| Cycle models \|/);
		expect(markdown).toContain("| `/` | Slash commands |");
		expect(markdown).toContain("| `!` | Run bash command |");
		expect(markdown).toContain("| `!!` | Run bash command (excluded from context) |");
		expect(markdown).toContain("**Extensions**");
		expect(markdown).toContain("| `Alt+M` | Toggle demo mode |");
		expect(hotkeysMarkdown(f.mode, "linux")).not.toContain("Windows Terminal");

		f.mode.editor.setText("/hotkeys");
		f.setup.mockInput.pressEnter();
		const text = await waitForFrame(f, (value) => value.includes("Toggle demo mode"));
		expect(text).toContain("Alt+M");
	});
});
