import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container, type Terminal, Text, type TUI, TuiMainScreen } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";
import { generateDiffString } from "../src/core/tools/edit-diff.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

class FakeTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = true;
	writes: string[] = [];
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	get fullClearCount(): number {
		return this.writes.filter((write) => write.includes("\x1b[2J\x1b[H\x1b[3J")).length;
	}
}

async function waitForRender(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForText(getRender: () => string, expected: string): Promise<string> {
	const deadline = Date.now() + 2000;
	let last = "";
	while (Date.now() < deadline) {
		await waitForRender();
		last = getRender();
		if (last.includes(expected)) return last;
	}
	throw new Error(`Timed out waiting for ${expected}: ${last}`);
}

function createComponent(args: unknown, terminal: FakeTerminal): { component: ToolExecutionComponent; tui: TUI } {
	const tui: TUI = new TuiMainScreen(terminal);
	const component = new ToolExecutionComponent(
		"edit",
		"tool-call-1",
		args,
		{},
		createEditToolDefinition(process.cwd()),
		tui,
		process.cwd(),
	);
	return { component, tui };
}

function largeEdit(): { oldContent: string; newContent: string } {
	const oldLines = Array.from({ length: 1000 }, (_, index) => `line ${index}`);
	const newLines = [...oldLines];
	for (const lineNumber of [50, 150, 250, 350, 450, 550, 650, 750, 850, 950]) {
		newLines[lineNumber] = `${newLines[lineNumber]} changed`;
	}
	return { oldContent: `${oldLines.join("\n")}\n`, newContent: `${newLines.join("\n")}\n` };
}

describe("edit tool TUI rendering", () => {
	const tempDirs: string[] = [];
	beforeAll(() => initTheme("dark"));
	afterEach(async () => {
		await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
	});

	it("renders a large call preview and does not full-redraw when the result settles", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-redraw-"));
		tempDirs.push(dir);
		const filePath = join(dir, "large-edit.txt");
		const { oldContent, newContent } = largeEdit();
		await writeFile(filePath, oldContent, "utf8");
		const diff = generateDiffString(oldContent, newContent);
		const terminal = new FakeTerminal();
		const { component, tui } = createComponent(
			{ file_path: filePath, old_string: oldContent, new_string: newContent },
			terminal,
		);
		const root = new Container();
		for (let index = 0; index < 200; index++) root.addChild(new Text(`history ${index}`, 0, 0));
		root.addChild(component);
		tui.addChild(root);
		tui.start();
		await waitForRender();
		component.setArgsComplete();
		tui.requestRender();
		const callRender = await waitForText(() => component.render(80).join("\n"), "line 50 changed");
		expect(callRender).toContain("edit");
		expect(callRender).toContain("line 950 changed");
		const redrawsBeforeResult = tui.fullRedraws;
		const clearsBeforeResult = terminal.fullClearCount;
		component.updateResult(
			{
				content: [{ type: "text", text: `The file ${filePath} has been updated successfully.` }],
				details: { diff: diff.diff },
				isError: false,
			},
			false,
		);
		tui.requestRender();
		await waitForRender();
		expect(tui.fullRedraws).toBe(redrawsBeforeResult);
		expect(terminal.fullClearCount).toBe(clearsBeforeResult);
		const settledRender = component.render(80).join("\n");
		expect(settledRender).toContain("line 50 changed");
		expect(settledRender).toContain("line 950 changed");
		expect(settledRender).not.toContain("updated successfully");
	});

	it("replays a settled result without argsComplete", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-replay-"));
		tempDirs.push(dir);
		const filePath = join(dir, "replay-edit.txt");
		const oldContent = "line 0\nline 50\nline 100\nline 150\n";
		const newContent = "line 0\nline 50 changed\nline 100\nline 150 changed\n";
		await writeFile(filePath, oldContent, "utf8");
		const diff = generateDiffString(oldContent, newContent);
		const terminal = new FakeTerminal();
		const { component, tui } = createComponent({ file_path: filePath }, terminal);
		tui.addChild(component);
		tui.start();
		await waitForRender();
		component.updateResult(
			{ content: [{ type: "text", text: "updated" }], details: { diff: diff.diff }, isError: false },
			false,
		);
		await waitForRender();
		const rendered = component.render(80).join("\n");
		expect(rendered).toContain("line 50 changed");
		expect(rendered).toContain("line 150 changed");
	});

	it("renders an error without a diff", async () => {
		const dir = await mkdtemp(join(tmpdir(), "pi-edit-preflight-"));
		tempDirs.push(dir);
		const filePath = join(dir, "missing-edit.txt");
		const terminal = new FakeTerminal();
		const { component, tui } = createComponent({ file_path: filePath }, terminal);
		tui.addChild(component);
		tui.start();
		await waitForRender();
		component.updateResult(
			{
				content: [{ type: "text", text: "String to replace not found in file." }],
				details: undefined,
				isError: true,
			},
			false,
		);
		const rendered = await waitForText(() => component.render(80).join("\n"), "String to replace not found");
		expect(rendered).not.toContain("+1 ");
		expect(rendered).not.toContain("-1 ");
	});
});
