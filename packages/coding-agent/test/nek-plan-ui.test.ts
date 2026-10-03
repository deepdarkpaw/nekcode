import {
	type Component,
	setKeybindings,
	type TUI,
	TuiAltScreen,
	TuiMainScreen,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import type { ExtensionContext, ExtensionUIContext, ToolRenderContext } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createSwitchModeToolDefinition } from "../src/extensions/nek/tools/switch-mode.ts";
import type { Mode, PlanData } from "../src/extensions/nek/types.ts";
import { planApprovalOptions, showPlanApproval } from "../src/extensions/nek/ui/plan-approval.ts";
import { askQuestion } from "../src/extensions/nek/ui/question-dialog.ts";
import { createPlanRenderers } from "../src/extensions/nek/ui/renderers.ts";
import { CustomEditor } from "../src/modes/interactive/components/custom-editor.ts";
import { WorkingStatusIndicator } from "../src/modes/interactive/components/status-indicator.ts";
import { getEditorTheme, initTheme, type Theme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const snapshot: PlanData = {
	plan: {
		name: "Cache review",
		path: "G:/repo/.nek/plans/cache.plan.md",
		revision: 2,
		overview: "Add Redis caching.",
		todos: [{ id: "cache", content: "Add the cache" }],
	},
	markdown:
		"# Cache review\n\n## Scope\n\nAdd Redis caching.\n\n## Implementation\n\n- Update the cache module.\n- Add regression tests.",
};

function renderContext(args: unknown): ToolRenderContext<Record<string, never>, unknown> {
	return {
		args,
		toolCallId: "plan-1",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "G:/repo",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
	};
}

function captureUi(tui: TUI, keybindings: KeybindingsManager) {
	const opened = Promise.withResolvers<Component>();
	const custom: ExtensionUIContext["custom"] = async <T>(
		factory: (
			tui: TUI,
			theme: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => (Component & { dispose?(): void }) | Promise<Component & { dispose?(): void }>,
	) =>
		new Promise<T>((resolve, reject) => {
			let view: (Component & { dispose?(): void }) | undefined;
			const done = (result: T) => {
				view?.dispose?.();
				resolve(result);
			};
			Promise.resolve(factory(tui, theme, keybindings, done)).then((component) => {
				view = component;
				tui.addChild(component);
				tui.setFocus(component);
				opened.resolve(component);
				tui.requestRender();
			}, reject);
		});
	const ctx = {
		mode: "tui",
		hasUI: true,
		ui: { custom },
		getContextUsage: () => undefined,
	} as unknown as ExtensionContext;
	return { ctx, opened };
}

afterEach(() => {
	vi.useRealTimers();
	setKeybindings(new KeybindingsManager());
});

describe("Plan documents and mode presentation", () => {
	it.each(["dark", "light"])(
		"renders the complete saved snapshot in %s without expansion or disk access",
		(appearance) => {
			initTheme(appearance);
			const args = { plan: "# Wrong later body" };
			const context = renderContext(args);
			const component = createPlanRenderers.renderResult?.(
				{ content: [{ type: "text", text: "saved" }], details: snapshot },
				{ expanded: false, isPartial: false },
				theme,
				context,
			);
			if (!component) throw new Error("Missing plan renderer");
			for (const width of [20, 40, 80, 120]) {
				const lines = component.render(width);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
				const rendered = stripAnsi(lines.join("\n"));
				expect(rendered).toContain("Cache review");
				expect(rendered).toContain("Implementation");
				expect(rendered).not.toContain("Wrong later body");
			}
			args.plan = "# Another revision";
			const document = stripAnsi(component.render(80).join("\n"));
			expect(document).toContain("Add Redis caching.");
			expect(document).toContain("Implementation Tasks");
			expect(document).toContain("Add the cache");
			expect(document).not.toContain("Another revision");
			expect(createPlanRenderers.renderShell).toBe("self");
		},
	);

	it("reports a missing final snapshot instead of displaying mutable arguments", () => {
		initTheme("dark");
		const context = renderContext({ plan: "# Unreviewed body" });
		const render = () =>
			createPlanRenderers.renderResult?.(
				{ content: [{ type: "text", text: "saved" }], details: undefined as unknown as PlanData },
				{ expanded: false, isPartial: context.isPartial },
				theme,
				context,
			);
		expect(stripAnsi(render()?.render(80).join("\n") ?? "").trim()).toBe("Saved plan snapshot is missing.");
		context.isPartial = true;
		expect(stripAnsi(render()?.render(80).join("\n") ?? "").trim()).toBe("Saving plan...");
	});

	it.each(["dark", "light"])("keeps the PLAN badge and spinner within narrow %s editor borders", (appearance) => {
		initTheme(appearance);
		vi.useFakeTimers();
		const tui = { requestRender: vi.fn(), terminal: { rows: 12 } } as unknown as TUI;
		const editor = new CustomEditor(tui, getEditorTheme(), new KeybindingsManager(), { embedWorkingStatus: true });
		editor.setText("draft requirement");
		editor.addToHistory("previous requirement");
		editor.setPlanMode(true);
		const indicator = new WorkingStatusIndicator(tui, "Planning", { frames: ["*"], intervalMs: 100 });
		editor.setWorkingStatusIndicator(indicator);
		try {
			for (const width of [1, 4, 8, 12, 20, 40, 80, 120]) {
				const top = editor.render(width)[0];
				expect(visibleWidth(top)).toBe(width);
				if (width >= 4) expect(stripAnsi(top)).toContain("PLAN");
				if (width >= 12) expect(stripAnsi(top)).toContain("*");
			}
			expect(editor.render(80)[0]).toContain(theme.getFgAnsi("borderAccent"));
			expect(editor.getText()).toBe("draft requirement");
			editor.setPlanMode(false);
			expect(stripAnsi(editor.render(80)[0])).not.toContain("PLAN");
		} finally {
			indicator.dispose();
		}
	});

	it.each(["regular", "fullscreen"])(
		"renders plan review and scrolls a long body with fixed actions in %s",
		async (mode) => {
			initTheme("dark");
			const terminal = new VirtualTerminal(80, 24);
			const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
			const keybindings = new KeybindingsManager();
			const ui = captureUi(tui, keybindings);
			const long = {
				...snapshot,
				markdown: `# Long cache plan\n\n${Array.from({ length: 60 }, (_, i) => `Step ${i + 1}: verify caching behavior.`).join("\n\n")}`,
			};
			const review = showPlanApproval(ui.ctx, long);
			const view = await ui.opened.promise;
			tui.start();
			try {
				await terminal.waitForRender();
				const first = terminal.getViewport().join("\n");
				expect(first).toContain("PLAN");
				expect(first).toContain("Implement");
				expect(first).toContain("Exit Plan mode");
				const before = stripAnsi(view.render(80).join("\n"));
				view.handleInput?.("\x1b[6~");
				await terminal.waitForRender();
				const after = stripAnsi(view.render(80).join("\n"));
				expect(after).not.toBe(before);
				expect(after).toContain("Exit Plan mode");
				for (const width of [20, 40, 80, 120]) {
					expect(view.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
				}
				view.handleInput?.("\x1b[B");
				view.handleInput?.("\x1b[B");
				view.handleInput?.("\x1b[B");
				view.handleInput?.("\r");
				expect(await review).toBe("exit");
			} finally {
				tui.stop();
			}
		},
	);

	it("offers all four actions and supports dismissal without execution", async () => {
		initTheme("light");
		expect(planApprovalOptions(undefined).map((option) => option.choice)).toEqual([
			"implement",
			"fresh",
			"stay",
			"exit",
		]);
		const tui = new TuiMainScreen(new VirtualTerminal());
		const ui = captureUi(tui, new KeybindingsManager());
		const review = showPlanApproval(ui.ctx, snapshot);
		(await ui.opened.promise).handleInput?.("\x1b");
		expect(await review).toBeUndefined();
	});

	it("does not change mode after cancellation while confirmation is pending", async () => {
		const approval = Promise.withResolvers<boolean>();
		const controller = new AbortController();
		const setMode = vi.fn();
		const tool = createSwitchModeToolDefinition({ getMode: () => "agent", setMode });
		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: { confirm: async () => approval.promise },
		} as unknown as ExtensionContext;
		const operation = tool.execute("switch-1", { target_mode_id: "plan" }, controller.signal, undefined, ctx);
		controller.abort();
		approval.resolve(true);
		await expect(operation).rejects.toMatchObject({ name: "AbortError" });
		expect(setMode).not.toHaveBeenCalled();
	});

	it("rejects a confirmation result when another action already changed the mode", async () => {
		const approval = Promise.withResolvers<boolean>();
		let mode: Mode = "agent";
		const setMode = vi.fn();
		const tool = createSwitchModeToolDefinition({ getMode: () => mode, setMode });
		const ctx = {
			mode: "rpc",
			hasUI: true,
			ui: { confirm: async () => approval.promise },
		} as unknown as ExtensionContext;
		const operation = tool.execute("switch-1", { target_mode_id: "plan" }, undefined, undefined, ctx);
		mode = "plan";
		approval.resolve(true);
		await expect(operation).rejects.toThrow("The mode changed while this approval was pending");
		expect(setMode).not.toHaveBeenCalled();
	});

	it("closes a question immediately on abort and ignores a later answer", async () => {
		initTheme("dark");
		const controller = new AbortController();
		const tui = new TuiMainScreen(new VirtualTerminal());
		const ui = captureUi(tui, new KeybindingsManager());
		const result = askQuestion(
			ui.ctx,
			{
				id: "store",
				prompt: "Which store?",
				options: [
					{ id: "redis", label: "Redis" },
					{ id: "memory", label: "Memory" },
				],
			},
			undefined,
			controller.signal,
		);
		const view = await ui.opened.promise;
		controller.abort();
		expect(await result).toBeUndefined();
		view.handleInput?.("\r");
		expect(await result).toBeUndefined();
	});

	/** The crash from ~/.nek/agent/pi-tui-crash.log: a 239-column option line in a 179-column terminal. */
	it.each([
		{ name: "single choice", multiple: false },
		{ name: "multiple choice", multiple: true },
	])("wraps a long mixed-script option in 40 columns ($name)", async ({ multiple }) => {
		initTheme("dark");
		const tui = new TuiMainScreen(new VirtualTerminal());
		const ui = captureUi(tui, new KeybindingsManager());
		const result = askQuestion(
			ui.ctx,
			{
				id: "update_plan",
				prompt: "要不要新增 update_plan 工具？",
				allow_multiple: multiple,
				options: [
					{
						id: "add",
						label: "新增 update_plan 工具：参数是一组 old_string/new_string 编辑，只改计划正文里需要改的地方",
					},
					{ id: "skip", label: "保持现状" },
				],
			},
			"计划修订方式",
		);
		const view = await ui.opened.promise;
		for (const width of [40, 80]) {
			const lines = view.render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		expect(stripAnsi(view.render(40).join("\n"))).toContain("update_plan");
		view.handleInput?.("\x1b");
		expect(await result).toBeUndefined();
	});

	it("renders Other editing in place, wraps CJK text, and preserves it across Escape", async () => {
		initTheme("dark");
		const tui = new TuiMainScreen(new VirtualTerminal());
		const ui = captureUi(tui, new KeybindingsManager());
		const result = askQuestion(
			ui.ctx,
			{
				id: "free_text",
				prompt: "Describe the change.",
				options: [{ id: "skip", label: "Skip it" }],
			},
			"Question",
		);
		const view = await ui.opened.promise;
		view.handleInput?.("\x1b[B");
		view.handleInput?.("\r");
		for (const character of "你好世界 and a narrow wrapped answer") view.handleInput?.(character);

		for (const width of [8, 12, 20]) {
			const lines = view.render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		const editingLines = view.render(20).map((line) => stripAnsi(line));
		const textLineIndex = editingLines.findIndex((line) => line.includes("你好"));
		expect(textLineIndex).toBeGreaterThan(0);
		expect(editingLines[textLineIndex - 1]).toContain("Skip it");
		const continuation = editingLines.find((line, index) => index > textLineIndex && line.includes("wrapped"));
		expect(continuation?.startsWith("  ")).toBe(true);

		view.handleInput?.("\x1b");
		const afterEscape = stripAnsi(view.render(20).join("\n"));
		expect(afterEscape).toContain("Other... 你好世");
		view.handleInput?.("\r");
		view.handleInput?.("\r");
		expect(await result).toEqual({
			questionId: "free_text",
			optionIds: [],
			labels: [],
			other: "你好世界 and a narrow wrapped answer",
		});
	});

	it("uses the configured newline in the in-place Other editor and keeps multi-select", async () => {
		initTheme("dark");
		const keybindings = new KeybindingsManager({ "tui.input.newLine": "ctrl+n" });
		setKeybindings(keybindings);
		const tui = new TuiMainScreen(new VirtualTerminal());
		const ui = captureUi(tui, keybindings);
		const result = askQuestion(
			ui.ctx,
			{
				id: "multi",
				prompt: "Choose changes.",
				allow_multiple: true,
				options: [
					{ id: "one", label: "One" },
					{ id: "two", label: "Two" },
				],
			},
			undefined,
		);
		const view = await ui.opened.promise;
		view.handleInput?.("\r");
		view.handleInput?.("\x1b[B");
		view.handleInput?.("\x1b[B");
		view.handleInput?.("\r");
		view.handleInput?.("o");
		view.handleInput?.("n");
		view.handleInput?.("e");
		view.handleInput?.("\x0e");
		view.handleInput?.("t");
		view.handleInput?.("w");
		view.handleInput?.("o");
		view.handleInput?.("\r");
		view.handleInput?.("\x1b[B");
		view.handleInput?.("\r");

		expect(await result).toEqual({
			questionId: "multi",
			optionIds: ["one"],
			labels: ["One"],
			other: "one\ntwo",
		});
	});
});
