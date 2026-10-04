/**
 * Prompt editor: a native OpenTUI textarea in a rounded `raised` panel whose border color shows
 * the thinking level (or bash mode), like the interactive mode's editor border.
 *
 * Phase 0 covers text entry, submit/newline through configurable keybindings (handled by the
 * mode), and history recording. Autocomplete, history navigation, paste markers, kill ring, and
 * the full keymap arrive with the editor phase.
 */

import { BoxRenderable, type CliRenderer, type RGBA, TextareaRenderable } from "@opentui/core";
import type { UiTheme } from "../theme/ui-theme.ts";
import type { EditorApi } from "./mode-context.ts";

/** Upper bound of remembered prompts. */
const HISTORY_LIMIT = 100;

export class PromptEditor implements EditorApi {
	readonly root: BoxRenderable;
	readonly textarea: TextareaRenderable;
	private readonly history: string[] = [];

	constructor(renderer: CliRenderer, theme: UiTheme) {
		this.root = new BoxRenderable(renderer, {
			id: "prompt-editor",
			width: "100%",
			flexDirection: "column",
			border: true,
			borderStyle: "rounded",
			borderColor: theme.thinkingBorder("off"),
			backgroundColor: theme.raised,
			paddingX: 1,
		});
		this.textarea = new TextareaRenderable(renderer, {
			id: "prompt-textarea",
			width: "100%",
			minHeight: 1,
			maxHeight: 12,
			wrapMode: "word",
			backgroundColor: theme.raised,
			focusedBackgroundColor: theme.raised,
			textColor: theme.text,
			focusedTextColor: theme.text,
			placeholderColor: theme.dim,
			cursorColor: theme.accent,
			// Submit and newline are handled by the mode's global key handler (configurable keybindings),
			// which runs before the textarea's built-in bindings.
		});
		this.root.add(this.textarea);
	}

	/** Prompts recorded with `addToHistory`, oldest first. */
	get historyEntries(): readonly string[] {
		return this.history;
	}

	getText(): string {
		return this.textarea.plainText;
	}

	getExpandedText(): string {
		return this.textarea.plainText;
	}

	setText(text: string): void {
		this.textarea.setText(text);
		this.textarea.gotoBufferEnd();
	}

	insertTextAtCursor(text: string): void {
		this.textarea.insertText(text);
	}

	paste(text: string): void {
		this.textarea.insertText(text);
	}

	addToHistory(text: string): void {
		const trimmed = text.trim();
		if (!trimmed || this.history[this.history.length - 1] === trimmed) return;
		this.history.push(trimmed);
		if (this.history.length > HISTORY_LIMIT) this.history.shift();
	}

	focus(): void {
		this.textarea.focus();
	}

	get isFocused(): boolean {
		return this.textarea.focused;
	}

	setBorderColor(color: RGBA): void {
		this.root.borderColor = color;
	}

	applyTheme(theme: UiTheme): void {
		this.root.backgroundColor = theme.raised;
		this.textarea.backgroundColor = theme.raised;
		this.textarea.focusedBackgroundColor = theme.raised;
		this.textarea.textColor = theme.text;
		this.textarea.focusedTextColor = theme.text;
	}
}
