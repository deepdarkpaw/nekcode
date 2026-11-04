import type { TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeRenderers } from "../src/core/tools/renderers/write.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { CodeHighlighter, highlightCode, initTheme } from "../src/modes/interactive/theme/theme.ts";
import * as syntaxHighlight from "../src/utils/syntax-highlight.ts";

const tui = { requestRender: () => {} } as unknown as TUI;
beforeEach(() => initTheme("dark", false));
afterEach(() => vi.restoreAllMocks());
describe("owner-scoped syntax cache", () => {
	it("reuses unchanged source and invalidates on theme/grammar changes", async () => {
		const code = 'const page = html`<div class="x">ok</div>`;';
		const highlighter = new CodeHighlighter();
		const first = highlighter.highlight(code, "javascript");
		expect(highlighter.highlight(code, "javascript")).toBe(first);
		expect(highlighter.highlight("const a = 1;", "javascript")).not.toBe(first);
		initTheme("light", false);
		expect(highlighter.highlight(code, "javascript")).toEqual(highlightCode(code, "javascript"));
		const light = highlighter.highlight(code, "javascript");
		const count = syntaxHighlight.getHighlightLanguageCount();
		vi.spyOn(syntaxHighlight, "getHighlightLanguageCount").mockReturnValue(count + 1);
		expect(highlighter.highlight(code, "javascript")).not.toBe(light);
	});
	it("highlights a stable streaming prefix and a complete file only once", () => {
		const content = Array.from({ length: 60 }, (_, i) => `const v${i} = ${i};`).join("\n");
		const row = new ToolExecutionComponent("write", "w", { path: "a.ts", content }, {}, writeRenderers, tui, "/");
		row.updateArgs({ path: "a.ts", content: `${content} //` });
		row.render(80);
		const highlight = vi.spyOn(syntaxHighlight, "highlight");
		row.updateArgs({ path: "a.ts", content: `${content} // more` });
		row.render(80);
		expect(highlight).toHaveBeenCalledTimes(1);
		row.setArgsComplete();
		row.setExpanded(true);
		row.setExpanded(false);
		row.render(80);
		expect(highlight).toHaveBeenCalledTimes(2);
	});
});
