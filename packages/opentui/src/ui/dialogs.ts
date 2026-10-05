/**
 * Promise-based dialog primitives: select, confirm, input, and multi-line editor.
 *
 * They back the extension UI (`ctx.ui.select/confirm/input/editor`) and are the building blocks for
 * command selectors. Every dialog is a rounded raised panel on the overlay stack, uses configurable
 * keybindings, resolves `undefined` when cancelled, and supports an abort signal and a timeout
 * (shown as a countdown in the title).
 */

import { InputRenderable, type KeyEvent, TextareaRenderable } from "@opentui/core";
import { matchesKeybinding } from "../bridge/input.ts";
import { DialogFrame } from "./dialog-frame.ts";
import { keyHints, type UiEnvironment } from "./environment.ts";
import type { OverlayContent, OverlayHandle, OverlayLayout } from "./overlay-stack.ts";
import { type SelectItem, SelectList } from "./select-list.ts";

/** Cancellation shared by all dialogs (mirrors `ExtensionUIDialogOptions`). */
export interface DialogBaseOptions {
	/** Resolve `undefined` and close when aborted. */
	signal?: AbortSignal;
	/** Resolve `undefined` and close after this many milliseconds. */
	timeoutMs?: number;
	layout?: OverlayLayout;
}

/** Handle given to a dialog builder. */
export interface DialogController<T> {
	/** Close the dialog with a result (`undefined` = cancelled). Only the first call counts. */
	resolve(value: T | undefined): void;
	/** Milliseconds until the timeout, or undefined without a timeout. */
	remainingMs(): number | undefined;
}

/**
 * Open a custom dialog. `build` returns the overlay content; call `controller.resolve` to close it.
 * `onTick` runs every second while a timeout is pending (for countdown displays).
 */
export function openDialog<T>(
	env: UiEnvironment,
	build: (controller: DialogController<T>) => OverlayContent,
	options: DialogBaseOptions & { onTick?: () => void } = {},
): Promise<T | undefined> {
	return new Promise((resolve) => {
		if (options.signal?.aborted) {
			resolve(undefined);
			return;
		}
		const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
		let settled = false;
		let handle: OverlayHandle | undefined;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let ticker: ReturnType<typeof setInterval> | undefined;
		const onAbort = () => controller.resolve(undefined);
		const controller: DialogController<T> = {
			resolve: (value) => {
				if (settled) return;
				settled = true;
				if (timeout) clearTimeout(timeout);
				if (ticker) clearInterval(ticker);
				options.signal?.removeEventListener("abort", onAbort);
				handle?.close();
				resolve(value);
			},
			remainingMs: () => (deadline === undefined ? undefined : Math.max(0, deadline - Date.now())),
		};
		const content = build(controller);
		if (settled) {
			content.root.destroyRecursively();
			content.dispose?.();
			return;
		}
		handle = env.overlays.open({ ...content, layout: content.layout ?? options.layout });
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.timeoutMs !== undefined) {
			timeout = setTimeout(() => controller.resolve(undefined), options.timeoutMs);
			if (options.onTick) ticker = setInterval(options.onTick, 1000);
		}
	});
}

function titleWithCountdown(title: string, controller: DialogController<unknown>): string {
	const remaining = controller.remainingMs();
	return remaining === undefined ? title : `${title} (${Math.ceil(remaining / 1000)}s)`;
}

export interface SelectDialogOptions<T> extends DialogBaseOptions {
	title: string;
	subtitle?: string;
	items: readonly SelectItem<T>[];
	initialIndex?: number;
	/** Show a fuzzy filter input. */
	filter?: boolean;
	maxVisible?: number;
	/** Called when the highlighted item changes (theme preview and similar). */
	onHighlight?: (item: SelectItem<T> | undefined) => void;
	/** Extra keys handled before list navigation. Return true to consume. */
	handleKey?: (key: KeyEvent, list: SelectList<T>, controller: DialogController<T>) => boolean;
}

/** Single-choice selector. Resolves the chosen value, or `undefined` when cancelled. */
export function showSelectDialog<T>(env: UiEnvironment, options: SelectDialogOptions<T>): Promise<T | undefined> {
	let frame: DialogFrame | undefined;
	let refreshTitle = () => {};
	return openDialog<T>(
		env,
		(controller) => {
			frame = new DialogFrame(env, {
				title: titleWithCountdown(options.title, controller),
				subtitle: options.subtitle,
				hint: keyHints(env.keybindings, [
					["tui.select.up", "up"],
					["tui.select.down", "down"],
					["tui.select.confirm", "select"],
					["tui.select.cancel", "cancel"],
				]),
			});
			refreshTitle = () => frame?.setTitle(titleWithCountdown(options.title, controller));
			const list = new SelectList<T>(env, {
				items: options.items,
				initialIndex: options.initialIndex,
				filter: options.filter,
				maxVisible: options.maxVisible,
				onConfirm: (item) => controller.resolve(item.value),
				onCancel: () => controller.resolve(undefined),
				onHighlight: options.onHighlight,
			});
			frame.add(list.root);
			return {
				root: frame.root,
				focusTarget: list.focusTarget,
				handleKey: (key) => options.handleKey?.(key, list, controller) === true || list.handleKey(key),
			};
		},
		{ ...options, onTick: () => refreshTitle() },
	);
}

