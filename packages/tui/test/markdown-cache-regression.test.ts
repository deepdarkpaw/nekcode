import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Markdown, type MarkdownTheme } from "../src/components/markdown.ts";
import { Text } from "../src/components/text.ts";
import { replaceControlCharacters } from "../src/utils.ts";

const identity = (text: string) => text;
const theme: MarkdownTheme = {
	heading: identity,
	link: identity,
	linkUrl: identity,
	code: identity,
	codeBlock: identity,
	codeBlockBorder: identity,
	quote: identity,
	quoteBorder: identity,
	hr: identity,
	listBullet: identity,
	bold: identity,
	italic: identity,
	strikethrough: identity,
	underline: identity,
};

describe("bounded Markdown reuse", () => {
	it("does not re-highlight completed blocks on append or resize, but invalidates on theme change", () => {
		let calls = 0;
		const colors = {
			...theme,
			highlightCode: (code: string) => {
				calls++;
				return code.split("\n");
			},
		};
		const prefix = "```ts\nconst x = 1;\n```\n\n";
		const markdown = new Markdown(prefix, 0, 0, colors);
		markdown.render(80);
		for (let i = 1; i <= 10; i++) {
			markdown.setText(prefix + "x".repeat(i));
			markdown.render(80);
		}
		markdown.render(40);
		assert.equal(calls, 1);
		markdown.invalidate();
		markdown.render(40);
		assert.equal(calls, 2);
	});
	it("does not reuse stale reference links", () => {
		const first = "[link][ref]\n\n[ref]: https://example.com/first";
		const second = "[link][ref]\n\n[ref]: https://example.com/second";
		const markdown = new Markdown(first, 1, 0, theme);
		markdown.render(80);
		markdown.setText(second);
		assert.deepEqual(markdown.render(80), new Markdown(second, 1, 0, theme).render(80));
	});
	it("bounds deeply nested quotes at narrow widths", () => {
		const markdown = new Markdown(`${"> ".repeat(60)}text`, 0, 0, theme);
		assert.ok(markdown.render(8).length < 20);
	});
	it("keeps Text wrapping when the text is unchanged", () => {
		const text = new Text("same text", 0, 0);
		const rendered = text.render(80);
		text.setText("same text");
		assert.equal(text.render(80), rendered);
	});
	it("removes terminal controls from untrusted labels", () => {
		assert.equal(replaceControlCharacters("name\u001b\u0007\nrest\u009b"), "name rest ");
	});
});
