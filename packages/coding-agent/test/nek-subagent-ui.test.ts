import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolRenderContext, ToolRenderResultOptions } from "../src/core/extensions/types.ts";
import type { SubagentRegistry } from "../src/extensions/nek/services/subagent-registry.ts";
import type { AwaitToolData, PlanData, SubagentRecord, SubagentToolData } from "../src/extensions/nek/types.ts";
import {
	askQuestionRenderers,
	switchModeRenderers,
	todoWriteRenderers,
	updatePlanRenderers,
} from "../src/extensions/nek/ui/renderers.ts";
import {
	awaitRenderers,
	renderSubagentNotice,
	subagentLine,
	subagentRenderers,
	subagentWidgetLines,
} from "../src/extensions/nek/ui/subagent-view.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const NOW = 1_700_000_000_000;

// Elapsed time is derived from Date.now(); pin it so the assertions are stable and no timer keeps the process alive.
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
});

afterEach(() => {
	vi.useRealTimers();
});

function record(overrides: Partial<SubagentRecord> = {}): SubagentRecord {
	return {
		id: "sub-1",
		description: "Map the caching layer",
		type: "generalPurpose",
		model: "anthropic/claude-sonnet-4",
		background: true,
		status: "running",
		startedAt: NOW - 12_000,
		observed: false,
		usage: { input: 0, output: 0 },
		...overrides,
	};
}

function renderContext(args: unknown, state: unknown = {}): ToolRenderContext<unknown, unknown> {
	return {
		args,
		toolCallId: "call-1",
		invalidate: () => {},
		lastComponent: undefined,
		state,
		cwd: "G:/repo",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
	};
}

const collapsed: ToolRenderResultOptions = { expanded: false, isPartial: false };
const expanded: ToolRenderResultOptions = { expanded: true, isPartial: false };

/** Assert every line fits the given widths; returns the plain text rendered at `textWidth` for content checks. */
function assertFits(component: Component, widths: readonly number[] = [40, 80, 120], textWidth = 40): string {
	let text = "";
	for (const width of widths) {
		const lines = component.render(width);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		if (width === textWidth) text = stripAnsi(lines.join("\n"));
	}
	return text;
}

function renderCard(overrides: Partial<SubagentRecord>, options = collapsed, isPartial = false): Component {
	const details: SubagentToolData = { subagent: record(overrides) };
	const context = renderContext({}, {});
	context.isPartial = isPartial;
	const component = subagentRenderers.renderResult?.(
		{ content: [{ type: "text", text: "" }], details },
		options,
		theme,
		context,
	);
	if (!component) throw new Error("Missing subagent result renderer");
	return component;
}