export interface ConfirmDialogOptions extends DialogBaseOptions {
	title: string;
	message: string;
}

/** Yes/No prompt (the interactive mode shows confirms as a two-item selector). */
export async function showConfirmDialog(env: UiEnvironment, options: ConfirmDialogOptions): Promise<boolean> {
	const result = await showSelectDialog(env, {
		...options,
		title: `${options.title}\n${options.message}`,
		items: [
			{ value: true, label: "Yes" },
			{ value: false, label: "No" },
		],
	});
	return result === true;
}

export interface InputDialogOptions extends DialogBaseOptions {
	title: string;
	placeholder?: string;
	initialValue?: string;
}

/** Single-line text input. Resolves the entered text, or `undefined` when cancelled. */
export function showInputDialog(env: UiEnvironment, options: InputDialogOptions): Promise<string | undefined> {
	let refreshTitle = () => {};
	return openDialog<string>(
		env,
		(controller) => {
			const theme = env.uiTheme();
			const frame = new DialogFrame(env, {
				title: titleWithCountdown(options.title, controller),
				hint: keyHints(env.keybindings, [
					["tui.select.confirm", "submit"],
					["tui.select.cancel", "cancel"],
				]),
			});
			refreshTitle = () => frame.setTitle(titleWithCountdown(options.title, controller));
			const input = new InputRenderable(env.renderer, {
				value: options.initialValue ?? "",
				placeholder: options.placeholder ?? "",
				backgroundColor: theme.overlay,
				focusedBackgroundColor: theme.overlay,
				textColor: theme.text,
				focusedTextColor: theme.text,
				placeholderColor: theme.dim,
			});
			frame.add(input);
			return {
				root: frame.root,
				focusTarget: input,
				handleKey: (key) => {
					if (matchesKeybinding(env.keybindings, key, "tui.select.confirm")) {
						controller.resolve(input.value);
						return true;
					}
					if (matchesKeybinding(env.keybindings, key, "tui.select.cancel")) {
						controller.resolve(undefined);
						return true;
					}
					return false;
				},
			};
		},
		{ ...options, onTick: () => refreshTitle() },
	);
}

export interface EditorDialogOptions extends DialogBaseOptions {
	title: string;
	prefill?: string;
	/**
	 * Open the text in an external editor (bound to `app.editor.external`). Resolve the edited text,
	 * or `undefined` to keep the current text.
	 */
	openExternalEditor?: (text: string) => Promise<string | undefined>;
}

/** Multi-line editor. Submit with `tui.input.submit`, newline with `tui.input.newLine`. */
export function showEditorDialog(env: UiEnvironment, options: EditorDialogOptions): Promise<string | undefined> {
	return openDialog<string>(
		env,
		(controller) => {
			const theme = env.uiTheme();
			const frame = new DialogFrame(env, {
				title: options.title,
				hint: keyHints(env.keybindings, [
					["tui.input.submit", "submit"],
					["tui.input.newLine", "newline"],
					["tui.select.cancel", "cancel"],
					...(options.openExternalEditor ? ([["app.editor.external", "external editor"]] as const) : []),
				]),
			});
			const editor = new TextareaRenderable(env.renderer, {
				initialValue: options.prefill ?? "",
				minHeight: 3,
				maxHeight: 16,
				wrapMode: "word",
				backgroundColor: theme.overlay,
				focusedBackgroundColor: theme.overlay,
				textColor: theme.text,
				focusedTextColor: theme.text,
			});
			editor.gotoBufferEnd();
			frame.add(editor);
			let externalEditorOpen = false;
			return {
				root: frame.root,
				focusTarget: editor,
				layout: { width: "80%" },
				handleKey: (key) => {
					if (externalEditorOpen) return true;
					if (matchesKeybinding(env.keybindings, key, "tui.input.newLine")) {
						editor.insertText("\n");
						return true;
					}
					if (matchesKeybinding(env.keybindings, key, "tui.input.submit")) {
						controller.resolve(editor.plainText);
						return true;
					}
					if (matchesKeybinding(env.keybindings, key, "tui.select.cancel")) {
						controller.resolve(undefined);
						return true;
					}
					if (options.openExternalEditor && matchesKeybinding(env.keybindings, key, "app.editor.external")) {
						externalEditorOpen = true;
						void options
							.openExternalEditor(editor.plainText)
							.then((text) => {
								if (text !== undefined) editor.setText(text);
							})
							.finally(() => {
								externalEditorOpen = false;
								env.renderer.requestRender();
							});
						return true;
					}
					return false;
				},
			};
		},
		options,
	);
}
