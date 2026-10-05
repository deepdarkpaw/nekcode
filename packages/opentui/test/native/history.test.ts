import { afterEach, describe, expect, test } from "bun:test";
import { fauxAssistantMessage, fauxThinking, fauxToolCall } from "@earendil-works/pi-ai/compat";
import type { SessionManager } from "@earendil-works/pi-coding-agent/core/session-manager";
import { CustomEditor } from "@earendil-works/pi-coding-agent/modes/interactive/components/custom-editor";
import { type EditorComponent, Text } from "@earendil-works/pi-tui";
import { createFixture, frame, isFocused, type ModeFixture, waitForFrame } from "./mode-fixture.ts";

let fixture: ModeFixture | undefined;

afterEach(async () => {
	await fixture?.cleanup();
	fixture = undefined;
});

const ANSI = /\x1b\[[0-9;:?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b_[^\x1b]*\x1b\\/g;

/** Plain text of the whole transcript (not only the visible rows). */
function transcriptText(f: ModeFixture): string {
	return f.mode.transcript
		.renderedLines()
		.map((line) => line.replace(ANSI, ""))
		.join("\n");
}

const now = Date.now();

function seedHistory(f: SessionManager): void {
	const firstId = f.appendMessage({ role: "user", content: "first question", timestamp: now });
	f.appendMessage(
		fauxAssistantMessage(
			[
				fauxThinking("private reasoning"),
				{ type: "text", text: "answer text" },
				fauxToolCall("read", { path: "a.txt" }, { id: "t1" }),
			],
			{
				stopReason: "toolUse",
			},
		),
	);
	f.appendMessage({
		role: "toolResult",
		toolCallId: "t1",
		toolName: "read",
		content: [{ type: "text", text: "file body" }],
		isError: false,
		timestamp: now,
	});
	f.appendMessage({
		role: "bashExecution",
		command: "echo bashed",
		output: "bashed\n",
		exitCode: 0,
		cancelled: false,
		truncated: false,
		timestamp: now,
	});
	f.appendCustomMessageEntry("demo", "custom note body", true);
	f.appendCompaction("compacted summary text", firstId, 1234);
	f.appendMessage({
		role: "user",
		content: '<skill name="demo-skill" location="/skills/demo/SKILL.md">\nskill body\n</skill>\n\nplease use it',
		timestamp: now,
	});
	f.appendMessage(
		fauxAssistantMessage([fauxToolCall("bash", { command: "sleep 100" }, { id: "t2" })], { stopReason: "aborted" }),
	);
}

describe("session history", () => {
	test("renders every message kind on load", async () => {
		fixture = await createFixture({ seed: seedHistory });
		const f = fixture;
		await frame(f);
		const text = transcriptText(f);
		expect(text).toContain("first question");
		expect(text).toContain("answer text");
		expect(text).toContain("private reasoning");
		expect(text).toContain("a.txt");
		expect(text).toContain("echo bashed");
		expect(text).toContain("custom note body");
		expect(text).toContain("demo-skill");
		expect(text).toContain("please use it");
		expect(text).toContain("Operation aborted");
		expect(text).toContain("Session compacted 1 time");
		// Compaction summaries are collapsed until tools are expanded.
		expect(text.toLowerCase()).toContain("compact");
		// Prompt zones (OSC 133) mark the user messages for prompt jumps.
		expect(f.mode.viewport.promptRows().length).toBeGreaterThanOrEqual(2);
	});

	test("thinking visibility, hidden label, and tool expansion update rendered messages", async () => {
		fixture = await createFixture({ seed: seedHistory });
		const f = fixture;
		await frame(f);
		f.mode.setHideThinkingBlock(true);
		f.ui().setHiddenThinkingLabel("Pondering...");
		await frame(f);
		let text = transcriptText(f);
		expect(text).not.toContain("private reasoning");
		expect(text).toContain("Pondering...");
		f.mode.setToolsExpanded(true);
		await frame(f);
		text = transcriptText(f);
		expect(text).toContain("Tool output: expanded");
		expect(text).toContain("compacted summary text");
		expect(f.ui().getToolsExpanded()).toBe(true);
	});
});

describe("chrome", () => {
	test("custom header and footer replace the built-in ones and restore", async () => {
		fixture = await createFixture();
		const f = fixture;
		f.ui().setFooter(() => new Text("custom footer line", 0, 0));
		f.ui().setHeader(() => new Text("custom header line", 0, 0));
		let text = await frame(f);
		expect(text).toContain("custom footer line");
		expect(transcriptText(f)).toContain("custom header line");
		expect(text).not.toContain("faux-1");
		f.ui().setFooter(undefined);
		f.ui().setHeader(undefined);
		text = await frame(f);
		expect(text).toContain("faux-1");
		expect(transcriptText(f)).not.toContain("custom header line");
	});

	test("notify levels, warnings, and errors go to the transcript; status lines collapse", async () => {
		fixture = await createFixture();
		const f = fixture;
		f.ui().notify("info one");
		f.ui().notify("info two");
		f.ui().notify("careful", "warning");
		f.ui().notify("broken", "error");
		await frame(f);
		const text = transcriptText(f);
		expect(text).not.toContain("info one");
		expect(text).toContain("info two");
		expect(text).toContain("Warning: careful");
		expect(text).toContain("Error: broken");
	});

	test("the working indicator shows the extension message while streaming", async () => {
		fixture = await createFixture({ tokensPerSecond: 10 });
		const f = fixture;
		f.faux.setResponses([fauxAssistantMessage("slow ".repeat(40))]);
		const run = f.mode.run();
		await frame(f);
		f.ui().setWorkingMessage("Crunching numbers");
		await f.setup.mockInput.typeText("go");
		f.setup.mockInput.pressEnter();
		await waitForFrame(f, (value) => value.includes("Crunching numbers"));
		f.setup.mockInput.pressEscape();
		await waitForFrame(f, () => !f.runtime.session.isStreaming);
		f.mode.stop("resume-hint");
		await run;
	});

	test("setTheme switches the theme and the shell shades", async () => {
		fixture = await createFixture();
		const f = fixture;
		const before = f.mode.uiTheme().base.toString();
		const result = f.ui().setTheme("light");
		expect(result.success).toBe(true);
		await frame(f);
		expect(f.mode.uiTheme().base.toString()).not.toBe(before);
	});
});

describe("lifecycle", () => {
	test("flash shows a transient toast", async () => {
		fixture = await createFixture();
		const f = fixture;
		f.mode.flash("Copied!");
		const text = await frame(f);
		expect(text).toContain("Copied!");
	});

	test("reload resets extension UI, rebinds, and reports", async () => {
		fixture = await createFixture();
		const f = fixture;
		f.ui().setWidget("demo", ["widget before reload"]);
		expect(await frame(f)).toContain("widget before reload");
		await f.mode.reload();
		const text = await waitForFrame(f, () => transcriptText(f).includes("Reloaded keybindings"));
		expect(text).not.toContain("widget before reload");
		expect(isFocused(f.mode.editorComponent)).toBe(true);
	});
});

describe("editor", () => {
	test("extension editor text APIs", async () => {
		fixture = await createFixture();
		const f = fixture;
		f.ui().setEditorText("abc");
		expect(f.ui().getEditorText()).toBe("abc");
		f.ui().pasteToEditor(" more");
		expect(f.ui().getEditorText()).toBe("abc more");
	});

	test("large pastes collapse into a marker and expand on read; terminal input listeners see the paste", async () => {
		fixture = await createFixture();
		const f = fixture;
		const seen: string[] = [];
		f.ui().onTerminalInput((data) => {
			seen.push(data);
			return undefined;
		});
		const pasted = Array.from({ length: 30 }, (_, index) => `pasted line ${index}`).join("\n");
		await f.setup.mockInput.pasteBracketedText(pasted);
		const text = await waitForFrame(f, (value) => value.includes("paste #1"));
		expect(text).toContain("paste #1");
		expect(f.mode.editor.getExpandedText()).toBe(pasted);
		expect(seen.some((data) => data.includes("pasted line 29"))).toBe(true);
	});

	test("bash mode runs the command and shows the output block", async () => {
		fixture = await createFixture();
		const f = fixture;
		const run = f.mode.run();
		await frame(f);
		await f.setup.mockInput.typeText("!echo from-bash-mode");
		f.setup.mockInput.pressEnter();
		await waitForFrame(f, () => transcriptText(f).includes("from-bash-mode") && !f.runtime.session.isBashRunning);
		expect(transcriptText(f)).toContain("echo from-bash-mode");
		f.mode.stop("resume-hint");
		await run;
	});

	test("setEditorComponent swaps the editor and keeps the text and submit handler", async () => {
		fixture = await createFixture();
		const f = fixture;
		f.mode.editor.setText("kept text");
		let created: EditorComponent | undefined;
		f.ui().setEditorComponent((tui, editorTheme, keybindings) => {
			const editor = new CustomEditor(tui, editorTheme, keybindings);
			created = editor;
			return editor;
		});
		await frame(f);
		expect(f.mode.editorComponent).toBe(created as EditorComponent);
		expect(f.mode.editor.getText()).toBe("kept text");
		expect(isFocused(f.mode.editorComponent)).toBe(true);
		await f.setup.mockInput.typeText("!");
		await frame(f);
		expect(f.mode.editor.getText()).toBe("kept text!");
		f.ui().setEditorComponent(undefined);
		await frame(f);
		expect(f.mode.editorComponent).not.toBe(created as EditorComponent);
		expect(f.mode.editor.getText()).toBe("kept text!");
	});

	test("addAutocompleteProvider wraps the provider", async () => {
		fixture = await createFixture();
		const f = fixture;
		f.ui().addAutocompleteProvider((current) => ({
			applyCompletion: (lines, line, col, item, prefix) => current.applyCompletion(lines, line, col, item, prefix),
			getSuggestions: async (lines, line, col, options) => {
				const text = lines[line]?.slice(0, col) ?? "";
				if (text.endsWith("%")) {
					return { prefix: "%", items: [{ value: "%wrapped", label: "wrapped-suggestion" }] };
				}
				return current.getSuggestions(lines, line, col, options);
			},
			triggerCharacters: ["%"],
		}));
		await f.setup.mockInput.typeText("%");
		await waitForFrame(f, (value) => value.includes("wrapped-suggestion"));
	});
});