describe("subagent card rendering", () => {
	it.each(["dark", "light"])(
		"keeps running, completed, errored, and expanded cards within 40 columns (%s)",
		(appearance) => {
			initTheme(appearance);
			const running = assertFits(
				renderCard(
					{
						status: "running",
						activity: "read src/foo.ts",
						lastActivityAt: NOW - 5_000,
						usage: { input: 12_400, output: 3_400 },
					},
					collapsed,
					true,
				),
				[80],
				80,
			);
			expect(running).toContain("Map the caching layer");
			expect(running).toContain("read src/foo.ts · 5s ago");
			expect(running).toContain("claude-sonnet-4 · generalPurpose · ↑12k ↓3.4k · 12s");
			// The provider prefix must not leak into the model label.
			expect(running).not.toContain("anthropic/");

			const completed = assertFits(
				renderCard({
					status: "completed",
					endedAt: NOW - 3_000,
					finalText: "The cache module is updated and covered by regression tests.",
					usage: { input: 2_000, output: 1_200 },
				}),
				[80],
				80,
			);
			expect(completed).toContain("✓");
			expect(completed).toContain("generalPurpose · ↑2.0k ↓1.2k · 9s");
			expect(completed).not.toContain("ago");
			expect(completed).toContain("The cache module is updated");

			const errored = assertFits(renderCard({ status: "errored", error: "The child session failed to start." }));
			expect(errored).toContain("✗");
			expect(errored).toContain("failed to start");

			const aborted = assertFits(renderCard({ status: "aborted", endedAt: NOW }));
			expect(aborted).toContain("✗");

			const expandedCard = assertFits(
				renderCard(
					{
						status: "completed",
						endedAt: NOW - 3_000,
						finalText: "## Result\n\n- Updated the cache module.\n- Added regression tests.",
						usage: { input: 1_000, output: 200 },
					},
					expanded,
				),
				[40, 80],
			);
			expect(expandedCard).toContain("Updated the cache module");
		},
	);

	it("collapses dynamic fields without flattening composed card rows or Markdown", () => {
		initTheme("dark");
		const running = renderCard({
			description: "running description\nwith a second line",
			activity: "tool output\nwith a newline\tand tab",
		});
		const completed = renderCard(
			{
				status: "completed",
				description: "completed description\nwith a second line",
				endedAt: NOW - 3_000,
				finalText: "summary line\nwith more result text\n\n```text\n  indented code\n    deeper\n```",
				usage: { input: 1_000, output: 200 },
			},
			expanded,
		);
		const errored = renderCard({
			status: "errored",
			description: "errored description\nwith a second line",
			error: "error line\nwith details\tand tabs",
		});
		const cards = [running, completed, errored];

		for (const card of cards) {
			const lines = card.render(80);
			// pi#subagent-card-newlines
			expect(lines.every((line) => !line.includes("\n"))).toBe(true);
			expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
		}

		const runningLines = running.render(120).map(stripAnsi);
		expect(runningLines[0]?.startsWith(" ")).toBe(true);
		expect(runningLines[0]?.startsWith("  ")).toBe(false);
		expect(runningLines[0]).toContain("running description with a second line  claude-sonnet-4");
		expect(runningLines[1]?.startsWith("   ")).toBe(true);
		expect(runningLines[1]?.startsWith("    ")).toBe(false);

		const completedText = completed.render(120).map(stripAnsi).join("\n");
		expect(completedText).toContain("  indented code");
		expect(completedText).toContain("    deeper");
	});

	it("shows a short model-less card and omits an empty activity line", () => {
		initTheme("dark");
		const text = assertFits(renderCard({ model: undefined, activity: undefined }, collapsed, true));
		expect(text).toContain("unknown model");
		expect(text.split("\n").filter((line) => line.includes("read "))).toHaveLength(0);
	});

	it("renders records from older sessions without usage and omits the token part", () => {
		initTheme("dark");
		const legacy = { ...record({ status: "completed", endedAt: NOW - 2_000 }), tokens: 900 };
		delete legacy.usage;
		const line = stripAnsi(subagentLine(legacy, theme, NOW));
		expect(line).toContain("claude-sonnet-4 · generalPurpose · 10s");
		expect(line).not.toContain("↑");
		const notice = renderSubagentNotice(
			{
				role: "custom",
				customType: "nek.subagent_notice",
				content: "done",
				display: true,
				details: { subagent: legacy },
				timestamp: 0,
			},
			{ expanded: false, outputPad: 1 },
			theme,
		);
		expect(stripAnsi(notice?.render(80).join("\n") ?? "")).toContain("generalPurpose · 10s");
	});

	it("shows the card format with the activity line in the background widget", () => {
		initTheme("dark");
		const lines = subagentWidgetLines(
			[
				record({ activity: "bash npm test", lastActivityAt: NOW - 65_000, usage: { input: 500, output: 20 } }),
				record({ id: "sub-2", background: false }),
				record({ id: "sub-3", status: "completed", endedAt: NOW }),
			],
			theme,
			NOW,
		)?.map(stripAnsi);
		expect(lines).toHaveLength(2);
		expect(lines?.[0]).toContain("Map the caching layer  claude-sonnet-4 · generalPurpose · ↑500 ↓20 · 12s");
		expect(lines?.[1]).toBe("bash npm test · 1m 5s ago");
		expect(subagentWidgetLines([record({ status: "completed" })], theme, NOW)).toBeUndefined();
	});

	it("computes elapsed time and the spinner frame from the record", () => {
		initTheme("dark");
		expect(subagentLine(record({ startedAt: NOW - 12_000 }), theme, NOW)).toContain("12s");
		expect(subagentLine(record({ startedAt: NOW - 125_000 }), theme, NOW)).toContain("2m 5s");
		expect(subagentLine(record({ startedAt: NOW - 3_725_000 }), theme, NOW)).toContain("1h 2m");
		const frames = new Set(
			[0, 80, 160, 240].map((offset) =>
				stripAnsi(subagentLine(record({ startedAt: NOW - offset }), theme, NOW)).slice(0, 1),
			),
		);
		expect(frames.size).toBeGreaterThan(1);
	});
});

describe("await rows", () => {
	const registry = {
		get: (id: string) => (id === "sub-1" ? record() : undefined),
	} as unknown as SubagentRegistry;

	it("resolves a known id, falls back to the raw id, and shows `any subagent` without one", () => {
		initTheme("dark");
		const renderers = awaitRenderers(() => registry);
		const context = renderContext({});
		const call = (args: unknown) => {
			const component = renderers.renderCall?.(args as never, theme, context);
			if (!component) throw new Error("Missing await call renderer");
			return assertFits(component);
		};
		expect(call({ subagent_id: "sub-1" })).toContain("Waiting Map the caching layer");
		expect(call({ subagent_id: "missing-id" })).toContain("missing-id");
		expect(call({})).toContain("any subagent");
	});

	it.each(["dark", "light"])("renders one card line per returned subagent within 40 columns (%s)", (appearance) => {
		initTheme(appearance);
		const renderers = awaitRenderers(() => registry);
		const details: AwaitToolData = {
			subagents: [
				record({ status: "completed", endedAt: NOW - 3_000, usage: { input: 900, output: 40 } }),
				record({ id: "sub-2", description: "Map the caching layer", status: "errored", error: "boom" }),
			],
			timedOut: false,
		};
		const component = renderers.renderResult?.(
			{ content: [{ type: "text", text: "" }], details },
			collapsed,
			theme,
			renderContext({}),
		);
		if (!component) throw new Error("Missing await result renderer");
		// Each returned subagent is one line in the same format as the card's first line.
		assertFits(component, [40, 80, 120]);
		const text = assertFits(component, [80], 80);
		expect(text).toContain("✓");
		expect(text).toContain("✗");
		expect(text).toContain("↑900 ↓40");
		expect(text.split("\n").filter((line) => line.includes("claude-sonnet-4"))).toHaveLength(2);
	});
});

