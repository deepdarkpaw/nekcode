/**
 * `ModeContext`: the API that command handlers, selectors, and startup flows use to drive the
 * OpenTUI mode. `OpenTuiMode` implements it.
 *
 * Rules for implementers of commands and selectors:
 * - Read session state from `session`, `sessionManager`, `settingsManager`, and `runtimeHost`.
 * - Write UI only through this context (transcript, editor, dialogs, overlays, indicators).
 * - Never hardcode keys; match `keybindings` ids with `matchesKeybinding` from `bridge/input.ts`.
 *
 * This file is a contract shared by parallel work. Add members only; do not rename or remove them.
 */

import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent/core/agent-session";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent/core/agent-session-runtime";
import type { ProjectTrustContext } from "@earendil-works/pi-coding-agent/core/extensions/types";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent/core/keybindings";
import type { SettingsManager } from "@earendil-works/pi-coding-agent/core/settings-manager";
import type { CompactionStatusReason } from "@earendil-works/pi-coding-agent/modes/interactive/components/status-indicator";
import type { Component } from "@earendil-works/pi-tui";
import type { Renderable } from "@opentui/core";
import type { ComponentHostRenderable } from "../bridge/component-host.ts";
import type { FacadeTui } from "../bridge/facade-tui.ts";
import type {
	ConfirmDialogOptions,
	EditorDialogOptions,
	InputDialogOptions,
	SelectDialogOptions,
} from "../ui/dialogs.ts";
import type { UiEnvironment } from "../ui/environment.ts";
import type { OverlayLayout } from "../ui/overlay-stack.ts";

/** Color role for transcript text without its own ANSI styling. */
export type NoticeTone = "text" | "muted" | "dim" | "accent" | "success" | "warning" | "error";

export interface TranscriptBlockOptions {
	/** Blank rows above the block. Default 1 (0 for the first block). */
	spacing?: number;
}

export interface TranscriptTextOptions extends TranscriptBlockOptions {
	/** Color for text without ANSI styling. Default `"text"`. */
	tone?: NoticeTone;
	/** Horizontal padding in cells. Default 1. */
	paddingX?: number;
}

export interface TranscriptMarkdownOptions extends TranscriptBlockOptions {
	/** Bold accent heading above the markdown (e.g. "What's New", "Keyboard Shortcuts"). */
	title?: string;
	/** Draw separator rules above and below (the interactive mode's `DynamicBorder` framing). */
	bordered?: boolean;
}

/** The scrollable conversation. */
export interface TranscriptApi {
	/** Append a native OpenTUI block. */
	appendBlock(block: Renderable, options?: TranscriptBlockOptions): void;
	/** Append a pi-tui component through the bridge. It re-renders on width changes and `tui.requestRender()`. */
	appendComponent(component: Component, options?: TranscriptBlockOptions): ComponentHostRenderable;
	/** Append text. ANSI styling in `text` is kept; unstyled text uses `tone`. */
	appendText(text: string, options?: TranscriptTextOptions): void;
	/** Append markdown (changelog, hotkeys, session info), rendered with the pi markdown theme. */
	appendMarkdown(markdown: string, options?: TranscriptMarkdownOptions): void;
	/** Remove every block. */
	clear(): void;
	/** Clear and render the current session branch again (`renderInitialMessages` in the interactive mode). */
	rebuildFromSession(): void;
	/** Scroll to the newest content and resume following output. */
	scrollToBottom(): void;
}

/** The prompt editor (or the extension-provided editor that replaced it). */
export interface EditorApi {
	getText(): string;
	/** Text with collapsed large pastes expanded. */
	getExpandedText(): string;
	setText(text: string): void;
	insertTextAtCursor(text: string): void;
	/** Insert as a bracketed paste (large pastes collapse into a marker). */
	paste(text: string): void;
	addToHistory(text: string): void;
	/** Give the editor keyboard focus. */
	focus(): void;
}

export type StatusIndicatorKind = "working" | "retry" | "compaction" | "branchSummary";

/** Working/status row shown above the editor while an operation runs. */
export type StatusIndicatorSpec =
	| { kind: "compaction"; reason: CompactionStatusReason }
	| { kind: "branchSummary" }
	| { kind: "retry"; attempt: number; maxAttempts: number; delayMs: number };

/** Builds a pi-tui component for `showComponent`. Call `done` to close it with a result. */
export type ComponentFactory<T> = (done: (result: T | undefined) => void, tui: FacadeTui) => Component;

export interface ShowComponentOptions {
	/** Wrap the component in a rounded raised panel with this title. Without it the component draws its own frame. */
	title?: string;
	layout?: OverlayLayout;
	/** Resolve `undefined` and close when aborted. */
	signal?: AbortSignal;
}

/** Promise dialogs bound to the mode. Same semantics as `ui/dialogs.ts`. */
export interface DialogApi {
	select<T>(options: SelectDialogOptions<T>): Promise<T | undefined>;
	confirm(options: ConfirmDialogOptions): Promise<boolean>;
	input(options: InputDialogOptions): Promise<string | undefined>;
	editor(options: EditorDialogOptions): Promise<string | undefined>;
}

