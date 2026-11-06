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
import {
	PLAN_APPROVAL_TRANSCRIPT_HINT,
	planApprovalOptions,
	showPlanApproval,
} from "../src/extensions/nek/ui/plan-approval.ts";
import { PLAN_PREVIEW_TYPE, renderPlanPreview } from "../src/extensions/nek/ui/plan-view.ts";
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
	it.each(["dark", "light"])("renders only the heading and overview of the saved snapshot in %s", (appearance) => {
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
		}
		const rendered = stripAnsi(component.render(80).join("\n"));
		expect(rendered).toContain("PLAN");
		expect(rendered).toContain("Cache review");
		expect(rendered).toContain("Revision 2");
		expect(rendered).toContain("Add Redis caching.");
		expect(rendered).not.toContain("Implementation");
		expect(rendered).not.toContain("Wrong later body");
		expect(createPlanRenderers.renderShell).toBe("self");
	});

	it("renders the complete snapshot as a transcript plan preview", () => {
		initTheme("dark");
		const component = renderPlanPreview(
			{
				role: "custom",
				customType: PLAN_PREVIEW_TYPE,
				content: "ignored",
				display: true,
				details: snapshot,
				timestamp: 0,
			},
			{ expanded: false, outputPad: 1 },
			theme,
		);
		if (!component) throw new Error("Missing plan preview renderer");
		for (const width of [20, 40, 80, 120]) {
			expect(component.render(width).every((line) => visibleWidth(line) <= width)).toBe(true);
		}
		const document = stripAnsi(component.render(80).join("\n"));
		expect(document).toContain("Cache review");
		expect(document).toContain("Revision 2");
		expect(document).toContain("Add Redis caching.");
		expect(document).toContain("Implementation Tasks");
		expect(document).toContain("Add the cache");
	});

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

	it.each(["regular", "fullscreen"])("renders a compact review panel without the plan body in %s", async (mode) => {
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
			const panel = stripAnsi(view.render(80).join("\n"));
			expect(panel).toContain("Cache review");
			expect(panel).toContain("Revision 2");
			expect(panel).toContain("Switch to Agent and start coding");
			expect(panel).toContain(PLAN_APPROVAL_TRANSCRIPT_HINT);
			expect(panel).not.toContain("Step 1");
			expect(view.render(80).length).toBeLessThan(12);
			view.handleInput?.("\x1b[6~");
			expect(stripAnsi(view.render(80).join("\n"))).toBe(panel);
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
	});

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

	it("uses structured RPC payloads for questions, plan review, and mode approval", async () => {
		const questionStructured = vi.fn(async () => ({
			answers: [{ questionId: "store", selected: ["redis"], other: "" }],
		}));
		const questionCtx = {
			mode: "rpc",
			hasUI: true,
			ui: { structured: questionStructured },
		} as unknown as ExtensionContext;
		await expect(
			askQuestion(
				questionCtx,
				{
					id: "store",
					prompt: "Which store?",
					options: [
						{ id: "redis", label: "Redis" },
						{ id: "memory", label: "Memory" },
					],
				},
				"Cache",
			),
		).resolves.toMatchObject({ questionId: "store", optionIds: ["redis"] });
		expect(questionStructured).toHaveBeenCalledWith(
			"nek.ask_question",
			{ title: "Cache", questions: [expect.objectContaining({ id: "store" })] },
			expect.anything(),
		);

		const planStructured = vi.fn(async () => ({ action: "implement_fresh" as const }));
		const planCtx = {
			mode: "rpc",
			hasUI: true,
			ui: { structured: planStructured },
			getContextUsage: () => undefined,
		} as unknown as ExtensionContext;
		await expect(showPlanApproval(planCtx, snapshot)).resolves.toBe("fresh");
		expect(planStructured).toHaveBeenCalledWith(
			"nek.plan_review",
			expect.objectContaining({ revision: 2 }),
			expect.anything(),
		);

		const modeStructured = vi.fn(async () => ({ approved: true }));
		const setMode = vi.fn();
		const modeCtx = { mode: "rpc", hasUI: true, ui: { structured: modeStructured } } as unknown as ExtensionContext;
		const tool = createSwitchModeToolDefinition({ getMode: () => "agent", setMode });
		await tool.execute(
			"switch-structured",
			{ target_mode_id: "plan", explanation: "Need a plan" },
			undefined,
			undefined,
			modeCtx,
		);
		expect(modeStructured).toHaveBeenCalledWith(
			"nek.switch_mode",
			{ from: "agent", to: "plan", explanation: "Need a plan" },
			expect.anything(),
		);
		expect(setMode).toHaveBeenCalledWith("plan", modeCtx);
	});

	/** A pending mode approval through the TUI confirm dialog or the RPC structured request. */
	function pendingModeApproval(mode: "tui" | "rpc") {
		const approval = Promise.withResolvers<boolean | undefined>();
		const ui =
			mode === "tui"
				? { confirm: async () => (await approval.promise) === true }
				: {
						structured: async () => {
							const approved = await approval.promise;
							return approved === undefined ? undefined : { approved };
						},
					};
		const ctx = { mode, hasUI: true, ui } as unknown as ExtensionContext;
		return { approval, ctx };
	}

	it.each(["tui", "rpc"] as const)(
		"does not change mode after cancellation while confirmation is pending (%s)",
		async (runMode) => {
			const { approval, ctx } = pendingModeApproval(runMode);
			const controller = new AbortController();
			const setMode = vi.fn();
			const tool = createSwitchModeToolDefinition({ getMode: () => "agent", setMode });
			const operation = tool.execute("switch-1", { target_mode_id: "plan" }, controller.signal, undefined, ctx);
			controller.abort();
			approval.resolve(true);
			await expect(operation).rejects.toMatchObject({ name: "AbortError" });
			expect(setMode).not.toHaveBeenCalled();
		},
	);

	it("reports an aborted RPC approval as an abort, not as a decline", async () => {
		const { approval, ctx } = pendingModeApproval("rpc");
		const controller = new AbortController();
		const tool = createSwitchModeToolDefinition({ getMode: () => "agent", setMode: vi.fn() });
		const operation = tool.execute("switch-1", { target_mode_id: "plan" }, controller.signal, undefined, ctx);
		controller.abort();
		approval.resolve(undefined);
		await expect(operation).rejects.toMatchObject({ name: "AbortError" });
	});

	it("does not label a missing RPC approval as a user decline", async () => {
		const { approval, ctx } = pendingModeApproval("rpc");
		const setMode = vi.fn();
		const tool = createSwitchModeToolDefinition({ getMode: () => "agent", setMode });
		const operation = tool.execute("switch-cancel", { target_mode_id: "plan" }, undefined, undefined, ctx);
		approval.resolve(undefined);
		const result = await operation;
		expect(JSON.stringify(result.content)).toContain("cancelled before approval");
		expect(JSON.stringify(result.content)).not.toContain("User declined");
		expect(setMode).not.toHaveBeenCalled();
	});

	it("labels only an explicit negative RPC approval as declined", async () => {
		const { approval, ctx } = pendingModeApproval("rpc");
		const setMode = vi.fn();
		const tool = createSwitchModeToolDefinition({ getMode: () => "agent", setMode });
		const operation = tool.execute("switch-reject", { target_mode_id: "plan" }, undefined, undefined, ctx);
		approval.resolve(false);
		expect(JSON.stringify((await operation).content)).toContain("User declined");
		expect(setMode).not.toHaveBeenCalled();
	});

	it("rejects RPC mode without structured UI instead of falling back to confirm", async () => {
		const ctx = { mode: "rpc", hasUI: true, ui: { confirm: async () => true } } as unknown as ExtensionContext;
		const setMode = vi.fn();
		const tool = createSwitchModeToolDefinition({ getMode: () => "agent", setMode });
		await expect(tool.execute("switch-1", { target_mode_id: "plan" }, undefined, undefined, ctx)).rejects.toThrow(
			"Structured UI is unavailable in RPC mode.",
		);
		expect(setMode).not.toHaveBeenCalled();
	});

	it.each(["tui", "rpc"] as const)(
		"rejects a confirmation result when another action already changed the mode (%s)",
		async (runMode) => {
			const { approval, ctx } = pendingModeApproval(runMode);
			let mode: Mode = "agent";
			const setMode = vi.fn();
			const tool = createSwitchModeToolDefinition({ getMode: () => mode, setMode });
			const operation = tool.execute("switch-1", { target_mode_id: "plan" }, undefined, undefined, ctx);
			mode = "plan";
			approval.resolve(true);
			await expect(operation).rejects.toThrow("The mode changed while this approval was pending");
			expect(setMode).not.toHaveBeenCalled();
		},
	);

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