const plan: PlanData & { diff: string } = {
	plan: {
		name: "Cache review",
		path: "G:/repo/.nek/plans/cache.plan.md",
		revision: 3,
		overview: "Add Redis caching.",
		todos: [{ id: "cache", content: "Add the cache" }],
	},
	markdown: "# Cache review\n\n## Scope\n\nAdd Redis caching.",
	diff: [
		" 1 Add Redis caching.",
		"-2 Old scope line.",
		"+2 New scope line.",
		...Array.from({ length: 20 }, (_, index) => `+${index + 3} Extra changed line ${index + 1}.`),
	].join("\n"),
};

describe("update_plan rendering", () => {
	it("shows the display name, revision, explanation, and a colored diff", () => {
		initTheme("dark");
		const context = renderContext({ explanation: "Rename the cache scope" });
		const component = updatePlanRenderers.renderResult?.(
			{ content: [{ type: "text", text: "saved" }], details: plan },
			collapsed,
			theme,
			context,
		);
		if (!component) throw new Error("Missing update_plan renderer");
		const lines = component.render(80);
		expect(lines.every((line) => visibleWidth(line) <= 80)).toBe(true);
		const text = stripAnsi(lines.join("\n"));
		expect(text).toContain("Plan update Cache review");
		expect(text).not.toContain("update_plan");
		expect(text).toContain("Revision 3");
		expect(text).toContain("Rename the cache scope");
		// The colored diff uses the diff theme tokens, not plain tool output.
		expect(lines.some((line) => line.includes(theme.getFgAnsi("toolDiffAdded")))).toBe(true);
		expect(lines.some((line) => line.includes(theme.getFgAnsi("toolDiffRemoved")))).toBe(true);
	});

	it.each(["dark", "light"])("collapses a long diff and expands it with the full document (%s)", (appearance) => {
		initTheme(appearance);
		const render = (options: ToolRenderResultOptions) => {
			const component = updatePlanRenderers.renderResult?.(
				{ content: [{ type: "text", text: "saved" }], details: plan },
				options,
				theme,
				renderContext({ explanation: "Trim the plan" }),
			);
			if (!component) throw new Error("Missing update_plan renderer");
			for (const width of [40, 80]) {
				const lines = component.render(width);
				expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			}
			return stripAnsi(component.render(80).join("\n"));
		};
		const preview = render(collapsed);
		expect(preview).toContain("Revision 3");
		expect(preview).toContain("more lines");
		const full = render(expanded);
		expect(full).toContain("Revision 3");
		expect(preview).not.toContain("Implementation Tasks");
		expect(full).toContain("Implementation Tasks");
		expect(full).toContain("Add the cache");
	});

	it("reports a missing snapshot without rendering the raw diff", () => {
		initTheme("dark");
		const component = updatePlanRenderers.renderResult?.(
			{ content: [{ type: "text", text: "saved" }], details: undefined as unknown as PlanData & { diff: string } },
			collapsed,
			theme,
			renderContext({}),
		);
		expect(stripAnsi(component?.render(80).join("\n") ?? "").trim()).toBe("Saved plan update is missing.");
	});
});

describe("nek tool display names", () => {
	function callText(component: Component | undefined): string {
		if (!component) throw new Error("Missing call renderer");
		return assertFits(component, [40, 80, 120], 120).trim();
	}

	it("uses display names instead of function names", () => {
		initTheme("dark");
		const todos = callText(
			todoWriteRenderers.renderCall?.({ merge: true, todos: [{}, {}, {}] } as never, theme, renderContext({})),
		);
		expect(todos).toBe("Todos 3 items · merge");
		expect(
			callText(switchModeRenderers.renderCall?.({ target_mode_id: "plan" } as never, theme, renderContext({}))),
		).toBe("Mode Plan");
		const single = callText(
			askQuestionRenderers.renderCall?.(
				{ questions: [{ id: "q", prompt: "Which\ncache store?", options: [] }] } as never,
				theme,
				renderContext({}),
			),
		);
		expect(single).toBe("Question Which cache store?");
		const several = callText(
			askQuestionRenderers.renderCall?.({ questions: [{}, {}] } as never, theme, renderContext({})),
		);
		expect(several).toBe("Question 2 questions");
		expect(callText(subagentRenderers.renderCall?.({ description: "Map" } as never, theme, renderContext({})))).toBe(
			"Subagent Map",
		);
		const partial = renderContext({});
		partial.isPartial = true;
		expect(callText(updatePlanRenderers.renderCall?.({ explanation: "Trim" } as never, theme, partial))).toBe(
			"Plan update Trim",
		);
	});
});