/** Theme control, mirroring the interactive mode's theme controller. */
export interface ThemeApi {
	/** Current theme setting (a name, or an automatic light/dark setting). */
	getThemeSelection(): string | undefined;
	/** Terminal background detected for automatic themes. */
	getTerminalTheme(): "dark" | "light";
	/** Apply a theme setting. The caller persists it with `settingsManager.setTheme`. */
	setThemeSetting(setting: string): Promise<void>;
	/** Show a theme without persisting it (selector highlight). */
	preview(name: string): void;
	/** Names of all available themes. */
	availableThemes(): string[];
}

export interface ModeContext extends UiEnvironment {
	// --- Runtime ---------------------------------------------------------------------------------
	/** Owns the current session; use it for new/fork/switch/import. The session changes after those. */
	readonly runtimeHost: AgentSessionRuntime;
	/** The current session. Re-read after session switches; do not cache. */
	readonly session: AgentSession;
	readonly sessionManager: AgentSession["sessionManager"];
	readonly settingsManager: SettingsManager;
	/** Configurable `app.*` and `tui.*` keybindings. */
	readonly keybindings: KeybindingsManager;
	/** pi-tui TUI for bridged components (`new SomeComponent(ctx.tui, ...)`). */
	readonly tui: FacadeTui;

	/** Schedule a repaint. */
	requestRender(): void;

	// --- Transcript and notices ------------------------------------------------------------------
	readonly transcript: TranscriptApi;
	/** Dim status line in the transcript. Consecutive status lines replace each other. */
	showStatus(message: string): void;
	/** `Warning: <message>` in the transcript. */
	showWarning(message: string): void;
	/** `Error: <message>` in the transcript. */
	showError(message: string): void;
	/** Transient toast (e.g. "Copied!"). */
	flash(message: string): void;
	/** Text of the current mouse selection in the transcript, if any. */
	getSelectedText(): string | undefined;

	// --- Editor and dialogs ----------------------------------------------------------------------
	readonly editor: EditorApi;
	readonly dialogs: DialogApi;
	/**
	 * Show a pi-tui component in a modal overlay (`ctx.ui.custom` semantics). The component gets
	 * keys and focus; it closes when it calls `done`. Resolves the value passed to `done`, or
	 * `undefined` when aborted.
	 */
	showComponent<T>(factory: ComponentFactory<T>, options?: ShowComponentOptions): Promise<T | undefined>;

	// --- Working state ---------------------------------------------------------------------------
	/** Show a status indicator (replaces the current one). */
	showStatusIndicator(spec: StatusIndicatorSpec): void;
	/** Clear the status indicator, or only when it is of `kind`. */
	clearStatusIndicator(kind?: StatusIndicatorKind): void;
	/** Route the interrupt key (`app.interrupt`) to `handler` until the returned function restores the previous one. */
	pushEscapeHandler(handler: () => void): () => void;

	// --- View state ------------------------------------------------------------------------------
	getToolsExpanded(): boolean;
	/** Expand or collapse tool output, thinking-adjacent blocks, and the startup header. */
	setToolsExpanded(expanded: boolean): void;
	getHideThinkingBlock(): boolean;
	/** Show or hide thinking blocks in rendered messages. Does not persist the setting. */
	setHideThinkingBlock(hidden: boolean): void;

	// --- Settings and chrome ---------------------------------------------------------------------
	/** Refresh footer, editor border, provider count, and terminal title after model/thinking/session changes. */
	refreshChrome(): void;
	/** Re-read `settingsManager` and apply every runtime-relevant setting (padding, images, timeouts, ...). */
	applySettings(): void;
	/** Rebuild the autocomplete provider (after skill-command or extension changes). */
	refreshAutocomplete(): void;
	readonly theme: ThemeApi;

	// --- Session lifecycle -----------------------------------------------------------------------
	/** Graceful exit: stop the UI, dispose the runtime, print the resume hint, exit the process. */
	shutdown(): Promise<void>;
	/** `/reload`: keybindings, extensions, skills, prompts, themes, and context files. */
	reload(): Promise<void>;
	/** Report a fatal runtime error, record a crash, restore the terminal, and exit. */
	handleFatalRuntimeError(prefix: string, error: unknown): Promise<never>;
	/** Move queued steering/follow-up messages back into the editor. Returns how many were restored. */
	restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number;
	/** Send messages queued during compaction or tree navigation. */
	flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void>;
	/** Project-trust prompts for `runtimeHost.switchSession(..., { projectTrustContextFactory })`. */
	createProjectTrustContext(cwd: string): ProjectTrustContext;
	/** Write the debug log (rendered lines and messages). Returns the log path. */
	writeDebugLog(): string;
	/** Suspend the renderer while `task` owns the terminal (external editor), then restore it. */
	runExternal<T>(task: () => Promise<T>): Promise<T>;
	/** Warn once when Anthropic subscription auth is used for `model` (default: the current model). */
	maybeWarnAboutAnthropicSubscriptionAuth(model?: Model<Api>): Promise<void>;
}
