import { formatKeyText } from "@earendil-works/pi-coding-agent/modes/interactive/components/keybinding-hints";
import type { Keybinding } from "@earendil-works/pi-tui";
import type { CommandDefinition } from "./registry.ts";

type Hotkey = readonly [Keybinding, string];
const GROUPS: ReadonlyArray<readonly [string, ReadonlyArray<Hotkey>]> = [
	[
		"Navigation",
		[
			["tui.editor.cursorUp", "Move cursor / browse history"],
			["tui.editor.cursorDown", "Move cursor / browse history"],
			["tui.editor.cursorLeft", "Move cursor"],
			["tui.editor.cursorRight", "Move cursor"],
			["tui.editor.cursorWordLeft", "Move by word"],
			["tui.editor.cursorWordRight", "Move by word"],
			["tui.editor.cursorLineStart", "Start of line"],
			["tui.editor.cursorLineEnd", "End of line"],
			["tui.editor.jumpForward", "Jump forward to character"],
			["tui.editor.jumpBackward", "Jump backward to character"],
			["tui.editor.pageUp", "Scroll by page"],
			["tui.editor.pageDown", "Scroll by page"],
		],
	],
	[
		"Editing",
		[
			["tui.input.submit", "Send message"],
			["tui.input.newLine", "New line"],
			["tui.editor.deleteWordBackward", "Delete word backwards"],
			["tui.editor.deleteWordForward", "Delete word forwards"],
			["tui.editor.deleteToLineStart", "Delete to start of line"],
			["tui.editor.deleteToLineEnd", "Delete to end of line"],
			["tui.editor.yank", "Paste deleted text"],
			["tui.editor.yankPop", "Cycle deleted text"],
			["tui.editor.undo", "Undo"],
		],
	],
	[
		"Other",
		[
			["tui.input.tab", "Path completion / accept autocomplete"],
			["app.interrupt", "Cancel autocomplete / abort streaming"],
			["app.clear", "Clear editor / exit"],
			["app.exit", "Exit when editor is empty"],
			["app.suspend", "Suspend to background"],
			["app.thinking.cycle", "Cycle thinking level"],
			["app.model.cycleForward", "Cycle model forward"],
			["app.model.cycleBackward", "Cycle model backward"],
			["app.model.select", "Open model selector"],
			["app.tools.expand", "Toggle tool output"],
			["app.thinking.toggle", "Toggle thinking blocks"],
			["app.editor.external", "External editor"],
			["app.message.copy", "Copy message"],
			["app.message.followUp", "Queue follow-up"],
			["app.message.dequeue", "Restore queued messages"],
			["app.clipboard.pasteImage", "Paste image or text"],
		],
	],
];

export const hotkeysCommand: CommandDefinition = {
	name: "hotkeys",
	acceptsArgs: false,
	clearEditor: "after",
	run: (ctx) => {
		const sections = GROUPS.map(
			([title, keys]) =>
				`**${title}**\n\n| Key | Action |\n|-----|--------|\n${keys.map(([id, description]) => `| \`${formatKeyText(ctx.keybindings.getKeys(id).join("/"))}\` | ${description} |`).join("\n")}`,
		).join("\n\n");
		ctx.transcript.appendMarkdown(sections, { title: "Keyboard Shortcuts", bordered: true });
	},
};
