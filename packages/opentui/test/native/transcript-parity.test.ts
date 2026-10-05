/** Transcript, editor, and extension-UI behaviors ported from the interactive mode. */

import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/compat";
import { theme } from "@earendil-works/pi-coding-agent/modes/interactive/theme/theme";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createFixture, frame, type ModeFixture, waitForFrame } from "./mode-fixture.ts";

let fixture: ModeFixture | undefined;

afterEach(async () => {
	await fixture?.cleanup();
	fixture = undefined;
});

async function waitFor(f: ModeFixture, predicate: () => boolean): Promise<void> {
	await waitForFrame(f, () => predicate());
}

function transcriptText(f: ModeFixture): string {
	return f.mode.transcript.renderedLines().join("\n");
}

describe("transcript parity", () => {
	test("extension tool renderCall/renderResult components render in the tool row", async () => {
		fixture = await createFixture({
			height: 40,
			extension: (pi) =>
				pi.registerTool({
					name: "demo_tool",
					label: "Demo",
					description: "Demo tool",
					parameters: Type.Object({ value: Type.String() }),
					execute: async () => ({ content: [{ type: "text", text: "raw result" }], details: undefined }),
					renderCall: (args) => new Text(`custom call ${args.value}`, 0, 0),
					renderResult: () => new Text("custom result view", 0, 0),
				}),
		});
		const f = fixture;
		f.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("demo_tool", { value: "v1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);
		await f.runtime.session.prompt("use the tool");
		await waitFor(f, () => transcriptText(f).includes("custom result view"));
		expect(transcriptText(f)).toContain("custom call v1");
	});

	test("extension markdown transformers apply to assistant messages", async () => {
		fixture = await createFixture({
			height: 30,
			extension: (pi) => pi.registerMarkdownTransformer((markdown) => markdown.replaceAll("RAW", "TRANSFORMED")),
		});
		const f = fixture;
		f.faux.setResponses([fauxAssistantMessage("this is RAW text")]);
		await f.runtime.session.prompt("go");
		await waitFor(f, () => transcriptText(f).includes("this is TRANSFORMED text"));
	});

	test("custom entries render through registered entry renderers", async () => {
		fixture = await createFixture({
			height: 30,
			extension: (pi) => {
				pi.registerEntryRenderer<{ note: string }>(
					"demo-entry",
					(entry) => new Text(`entry: ${entry.data?.note}`, 0, 0),
				);
				pi.registerCommand("note", {
					description: "Append a note entry",
					handler: async (args) => pi.appendEntry("demo-entry", { note: args }),
				});
			},
		});
		const f = fixture;
		const run = f.mode.run();
		await frame(f);
		f.mode.editor.setText("/note hello entry");
		f.setup.mockInput.pressEnter();
		await waitFor(f, () => transcriptText(f).includes("entry: hello entry"));
		f.mode.stop("resume-hint");
		await run;
	});

	test("branch summaries render from the session", async () => {
		fixture = await createFixture({
			height: 30,
			seed: (sessionManager) => {
				sessionManager.appendMessage({ role: "user", content: "before branch", timestamp: Date.now() });
				sessionManager.branchWithSummary(null, "summary of the abandoned branch");
			},
		});
		const f = fixture;
		await waitFor(
			f,
			() => /branch/i.test(transcriptText(f)) && transcriptText(f).includes("before branch") === false,
		);
		expect(transcriptText(f).toLowerCase()).toContain("summary");
	});

	test("extension errors show in the transcript", async () => {
		fixture = await createFixture({
			height: 30,
			extension: (pi) =>
				pi.on("agent_start", () => {
					throw new Error("extension boom");
				}),
		});
		const f = fixture;
		f.faux.setResponses([fauxAssistantMessage("reply")]);
		await f.runtime.session.prompt("trigger");
		await waitFor(f, () => transcriptText(f).includes("extension boom"));
	});

	test("loaded resources list context files", async () => {
		fixture = await createFixture({
			height: 30,
			seed: (sessionManager) => writeFileSync(join(sessionManager.getCwd(), "AGENTS.md"), "# rules\n"),
		});
		const f = fixture;
		await waitFor(f, () => transcriptText(f).includes("[Context]"));
		expect(transcriptText(f)).toContain("AGENTS.md");
	});

	test("built-in command conflicts are reported in the loaded resources", async () => {
		fixture = await createFixture({
			height: 40,
			extension: (pi) => pi.registerCommand("model", { description: "Shadow", handler: async () => {} }),
		});
		const f = fixture;
		await waitFor(f, () => transcriptText(f).includes("conflicts with built-in interactive command"));
	});
});

describe("editor parity", () => {
	test("editor border follows bash mode", async () => {
		fixture = await createFixture({ height: 30 });
		const f = fixture;
		const run = f.mode.run();
		await frame(f);
		const thinkingColor = f.mode.editorComponent.borderColor?.("x");
		await f.setup.mockInput.typeText("!ls");
		await frame(f);
		expect(f.mode.editorComponent.borderColor?.("x")).toBe(theme.getBashModeBorderColor()("x"));
		expect(f.mode.editorComponent.borderColor?.("x")).not.toBe(thinkingColor);
		f.mode.stop("resume-hint");
		await run;
	});

	test("runtime settings re-apply editor padding", async () => {
		fixture = await createFixture({ height: 30 });
		const f = fixture;
		f.mode.editor.setText("padded");
		let text = await frame(f);
		const before = text.split("\n").find((line) => line.includes("padded")) ?? "";
		f.runtime.session.settingsManager.setEditorPaddingX(4);
		f.mode.applySettings();
		text = await waitForFrame(f, (value) => {
			const line = value.split("\n").find((row) => row.includes("padded")) ?? "";
			return line.indexOf("padded") > before.indexOf("padded");
		});
		expect(text).toContain("padded");
	});

	test("double app.clear and app.exit on an empty editor shut down", async () => {
		fixture = await createFixture({ height: 30 });
		const f = fixture;
		let shutdowns = 0;
		f.mode.shutdown = async () => {
			shutdowns++;
		};
		const run = f.mode.run();
		await frame(f);
		f.setup.mockInput.pressCtrlC();
		await frame(f);
		expect(shutdowns).toBe(0);
		f.setup.mockInput.pressCtrlC();
		await waitFor(f, () => shutdowns === 1);
		f.setup.mockInput.pressKey("d", { ctrl: true });
		await waitFor(f, () => shutdowns === 2);
		f.mode.stop("resume-hint");
		await run;
	});

	test("extension shortcuts run their handlers", async () => {
		let ran = 0;
		fixture = await createFixture({
			height: 30,
			extension: (pi) =>
				pi.registerShortcut("alt+m", {
					description: "Demo",
					handler: () => {
						ran++;
					},
				}),
		});
		const f = fixture;
		const run = f.mode.run();
		await frame(f);
		f.setup.mockInput.pressKey("m", { meta: true });
		await waitFor(f, () => ran === 1);
		f.mode.stop("resume-hint");
		await run;
	});

	test("command context actions: newSession and waitForIdle", async () => {
		let idle = false;
		fixture = await createFixture({
			height: 30,
			extension: (pi) =>
				pi.registerCommand("fresh", {
					description: "New session from an extension",
					handler: async (_args, ctx) => {
						await ctx.waitForIdle();
						idle = true;
						await ctx.newSession();
					},
				}),
		});
		const f = fixture;
		f.faux.setResponses([fauxAssistantMessage("old reply")]);
		await f.runtime.session.prompt("old prompt");
		const before = f.runtime.session.sessionManager.getSessionId();
		const run = f.mode.run();
		await frame(f);
		f.mode.editor.setText("/fresh");
		f.setup.mockInput.pressEnter();
		await waitFor(f, () => idle && f.runtime.session.sessionManager.getSessionId() !== before);
		expect(f.runtime.session.messages).toHaveLength(0);
		f.mode.stop("resume-hint");
		await run;
	});

	test("interrupt hints use the configured app.interrupt key", async () => {
		const agentDir = process.env.NEK_CODING_AGENT_DIR ?? "";
		const keybindingsPath = join(agentDir, "keybindings.json");
		writeFileSync(keybindingsPath, JSON.stringify({ "app.interrupt": "ctrl+k" }));
		try {
			fixture = await createFixture({ height: 30 });
			const text = await frame(fixture);
			expect(text).toContain("ctrl+k interrupt");
			expect(text).not.toContain("escape interrupt");
		} finally {
			rmSync(keybindingsPath, { force: true });
		}
	});

	test("follow-up queue and dequeue use their keybindings", async () => {
		const keybindingsPath = join(process.env.NEK_CODING_AGENT_DIR ?? "", "keybindings.json");
		writeFileSync(
			keybindingsPath,
			JSON.stringify({ "app.message.followUp": "ctrl+q", "app.message.dequeue": "alt+q" }),
		);
		try {
			fixture = await createFixture({ height: 30, tokensPerSecond: 10 });
			const f = fixture;
			f.faux.setResponses([fauxAssistantMessage("slow reply ".repeat(30)), fauxAssistantMessage("second")]);
			const run = f.mode.run();
			await frame(f);
			await f.setup.mockInput.typeText("first");
			f.setup.mockInput.pressEnter();
			await waitFor(f, () => f.runtime.session.isStreaming);
			await f.setup.mockInput.typeText("later please");
			f.setup.mockInput.pressKey("q", { ctrl: true });
			await waitForFrame(f, (value) => value.includes("Follow-up: later please"));
			expect(f.mode.editor.getText()).toBe("");
			f.setup.mockInput.pressKey("q", { meta: true });
			await waitFor(f, () => f.mode.editor.getText() === "later please");
			f.mode.stop("resume-hint");
			await run;
		} finally {
			rmSync(keybindingsPath, { force: true });
		}
	}, 20_000);
});
