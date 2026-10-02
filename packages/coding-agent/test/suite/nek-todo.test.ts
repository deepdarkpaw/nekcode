import { fauxAssistantMessage, fauxToolCall, getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionUIContext } from "../../src/core/extensions/index.ts";
import type { SessionEntry } from "../../src/core/session-manager.ts";
import { DEFAULT_NEK_CONFIG } from "../../src/extensions/nek/config.ts";
import { createNekExtension } from "../../src/extensions/nek/index.ts";
import type { Todo } from "../../src/extensions/nek/types.ts";
import { initTheme, type Theme, theme } from "../../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../../src/utils/ansi.ts";
import { createHarness, type Harness } from "./harness.ts";

interface UiRecord {
	/** Plain text of the `nek.todos` widget; undefined when the widget was removed. */
	widget: string | undefined;
	status: string | undefined;
}

function createRecordingUiContext(record: UiRecord): ExtensionUIContext {
	return {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: (key, text) => {
			if (key === "nek.todos") record.status = text;
		},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: (key: string, content: unknown) => {
			if (key !== "nek.todos") return;
			if (content === undefined) {
				record.widget = undefined;
				return;
			}
			if (typeof content !== "function") throw new Error("the todo widget must be a component factory");
			const component = (content as (tui: unknown, th: Theme) => { render(width: number): string[] })(
				undefined,
				theme,
			);
			// Text pads every line with one space on each side; compare against the content without that padding.
			record.widget = stripAnsi(component.render(80).join("\n"))
				.split("\n")
				.map((line) => (line.trim() === "" ? "" : line.replace(/^ /, "").trimEnd()))
				.join("\n");
		},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async <T>() => undefined as T,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		get theme() {
			return theme;
		},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: (_theme: string | Theme) => ({ success: false, error: "Theme switching not available in tests" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

function todoWriteCall(merge: boolean, todos: Todo[]) {
	return fauxAssistantMessage(fauxToolCall("todo_write", { merge, todos: todos.map((todo) => ({ ...todo })) }), {
		stopReason: "toolUse",
	});
}

function todoWriteDetails(harness: Harness): unknown[] {
	return harness.session.messages.flatMap((message) =>
		message.role === "toolResult" && message.toolName === "todo_write" ? [message.details] : [],
	);
}

function reminderEntries(harness: Harness): SessionEntry[] {
	return harness.sessionManager
		.getEntries()
		.filter((entry) => entry.type === "custom_message" && entry.customType === "nek.reminder");
}

describe("nek todo_write", () => {
	const harnesses: Harness[] = [];

	beforeAll(() => {
		initTheme("dark", false);
	});

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function createNekHarness(record: UiRecord): Promise<Harness> {
		const harness = await createHarness({
			extensionFactories: [createNekExtension({ role: "root", config: DEFAULT_NEK_CONFIG })],
		});
		harnesses.push(harness);
		await harness.session.bindExtensions({ uiContext: createRecordingUiContext(record), mode: "tui" });
		return harness;
	}

	it("stores the list in details and in memory, and restores earlier todos after tree navigation", async () => {
		const record: UiRecord = { widget: undefined, status: undefined };
		const harness = await createNekHarness(record);
		const first: Todo[] = [
			{ id: "a", content: "First", status: "completed" },
			{ id: "b", content: "Second", status: "cancelled" },
		];
		const second: Todo[] = [
			{ id: "c", content: "Third", status: "completed" },
			{ id: "d", content: "Fourth", status: "completed" },
		];

		harness.setResponses([todoWriteCall(false, first), fauxAssistantMessage("first done")]);
		await harness.session.prompt("first");
		const firstLeaf = harness.sessionManager.getLeafId();
		expect(todoWriteDetails(harness)).toEqual([{ todos: first }]);
		expect(record.status).toBeUndefined();
		// First has one completed and one cancelled item: nothing open, so no widget.
		expect(record.widget).toBeUndefined();

		harness.setResponses([todoWriteCall(false, second), fauxAssistantMessage("second done")]);
		await harness.session.prompt("second");
		expect(record.widget).toBeUndefined();

		if (!firstLeaf) throw new Error("expected a leaf after the first prompt");
		await harness.session.navigateTree(firstLeaf);
		expect(record.widget).toBeUndefined();

		const added: Todo[] = [
			{ id: "b", content: "Second", status: "completed" },
			{ id: "e", content: "Fifth", status: "completed" },
		];
		harness.setResponses([todoWriteCall(true, added), fauxAssistantMessage("merged")]);
		await harness.session.prompt("third");
		expect(todoWriteDetails(harness).at(-1)).toEqual({ todos: [first[0], added[0], added[1]] });
		expect(record.widget).toBeUndefined();
	});

	it("puts the progress in the dim widget title instead of the status bar", async () => {
		const record: UiRecord = { widget: undefined, status: undefined };
		const harness = await createNekHarness(record);
		const todos: Todo[] = [
			{ id: "a", content: "First", status: "completed" },
			{ id: "b", content: "Second", status: "in_progress" },
			{ id: "c", content: "Third", status: "pending" },
		];
		harness.setResponses([todoWriteCall(false, todos), fauxAssistantMessage("stopping")]);

		await harness.session.prompt("work");

		const lines = record.widget?.split("\n") ?? [];
		expect(lines[0]).toBe("Todos 1/3");
		expect(lines.slice(1)).toEqual(["✓ First", "▶ Second", "○ Third"]);
		expect(record.status).toBeUndefined();
	});

	it("shows open todos above the editor, collapsed to widgetMaxLines", async () => {
		const record: UiRecord = { widget: undefined, status: undefined };
		const harness = await createNekHarness(record);
		const todos: Todo[] = Array.from({ length: 10 }, (_, index) => ({
			id: `t${index}`,
			content: `Task ${index}`,
			status: index === 0 ? "in_progress" : "pending",
		}));
		harness.setResponses([
			todoWriteCall(false, todos),
			fauxAssistantMessage("stopping"),
			fauxAssistantMessage("stopping again"),
		]);

		await harness.session.prompt("plan");

		const lines = record.widget?.split("\n") ?? [];
		expect(lines[0]).toBe("Todos 0/10");
		expect(lines[1]).toBe("▶ Task 0");
		expect(lines).toHaveLength(DEFAULT_NEK_CONFIG.todo.widgetMaxLines + 1);
		expect(lines.at(-1)).toContain("... +3 more");
		expect(record.status).toBeUndefined();
	});

	it("continues a run with open todos exactly once, and again in the next run", async () => {
		const record: UiRecord = { widget: undefined, status: undefined };
		const harness = await createNekHarness(record);
		const requests: string[] = [];
		harness.setResponses([
			todoWriteCall(false, [
				{ id: "a", content: "First", status: "completed" },
				{ id: "b", content: "Second", status: "in_progress" },
			]),
			fauxAssistantMessage("ending early"),
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("still ending");
			},
		]);

		await harness.session.prompt("work");

		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(0);
		expect(requests[0]).toContain("You still have open todos: b [in_progress] Second.");
		expect(reminderEntries(harness)).toEqual([
			expect.objectContaining({ type: "custom_message", customType: "nek.reminder", display: false }),
		]);
		expect(harness.eventsOfType("agent_settled")).toHaveLength(1);

		harness.setResponses([fauxAssistantMessage("next run ends"), fauxAssistantMessage("next run continued")]);
		await harness.session.prompt("next");

		expect(harness.faux.state.callCount).toBe(5);
		expect(reminderEntries(harness)).toHaveLength(2);
	});

	it("adds the Cursor task_management section to the system prompt", async () => {
		const record: UiRecord = { widget: undefined, status: undefined };
		const harness = await createNekHarness(record);
		let systemPrompt = "";
		harness.setResponses([
			(context) => {
				systemPrompt = getCurrentSystemPrompt(context.messages);
				return fauxAssistantMessage("done");
			},
		]);

		await harness.session.prompt("hello");

		expect(systemPrompt).toContain(
			"<task_management>\nYou have access to the todo_write tool to help you manage and plan tasks.",
		);
		expect(systemPrompt).toContain(
			"IMPORTANT: Make sure you don't end your turn before you've completed all todos.\n</task_management>",
		);
	});
});
