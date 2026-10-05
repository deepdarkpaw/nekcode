/** Built-in slash commands and command-owned keys, driven through the real mode (faux provider). */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { createFixture, frame, isFocused, type ModeFixture, waitForFrame } from "./mode-fixture.ts";

let fixture: ModeFixture | undefined;

afterEach(async () => {
	await fixture?.cleanup();
	fixture = undefined;
});

async function command(f: ModeFixture, text: string): Promise<void> {
	f.mode.editor.setText(text);
	f.setup.mockInput.pressEnter();
	await frame(f);
}

async function waitFor(f: ModeFixture, predicate: () => boolean): Promise<void> {
	await waitForFrame(f, () => predicate());
}

/** Run one prompt to completion so the session has user and assistant messages. */
async function prompt(f: ModeFixture, text: string, reply: string): Promise<void> {
	f.faux.setResponses([fauxAssistantMessage(reply)]);
	await f.runtime.session.prompt(text);
	await waitForFrame(f, (value) => value.includes(reply));
}

function seedUserMessages(texts: readonly string[]) {
	return (sessionManager: Parameters<NonNullable<Parameters<typeof createFixture>[0]>["seed"] & object>[0]) => {
		for (const text of texts) sessionManager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
	};
}

describe("built-in commands", () => {
	test("/model with a unique match switches without a selector", async () => {
		fixture = await createFixture({ height: 30 });
		const f = fixture;
		await command(f, "/model faux/faux-1");
		await waitForFrame(f, (value) => value.includes("Model: faux-1"));
		expect(f.mode.overlays.size).toBe(0);
		expect(f.runtime.session.model?.id).toBe("faux-1");
	});

	test("/thinking with a level sets it; an unknown level is an error", async () => {
		fixture = await createFixture({ height: 30 });
		const f = fixture;
		await command(f, "/thinking off");
		await waitForFrame(f, (value) => value.includes("Thinking level: off"));
		await command(f, "/thinking nonsense");
		await waitForFrame(f, (value) => value.includes('Unknown thinking level "nonsense"'));
	});

	test("/export writes html and jsonl; /import replaces the session after confirmation", async () => {
		fixture = await createFixture({ height: 30, persistSession: true });
		const f = fixture;
		await prompt(f, "exported question", "exported answer");
		const dir = f.runtime.session.sessionManager.getCwd();
		const html = join(dir, "out.html");
		const jsonl = join(dir, "out.jsonl");
		await command(f, `/export ${html}`);
		await waitFor(f, () => existsSync(html));
		expect(readFileSync(html, "utf8")).toMatch(/<html/i);
		await command(f, `/export ${jsonl}`);
		await waitFor(f, () => existsSync(jsonl));
		expect(readFileSync(jsonl, "utf8")).toContain("exported question");
		await command(f, "/new");
		await waitFor(f, () => f.runtime.session.messages.length === 0);
		await command(f, `/import ${jsonl}`);
		await waitForFrame(f, (value) => value.includes("Import session"));
		f.setup.mockInput.pressEnter();
		await waitFor(f, () => f.runtime.session.messages.some((message) => message.role === "user"));
		await waitFor(f, () => f.mode.transcript.renderedLines().some((line) => line.includes("exported question")));
	});

	test("/resume switches to a stored session", async () => {
		fixture = await createFixture({ height: 30, persistSession: true });
		const f = fixture;
		await prompt(f, "resume me later", "stored answer");
		const stored = f.runtime.session.sessionManager.getSessionId();
		await command(f, "/new");
		await waitFor(f, () => f.runtime.session.sessionManager.getSessionId() !== stored);
		await command(f, "/resume");
		await waitForFrame(f, (value) => value.includes("resume me later"));
		f.setup.mockInput.pressEnter();
		await waitFor(f, () => f.runtime.session.sessionManager.getSessionId() === stored);
	});

	test("/copy without a reply reports it; /name sets the session name; /session shows stats", async () => {
		fixture = await createFixture({ height: 40 });
		const f = fixture;
		await command(f, "/copy");
		await waitForFrame(f, (value) => value.includes("No agent messages to copy yet."));
		await command(f, "/name my session");
		await waitForFrame(f, (value) => value.includes("Session name set: my session"));
		expect(f.runtime.session.sessionManager.getSessionName()).toBe("my session");
		await command(f, "/session");
		const text = await waitForFrame(f, (value) => value.includes("Cache Warming"));
		expect(text).toContain("Cost");
	});

	test("/changelog renders the What's New block", async () => {
		fixture = await createFixture({ height: 30 });
		const f = fixture;
		await command(f, "/changelog");
		await waitFor(f, () => f.mode.transcript.renderedLines().some((line) => line.includes("What's New")));
	});

	test("/fork puts the selected message in the editor of a new session", async () => {
		fixture = await createFixture({ height: 30, seed: seedUserMessages(["first question", "second question"]) });
		const f = fixture;
		const before = f.runtime.session.sessionManager.getSessionId();
		await command(f, "/fork");
		await waitForFrame(f, (value) => value.includes("second question"));
		f.setup.mockInput.pressEnter();
		await waitForFrame(f, (value) => value.includes("Forked to new session"));
		expect(f.mode.editor.getText()).toBe("second question");
		expect(f.runtime.session.sessionManager.getSessionId()).not.toBe(before);
	});

	test("/clone duplicates the session at the current leaf", async () => {
		fixture = await createFixture({ height: 30 });
		const f = fixture;
		await prompt(f, "clone me", "cloned answer");
		const before = f.runtime.session.sessionManager.getSessionId();
		await command(f, "/clone");
		await waitForFrame(f, (value) => value.includes("Cloned to new session"));
		expect(f.runtime.session.sessionManager.getSessionId()).not.toBe(before);
		expect(f.runtime.session.messages.some((message) => message.role === "user")).toBe(true);
	});

	test("/tree navigates to an earlier entry", async () => {
		fixture = await createFixture({ height: 40 });
		const f = fixture;
		await prompt(f, "tree first", "answer one");
		await prompt(f, "tree second", "answer two");
		const leaf = f.runtime.session.sessionManager.getLeafId();
		await command(f, "/tree");
		await waitForFrame(f, (value) => value.includes("tree second"));
		f.setup.mockInput.pressArrow("up");
		f.setup.mockInput.pressArrow("up");
		f.setup.mockInput.pressEnter();
		// Summarize prompt: "No summary".
		await waitForFrame(f, (value) => value.includes("Summarize branch?"));
		f.setup.mockInput.pressEnter();
		await waitFor(f, () => f.runtime.session.sessionManager.getLeafId() !== leaf);
	});

	test("/trust saves a decision", async () => {
		fixture = await createFixture({ height: 40 });
		const f = fixture;
		await command(f, "/trust");
		await waitFor(f, () => f.mode.overlays.size === 1);
		f.setup.mockInput.pressEnter();
		await waitForFrame(f, (value) => value.includes("Saved trust decision"));
	});

	test("/login <provider> runs the API key flow; /logout removes the stored key", async () => {
		fixture = await createFixture({ height: 40 });
		const f = fixture;
		await command(f, "/login faux");
		await waitFor(f, () => f.mode.overlays.size === 1);
		await f.setup.mockInput.typeText("secret-key");
		f.setup.mockInput.pressEnter();
		await waitForFrame(f, (value) => value.includes("Saved API key for"));
		await command(f, "/logout");
		await waitForFrame(f, (value) => value.includes("Select provider to logout"));
		f.setup.mockInput.pressEnter();
		await waitForFrame(f, (value) => value.includes("Removed stored API key"));
	});

	test("/new starts an empty session", async () => {
		fixture = await createFixture({ height: 30 });
		const f = fixture;
		await prompt(f, "old question", "old answer");
		await command(f, "/new");
		await waitForFrame(f, (value) => value.includes("New session started"));
		expect(f.runtime.session.messages).toHaveLength(0);
	});

	test("/compact runs session compaction and reports its result", async () => {
		fixture = await createFixture({ height: 30 });
		const f = fixture;
		await prompt(f, "compact question", "compact answer");
		await command(f, "/compact");
		// One exchange is below the keep-recent budget: the session reports it and the indicator clears.
		await waitForFrame(f, (value) => value.includes("Nothing to compact"));
		expect(isFocused(f.mode.editorComponent)).toBe(true);
	});

	test("/reload reloads resources and gives the editor back", async () => {
		fixture = await createFixture({ height: 30 });
		const f = fixture;
		await command(f, "/reload");
		await waitForFrame(f, (value) => value.includes("Reloaded"));
		expect(isFocused(f.mode.editorComponent)).toBe(true);
	});

	test("/debug writes the debug log", async () => {
		fixture = await createFixture({ height: 30 });
		const f = fixture;
		await command(f, "/debug");
		const text = await waitForFrame(f, (value) => value.includes("Debug log written"));
		expect(text).toContain("Debug log written");
	});

	test("/quit shuts down", async () => {
		fixture = await createFixture({ height: 30 });
		const f = fixture;
		let shutdowns = 0;
		f.mode.shutdown = async () => {
			shutdowns++;
		};
		await command(f, "/quit");
		await waitFor(f, () => shutdowns === 1);
	});

	test("/arminsayshi and /dementedelves render their components", async () => {
		fixture = await createFixture({ height: 40 });
		const f = fixture;
		const before = f.mode.transcript.renderedLines().length;
		await command(f, "/arminsayshi");
		await waitFor(f, () => f.mode.transcript.renderedLines().length > before + 5);
		const afterArmin = f.mode.transcript.renderedLines().length;
		await command(f, "/dementedelves");
		await waitFor(f, () => f.mode.transcript.renderedLines().length > afterArmin);
	});

	test("/settings toggles auto-compact", async () => {
		fixture = await createFixture({ height: 30 });
		const f = fixture;
		const before = f.runtime.session.autoCompactionEnabled;
		await command(f, "/settings");
		await waitForFrame(f, (value) => value.includes("Auto-compact"));
		f.setup.mockInput.pressEnter();
		await waitFor(f, () => f.runtime.session.autoCompactionEnabled !== before);
		f.setup.mockInput.pressEscape();
		await waitFor(f, () => f.mode.overlays.size === 0);
	});

	test("an extension command falls through to the extension handler", async () => {
		let ran = "";
		fixture = await createFixture({
			height: 30,
			extension: (pi) =>
				pi.registerCommand("democmd", {
					description: "Demo",
					handler: async (args) => {
						ran = args;
					},
				}),
		});
		const f = fixture;
		const run = f.mode.run();
		await frame(f);
		await command(f, "/democmd some args");
		await waitFor(f, () => ran === "some args");
		f.mode.stop("resume-hint");
		await run;
	});
});

describe("command-owned keys", () => {
	test("thinking and model cycling report the faux model's limits", async () => {
		fixture = await createFixture({ height: 30 });
		const f = fixture;
		f.setup.mockInput.pressTab({ shift: true });
		await waitForFrame(f, (value) => value.includes("Current model does not support thinking"));
		f.mode.editor.setText("");
		f.setup.mockInput.pressKey("p", { ctrl: true });
		await waitForFrame(f, (value) => value.includes("Only one model available"));
	});

	test("app.model.select opens the model selector", async () => {
		fixture = await createFixture({ height: 30 });
		const f = fixture;
		f.setup.mockInput.pressKey("l", { ctrl: true });
		await waitFor(f, () => f.mode.overlays.size === 1);
		f.setup.mockInput.pressEscape();
		await waitFor(f, () => f.mode.overlays.size === 0);
	});
});
