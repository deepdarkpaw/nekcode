import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { hyperlink, setCapabilityOverrides, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { defaultEditorTheme } from "../../tui/test/test-themes.ts";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import {
	createMentionStyler,
	type MentionLinks,
	styleMentionsInLine,
} from "../src/modes/interactive/components/mention-style.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";

const ESCAPES = /\x1b(?:\[[0-?]*[ -/]*[@-~]|[\]_][^\x07\x1b]*(?:\x07|\x1b\\))/g;

function visible(text: string): string {
	return text.replace(ESCAPES, "");
}

const link = (text: string) => theme.fg("mdLink", text);
const plain = (text: string) => `<${text}>`;

describe("mention styling", () => {
	const dirs: string[] = [];

	beforeAll(() => {
		initTheme("dark", false);
	});

	afterEach(() => {
		setCapabilityOverrides({});
		while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
	});

	function createLinks(): { links: MentionLinks; notes: string; skill: string } {
		const cwd = mkdtempSync(join(tmpdir(), "nek-mentions-"));
		dirs.push(cwd);
		const notes = join(cwd, "notes.md");
		writeFileSync(notes, "notes");
		const skill = join(cwd, "pdf", "SKILL.md");
		return { links: { cwd, skillFile: (name) => (name === "pdf" ? skill : undefined) }, notes, skill };
	}

	it("colors mentions and links skills and existing @paths when the terminal supports hyperlinks", () => {
		setCapabilityOverrides({ hyperlinks: true });
		const { links, notes, skill } = createLinks();
		const style = createMentionStyler(plain, links);

		const styled = style("用 @skill:pdf 读 @notes.md，问 @agent:explorer，@missing.md 不存在");

		expect(styled).toBe(
			[
				plain("用 "),
				hyperlink(theme.underline(link("@skill:pdf")), pathToFileURL(skill).href),
				plain(" 读 "),
				hyperlink(theme.underline(link("@notes.md")), pathToFileURL(notes).href),
				plain("，问 "),
				link("@agent:explorer"),
				plain("，@missing.md 不存在"),
			].join(""),
		);
	});

	it("only colors mentions without hyperlink support or links", () => {
		setCapabilityOverrides({ hyperlinks: false });
		const { links } = createLinks();

		expect(createMentionStyler(plain, links)("用 @skill:pdf 读 @notes.md")).toBe(
			`${plain("用 ")}${link("@skill:pdf")}${plain(" 读 ")}${link("@notes.md")}`,
		);
		expect(createMentionStyler(plain, undefined)("@agent:explorer 看 @notes.md，user@skill:x")).toBe(
			`${link("@agent:explorer")}${plain(" 看 @notes.md，user@skill:x")}`,
		);
	});

	it("colors editor mentions around the cursor's escape sequences without changing the visible text", () => {
		const line = "ask @sk\x1b[7mi\x1b[0mll:pdf and user@skill:x";

		const styled = styleMentionsInLine(line);

		expect(styled).toBe(`ask ${link("@sk")}\x1b[7m${link("i")}\x1b[0m${link("ll:pdf")} and user@skill:x`);
		expect(visible(styled)).toBe(visible(line));
	});

	it("renders the sent message with colored mentions and no skill body", () => {
		const lines = new UserMessageComponent("看 @agent:explorer 和 @skill:pdf", undefined, 1).render(60);

		expect(lines.join("\n")).toContain(link("@agent:explorer"));
		expect(lines.join("\n")).toContain(link("@skill:pdf"));
		expect(visible(lines.join("\n"))).toContain("看 @agent:explorer 和 @skill:pdf");
	});

	it("colors mentions in the input editor", () => {
		const keybindings = new KeybindingsManager();
		const editor = new CustomEditor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme, keybindings);
		editor.setText("use @skill:pdf now");

		const content = editor.render(40).find((line) => visible(line).includes("use @skill:pdf"));

		expect(content).toContain(link("@skill:pdf"));
	});
});
