import { formatKeyText } from "@earendil-works/pi-coding-agent/modes/interactive/components/keybinding-hints";
import type { Keybinding } from "@earendil-works/pi-tui";
import type { ModeContext } from "../mode/mode-context.ts";
import type { CommandDefinition } from "./registry.ts";

/** Capitalized display text of a keybinding (`keyDisplayText` in the interactive mode). */
function keyDisplay(ctx: ModeContext, id: Keybinding): string {
	const keys = ctx.keybindings.getKeys(id);
	return keys.length === 0 ? "" : formatKeyText(keys.join("/"), { capitalize: true });
}

/** The `/hotkeys` markdown, ported from the interactive mode's `handleHotkeysCommand`. */
export function hotkeysMarkdown(ctx: ModeContext, platform: NodeJS.Platform = process.platform): string {
	const key = (id: Keybinding) => keyDisplay(ctx, id);
	let hotkeys = `
**Navigation**
| Key | Action |
|-----|--------|
| \`${key("tui.editor.cursorUp")}\` / \`${key("tui.editor.cursorDown")}\` / \`${key("tui.editor.cursorLeft")}\` / \`${key("tui.editor.cursorRight")}\` | Move cursor / browse history |
| \`${key("tui.editor.cursorWordLeft")}\` / \`${key("tui.editor.cursorWordRight")}\` | Move by word |
| \`${key("tui.editor.cursorLineStart")}\` | Start of line |
| \`${key("tui.editor.cursorLineEnd")}\` | End of line |
| \`${key("tui.editor.jumpForward")}\` | Jump forward to character |
| \`${key("tui.editor.jumpBackward")}\` | Jump backward to character |
| \`${key("tui.editor.pageUp")}\` / \`${key("tui.editor.pageDown")}\` | Scroll by page |

**Editing**
| Key | Action |
|-----|--------|
| \`${key("tui.input.submit")}\` | Send message |
| \`${key("tui.input.newLine")}\` | New line${platform === "win32" ? " (Ctrl+Enter on Windows Terminal)" : ""} |
| \`${key("tui.editor.deleteWordBackward")}\` | Delete word backwards |
| \`${key("tui.editor.deleteWordForward")}\` | Delete word forwards |
| \`${key("tui.editor.deleteToLineStart")}\` | Delete to start of line |
| \`${key("tui.editor.deleteToLineEnd")}\` | Delete to end of line |
| \`${key("tui.editor.yank")}\` | Paste the most-recently-deleted text |
| \`${key("tui.editor.yankPop")}\` | Cycle through the deleted text after pasting |
| \`${key("tui.editor.undo")}\` | Undo |

**Other**
| Key | Action |
|-----|--------|
| \`${key("tui.input.tab")}\` | Path completion / accept autocomplete |
| \`${key("app.interrupt")}\` | Cancel autocomplete / abort streaming |
| \`${key("app.clear")}\` | Clear editor (first) / exit (second) |
| \`${key("app.exit")}\` | Exit (when editor is empty) |
| \`${key("app.suspend")}\` | Suspend to background |
| \`${key("app.thinking.cycle")}\` | Cycle thinking level |
| \`${key("app.model.cycleForward")}\` / \`${key("app.model.cycleBackward")}\` | Cycle models |
| \`${key("app.model.select")}\` | Open model selector |
| \`${key("app.tools.expand")}\` | Toggle tool output expansion |
| \`${key("app.thinking.toggle")}\` | Toggle thinking block visibility |
| \`${key("app.editor.external")}\` | Edit message in external editor |
| \`${key("app.message.copy")}\` | Copy selection or last assistant message |
| \`${key("app.message.followUp")}\` | Queue follow-up message |
| \`${key("app.message.dequeue")}\` | Restore queued messages |
| \`${key("app.clipboard.pasteImage")}\` | Paste image or text from clipboard |
| \`/\` | Slash commands |
| \`!\` | Run bash command |
| \`!!\` | Run bash command (excluded from context) |
`;
	const shortcuts = ctx.session.extensionRunner.getShortcuts(ctx.keybindings.getEffectiveConfig());
	if (shortcuts.size > 0) {
		hotkeys += `
**Extensions**
| Key | Action |
|-----|--------|
`;
		for (const [shortcutKey, shortcut] of shortcuts) {
			const description = shortcut.description ?? shortcut.extensionPath;
			hotkeys += `| \`${formatKeyText(shortcutKey, { capitalize: true })}\` | ${description} |\n`;
		}
	}
	return hotkeys.trim();
}

export const hotkeysCommand: CommandDefinition = {
	name: "hotkeys",
	acceptsArgs: false,
	clearEditor: "after",
	run: (ctx) => {
		ctx.transcript.appendMarkdown(hotkeysMarkdown(ctx), { title: "Keyboard Shortcuts", bordered: true });
	},
};
