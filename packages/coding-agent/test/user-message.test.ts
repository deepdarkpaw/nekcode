import { Box, Container, Markdown, type MarkdownTheme } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { createMarkdownTransform } from "../src/modes/interactive/components/markdown-transform.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { getMarkdownTheme, initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function renderBeforeBoxRemoval(
	text: string,
	width: number,
	markdownTheme: MarkdownTheme,
	outputPad: number,
): string[] {
	const root = new Container();
	const contentBox = new Box(outputPad, 1, (content: string) => theme.bg("userMessageBg", content));
	contentBox.addChild(
		new Markdown(
			text,
			0,
			0,
			markdownTheme,
			{ color: (content: string) => theme.fg("userMessageText", content) },
			{
				preserveOrderedListMarkers: true,
				preserveBackslashEscapes: true,
				transform: createMarkdownTransform("user", false, []),
			},
		),
	);
	root.addChild(contentBox);
	const lines = root.render(width);
	lines[0] = `\x1b]133;A\x07${lines[0]}`;
	lines[lines.length - 1] = `\x1b]133;B\x07\x1b]133;C\x07${lines[lines.length - 1]}`;
	return lines;
}

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";
const BG_RESET = "\x1b[49m";

describe("UserMessageComponent", () => {
	test("keeps user message height stable while moving closing OSC markers off line end", () => {
		initTheme("dark");

		const component = new UserMessageComponent("hello");
		const lines = component.render(20);

		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[0].endsWith(BG_RESET)).toBe(true);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[1]).toContain("hello");
		expect(lines[2].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		expect(lines[2].endsWith(BG_RESET)).toBe(true);
	});

	test("keeps the rendered output unchanged when the Box is removed", () => {
		initTheme("dark");
		const cases = [
			{ text: "hello", width: 20, outputPad: 1 },
			{ text: "## title\n\nA longer **user message** with `code`.", width: 32, outputPad: 2 },
		];

		for (const { text, width, outputPad } of cases) {
			const markdownTheme = getMarkdownTheme();
			const actual = new UserMessageComponent(text, markdownTheme, outputPad).render(width);
			expect(actual).toEqual(renderBeforeBoxRemoval(text, width, markdownTheme, outputPad));
		}
	});

	test("chains Markdown transformers with user message context", () => {
		initTheme("dark");
		const calls: string[] = [];
		const component = new UserMessageComponent("The input is $x^2$.", undefined, 1, [
			(markdown, context) => {
				calls.push("formula");
				expect(context).toEqual({ messageType: "user", isStreaming: false, availableWidth: 78 });
				return markdown.replace("$x^2$", "x²");
			},
			(markdown) => {
				calls.push("suffix");
				return `${markdown} Done.`;
			},
		]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("The input is x². Done.");
		expect(calls).toEqual(["formula", "suffix"]);
	});

	test("reapplies Markdown transformers when invalidated", () => {
		initTheme("dark");
		let suffix = "before";
		const component = new UserMessageComponent("Message", undefined, 1, [(markdown) => `${markdown} ${suffix}`]);

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message before");

		suffix = "after";
		component.invalidate();

		expect(stripAnsi(component.render(80).join("\n"))).toContain("Message after");
	});
});
