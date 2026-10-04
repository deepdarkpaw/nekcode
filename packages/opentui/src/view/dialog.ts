/** Rounded modal dialog for extension UI requests: select, confirm, input, and editor. */

import {
	BoxRenderable,
	type CliRenderer,
	type KeyEvent,
	TextareaRenderable,
	type TextChunk,
	TextRenderable,
} from "@opentui/core";
import { keyLabel, matchesAction } from "../keys.ts";
import type { RpcExtensionUIResponse } from "../rpc/protocol.ts";
import type { DialogRequest } from "../state/types.ts";
import type { Palette } from "../theme/palette.ts";
import { chunk, styled } from "./styled.ts";

/** Options shown at once in a select dialog. */
const MAX_VISIBLE_OPTIONS = 10;

export class DialogView {
	readonly root: BoxRenderable;
	private readonly renderer: CliRenderer;
	private readonly palette: Palette;
	private readonly title: TextRenderable;
	private readonly body: TextRenderable;
	private readonly editor: TextareaRenderable;
	private readonly hint: TextRenderable;
	private request: DialogRequest | undefined;
	private selected = 0;

	constructor(renderer: CliRenderer, palette: Palette) {
		this.renderer = renderer;
		this.palette = palette;
		this.root = new BoxRenderable(renderer, {
			id: "dialog",
			position: "absolute",
			top: "20%",
			left: "15%",
			width: "70%",
			zIndex: 100,
			flexDirection: "column",
			border: true,
			borderStyle: "rounded",
			borderColor: palette.borderAccent,
			backgroundColor: palette.raised,
			paddingX: 2,
			paddingY: 1,
			visible: false,
		});
		this.title = new TextRenderable(renderer, { id: "dialog-title", wrapMode: "word" });
		this.body = new TextRenderable(renderer, { id: "dialog-body", wrapMode: "word", marginTop: 1 });
		this.editor = new TextareaRenderable(renderer, {
			id: "dialog-editor",
			marginTop: 1,
			minHeight: 1,
			maxHeight: 12,
			wrapMode: "word",
			backgroundColor: palette.panel,
			focusedBackgroundColor: palette.panel,
			textColor: palette.text,
			focusedTextColor: palette.text,
			placeholderColor: palette.dim,
			cursorColor: palette.accent,
			// Enter handling is done by the dialog, so the textarea only edits.
			keyBindings: [
				{ name: "return", action: "newline" },
				{ name: "return", meta: true, action: "newline" },
			],
			visible: false,
		});
		this.hint = new TextRenderable(renderer, { id: "dialog-hint", wrapMode: "none", truncate: true, marginTop: 1 });
		this.root.add(this.title);
		this.root.add(this.body);
		this.root.add(this.editor);
		this.root.add(this.hint);
	}

	get activeId(): string | undefined {
		return this.request?.id;
	}

	/** Show the request, or hide the dialog when undefined. Focuses the editor for text dialogs. */
	show(request: DialogRequest | undefined): void {
		if (request?.id === this.request?.id) return;
		this.request = request;
		this.selected = 0;
		this.root.visible = request !== undefined;
		if (!request) {
			this.editor.blur();
			return;
		}
		const palette = this.palette;
		this.title.content = styled([chunk(request.title, { color: palette.text, bold: true })]);
		const textEntry = request.method === "input" || request.method === "editor";
		this.editor.visible = textEntry;
		if (textEntry) {
			this.editor.setText(request.method === "editor" ? (request.prefill ?? "") : "");
			this.editor.placeholder = request.method === "input" ? (request.placeholder ?? null) : null;
			this.editor.maxHeight = request.method === "editor" ? 16 : 3;
			this.editor.focus();
		} else {
			this.editor.blur();
		}
		this.render();
	}

	private render(): void {
		const request = this.request;
		if (!request) return;
		const palette = this.palette;
		const accept = keyLabel("dialogAccept");
		const cancel = keyLabel("dialogCancel");
		switch (request.method) {
			case "select": {
				const chunks: TextChunk[] = [];
				const start = Math.max(
					0,
					Math.min(
						this.selected - Math.floor(MAX_VISIBLE_OPTIONS / 2),
						request.options.length - MAX_VISIBLE_OPTIONS,
					),
				);
				const visible = request.options.slice(start, start + MAX_VISIBLE_OPTIONS);
				for (const [offset, option] of visible.entries()) {
					const index = start + offset;
					const active = index === this.selected;
					if (offset > 0) chunks.push(chunk("\n", { color: palette.text }));
					chunks.push(chunk(active ? "› " : "  ", { color: palette.accent }));
					chunks.push(chunk(option, { color: active ? palette.text : palette.toolOutput, bold: active }));
				}
				if (request.options.length > visible.length) {
					chunks.push(chunk(`\n  ${this.selected + 1}/${request.options.length}`, { color: palette.dim }));
				}
				this.body.content = styled(chunks);
				this.body.visible = true;
				this.hint.content = styled([
					chunk(`↑↓ choose · ${accept} select · ${cancel} cancel`, { color: palette.dim }),
				]);
				break;
			}
			case "confirm":
				this.body.content = styled([chunk(request.message, { color: palette.toolOutput })]);
				this.body.visible = request.message.length > 0;
				this.hint.content = styled([chunk(`Y yes · N no · ${cancel} cancel`, { color: palette.dim })]);
				break;
			case "input":
				this.body.visible = false;
				this.hint.content = styled([chunk(`${accept} submit · ${cancel} cancel`, { color: palette.dim })]);
				break;
			case "editor":
				this.body.visible = false;
				this.hint.content = styled([
					chunk(`${keyLabel("editorSubmit")} submit · ${accept} newline · ${cancel} cancel`, {
						color: palette.dim,
					}),
				]);
				break;
		}
	}

	/**
	 * Handle a key while the dialog is open. Returns the response when the dialog completes.
	 * Keys the dialog does not use are left to the focused editor (text dialogs) or ignored.
	 */
	handleKey(key: KeyEvent): RpcExtensionUIResponse | undefined {
		const request = this.request;
		if (!request) return undefined;
		const id = request.id;
		if (matchesAction(key, "dialogCancel")) {
			key.preventDefault();
			return { type: "extension_ui_response", id, cancelled: true };
		}
		switch (request.method) {
			case "select":
				key.preventDefault();
				if (matchesAction(key, "dialogUp")) this.move(-1, request.options.length);
				else if (matchesAction(key, "dialogDown")) this.move(1, request.options.length);
				else if (matchesAction(key, "dialogAccept") && request.options.length > 0) {
					return { type: "extension_ui_response", id, value: request.options[this.selected] ?? "" };
				}
				return undefined;
			case "confirm":
				key.preventDefault();
				if (matchesAction(key, "dialogYes") || matchesAction(key, "dialogAccept")) {
					return { type: "extension_ui_response", id, confirmed: true };
				}
				if (matchesAction(key, "dialogNo")) return { type: "extension_ui_response", id, confirmed: false };
				return undefined;
			case "input":
				if (matchesAction(key, "dialogAccept")) {
					key.preventDefault();
					return { type: "extension_ui_response", id, value: this.editor.plainText };
				}
				return undefined;
			case "editor":
				if (matchesAction(key, "editorSubmit")) {
					key.preventDefault();
					return { type: "extension_ui_response", id, value: this.editor.plainText };
				}
				return undefined;
		}
	}

	private move(delta: number, count: number): void {
		if (count === 0) return;
		this.selected = (this.selected + delta + count) % count;
		this.render();
		this.renderer.requestRender();
	}
}
