/**
 * The OpenTUI interactive mode: a same-process replacement for coding-agent `InteractiveMode`.
 *
 * `main()` builds it through `MainOptions.createInteractiveMode` and drives `init()`, `run()`, and
 * `stop()`. The mode uses the session, settings, keybindings, and theme objects directly. Layout,
 * scrolling, overlays, dialogs, search, and selection are native OpenTUI; messages, tool rows, the
 * prompt editor, indicators, and extension components are the interactive mode's pi-tui components
 * hosted through the bridge. Behavior follows `InteractiveMode` (ported, not shared, so the old UI
 * stays untouched); see `docs/opentui.md` for the differences.
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, AssistantMessage, Message, Model } from "@earendil-works/pi-ai";
import {
	APP_NAME,
	APP_TITLE,
	CONFIG_DIR_NAME,
	getDebugLogPath,
	NEK_VERSION,
} from "@earendil-works/pi-coding-agent/config";
import {
	type AgentSession,
	type AgentSessionEvent,
	parseSkillBlock,
} from "@earendil-works/pi-coding-agent/core/agent-session";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent/core/agent-session-runtime";
import {
	CACHE_TTL_MS,
	type CacheMiss,
	collectCacheMisses,
	detectCacheMiss,
} from "@earendil-works/pi-coding-agent/core/cache-stats";
import { formatCacheWarmingUsage } from "@earendil-works/pi-coding-agent/core/cache-warmer";
import { findExtensionStackMatches, recordCrash } from "@earendil-works/pi-coding-agent/core/crash-log";
import type {
	AutocompleteProviderFactory,
	EditorFactory,
	ExtensionContext,
	ExtensionRunner,
	ExtensionUIContext,
	ExtensionWidgetOptions,
	MarkdownTransformer,
	ProjectTrustContext,
	UserBashEventResult,
	WorkingIndicatorOptions,
} from "@earendil-works/pi-coding-agent/core/extensions/index";
import {
	FooterDataProvider,
	type ReadonlyFooterDataProvider,
} from "@earendil-works/pi-coding-agent/core/footer-data-provider";
import { configureHttpDispatcher } from "@earendil-works/pi-coding-agent/core/http-dispatcher";
import { type AppKeybinding, KeybindingsManager } from "@earendil-works/pi-coding-agent/core/keybindings";
import { createCompactionSummaryMessage, createCustomMessage } from "@earendil-works/pi-coding-agent/core/messages";
import type { ResourceDiagnostic } from "@earendil-works/pi-coding-agent/core/resource-loader";
import {
	type SessionEntry,
	sessionEntryToContextMessages,
	type UsageEntry,
} from "@earendil-works/pi-coding-agent/core/session-manager";
import type { SettingsManager } from "@earendil-works/pi-coding-agent/core/settings-manager";
import { BUILTIN_SLASH_COMMANDS } from "@earendil-works/pi-coding-agent/core/slash-commands";
import type { SourceInfo } from "@earendil-works/pi-coding-agent/core/source-info";
import { withBuiltInRenderers } from "@earendil-works/pi-coding-agent/core/tools/renderers/index";
import type { TruncationResult } from "@earendil-works/pi-coding-agent/core/tools/truncate";
import {
	hasTrustRequiringProjectResources,
	ProjectTrustStore,
} from "@earendil-works/pi-coding-agent/core/trust-manager";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/assistant-message";
import { BashExecutionComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/bash-execution";
import { BranchSummaryMessageComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/branch-summary-message";
import { CompactionSummaryMessageComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/compaction-summary-message";
import { CustomEditor } from "@earendil-works/pi-coding-agent/modes/interactive/components/custom-editor";
import { CustomEntryComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/custom-entry";
import { CustomMessageComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/custom-message";
import { DynamicBorder } from "@earendil-works/pi-coding-agent/modes/interactive/components/dynamic-border";
import { FooterComponent, formatTokens } from "@earendil-works/pi-coding-agent/modes/interactive/components/footer";
import {
	formatKeyText,
	keyDisplayText,
	keyHint,
	keyText,
	rawKeyHint,
} from "@earendil-works/pi-coding-agent/modes/interactive/components/keybinding-hints";
import { createMermaidMarkdownTransformer } from "@earendil-works/pi-coding-agent/modes/interactive/components/mermaid";
import { SkillInvocationMessageComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/skill-invocation-message";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	RetryStatusIndicator,
	type StatusIndicator,
	WorkingStatusIndicator,
} from "@earendil-works/pi-coding-agent/modes/interactive/components/status-indicator";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/tool-execution";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/user-message";
import { editInExternalEditor } from "@earendil-works/pi-coding-agent/modes/interactive/external-editor";
import {
	formatCrashExtensionHint,
	formatResumeCommand,
	type InteractiveModeOptions,
} from "@earendil-works/pi-coding-agent/modes/interactive/interactive-mode";
import type { InteractiveModeLike } from "@earendil-works/pi-coding-agent/modes/interactive/interactive-mode-factory";
import {
	getAvailableThemes,
	getAvailableThemesWithPaths,
	getEditorTheme,
	getMarkdownTheme,
	getThemeByName,
	onThemeChange,
	setRegisteredThemes,
	stopThemeWatcher,
	Theme,
	theme,
} from "@earendil-works/pi-coding-agent/modes/interactive/theme/theme";
import { InteractiveThemeController } from "@earendil-works/pi-coding-agent/modes/interactive/theme/theme-controller";
import { copyToClipboard, readClipboardText } from "@earendil-works/pi-coding-agent/utils/clipboard";
import { extensionForImageMimeType, readClipboardImage } from "@earendil-works/pi-coding-agent/utils/clipboard-image";
import { parseGitUrl } from "@earendil-works/pi-coding-agent/utils/git";
import { killTrackedDetachedChildren } from "@earendil-works/pi-coding-agent/utils/shell";
import { loadAllHighlightLanguages } from "@earendil-works/pi-coding-agent/utils/syntax-highlight";
import { ensureTool, type ToolStatus } from "@earendil-works/pi-coding-agent/utils/tools-manager";
import {
	type AutocompleteProvider,
	CombinedAutocompleteProvider,
	type Component,
	Container,
	type EditorComponent,
	type KeyId,
	type MarkdownTheme,
	matchesKey,
	type OverlayHandle,
	type OverlayOptions,
	type SlashCommand,
	Spacer,
	setCapabilityOverrides,
	setKeybindings,
	Text,
	TruncatedText,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { BoxRenderable, CliRenderEvents, type CliRenderer, type KeyEvent, MouseButton } from "@opentui/core";
import { ComponentHostRenderable } from "../bridge/component-host.ts";
import { FacadeTui } from "../bridge/facade-tui.ts";
import { RawInputRouter } from "../bridge/input.ts";
import {
	builtinCommandNames,
	builtinKeyActions,
	builtinSlashCommands,
	dispatchBuiltinCommand,
	getBuiltinCommand,
	runKeyAction,
} from "../commands/registry.ts";
import { MODE_STARTUP_FLOWS } from "../startup/index.ts";
import type { ModeStartupPhase } from "../startup/types.ts";
import { createUiTheme, type UiTheme } from "../theme/ui-theme.ts";
import { DialogFrame } from "../ui/dialog-frame.ts";
import { openDialog, showConfirmDialog, showEditorDialog, showInputDialog, showSelectDialog } from "../ui/dialogs.ts";
import { OverlayStack } from "../ui/overlay-stack.ts";
import { ExpandableText, isExpandable } from "./expandable-text.ts";
import { renderLoadedResources } from "./loaded-resources.ts";
import {
	type ComponentFactory,
	type DialogApi,
	type EditorApi,
	isHostedComponent,
	type ModeContext,
	type ShowComponentOptions,
	type StatusIndicatorKind,
	type StatusIndicatorSpec,
	type ThemeApi,
} from "./mode-context.ts";
import { PiOverlayRegistry } from "./pi-overlays.ts";
import type { RendererHost } from "./renderer-host.ts";
import { Shell } from "./shell.ts";
import { TranscriptView } from "./transcript.ts";
import { TranscriptViewport } from "./viewport.ts";

/** Two `app.clear` presses (or escapes for the double-escape action) within this window. */
const DOUBLE_PRESS_MS = 500;
/** Maximum lines of a string-array extension widget. */
const MAX_WIDGET_LINES = 10;
const DEFAULT_WORKING_MESSAGE = "Working";
const DEFAULT_HIDDEN_THINKING_LABEL = "Thinking...";
const DEAD_TERMINAL_ERROR_CODES = new Set(["EIO", "EPIPE", "ENOTCONN"]);
const TERMINAL_PROGRESS_ACTIVE = "\x1b]9;4;3\x07";
const TERMINAL_PROGRESS_CLEAR = "\x1b]9;4;0\x07";
const TERMINAL_PROGRESS_KEEPALIVE_MS = 1000;
const ANTHROPIC_SUBSCRIPTION_AUTH_WARNING =
	"Anthropic subscription auth is active. Third-party harness usage draws from extra usage and is billed per token, not your Claude plan limits. Manage extra usage at https://claude.ai/settings/usage. Disable this warning in /settings.";

type DisposableComponent = Component & { dispose?(): void };

type CompactionQueuedMessage = { text: string; mode: "steer" | "followUp" };

type CompactionCostNotice = {
	type: "compaction_cost";
	kind: "compaction" | "branch_summary";
	usage: NonNullable<Extract<SessionEntry, { type: "compaction" }>["usage"]>;
};

type RenderSessionItem = AgentMessage | Extract<SessionEntry, { type: "custom" | "usage" }> | CompactionCostNotice;

interface WorkingStatusEditor extends EditorComponent {
	readonly embedWorkingStatus: boolean;
	setWorkingStatusIndicator(indicator: StatusIndicator | undefined): void;
}

function isWorkingStatusEditor(editor: EditorComponent): editor is WorkingStatusEditor {
	return (
		"embedWorkingStatus" in editor &&
		editor.embedWorkingStatus === true &&
		"setWorkingStatusIndicator" in editor &&
		typeof editor.setWorkingStatusIndicator === "function"
	);
}

function isCustomSessionEntry(item: RenderSessionItem): item is Extract<SessionEntry, { type: "custom" }> {
	return "type" in item && item.type === "custom";
}

function isCompactionCostNotice(item: RenderSessionItem): item is CompactionCostNotice {
	return "type" in item && item.type === "compaction_cost";
}

function isUsageSessionEntry(item: RenderSessionItem): item is Extract<SessionEntry, { type: "usage" }> {
	return "type" in item && item.type === "usage";
}

function isDeadTerminalError(error: unknown): boolean {
	if (!error || typeof error !== "object" || !("code" in error)) return false;
	const code = (error as NodeJS.ErrnoException).code;
	return code !== undefined && DEAD_TERMINAL_ERROR_CODES.has(code);
}

function isAnthropicSubscriptionAuthKey(apiKey: string | undefined): boolean {
	return typeof apiKey === "string" && apiKey.startsWith("sk-ant-oat");
}

function countDroppedThinkingBlocks(message: AssistantMessage): number {
	let count = 0;
	for (const diagnostic of message.diagnostics ?? []) {
		if (diagnostic.type !== "anthropic_input_transformations") continue;
		const transformations = diagnostic.details?.transformations;
		if (!Array.isArray(transformations)) continue;
		count += transformations.filter(
			(transformation) =>
				typeof transformation === "object" &&
				transformation !== null &&
				(transformation as Record<string, unknown>).type === "thinking_dropped",
		).length;
	}
	return count;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Created during `init()`; everything that needs the renderer. */
interface ModeUi {
	readonly renderer: CliRenderer;
	readonly shell: Shell;
	readonly overlays: OverlayStack;
	readonly transcript: TranscriptView;
	readonly viewport: TranscriptViewport;
	readonly piOverlays: PiOverlayRegistry;
	/** Hosts the editor slot (`editorContainer`); pi-tui keys go through it. */
	readonly editorHost: ComponentHostRenderable;
	/** Pending, status, widget, editor, and footer region hosts (debug output). */
	readonly regionHosts: readonly ComponentHostRenderable[];
	readonly inputRouter: RawInputRouter;
}

export class OpenTuiMode implements InteractiveModeLike, ModeContext {
	readonly runtimeHost: AgentSessionRuntime;
	readonly keybindings: KeybindingsManager;
	readonly tui: FacadeTui;
	readonly dialogs: DialogApi;
	readonly theme: ThemeApi;
	readonly editor: EditorApi;
	private readonly options: InteractiveModeOptions;
	private readonly rendererHost: RendererHost;
	private readonly themeController: InteractiveThemeController;
	private ui: ModeUi | undefined;
	private currentUiTheme: UiTheme;

	// pi-tui containers, mounted into the shell regions during `init()`.
	private readonly pendingMessagesContainer = new Container();
	private readonly statusContainer = new Container();
	private readonly widgetContainerAbove = new Container();
	private readonly widgetContainerBelow = new Container();
	private readonly editorContainer = new Container();
	private readonly footerContainer = new Container();
	private readonly defaultEditor: CustomEditor;
	private currentEditor: EditorComponent;
	/** pi-tui component focused inside the editor slot (editor, selector, custom component). */
	private editorSlotFocus: Component;
	private editorComponentFactory: EditorFactory | undefined;
	private autocompleteProvider: AutocompleteProvider | undefined;
	private autocompleteProviderWrappers: AutocompleteProviderFactory[] = [];
	private fdPath: string | undefined;
	private readonly footer: FooterComponent;
	private readonly footerDataProvider: FooterDataProvider;
	private customFooter: DisposableComponent | undefined;
	private builtInHeader: Component | undefined;
	private customHeader: DisposableComponent | undefined;
	private readonly extensionWidgetsAbove = new Map<string, DisposableComponent>();
	private readonly extensionWidgetsBelow = new Map<string, DisposableComponent>();
	private readonly extensionTerminalInputUnsubscribers = new Set<() => void>();

	// Working state.
	private activeStatusIndicator: StatusIndicator | undefined;
	private activeWorkingIndicatorEmbedded = false;
	private workingMessage: string | undefined;
	private workingVisible = true;
	private workingIndicatorOptions: WorkingIndicatorOptions | undefined;
	private hiddenThinkingLabel = DEFAULT_HIDDEN_THINKING_LABEL;
	private readonly escapeHandlers: Array<() => void> = [];
	private releaseCompactionEscape: (() => void) | undefined;
	private releaseRetryEscape: (() => void) | undefined;

	// Transcript state.
	private streamingComponent: AssistantMessageComponent | undefined;
	private streamingMessage: AssistantMessage | undefined;
	private readonly pendingTools = new Map<string, ToolExecutionComponent>();
	private readonly entriesRenderedByBoundaryCompaction = new Set<string>();
	private toolOutputExpanded = false;
	private hideThinkingBlock: boolean;
	private outputPad: number;
	private managedToolStatusStarted = false;
	private readonly mermaidMarkdownTransformer: MarkdownTransformer;
	private bashComponent: BashExecutionComponent | undefined;
	private pendingBashComponents: BashExecutionComponent[] = [];
	private compactionQueuedMessages: CompactionQueuedMessage[] = [];

	// Input and lifecycle state.
	private isBashMode = false;
	private isPlanMode = false;
	private lastSigintTime = 0;
	private lastEscapeTime = 0;
	private readonly pendingUserInputs: string[] = [];
	private onInputCallback: ((text: string) => void) | undefined;
	private unsubscribe: (() => void) | undefined;
	private initialized = false;
	private stopped = false;
	private isShuttingDown = false;
	private shutdownRequested = false;
	private anthropicSubscriptionWarningShown = false;
	private autoTrustOnReloadCwd: string | undefined;
	private progressInterval: ReturnType<typeof setInterval> | undefined;
	private hardwareCursorShown = false;
	private signalCleanupHandlers: Array<() => void> = [];
	private readonly keyHandler = (key: KeyEvent): void => this.handleGlobalKey(key);

	constructor(runtimeHost: AgentSessionRuntime, options: InteractiveModeOptions, rendererHost: RendererHost) {
		this.runtimeHost = runtimeHost;
		this.options = options;
		this.rendererHost = rendererHost;
		this.autoTrustOnReloadCwd = options.autoTrustOnReloadCwd;
		setCapabilityOverrides(this.settingsManager.getTerminalCapabilityOverrides());
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.outputPad = this.settingsManager.getOutputPad();
		this.mermaidMarkdownTransformer = createMermaidMarkdownTransformer({
			getMode: () => this.settingsManager.getMermaidRenderingMode(),
			theme,
		});
		this.tui = new FacadeTui({
			size: () => {
				const renderer = this.rendererHost.current;
				return {
					columns: renderer?.width ?? process.stdout.columns ?? 80,
					rows: renderer?.height ?? process.stdout.rows ?? 24,
				};
			},
			onTitle: (title) => this.rendererHost.current?.setTerminalTitle(title),
			onProgress: (active) => this.setTerminalProgress(active),
			showHardwareCursor: this.settingsManager.getShowHardwareCursor(),
		});
		this.defaultEditor = new CustomEditor(this.tui, getEditorTheme(), this.keybindings, {
			paddingX: this.settingsManager.getEditorPaddingX(),
			autocompleteMaxVisible: this.settingsManager.getAutocompleteMaxVisible(),
			embedWorkingStatus: true,
		});
		this.currentEditor = this.defaultEditor;
		this.editorSlotFocus = this.defaultEditor;
		this.editorContainer.addChild(this.defaultEditor);
		this.footerDataProvider = new FooterDataProvider(this.sessionManager.getCwd());
		this.footer = new FooterComponent(this.session, this.footerDataProvider);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.footerContainer.addChild(this.footer);
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.themeController = new InteractiveThemeController(this.tui, {
			getSettingsManager: () => this.settingsManager,
			showError: (message) => this.showError(message),
			onChanged: () => this.applyThemeChange(),
			initialThemeSetting: options.initialThemeSetting,
		});
		this.currentUiTheme = createUiTheme(theme);
		this.dialogs = {
			select: (dialogOptions) => showSelectDialog(this, dialogOptions),
			confirm: (dialogOptions) => showConfirmDialog(this, dialogOptions),
			input: (dialogOptions) => showInputDialog(this, dialogOptions),
			editor: (dialogOptions) => showEditorDialog(this, dialogOptions),
		};
		this.theme = {
			getThemeSelection: () => this.themeController.getThemeSelection(),
			getTerminalTheme: () => this.themeController.getTerminalTheme(),
			setThemeSetting: (setting) => this.themeController.setThemeSetting(setting),
			preview: (name) => this.themeController.preview(name),
			availableThemes: () => getAvailableThemes(),
		};
		this.editor = {
			getText: () => this.currentEditor.getText(),
			getExpandedText: () => this.currentEditor.getExpandedText?.() ?? this.currentEditor.getText(),
			setText: (text) => {
				this.currentEditor.setText(text);
				this.tui.requestRender();
			},
			insertTextAtCursor: (text) => {
				if (this.currentEditor.insertTextAtCursor) this.currentEditor.insertTextAtCursor(text);
				else this.currentEditor.setText(this.currentEditor.getText() + text);
				this.tui.requestRender();
			},
			paste: (text) => this.currentEditor.handleInput(`\x1b[200~${text}\x1b[201~`),
			addToHistory: (text) => this.currentEditor.addToHistory?.(text),
			focus: () => this.tui.setFocus(this.currentEditor),
		};
		this.runtimeHost.setBeforeSessionInvalidate(() => this.resetExtensionUI());
		this.runtimeHost.setRebindSession(async () => {
			await this.rebindCurrentSession({ renderBeforeBind: true });
			await this.themeController.applyFromSettings();
		});
	}

	// --- ModeContext: runtime ----------------------------------------------------------------------

	get session(): AgentSession {
		return this.runtimeHost.session;
	}

	get sessionManager(): AgentSession["sessionManager"] {
		return this.session.sessionManager;
	}

	get settingsManager(): SettingsManager {
		return this.session.settingsManager;
	}

	get renderer(): CliRenderer {
		return this.requireUi().renderer;
	}

	get overlays(): OverlayStack {
		return this.requireUi().overlays;
	}

	get transcript(): TranscriptView {
		return this.requireUi().transcript;
	}

	/** The active editor component (default editor or an extension editor). */
	get editorComponent(): EditorComponent {
		return this.currentEditor;
	}

	/** Transcript scrolling, search, flash, and selection (tests). */
	get viewport(): TranscriptViewport {
		return this.requireUi().viewport;
	}

	uiTheme(): UiTheme {
		return this.currentUiTheme;
	}

	requestRender(): void {
		this.tui.requestRender();
		this.ui?.renderer.requestRender();
	}

	// --- Lifecycle -------------------------------------------------------------------------------

	async init(): Promise<void> {
		if (this.initialized) return;
		this.initialized = true;
		this.registerSignalHandlers();
		const renderer = await this.rendererHost.get();
		const shell = new Shell(renderer, this.currentUiTheme);
		renderer.root.add(shell.root);
		const overlays = new OverlayStack(renderer, renderer.root);
		const regionHost = (component: Component, bg?: UiTheme["base"]) =>
			new ComponentHostRenderable(renderer, {
				component,
				tui: this.tui,
				focusable: false,
				syncFocus: false,
				disposeComponent: false,
				...(bg ? { bg } : {}),
			});
		const editorHost = new ComponentHostRenderable(renderer, {
			component: this.editorContainer,
			tui: this.tui,
			focusable: true,
			syncFocus: () => this.editorSlotFocus,
			disposeComponent: false,
		});
		editorHost.renderAfter = () => this.updateHardwareCursor();
		const regionHosts = [
			regionHost(this.pendingMessagesContainer),
			regionHost(this.statusContainer),
			regionHost(this.widgetContainerAbove),
			editorHost,
			regionHost(this.widgetContainerBelow),
			regionHost(this.footerContainer),
		];
		const [pendingHost, statusHost, aboveHost, , belowHost, footerHost] = regionHosts;
		if (pendingHost) shell.pending.add(pendingHost);
		if (statusHost) shell.status.add(statusHost);
		if (aboveHost) shell.widgetsAbove.add(aboveHost);
		shell.editor.add(editorHost);
		if (belowHost) shell.widgetsBelow.add(belowHost);
		if (footerHost) shell.footer.add(footerHost);
		const transcript = new TranscriptView({
			renderer,
			scrollBox: shell.transcript,
			tui: this.tui,
			rebuild: () => this.renderInitialMessages(),
			scrollToBottom: () => viewport.scrollToBottom(),
			codeBlockIndent: () => this.settingsManager.getCodeBlockIndent(),
		});
		const viewport = new TranscriptViewport({
			renderer,
			scrollBox: shell.transcript,
			area: shell.transcriptArea,
			tui: this.tui,
			overlays,
			keybindings: this.keybindings,
			uiTheme: () => this.currentUiTheme,
			hosts: () => transcript.hosts(),
			copyText: async (text) => {
				try {
					await copyToClipboard(text);
					return true;
				} catch (error) {
					return errorText(error);
				}
			},
			getCopyOnSelect: () => this.settingsManager.getFullscreenCopyOnSelect(),
			restoreEditorFocus: () => this.focusEditorSlot(),
		});
		const piOverlays = new PiOverlayRegistry({
			renderer,
			overlays,
			tui: this.tui,
			uiTheme: () => this.currentUiTheme,
		});
		const inputRouter = new RawInputRouter(renderer);
		this.ui = { renderer, shell, overlays, transcript, viewport, piOverlays, editorHost, regionHosts, inputRouter };

		this.tui.bind({
			onRenderRequest: () => renderer.requestRender(),
			showOverlay: (component, overlayOptions) => piOverlays.show(component, overlayOptions),
			hideTopOverlay: () => piOverlays.hideTop(),
			hasOverlay: () => piOverlays.hasVisible(),
			onFocusRequest: (component) => this.handleFocusRequest(component),
			onInvalidate: () => renderer.requestRender(),
		});
		this.tui.onDebug = () => this.handleDebugKey();
		this.tui.start();
		inputRouter.attach();
		inputRouter.add((data) => {
			const result = this.tui.dispatchInput(data);
			if (result.consumed) return { consume: true };
			return result.data === data ? undefined : { data: result.data };
		});
		renderer.keyInput.on("keypress", this.keyHandler);
		renderer.on(CliRenderEvents.RESIZE, () => this.tui.virtualTerminal.notifyResize());
		shell.root.onMouseDown = (event) => {
			if (event.button === MouseButton.RIGHT) void this.handleRightClickPaste();
		};
		viewport.setScrollbar(this.settingsManager.getFullscreenScrollbar());
		this.renderWidgets();

		// Accept text while startup completes, but only enable interrupt, exit, and submission feedback.
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onSubmit = (text) => this.handleStartupSubmit(text);
		this.focusEditorSlot();

		await this.themeController.applyFromSettings();
		this.renderHeader();
		await this.runStartupFlows("init");
		this.requestRender();

		const [fdPath] = await Promise.all([
			ensureTool("fd", (status) => this.showManagedToolStatus(status)),
			ensureTool("rg", (status) => this.showManagedToolStatus(status)),
		]);
		this.fdPath = fdPath;
		this.setupKeyHandlers();
		this.setupEditorSubmitHandler();

		await this.rebindCurrentSession();
		this.renderInitialMessages();
		onThemeChange(() => this.applyThemeChange());
		this.footerDataProvider.onBranchChange(() => this.requestRender());
		this.updateAvailableProviderCount();
		await this.runStartupFlows("ready");
		this.requestRender();
		void loadAllHighlightLanguages().then(() => {
			if (this.stopped) return;
			this.tui.invalidate();
			this.requestRender();
		});
	}

	async run(): Promise<void> {
		await this.init();
		await this.runStartupFlows("run");
		const { initialMessage, initialImages, initialMessages } = this.options;
		if (initialMessage) await this.promptSafely(initialMessage, initialImages);
		for (const message of initialMessages ?? []) await this.promptSafely(message);
		while (!this.stopped) {
			const input = await this.getUserInput();
			if (this.stopped) return;
			await this.promptSafely(input);
		}
	}

	/**
	 * Stop the UI. With the `fullscreenExitOutput` setting at `"transcript"` (default), the rendered
	 * transcript is printed to the normal screen after the renderer restores the terminal.
	 */
	stop(fullscreenExitOutput = this.settingsManager.getFullscreenExitOutput()): void {
		if (this.stopped) return;
		this.stopped = true;
		this.setTerminalProgress(false);
		this.clearStatusIndicator();
		this.themeController.disableAutoSync();
		this.clearExtensionTerminalInputListeners();
		this.footer.dispose();
		this.footerDataProvider.dispose();
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		// Release `run()`: it returns once it sees `stopped`.
		const waiter = this.onInputCallback;
		this.onInputCallback = undefined;
		waiter?.("");
		const ui = this.ui;
		const exitLines = ui && fullscreenExitOutput === "transcript" ? ui.transcript.renderedLines() : [];
		if (ui) {
			ui.renderer.keyInput.off("keypress", this.keyHandler);
			ui.inputRouter.detach();
			ui.viewport.dispose();
			ui.overlays.dispose();
		}
		this.themeController.dispose();
		this.tui.stop();
		this.rendererHost.destroy();
		this.unregisterSignalHandlers();
		if (exitLines.length > 0) process.stdout.write(`${exitLines.join("\n")}\n`);
	}

	async shutdown(options?: { fromSignal?: boolean }): Promise<void> {
		if (this.isShuttingDown) return;
		this.isShuttingDown = true;
		if (options?.fromSignal) {
			// Emit extension cleanup (session_shutdown) before touching the terminal.
			await this.runtimeHost.dispose();
			this.themeController.disableAutoSync();
			this.stop();
			process.exit(0);
		}
		this.themeController.disableAutoSync();
		this.stop();
		await this.runtimeHost.dispose();
		stopThemeWatcher();
		const resumeCommand = formatResumeCommand(this.sessionManager);
		if (resumeCommand) process.stdout.write(`${theme.fg("dim", "To resume this session:")} ${resumeCommand}\n`);
		process.exit(0);
	}

	async handleFatalRuntimeError(prefix: string, error: unknown): Promise<never> {
		this.showError(`${prefix}: ${errorText(error)}`);
		const extensionHint = this.getCrashExtensionHint(error);
		if (extensionHint && this.ui) {
			this.transcript.chat.addChild(new Text(theme.fg("warning", extensionHint), this.outputPad, 0));
		}
		if (this.recordCrash("fatal_error", error) && this.ui) {
			this.transcript.chat.addChild(new Text(theme.fg("muted", this.crashReportInstructions()), this.outputPad, 0));
		}
		stopThemeWatcher();
		this.stop("transcript");
		process.exit(1);
	}

	private getCrashExtensionHint(error: unknown): string | undefined {
		try {
			return formatCrashExtensionHint(
				findExtensionStackMatches(
					error instanceof Error ? error.stack : undefined,
					this.session.resourceLoader.getExtensions().extensions,
				),
			);
		} catch {
			return undefined;
		}
	}

	/** Persist a crash for inspection on the next start. Returns false when nothing was written. */
	private recordCrash(kind: "uncaught_exception" | "fatal_error", error: unknown): boolean {
		try {
			return (
				recordCrash({ kind, error, sessionFile: this.session.sessionFile, cwd: this.sessionManager.getCwd() }) !==
				undefined
			);
		} catch {
			return false;
		}
	}

	private crashReportInstructions(): string {
		const resume = this.session.sessionFile ? `run \`${APP_NAME} -r\` to resume the session.` : "restart nek.";
		return `A crash occurred: ${resume}`;
	}

	private registerSignalHandlers(): void {
		this.unregisterSignalHandlers();
		const signals: NodeJS.Signals[] = ["SIGTERM"];
		if (process.platform !== "win32") signals.push("SIGHUP");
		for (const signal of signals) {
			const handler = () => {
				killTrackedDetachedChildren();
				void this.shutdown({ fromSignal: true });
			};
			process.prependListener(signal, handler);
			this.signalCleanupHandlers.push(() => process.off(signal, handler));
		}
		const terminalErrorHandler = (error: Error) => {
			if (isDeadTerminalError(error)) this.emergencyTerminalExit();
			throw error;
		};
		process.stdout.on("error", terminalErrorHandler);
		process.stderr.on("error", terminalErrorHandler);
		this.signalCleanupHandlers.push(() => process.stdout.off("error", terminalErrorHandler));
		this.signalCleanupHandlers.push(() => process.stderr.off("error", terminalErrorHandler));
		const uncaughtExceptionHandler = (error: Error) => this.uncaughtCrash(error);
		process.prependListener("uncaughtException", uncaughtExceptionHandler);
		this.signalCleanupHandlers.push(() => process.off("uncaughtException", uncaughtExceptionHandler));
	}

	private unregisterSignalHandlers(): void {
		for (const cleanup of this.signalCleanupHandlers) cleanup();
		this.signalCleanupHandlers = [];
	}

	private emergencyTerminalExit(): never {
		this.isShuttingDown = true;
		this.unregisterSignalHandlers();
		killTrackedDetachedChildren();
		process.exit(129);
	}

	/** Restore the terminal before the process dies on an uncaught throw. */
	private uncaughtCrash(error: Error): never {
		if (this.isShuttingDown) process.exit(1);
		this.isShuttingDown = true;
		try {
			this.unregisterSignalHandlers();
		} catch {}
		try {
			killTrackedDetachedChildren();
		} catch {}
		try {
			this.rendererHost.destroy();
		} catch {}
		console.error(`${APP_NAME} exiting due to uncaughtException:`);
		console.error(error);
		const extensionHint = this.getCrashExtensionHint(error);
		if (extensionHint) console.error(`\n${extensionHint}`);
		if (this.recordCrash("uncaught_exception", error)) console.error(`\n${this.crashReportInstructions()}`);
		process.exit(1);
	}

	private async checkShutdownRequested(): Promise<void> {
		if (this.shutdownRequested) await this.shutdown();
	}

	private async runStartupFlows(phase: ModeStartupPhase): Promise<void> {
		for (const flow of MODE_STARTUP_FLOWS) {
			if (flow.phase !== phase) continue;
			try {
				await flow.run(this, this.options);
			} catch (error) {
				this.showError(`Startup step "${flow.id}" failed: ${errorText(error)}`);
			}
		}
	}

	// --- Session binding -------------------------------------------------------------------------

	private async rebindCurrentSession(options: { renderBeforeBind?: boolean } = {}): Promise<void> {
		const session = this.session;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.applySettings();
		if (options.renderBeforeBind) {
			this.renderCurrentSessionState();
			this.subscribeToAgent();
		}
		await this.bindCurrentSessionExtensions();
		if (this.session !== session) return;
		if (!options.renderBeforeBind) this.subscribeToAgent();
		this.updateAvailableProviderCount();
		this.updateEditorBorderColor();
		this.updateTerminalTitle();
	}

	private async bindCurrentSessionExtensions(): Promise<void> {
		await this.session.bindExtensions({
			uiContext: this.createExtensionUIContext(),
			mode: "tui",
			abortHandler: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			commandContextActions: {
				waitForIdle: () => this.session.waitForIdle(),
				newSession: async (sessionOptions) => {
					this.clearStatusIndicator();
					try {
						return await this.runtimeHost.newSession(sessionOptions);
					} catch (error) {
						return this.handleFatalRuntimeError("Failed to create session", error);
					}
				},
				fork: async (entryId, forkOptions) => {
					try {
						const result = await this.runtimeHost.fork(entryId, forkOptions);
						if (!result.cancelled) {
							this.currentEditor.setText(result.selectedText ?? "");
							this.showStatus("Forked to new session");
						}
						return { cancelled: result.cancelled };
					} catch (error) {
						return this.handleFatalRuntimeError("Failed to fork session", error);
					}
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await this.session.navigateTree(targetId, {
						summarize: navigateOptions?.summarize,
						customInstructions: navigateOptions?.customInstructions,
						replaceInstructions: navigateOptions?.replaceInstructions,
						label: navigateOptions?.label,
					});
					if (result.cancelled) return { cancelled: true };
					this.transcript.clear();
					this.renderInitialMessages();
					if (result.editorText && !this.currentEditor.getText().trim()) {
						this.currentEditor.setText(result.editorText);
					}
					this.showStatus("Navigated to selected point");
					void this.flushCompactionQueue({ willRetry: false });
					return { cancelled: false };
				},
				switchSession: async (sessionPath, switchOptions) => {
					try {
						return await this.runtimeHost.switchSession(sessionPath, {
							...switchOptions,
							projectTrustContextFactory: (cwd) => this.createProjectTrustContext(cwd),
						});
					} catch (error) {
						return this.handleFatalRuntimeError("Failed to switch session", error);
					}
				},
				reload: () => this.reload(),
			},
			shutdownHandler: () => {
				this.shutdownRequested = true;
				if (this.session.isIdle) void this.shutdown();
			},
			onError: (error) => this.showExtensionError(error.extensionPath, error.error, error.stack),
		});
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		this.setupAutocompleteProvider();
		this.setupExtensionShortcuts(this.session.extensionRunner);
		this.showLoadedResources();
	}

	private subscribeToAgent(): void {
		this.unsubscribe = this.session.subscribe((event) => {
			this.handleEvent(event).catch((error: unknown) => this.showError(errorText(error)));
		});
	}

	private renderCurrentSessionState(): void {
		this.transcript.resourcesContainer.clear();
		this.transcript.clear();
		this.pendingMessagesContainer.clear();
		this.compactionQueuedMessages = [];
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.pendingTools.clear();
		this.renderInitialMessages();
	}

	// --- Header and loaded resources -------------------------------------------------------------

	private getStartupExpansionState(): boolean {
		return (this.options.verbose ?? false) || this.toolOutputExpanded;
	}

	private renderHeader(): void {
		const header = this.transcript.headerContainer;
		header.clear();
		const showStartup = this.options.verbose || !this.settingsManager.getQuietStartup();
		if (this.session.scopedModels.length > 0 && showStartup) {
			const modelList = this.session.scopedModels
				.map((scoped) => `${scoped.model.id}${scoped.thinkingLevel ? `:${scoped.thinkingLevel}` : ""}`)
				.join(", ");
			const cycleKeys = this.keybindings.getKeys("app.model.cycleForward");
			const cycleHint =
				cycleKeys.length > 0
					? theme.fg("muted", ` (${formatKeyText(cycleKeys.join("/"), { capitalize: true })} to cycle)`)
					: "";
			header.addChild(new Text(theme.fg("dim", `Model scope: ${modelList}${cycleHint}`), 1, 0));
		}
		if (!showStartup) {
			this.builtInHeader = new Text("", 0, 0);
			header.addChild(this.builtInHeader);
			return;
		}
		const logo = theme.bold(theme.fg("accent", APP_NAME)) + theme.fg("dim", ` v${NEK_VERSION}`);
		const hint = (keybinding: AppKeybinding, description: string) => keyHint(keybinding, description);
		const expandedInstructions = [
			hint("app.interrupt", "to interrupt"),
			hint("app.clear", "to clear"),
			rawKeyHint(`${keyText("app.clear")} twice`, "to exit"),
			hint("app.exit", "to exit (empty)"),
			hint("app.suspend", "to suspend"),
			keyHint("tui.editor.deleteToLineEnd", "to delete to end"),
			hint("app.thinking.cycle", "to cycle thinking level"),
			rawKeyHint(`${keyText("app.model.cycleForward")}/${keyText("app.model.cycleBackward")}`, "to cycle models"),
			hint("app.model.select", "to select model"),
			hint("app.tools.expand", "to expand tools"),
			hint("app.thinking.toggle", "to expand thinking"),
			hint("app.editor.external", "for external editor"),
			rawKeyHint("/", "for commands"),
			rawKeyHint("!", "to run bash"),
			rawKeyHint("!!", "to run bash (no context)"),
			hint("app.message.followUp", "to queue follow-up"),
			hint("app.message.dequeue", "to edit all queued messages"),
			hint("app.clipboard.pasteImage", "to paste image (with text fallback)"),
			rawKeyHint("drop files", "to attach"),
		].join("\n");
		const compactInstructions = [
			hint("app.interrupt", "interrupt"),
			rawKeyHint(`${keyText("app.clear")}/${keyText("app.exit")}`, "clear/exit"),
			rawKeyHint("/", "commands"),
			rawKeyHint("!", "bash"),
			hint("app.tools.expand", "more"),
		].join(theme.fg("muted", " · "));
		const compactOnboarding = theme.fg(
			"dim",
			`Press ${keyText("app.tools.expand")} to show full startup help and loaded resources.`,
		);
		const onboarding = theme.fg(
			"dim",
			"nekcode can explain its own features and look up its docs. Ask it how to use or extend nekcode.",
		);
		this.builtInHeader = new ExpandableText(
			() => `${logo}\n${compactInstructions}\n${compactOnboarding}\n\n${onboarding}`,
			() => `${logo}\n${expandedInstructions}\n\n${onboarding}`,
			this.getStartupExpansionState(),
			1,
			0,
		);
		header.addChild(new Spacer(1));
		header.addChild(this.customHeader ?? this.builtInHeader);
		header.addChild(new Spacer(1));
	}

	private getBuiltInCommandConflictDiagnostics(extensionRunner: ExtensionRunner): ResourceDiagnostic[] {
		const builtinNames = new Set(BUILTIN_SLASH_COMMANDS.map((command) => command.name));
		return extensionRunner
			.getRegisteredCommands()
			.filter((command) => builtinNames.has(command.name))
			.map((command) => ({
				type: "warning" as const,
				message:
					command.invocationName === command.name
						? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
						: `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
				path: command.sourceInfo.path,
			}));
	}

	private showLoadedResources(): void {
		const showListing = (this.options.verbose ?? false) || !this.settingsManager.getQuietStartup();
		renderLoadedResources(this.transcript.resourcesContainer, {
			session: this.session,
			showListing,
			showDiagnostics: true,
			expanded: this.getStartupExpansionState(),
			extraExtensionDiagnostics: this.getBuiltInCommandConflictDiagnostics(this.session.extensionRunner),
		});
		this.requestRender();
	}

	private showManagedToolStatus(status: ToolStatus): void {
		if (!this.managedToolStatusStarted) {
			this.transcript.chat.addChild(new Spacer(1));
			this.managedToolStatusStarted = true;
		}
		const message = status.type === "warning" ? `Warning: ${status.message}` : status.message;
		const color = status.type === "warning" ? "warning" : "dim";
		this.transcript.chat.addChild(new Text(theme.fg(color, message), 1, 0));
		this.transcript.resetStatusLine();
		this.requestRender();
	}

	private showExtensionError(extensionPath: string, error: string, stack?: string): void {
		const chat = this.transcript.chat;
		chat.addChild(new Text(theme.fg("error", `Extension "${extensionPath}" error: ${error}`), 1, 0));
		if (stack) {
			const stackLines = stack
				.split("\n")
				.slice(1)
				.map((line) => theme.fg("dim", `  ${line.trim()}`))
				.join("\n");
			if (stackLines) chat.addChild(new Text(stackLines, 1, 0));
		}
		this.requestRender();
	}

	// --- Autocomplete and shortcuts ----------------------------------------------------------------

	private getAutocompleteSourceTag(sourceInfo?: SourceInfo): string | undefined {
		if (!sourceInfo) return undefined;
		const scopePrefix = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
		const source = sourceInfo.source.trim();
		if (source === "auto" || source === "local" || source === "cli") return scopePrefix;
		if (source.startsWith("npm:")) return `${scopePrefix}:${source}`;
		const gitSource = parseGitUrl(source);
		if (gitSource) {
			const ref = gitSource.ref ? `@${gitSource.ref}` : "";
			return `${scopePrefix}:git:${gitSource.host}/${gitSource.path}${ref}`;
		}
		return scopePrefix;
	}

	private prefixAutocompleteDescription(description: string | undefined, sourceInfo?: SourceInfo): string | undefined {
		const sourceTag = this.getAutocompleteSourceTag(sourceInfo);
		if (!sourceTag) return description;
		return description ? `[${sourceTag}] ${description}` : `[${sourceTag}]`;
	}

	private createBaseAutocompleteProvider(): AutocompleteProvider {
		const slashCommands = builtinSlashCommands(this);
		const templateCommands: SlashCommand[] = this.session.promptTemplates.map((template) => ({
			name: template.name,
			description: this.prefixAutocompleteDescription(template.description, template.sourceInfo),
			...(template.argumentHint && { argumentHint: template.argumentHint }),
		}));
		const builtinNames = builtinCommandNames();
		const extensionCommands: SlashCommand[] = this.session.extensionRunner
			.getRegisteredCommands()
			.filter((command) => !builtinNames.has(command.name))
			.map((command) => ({
				name: command.invocationName,
				description: this.prefixAutocompleteDescription(command.description, command.sourceInfo),
				getArgumentCompletions: command.getArgumentCompletions,
			}));
		const skillCommands: SlashCommand[] = [];
		if (this.settingsManager.getEnableSkillCommands()) {
			for (const skill of this.session.resourceLoader.getSkills().skills) {
				skillCommands.push({
					name: `skill:${skill.name}`,
					description: this.prefixAutocompleteDescription(skill.description, skill.sourceInfo),
				});
			}
		}
		return new CombinedAutocompleteProvider(
			[...slashCommands, ...templateCommands, ...extensionCommands, ...skillCommands],
			this.sessionManager.getCwd(),
			this.fdPath,
		);
	}

	private setupAutocompleteProvider(): void {
		let provider = this.createBaseAutocompleteProvider();
		const triggerCharacters: string[] = [];
		for (const wrapProvider of this.autocompleteProviderWrappers) {
			provider = wrapProvider(provider);
			triggerCharacters.push(...(provider.triggerCharacters ?? []));
		}
		if (triggerCharacters.length > 0) provider.triggerCharacters = [...new Set(triggerCharacters)];
		this.autocompleteProvider = provider;
		this.defaultEditor.setAutocompleteProvider(provider);
		if (this.currentEditor !== this.defaultEditor) this.currentEditor.setAutocompleteProvider?.(provider);
	}

	private setupExtensionShortcuts(extensionRunner: ExtensionRunner): void {
		const shortcuts = extensionRunner.getShortcuts(this.keybindings.getEffectiveConfig());
		if (shortcuts.size === 0) {
			this.defaultEditor.onExtensionShortcut = undefined;
			return;
		}
		const createContext = (): ExtensionContext => ({
			ui: this.createExtensionUIContext(),
			mode: "tui",
			hasUI: true,
			cwd: this.sessionManager.getCwd(),
			sessionManager: this.sessionManager,
			modelRegistry: extensionRunner.getModelRegistry(),
			model: this.session.model,
			scopedModels: this.session.scopedModels,
			thinkingLevel: this.session.thinkingLevel,
			isIdle: () => this.session.isIdle,
			isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
			signal: this.session.agent.signal,
			abort: () => {
				this.restoreQueuedMessagesToEditor({ abort: true });
			},
			hasPendingMessages: () => this.session.pendingMessageCount > 0,
			shutdown: () => {
				this.shutdownRequested = true;
			},
			getContextUsage: () => this.session.getContextUsage(),
			compact: (compactOptions) => {
				void (async () => {
					try {
						const result = await this.session.compact(compactOptions?.customInstructions);
						compactOptions?.onComplete?.(result);
					} catch (error) {
						compactOptions?.onError?.(error instanceof Error ? error : new Error(String(error)));
					}
				})();
			},
			getSystemPrompt: () => this.session.systemPrompt,
		});
		this.defaultEditor.onExtensionShortcut = (data: string) => {
			for (const [shortcutKey, shortcut] of shortcuts) {
				if (!matchesKey(data, shortcutKey as KeyId)) continue;
				Promise.resolve(shortcut.handler(createContext())).catch((error: unknown) => {
					this.showError(`Shortcut handler error: ${errorText(error)}`);
				});
				return true;
			}
			return false;
		};
	}

	// --- Editor slot and focus ---------------------------------------------------------------------

	/** Show `component` in the editor slot (selectors, custom components, the reload box). */
	private setEditorSlot(component: Component, focus: Component = component): void {
		this.editorContainer.clear();
		this.editorContainer.addChild(component);
		this.editorSlotFocus = focus;
		this.tui.setFocus(focus);
		this.requestRender();
	}

	/** Put the active editor back into the editor slot. */
	private restoreEditorSlot(): void {
		this.setEditorSlot(this.currentEditor);
	}

	/** Give keyboard focus to the editor slot (unless a modal overlay holds it). */
	private focusEditorSlot(): void {
		const ui = this.ui;
		if (!ui || ui.overlays.hasModal()) return;
		ui.editorHost.focus();
		this.tui.syncFocus(this.editorSlotFocus);
	}

	/** `tui.setFocus(component)` from pi-tui code: focus the renderable that shows it. */
	private handleFocusRequest(component: Component | null): void {
		const ui = this.ui;
		if (!ui || component === null) return;
		const host = this.tui.hostFor(component);
		if (host && host !== ui.editorHost) {
			host.focus();
			return;
		}
		this.editorSlotFocus = component;
		if (!ui.overlays.hasModal()) ui.editorHost.focus();
	}

	private updateHardwareCursor(): void {
		const ui = this.ui;
		if (!ui) return;
		const cursor = ui.editorHost.cursor;
		const show = this.settingsManager.getShowHardwareCursor() && ui.editorHost.focused && cursor !== undefined;
		if (show && cursor) {
			ui.renderer.setCursorPosition(ui.editorHost.x + cursor.col + 1, ui.editorHost.y + cursor.row + 1, true);
			this.hardwareCursorShown = true;
		} else if (this.hardwareCursorShown) {
			ui.renderer.setCursorPosition(0, 0, false);
			this.hardwareCursorShown = false;
		}
	}

	// --- Keys ------------------------------------------------------------------------------------

	/**
	 * Transcript keys (scrolling, prompt jumps, search) before the focused renderable, like the
	 * alternate-screen TUI. Overlays see keys first (their listener is registered earlier); the
	 * search bar routes its keys to the viewport itself.
	 */
	private handleGlobalKey(key: KeyEvent): void {
		const ui = this.ui;
		if (!ui || key.defaultPrevented || ui.overlays.hasModal()) return;
		const consume = () => {
			key.preventDefault();
			key.stopPropagation();
		};
		if (ui.viewport.handleKey(key)) {
			consume();
			return;
		}
		if (ui.renderer.currentFocusedRenderable !== ui.editorHost) {
			// Focus drifted (a closed non-modal overlay, a destroyed renderable): keys belong to the editor.
			consume();
			this.focusEditorSlot();
			ui.editorHost.handleKeyPress(key);
		}
	}

	private setupKeyHandlers(): void {
		this.defaultEditor.onEscape = () => this.handleEscape();
		this.defaultEditor.onAction("app.clear", () => this.handleCtrlC());
		this.defaultEditor.onCtrlD = () => this.handleCtrlD();
		this.defaultEditor.onAction("app.suspend", () => this.handleCtrlZ());
		this.defaultEditor.onAction("app.tools.expand", () => this.toggleToolOutputExpansion());
		this.defaultEditor.onAction("app.thinking.toggle", () => this.toggleThinkingBlockVisibility());
		this.defaultEditor.onAction("app.editor.external", () => void this.handleOpenExternalEditor());
		this.defaultEditor.onAction("app.message.followUp", () => void this.handleFollowUp());
		this.defaultEditor.onAction("app.message.dequeue", () => this.handleDequeue());
		for (const action of builtinKeyActions()) {
			if (action.id === "app.message.copy") {
				this.defaultEditor.onAction(action.id, () => void this.handleCopyAction(action));
				continue;
			}
			this.defaultEditor.onAction(action.id, () => void runKeyAction(this, action));
		}
		this.defaultEditor.onChange = (text: string) => {
			const wasBashMode = this.isBashMode;
			this.isBashMode = text.trimStart().startsWith("!");
			if (wasBashMode !== this.isBashMode) this.updateEditorBorderColor();
		};
		this.defaultEditor.onPasteImage = () => {
			void this.handleClipboardPaste();
		};
	}

	/** `app.message.copy`: copy the mouse selection when copy-on-select is off, else the last reply. */
	private async handleCopyAction(action: ReturnType<typeof builtinKeyActions>[number]): Promise<void> {
		const viewport = this.ui?.viewport;
		if (viewport && !this.settingsManager.getFullscreenCopyOnSelect() && viewport.hasSelection()) {
			await viewport.copySelection();
			return;
		}
		await runKeyAction(this, action);
	}

	private handleEscape(): void {
		const handler = this.escapeHandlers[this.escapeHandlers.length - 1];
		if (handler) {
			handler();
			return;
		}
		if (this.session.isStreaming) {
			this.restoreQueuedMessagesToEditor({ abort: true });
		} else if (this.session.isBashRunning) {
			this.session.abortBash();
		} else if (this.isBashMode) {
			this.currentEditor.setText("");
			this.isBashMode = false;
			this.updateEditorBorderColor();
		} else if (!this.currentEditor.getText().trim()) {
			// Double escape with an empty editor opens /tree or /fork, per setting.
			const action = this.settingsManager.getDoubleEscapeAction();
			if (action === "none") return;
			const now = Date.now();
			if (now - this.lastEscapeTime < DOUBLE_PRESS_MS) {
				void this.runBuiltinCommand(action === "tree" ? "tree" : "fork");
				this.lastEscapeTime = 0;
			} else {
				this.lastEscapeTime = now;
			}
		}
	}

	private async runBuiltinCommand(name: string): Promise<void> {
		const command = getBuiltinCommand(name);
		if (!command) return;
		try {
			await command.run(this, { name, args: undefined, text: `/${name}` });
		} catch (error) {
			this.showError(`/${name} failed: ${errorText(error)}`);
		}
	}

	private handleCtrlC(): void {
		const now = Date.now();
		if (now - this.lastSigintTime < DOUBLE_PRESS_MS) {
			void this.shutdown();
			return;
		}
		this.currentEditor.setText("");
		this.requestRender();
		this.lastSigintTime = now;
	}

	private handleCtrlD(): void {
		// Only called when the editor is empty (enforced by CustomEditor).
		void this.shutdown();
	}

	private handleCtrlZ(): void {
		if (process.platform === "win32") {
			this.showStatus("Suspend to background is not supported on Windows");
			return;
		}
		const renderer = this.renderer;
		// Keep the event loop alive while suspended so the process survives until SIGCONT.
		const suspendKeepAlive = setInterval(() => {}, 2 ** 30);
		const ignoreSigint = () => {};
		process.on("SIGINT", ignoreSigint);
		process.once("SIGCONT", () => {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			renderer.resume();
			this.tui.invalidate();
			this.requestRender();
		});
		try {
			renderer.suspend();
			process.kill(0, "SIGTSTP");
		} catch (error) {
			clearInterval(suspendKeepAlive);
			process.removeListener("SIGINT", ignoreSigint);
			renderer.resume();
			throw error;
		}
	}

	private async handleRightClickPaste(): Promise<void> {
		const ui = this.ui;
		if (!ui) return;
		const target = ui.renderer.currentFocusedRenderable;
		if (!target) return;
		try {
			const text = await readClipboardText();
			if (!text || ui.renderer.currentFocusedRenderable !== target) return;
			if (target === ui.editorHost) {
				const dispatch = this.tui.dispatchInput(`\x1b[200~${text}\x1b[201~`);
				if (!dispatch.consumed) this.tui.feedInput(dispatch.data);
			} else if (target instanceof ComponentHostRenderable) {
				this.tui.feedInput(`\x1b[200~${text}\x1b[201~`);
			}
			this.requestRender();
		} catch {
			// Clipboard errors (no permission, no tool) are ignored, like the interactive mode.
		}
	}

	private async handleClipboardPaste(): Promise<void> {
		try {
			const image = await readClipboardImage();
			if (image) {
				const extension = extensionForImageMimeType(image.mimeType) ?? "png";
				const filePath = path.join(os.tmpdir(), `pi-clipboard-${crypto.randomUUID()}.${extension}`);
				fs.writeFileSync(filePath, Buffer.from(image.bytes));
				this.currentEditor.insertTextAtCursor?.(filePath);
				this.requestRender();
				return;
			}
			const text = await readClipboardText();
			if (text) {
				this.currentEditor.insertTextAtCursor?.(text);
				this.requestRender();
			}
		} catch {
			// Clipboard errors (no permission, no tool) are ignored, like the interactive mode.
		}
	}

	private async handleOpenExternalEditor(): Promise<void> {
		const command = this.settingsManager.getExternalEditorCommand();
		const content = this.currentEditor.getExpandedText?.() ?? this.currentEditor.getText();
		const result = await this.runExternal(() => editInExternalEditor({ command, content }));
		if (result.status === "complete") this.currentEditor.setText(result.content);
		this.requestRender();
	}

	private handleDebugKey(): void {
		const debugLogPath = this.writeDebugLog();
		this.transcript.chat.addChild(new Spacer(1));
		this.transcript.chat.addChild(
			new Text(`${theme.fg("accent", "✓ Debug log written")}\n${theme.fg("muted", debugLogPath)}`, 1, 1),
		);
		this.requestRender();
	}

	// --- Submission ------------------------------------------------------------------------------

	private handleStartupSubmit(text: string): void {
		this.currentEditor.setText(text);
		this.showStatus("Startup is still in progress");
	}

	private setupEditorSubmitHandler(): void {
		this.defaultEditor.onSubmit = async (submitted: string) => {
			const text = submitted.trim();
			if (!text) return;
			try {
				await this.submitText(text);
			} catch (error) {
				this.showError(errorText(error));
			}
		};
		if (this.currentEditor !== this.defaultEditor) this.currentEditor.onSubmit = this.defaultEditor.onSubmit;
	}

	private async submitText(text: string): Promise<void> {
		if (await dispatchBuiltinCommand(this, text)) return;
		// Bash command: `!` runs with context, `!!` excludes the output from context.
		if (text.startsWith("!")) {
			const isExcluded = text.startsWith("!!");
			const command = isExcluded ? text.slice(2).trim() : text.slice(1).trim();
			if (command) {
				if (this.session.isBashRunning) {
					this.showWarning("A bash command is already running. Press Esc to cancel it first.");
					this.currentEditor.setText(text);
					return;
				}
				this.currentEditor.addToHistory?.(text);
				await this.handleBashCommand(command, isExcluded);
				this.isBashMode = false;
				this.updateEditorBorderColor();
				return;
			}
		}
		// Queue input during compaction (extension commands run immediately).
		if (this.session.isCompacting) {
			if (this.isExtensionCommand(text)) {
				this.currentEditor.addToHistory?.(text);
				this.currentEditor.setText("");
				await this.session.prompt(text);
			} else {
				this.queueCompactionMessage(text, "steer");
			}
			return;
		}
		if (this.session.isStreaming) {
			this.currentEditor.addToHistory?.(text);
			this.currentEditor.setText("");
			await this.session.prompt(text, { streamingBehavior: "steer" });
			this.updatePendingMessagesDisplay();
			this.requestRender();
			return;
		}
		this.flushPendingBashComponents();
		const callback = this.onInputCallback;
		if (callback) callback(text);
		else this.pendingUserInputs.push(text);
		this.currentEditor.addToHistory?.(text);
	}

	private async handleFollowUp(): Promise<void> {
		const text = (this.currentEditor.getExpandedText?.() ?? this.currentEditor.getText()).trim();
		if (!text) return;
		if (this.session.isCompacting) {
			if (this.isExtensionCommand(text)) {
				this.currentEditor.addToHistory?.(text);
				this.currentEditor.setText("");
				await this.session.prompt(text);
			} else {
				this.queueCompactionMessage(text, "followUp");
			}
			return;
		}
		if (this.session.isStreaming) {
			this.currentEditor.addToHistory?.(text);
			this.currentEditor.setText("");
			await this.session.prompt(text, { streamingBehavior: "followUp" });
			this.updatePendingMessagesDisplay();
			this.requestRender();
		} else if (this.currentEditor.onSubmit) {
			this.currentEditor.setText("");
			this.currentEditor.onSubmit(text);
		}
	}

	private handleDequeue(): void {
		const restored = this.restoreQueuedMessagesToEditor();
		if (restored === 0) this.showStatus("No queued messages to restore");
		else this.showStatus(`Restored ${restored} queued message${restored > 1 ? "s" : ""} to editor`);
	}

	private getUserInput(): Promise<string> {
		const queued = this.pendingUserInputs.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		return new Promise((resolve) => {
			this.onInputCallback = (text: string) => {
				this.onInputCallback = undefined;
				resolve(text);
			};
		});
	}

	private async promptSafely(text: string, images?: InteractiveModeOptions["initialImages"]): Promise<void> {
		try {
			await this.session.prompt(text, images ? { images } : undefined);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : "Unknown error occurred");
		}
	}

	private async handleBashCommand(command: string, excludeFromContext = false): Promise<void> {
		let eventResult: UserBashEventResult | undefined;
		try {
			eventResult = await this.session.extensionRunner.emitUserBash({
				type: "user_bash",
				command,
				excludeFromContext,
				cwd: this.sessionManager.getCwd(),
			});
		} catch {
			// The extension runner already reported the error. Do not fall back to local execution.
			return;
		}
		const component = new BashExecutionComponent(command, this.tui, excludeFromContext);
		this.bashComponent = component;
		if (this.session.isStreaming) {
			this.pendingMessagesContainer.addChild(component);
			this.pendingBashComponents.push(component);
		} else {
			this.transcript.chat.addChild(component);
		}
		if (eventResult?.result) {
			const result = eventResult.result;
			if (result.output) component.appendOutput(result.output);
			component.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);
			this.session.recordBashResult(command, result, { excludeFromContext });
			this.bashComponent = undefined;
			this.requestRender();
			return;
		}
		this.requestRender();
		try {
			const result = await this.session.executeBash(
				command,
				(chunk) => {
					if (!this.bashComponent) return;
					this.bashComponent.appendOutput(chunk);
					this.requestRender();
				},
				{ excludeFromContext, operations: eventResult?.operations },
			);
			this.bashComponent?.setComplete(
				result.exitCode,
				result.cancelled,
				result.truncated ? ({ truncated: true, content: result.output } as TruncationResult) : undefined,
				result.fullOutputPath,
			);
		} catch (error) {
			this.bashComponent?.setComplete(undefined, false);
			this.showError(`Bash command failed: ${error instanceof Error ? error.message : "Unknown error"}`);
		}
		this.bashComponent = undefined;
		this.requestRender();
	}

	/** Move deferred bash output from the pending area into the chat. */
	private flushPendingBashComponents(): void {
		for (const component of this.pendingBashComponents) {
			this.pendingMessagesContainer.removeChild(component);
			this.transcript.chat.addChild(component);
		}
		this.pendingBashComponents = [];
	}

	// --- Queues ----------------------------------------------------------------------------------

	private getAllQueuedMessages(): { steering: string[]; followUp: string[] } {
		return {
			steering: [
				...this.session.getSteeringMessages(),
				...this.compactionQueuedMessages
					.filter((message) => message.mode === "steer")
					.map((message) => message.text),
			],
			followUp: [
				...this.session.getFollowUpMessages(),
				...this.compactionQueuedMessages
					.filter((message) => message.mode === "followUp")
					.map((message) => message.text),
			],
		};
	}

	private clearAllQueues(): { steering: string[]; followUp: string[] } {
		const { steering, followUp } = this.session.clearQueue();
		const compactionSteering = this.compactionQueuedMessages
			.filter((message) => message.mode === "steer")
			.map((message) => message.text);
		const compactionFollowUp = this.compactionQueuedMessages
			.filter((message) => message.mode === "followUp")
			.map((message) => message.text);
		this.compactionQueuedMessages = [];
		return { steering: [...steering, ...compactionSteering], followUp: [...followUp, ...compactionFollowUp] };
	}

	private updatePendingMessagesDisplay(): void {
		for (const child of [...this.pendingMessagesContainer.children]) {
			if (!(child instanceof BashExecutionComponent)) this.pendingMessagesContainer.removeChild(child);
		}
		const bashComponents = [...this.pendingMessagesContainer.children];
		this.pendingMessagesContainer.clear();
		const { steering, followUp } = this.getAllQueuedMessages();
		if (steering.length > 0 || followUp.length > 0) {
			this.pendingMessagesContainer.addChild(new Spacer(1));
			for (const message of steering) {
				this.pendingMessagesContainer.addChild(new TruncatedText(theme.fg("dim", `Steering: ${message}`), 1, 0));
			}
			for (const message of followUp) {
				this.pendingMessagesContainer.addChild(new TruncatedText(theme.fg("dim", `Follow-up: ${message}`), 1, 0));
			}
			const dequeueHint = keyDisplayText("app.message.dequeue");
			this.pendingMessagesContainer.addChild(
				new TruncatedText(theme.fg("dim", `↳ ${dequeueHint} to edit all queued messages`), 1, 0),
			);
		}
		for (const component of bashComponents) this.pendingMessagesContainer.addChild(component);
		this.requestRender();
	}

	restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp } = this.clearAllQueues();
		const allQueued = [...steering, ...followUp];
		if (allQueued.length > 0) {
			const currentText = options?.currentText ?? this.currentEditor.getText();
			this.currentEditor.setText([allQueued.join("\n\n"), currentText].filter((text) => text.trim()).join("\n\n"));
		}
		this.updatePendingMessagesDisplay();
		if (options?.abort) void this.session.abort();
		return allQueued.length;
	}

	private queueCompactionMessage(text: string, mode: "steer" | "followUp"): void {
		this.compactionQueuedMessages.push({ text, mode });
		this.currentEditor.addToHistory?.(text);
		this.currentEditor.setText("");
		this.updatePendingMessagesDisplay();
		this.showStatus("Queued message for after compaction");
	}

	private isExtensionCommand(text: string): boolean {
		if (!text.startsWith("/")) return false;
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		return !!this.session.extensionRunner.getCommand(commandName);
	}

	async flushCompactionQueue(options?: { willRetry?: boolean }): Promise<void> {
		if (this.compactionQueuedMessages.length === 0) return;
		const queuedMessages = [...this.compactionQueuedMessages];
		this.compactionQueuedMessages = [];
		this.updatePendingMessagesDisplay();
		const restoreQueue = (error: unknown) => {
			this.session.clearQueue();
			this.compactionQueuedMessages = queuedMessages;
			this.updatePendingMessagesDisplay();
			this.showError(`Failed to send queued message${queuedMessages.length > 1 ? "s" : ""}: ${errorText(error)}`);
		};
		const queueMessage = async (message: CompactionQueuedMessage) => {
			if (this.isExtensionCommand(message.text)) await this.session.prompt(message.text);
			else if (message.mode === "followUp") await this.session.followUp(message.text);
			else await this.session.steer(message.text);
		};
		try {
			if (options?.willRetry) {
				// A retry is pending: queue the messages for the retry turn.
				for (const message of queuedMessages) await queueMessage(message);
				this.updatePendingMessagesDisplay();
				return;
			}
			const firstPromptIndex = queuedMessages.findIndex((message) => !this.isExtensionCommand(message.text));
			if (firstPromptIndex === -1) {
				for (const message of queuedMessages) await this.session.prompt(message.text);
				return;
			}
			const firstPrompt = queuedMessages[firstPromptIndex];
			if (!firstPrompt) return;
			for (const message of queuedMessages.slice(0, firstPromptIndex)) await this.session.prompt(message.text);
			// Start a prompt when idle, or queue it into a run still finishing compaction.
			const promptPromise = this.session
				.prompt(firstPrompt.text, { streamingBehavior: firstPrompt.mode })
				.catch((error: unknown) => restoreQueue(error));
			for (const message of queuedMessages.slice(firstPromptIndex + 1)) await queueMessage(message);
			this.updatePendingMessagesDisplay();
			void promptPromise;
		} catch (error) {
			restoreQueue(error);
		}
	}

	// --- Session events --------------------------------------------------------------------------

	private async handleEvent(event: AgentSessionEvent): Promise<void> {
		if (!this.ui || this.stopped) return;
		this.footer.invalidate();
		const chat = this.transcript.chat;
		switch (event.type) {
			case "agent_start":
				this.pendingTools.clear();
				// The retry handler stays until `auto_retry_end`, but escape must abort the new run.
				this.releaseRetryEscape?.();
				this.releaseRetryEscape = undefined;
				break;
			case "turn_start":
				if (this.settingsManager.getShowTerminalProgress()) this.setTerminalProgress(true);
				if (this.workingVisible) {
					if (this.activeStatusIndicator?.kind !== "working") this.showWorkingStatusIndicator();
				} else {
					this.clearStatusIndicator();
				}
				break;
			case "queue_update":
				this.updatePendingMessagesDisplay();
				break;
			case "entry_appended":
				this.handleEntryAppended(event.entry);
				break;
			case "session_info_changed":
				this.updateTerminalTitle();
				break;
			case "thinking_level_changed":
				this.updateEditorBorderColor();
				break;
			case "message_start":
				if (event.message.role === "custom") {
					this.addMessageToChat(event.message);
				} else if (event.message.role === "user") {
					this.addMessageToChat(event.message);
					this.updatePendingMessagesDisplay();
				} else if (event.message.role === "assistant") {
					this.streamingComponent = this.createAssistantComponent(undefined);
					this.streamingMessage = event.message;
					chat.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(this.streamingMessage, true);
				}
				break;
			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingMessage = event.message;
					this.streamingComponent.updateContent(this.streamingMessage, true);
					for (const content of this.streamingMessage.content) {
						if (content.type !== "toolCall") continue;
						const existing = this.pendingTools.get(content.id);
						if (existing) {
							existing.updateArgs(content.arguments);
							continue;
						}
						const component = this.createToolComponent(content.name, content.id, content.arguments);
						chat.addChild(component);
						this.pendingTools.set(content.id, component);
					}
				}
				break;
			case "message_end":
				if (event.message.role === "user") break;
				if (this.streamingComponent && event.message.role === "assistant")
					this.finishStreamingMessage(event.message);
				break;
			case "bash_execution_update":
				// The bash execution callback renders the output.
				break;
			case "tool_execution_start": {
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = this.createToolComponent(event.toolName, event.toolCallId, event.args);
					chat.addChild(component);
					this.pendingTools.set(event.toolCallId, component);
				}
				component.markExecutionStarted();
				break;
			}
			case "tool_execution_update":
				this.pendingTools.get(event.toolCallId)?.updateResult({ ...event.partialResult, isError: false }, true);
				break;
			case "tool_execution_end": {
				const component = this.pendingTools.get(event.toolCallId);
				if (component) {
					component.updateResult({ ...event.result, isError: event.isError });
					this.pendingTools.delete(event.toolCallId);
				}
				break;
			}
			case "agent_end":
				if (this.settingsManager.getShowTerminalProgress()) this.setTerminalProgress(false);
				this.clearStatusIndicator("working");
				if (this.streamingComponent) {
					chat.removeChild(this.streamingComponent);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.pendingTools.clear();
				break;
			case "agent_settled":
				await this.checkShutdownRequested();
				break;
			case "compaction_start":
				if (this.settingsManager.getShowTerminalProgress()) this.setTerminalProgress(true);
				// Keep the editor active; submissions are queued during compaction.
				this.releaseCompactionEscape?.();
				this.releaseCompactionEscape = this.pushEscapeHandler(() => this.session.abortCompaction());
				this.setStatusIndicator(new CompactionStatusIndicator(this.tui, event.reason));
				break;
			case "compaction_end":
				this.handleCompactionEnd(event);
				break;
			case "auto_retry_start":
				this.releaseRetryEscape?.();
				this.releaseRetryEscape = this.pushEscapeHandler(() => this.session.abortRetry());
				this.setStatusIndicator(
					new RetryStatusIndicator(this.tui, event.attempt, event.maxAttempts, event.delayMs),
				);
				break;
			case "auto_retry_end":
				this.releaseRetryEscape?.();
				this.releaseRetryEscape = undefined;
				this.clearStatusIndicator("retry");
				if (!event.success) {
					this.showError(`Retry failed after ${event.attempt} attempts: ${event.finalError || "Unknown error"}`);
				}
				break;
			case "summarization_retry_scheduled":
				this.showError(event.errorMessage);
				this.setStatusIndicator(
					new RetryStatusIndicator(this.tui, event.attempt, event.maxAttempts, event.delayMs),
				);
				break;
			case "summarization_retry_attempt_start":
				this.clearStatusIndicator("retry");
				if (event.source === "branchSummary") this.setStatusIndicator(new BranchSummaryStatusIndicator(this.tui));
				else this.setStatusIndicator(new CompactionStatusIndicator(this.tui, event.reason));
				break;
			case "summarization_retry_finished":
				this.clearStatusIndicator("retry");
				break;
			default:
				break;
		}
		this.requestRender();
	}

	private handleEntryAppended(entry: SessionEntry): void {
		if (this.entriesRenderedByBoundaryCompaction.delete(entry.id)) return;
		if (entry.type === "custom") {
			this.addCustomEntryToChat(entry);
		} else if (entry.type === "usage" && entry.kind === "cache_warm") {
			this.addCacheWarmingUsage(entry);
		} else if (entry.type === "custom_message" && entry.display) {
			this.addMessageToChat(
				createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp),
			);
		} else if (entry.type === "compaction") {
			const entries = this.sessionManager.buildContextEntries();
			if (entries[0]?.id !== entry.id) return;
			this.transcript.clear();
			const branch = this.sessionManager.getBranch();
			const compactionIndex = branch.findIndex((candidate) => candidate.id === entry.id);
			const entriesAfterCompaction = new Set(branch.slice(compactionIndex + 1).map((candidate) => candidate.id));
			const retainedEntries = entries.slice(1);
			this.renderSessionEntries(retainedEntries.filter((candidate) => !entriesAfterCompaction.has(candidate.id)));
			this.addMessageToChat(createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp));
			if (entry.usage)
				this.addCompactionCostNotice({ type: "compaction_cost", kind: "compaction", usage: entry.usage });
			this.renderSessionEntries(retainedEntries.filter((candidate) => entriesAfterCompaction.has(candidate.id)));
			for (const entryId of entriesAfterCompaction) this.entriesRenderedByBoundaryCompaction.add(entryId);
		}
	}

	private handleCompactionEnd(event: Extract<AgentSessionEvent, { type: "compaction_end" }>): void {
		if (this.settingsManager.getShowTerminalProgress()) this.setTerminalProgress(false);
		this.releaseCompactionEscape?.();
		this.releaseCompactionEscape = undefined;
		this.clearStatusIndicator("compaction");
		if (event.aborted) {
			if (event.reason === "manual") this.showError("Compaction cancelled");
			else this.showStatus("Auto-compaction cancelled");
		} else if (event.result) {
			const entries = this.sessionManager.buildContextEntries();
			if (entries[0]?.type !== "compaction")
				throw new Error("Completed compaction is missing from the session context");
			this.transcript.clear();
			// The latest compaction is prepended for model context; show it at its chronological position.
			this.renderSessionEntries(entries.slice(1));
			this.addMessageToChat(
				createCompactionSummaryMessage(event.result.summary, event.result.tokensBefore, new Date().toISOString()),
			);
			if (event.result.usage) {
				this.addCompactionCostNotice({ type: "compaction_cost", kind: "compaction", usage: event.result.usage });
			}
		} else if (event.errorMessage) {
			if (event.reason === "manual") {
				this.showError(event.errorMessage);
			} else {
				this.transcript.chat.addChild(new Spacer(1));
				this.transcript.chat.addChild(new Text(theme.fg("error", event.errorMessage), 1, 0));
			}
		}
		void this.flushCompactionQueue({ willRetry: event.willRetry });
	}

	private finishStreamingMessage(message: AssistantMessage): void {
		const component = this.streamingComponent;
		if (!component) return;
		this.streamingMessage = message;
		let errorMessage: string | undefined;
		if (message.stopReason === "aborted") {
			const retryAttempt = this.session.retryAttempt;
			errorMessage =
				retryAttempt > 0
					? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
					: "Operation aborted";
			message.errorMessage = errorMessage;
		}
		component.updateContent(message, false);
		if (message.stopReason === "aborted" || message.stopReason === "error") {
			const text = errorMessage ?? (message.errorMessage || "Error");
			for (const tool of this.pendingTools.values()) {
				tool.updateResult({ content: [{ type: "text", text }], isError: true });
			}
			this.pendingTools.clear();
		} else {
			// Args are complete: edit tools compute their diffs now.
			for (const tool of this.pendingTools.values()) tool.setArgsComplete();
			this.maybeShowThinkingDropNotice(message);
			this.maybeShowCacheMissNotice(message);
		}
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
	}

	// --- Message rendering -----------------------------------------------------------------------

	private getMarkdownThemeWithSettings(): MarkdownTheme {
		return { ...getMarkdownTheme(), codeBlockIndent: this.settingsManager.getCodeBlockIndent() };
	}

	private getMarkdownTransformers(): MarkdownTransformer[] {
		return [this.mermaidMarkdownTransformer, ...this.session.extensionRunner.getMarkdownTransformers()];
	}

	private createAssistantComponent(message: AssistantMessage | undefined): AssistantMessageComponent {
		return new AssistantMessageComponent(
			message,
			this.hideThinkingBlock,
			this.getMarkdownThemeWithSettings(),
			this.hiddenThinkingLabel,
			this.outputPad,
			this.getMarkdownTransformers(),
		);
	}

	private createToolComponent(toolName: string, toolCallId: string, args: unknown): ToolExecutionComponent {
		const component = new ToolExecutionComponent(
			toolName,
			toolCallId,
			args,
			{
				showImages: this.settingsManager.getShowImages(),
				imageWidthCells: this.settingsManager.getImageWidthCells(),
			},
			withBuiltInRenderers(toolName, this.session.getToolDefinition(toolName)),
			this.tui,
			this.sessionManager.getCwd(),
		);
		component.setExpanded(this.toolOutputExpanded);
		return component;
	}

	private getUserMessageText(message: Message): string {
		if (message.role !== "user") return "";
		if (typeof message.content === "string") return message.content;
		return message.content
			.filter((content): content is Extract<typeof content, { type: "text" }> => content.type === "text")
			.map((content) => content.text)
			.join("");
	}

	private addCustomEntryToChat(entry: Extract<SessionEntry, { type: "custom" }>): void {
		const renderer = this.session.extensionRunner.getEntryRenderer(entry.customType);
		if (!renderer) return;
		const component = new CustomEntryComponent(entry, renderer);
		component.setExpanded(this.toolOutputExpanded);
		if (!component.hasContent()) return;
		const chat = this.transcript.chat;
		if (this.streamingComponent && chat.indexOf(this.streamingComponent) >= 0) {
			chat.insertBefore(component, this.streamingComponent);
			return;
		}
		chat.addChild(component);
	}

	private addMessageToChat(message: AgentMessage, options?: { populateHistory?: boolean }): void {
		const chat = this.transcript.chat;
		switch (message.role) {
			case "bashExecution": {
				const component = new BashExecutionComponent(message.command, this.tui, message.excludeFromContext);
				if (message.output) component.appendOutput(message.output);
				component.setComplete(
					message.exitCode,
					message.cancelled,
					message.truncated ? ({ truncated: true } as TruncationResult) : undefined,
					message.fullOutputPath,
				);
				chat.addChild(component);
				break;
			}
			case "custom": {
				if (!message.display) break;
				const renderer = this.session.extensionRunner.getMessageRenderer(message.customType);
				const component = new CustomMessageComponent(
					message,
					renderer,
					this.getMarkdownThemeWithSettings(),
					this.outputPad,
				);
				component.setExpanded(this.toolOutputExpanded);
				chat.addChild(component);
				break;
			}
			case "compactionSummary": {
				chat.addChild(new Spacer(1));
				const component = new CompactionSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				chat.addChild(component);
				break;
			}
			case "branchSummary": {
				chat.addChild(new Spacer(1));
				const component = new BranchSummaryMessageComponent(message, this.getMarkdownThemeWithSettings());
				component.setExpanded(this.toolOutputExpanded);
				chat.addChild(component);
				break;
			}
			case "system":
			case "toolResult":
				// Tool results render inline with their tool calls.
				break;
			case "user": {
				const textContent = this.getUserMessageText(message);
				if (!textContent) break;
				if (chat.length > 0) chat.addChild(new Spacer(1));
				const skillBlock = parseSkillBlock(textContent);
				if (skillBlock) {
					const component = new SkillInvocationMessageComponent(skillBlock, this.getMarkdownThemeWithSettings());
					component.setExpanded(this.toolOutputExpanded);
					chat.addChild(component);
					if (skillBlock.userMessage) {
						chat.addChild(new Spacer(1));
						chat.addChild(
							new UserMessageComponent(
								skillBlock.userMessage,
								this.getMarkdownThemeWithSettings(),
								this.outputPad,
								this.getMarkdownTransformers(),
							),
						);
					}
				} else {
					chat.addChild(
						new UserMessageComponent(
							textContent,
							this.getMarkdownThemeWithSettings(),
							this.outputPad,
							this.getMarkdownTransformers(),
						),
					);
				}
				if (options?.populateHistory) this.currentEditor.addToHistory?.(textContent);
				break;
			}
			case "assistant":
				chat.addChild(this.createAssistantComponent(message));
				break;
			default: {
				const exhaustive: never = message;
				void exhaustive;
			}
		}
	}

	private renderSessionItems(
		items: readonly RenderSessionItem[],
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		this.pendingTools.clear();
		const renderedPendingTools = new Map<string, ToolExecutionComponent>();
		// Cache misses are not persisted; re-derive them after the assistant messages that paid for them.
		const cacheMisses = this.settingsManager.getShowCacheMissNotices()
			? collectCacheMisses(this.sessionManager.getEntries(), this.session.modelRuntime)
			: new Map<AssistantMessage, CacheMiss>();
		if (options.updateFooter) {
			this.footer.invalidate();
			this.updateEditorBorderColor();
		}
		const chat = this.transcript.chat;
		for (const item of items) {
			if (isCustomSessionEntry(item)) {
				this.addCustomEntryToChat(item);
				continue;
			}
			if (isUsageSessionEntry(item)) {
				this.addCacheWarmingUsage(item);
				continue;
			}
			if (isCompactionCostNotice(item)) {
				this.addCompactionCostNotice(item);
				continue;
			}
			const message = item;
			if (message.role === "assistant") {
				this.addMessageToChat(message);
				for (const content of message.content) {
					if (content.type !== "toolCall") continue;
					const component = this.createToolComponent(content.name, content.id, content.arguments);
					chat.addChild(component);
					if (message.stopReason === "aborted" || message.stopReason === "error") {
						let text: string;
						if (message.stopReason === "aborted") {
							const retryAttempt = this.session.retryAttempt;
							text =
								retryAttempt > 0
									? `Aborted after ${retryAttempt} retry attempt${retryAttempt > 1 ? "s" : ""}`
									: "Operation aborted";
						} else {
							text = message.errorMessage || "Error";
						}
						component.updateResult({ content: [{ type: "text", text }], isError: true });
					} else {
						renderedPendingTools.set(content.id, component);
					}
				}
				if (message.stopReason !== "aborted" && message.stopReason !== "error") {
					const miss = cacheMisses.get(message);
					if (miss) this.addCacheMissNotice(miss);
				}
			} else if (message.role === "toolResult") {
				const component = renderedPendingTools.get(message.toolCallId);
				if (component) {
					component.updateResult(message);
					renderedPendingTools.delete(message.toolCallId);
				}
			} else {
				this.addMessageToChat(message, options);
			}
		}
		for (const [toolCallId, component] of renderedPendingTools) this.pendingTools.set(toolCallId, component);
		this.requestRender();
	}

	private renderSessionEntries(
		entries: SessionEntry[],
		options: { updateFooter?: boolean; populateHistory?: boolean } = {},
	): void {
		const items = entries.flatMap((entry): RenderSessionItem[] => {
			if (entry.type === "custom" || (entry.type === "usage" && entry.kind === "cache_warm")) return [entry];
			const messages = sessionEntryToContextMessages(entry);
			if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usage && messages.length > 0) {
				return [...messages, { type: "compaction_cost", kind: entry.type, usage: entry.usage }];
			}
			return messages;
		});
		this.renderSessionItems(items, options);
	}

	private addCacheWarmingUsage(entry: UsageEntry): void {
		if (!this.settingsManager.getShowCacheMissNotices()) return;
		this.transcript.chat.addChild(new Spacer(1));
		this.transcript.chat.addChild(new Text(theme.fg("dim", formatCacheWarmingUsage(entry)), 1, 0));
	}

	/** Billing usage of a compaction or branch summary (derived from the persisted summary usage). */
	private addCompactionCostNotice(notice: CompactionCostNotice): void {
		if (!this.settingsManager.getShowCacheMissNotices()) return;
		const { usage } = notice;
		const tokens = usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
		const cost = usage.cost.total >= 0.01 ? ` (~$${usage.cost.total.toFixed(2)})` : "";
		const label = notice.kind === "compaction" ? "Compaction" : "Branch summary";
		this.transcript.chat.addChild(new Spacer(1));
		this.transcript.chat.addChild(
			new Text(theme.fg("warning", `${label}: ${formatTokens(tokens)} tokens billed${cost}`), 1, 0),
		);
	}

	private maybeShowThinkingDropNotice(message: AssistantMessage): void {
		if (!this.settingsManager.getShowCacheMissNotices()) return;
		const droppedCount = countDroppedThinkingBlocks(message);
		if (droppedCount === 0) return;
		let previousDroppedCount = 0;
		// message_end arrives before the message is persisted: the branch's last assistant message is the previous one.
		const branch = this.sessionManager.getBranch();
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			if (entry?.type === "message" && entry.message.role === "assistant") {
				previousDroppedCount = countDroppedThinkingBlocks(entry.message);
				break;
			}
		}
		if (droppedCount <= previousDroppedCount) return;
		const noun = droppedCount === 1 ? "thinking block" : "thinking blocks";
		this.transcript.chat.addChild(new Spacer(1));
		this.transcript.chat.addChild(
			new Text(theme.fg("warning", `Anthropic dropped ${droppedCount} ${noun} (details in session)`), 1, 0),
		);
	}

	private maybeShowCacheMissNotice(message: AssistantMessage): void {
		if (!this.settingsManager.getShowCacheMissNotices()) return;
		const miss = detectCacheMiss(this.sessionManager.getEntries(), message, this.session.modelRuntime);
		if (miss) this.addCacheMissNotice(miss);
	}

	private addCacheMissNotice(miss: CacheMiss): void {
		if (miss.missedTokens < 20_000 && miss.missedCost < 0.1) return;
		const cost = miss.missedCost >= 0.01 ? ` (~$${miss.missedCost.toFixed(2)})` : "";
		const reBilled = `${formatTokens(miss.missedTokens)} tokens re-billed${cost}`;
		let label = "Cache miss";
		if (miss.modelChanged) label = "Cache miss after model switch";
		else if (miss.idleMs >= CACHE_TTL_MS) label = `Cache miss after ${Math.round(miss.idleMs / 60_000)}m idle`;
		this.transcript.chat.addChild(new Spacer(1));
		this.transcript.chat.addChild(new Text(theme.fg("warning", `${label}: ${reBilled}`), 1, 0));
	}

	/** Render the current session branch (`renderInitialMessages` in the interactive mode). */
	private renderInitialMessages(): void {
		this.renderSessionEntries(this.sessionManager.buildContextEntries(), {
			updateFooter: true,
			populateHistory: true,
		});
		this.renderProjectTrustWarningIfNeeded();
		const compactionCount = this.sessionManager.getEntries().filter((entry) => entry.type === "compaction").length;
		if (compactionCount > 0) {
			this.showStatus(`Session compacted ${compactionCount === 1 ? "1 time" : `${compactionCount} times`}`);
		}
	}

	private renderProjectTrustWarningIfNeeded(): void {
		if (this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(this.sessionManager.getCwd())) {
			return;
		}
		const chat = this.transcript.chat;
		if (chat.length > 0) chat.addChild(new Spacer(1));
		chat.addChild(
			new Text(
				theme.fg(
					"warning",
					`This project is not trusted. Project ${CONFIG_DIR_NAME} resources and packages are ignored. Use /trust to save a trust decision, then restart pi.`,
				),
				1,
				0,
			),
		);
	}

	// --- ModeContext: transcript and notices -----------------------------------------------------

	showStatus(message: string): void {
		if (!this.ui) return;
		this.transcript.showStatus(message);
		this.requestRender();
	}

	showWarning(message: string): void {
		if (!this.ui) {
			process.stderr.write(`Warning: ${message}\n`);
			return;
		}
		this.transcript.chat.addChild(new Spacer(1));
		this.transcript.chat.addChild(new Text(theme.fg("warning", `Warning: ${message}`), 1, 0));
		this.requestRender();
	}

	showError(message: string): void {
		if (!this.ui) {
			process.stderr.write(`Error: ${message}\n`);
			return;
		}
		this.transcript.chat.addChild(new Spacer(1));
		this.transcript.chat.addChild(new Text(theme.fg("error", `Error: ${message}`), this.outputPad, 0));
		this.requestRender();
	}

	flash(message: string): void {
		if (this.ui) this.ui.viewport.flash(message);
	}

	getSelectedText(): string | undefined {
		return this.ui?.viewport.selectedText();
	}

	// --- ModeContext: overlays -------------------------------------------------------------------

	showComponent<T>(factory: ComponentFactory<T>, options?: ShowComponentOptions): Promise<T | undefined> {
		return openDialog<T>(
			this,
			(controller) => {
				const created = factory((result) => controller.resolve(result), this.tui);
				const hosted = isHostedComponent(created) ? created : { component: created };
				const focus = hosted.focus ?? hosted.component;
				const host = new ComponentHostRenderable(this.renderer, {
					component: hosted.component,
					tui: this.tui,
					focusable: true,
					syncFocus: () => focus,
					// With an explicit dispose (old `showSelector` contract) only that runs.
					disposeComponent: hosted.dispose === undefined,
					trimRules: !options?.title,
				});
				const dispose = hosted.dispose;
				if (options?.title) {
					const frame = new DialogFrame(this, { title: options.title });
					frame.add(host);
					return { root: frame.root, focusTarget: host, layout: options.layout, dispose };
				}
				// Opaque rounded panel: transparent cells would let the transcript show through.
				const theme = this.uiTheme();
				const panel = new BoxRenderable(this.renderer, {
					flexDirection: "column",
					border: true,
					borderStyle: "rounded",
					borderColor: theme.borderMuted,
					backgroundColor: theme.raised,
					paddingX: 1,
					flexShrink: 1,
					overflow: "hidden",
				});
				panel.add(host);
				return { root: panel, focusTarget: host, layout: options?.layout, dispose };
			},
			{ signal: options?.signal },
		);
	}

	// --- ModeContext: working state --------------------------------------------------------------

	showStatusIndicator(spec: StatusIndicatorSpec): void {
		if (spec.kind === "compaction") this.setStatusIndicator(new CompactionStatusIndicator(this.tui, spec.reason));
		else if (spec.kind === "branchSummary") this.setStatusIndicator(new BranchSummaryStatusIndicator(this.tui));
		else this.setStatusIndicator(new RetryStatusIndicator(this.tui, spec.attempt, spec.maxAttempts, spec.delayMs));
	}

	clearStatusIndicator(kind?: StatusIndicatorKind): void {
		if (kind && this.activeStatusIndicator?.kind !== kind) return;
		this.activeStatusIndicator?.dispose();
		this.activeStatusIndicator = undefined;
		this.activeWorkingIndicatorEmbedded = false;
		this.statusContainer.clear();
		this.setEditorWorkingStatusIndicator(undefined);
		this.requestRender();
	}

	pushEscapeHandler(handler: () => void): () => void {
		this.escapeHandlers.push(handler);
		return () => {
			const index = this.escapeHandlers.lastIndexOf(handler);
			if (index !== -1) this.escapeHandlers.splice(index, 1);
		};
	}

	/** Embed the indicator in the editor's top border when the editor supports it. */
	private setEditorWorkingStatusIndicator(indicator: StatusIndicator | undefined): boolean {
		this.defaultEditor.setWorkingStatusIndicator(undefined);
		if (!isWorkingStatusEditor(this.currentEditor)) return false;
		this.currentEditor.setWorkingStatusIndicator(indicator);
		return true;
	}

	private setStatusIndicator(indicator: StatusIndicator): void {
		this.activeStatusIndicator?.dispose();
		this.activeStatusIndicator = indicator;
		this.activeWorkingIndicatorEmbedded = false;
		this.statusContainer.clear();
		this.setEditorWorkingStatusIndicator(undefined);
		if (this.setEditorWorkingStatusIndicator(indicator)) {
			this.activeWorkingIndicatorEmbedded = true;
		} else {
			this.statusContainer.addChild(indicator);
		}
		this.requestRender();
	}

	private showWorkingStatusIndicator(): void {
		const editor = this.currentEditor;
		const colorFn = isWorkingStatusEditor(editor)
			? (text: string) =>
					(editor.borderColor ?? theme.getThinkingBorderColor(this.session.thinkingLevel || "off"))(text)
			: undefined;
		this.setStatusIndicator(
			new WorkingStatusIndicator(
				this.tui,
				this.workingMessage ?? DEFAULT_WORKING_MESSAGE,
				this.workingIndicatorOptions,
				colorFn,
			),
		);
	}

	private setWorkingVisible(visible: boolean): void {
		this.workingVisible = visible;
		if (!visible) {
			this.clearStatusIndicator("working");
			return;
		}
		if (this.session.isStreaming && this.activeStatusIndicator?.kind !== "working") this.showWorkingStatusIndicator();
		this.requestRender();
	}

	private setWorkingIndicator(options?: WorkingIndicatorOptions): void {
		this.workingIndicatorOptions = options;
		if (this.activeStatusIndicator?.kind === "working") this.activeStatusIndicator.setIndicator(options);
		this.requestRender();
	}

	private setHiddenThinkingLabel(label?: string): void {
		this.hiddenThinkingLabel = label ?? DEFAULT_HIDDEN_THINKING_LABEL;
		if (this.ui) {
			for (const child of this.transcript.chat.children) {
				if (child instanceof AssistantMessageComponent) child.setHiddenThinkingLabel(this.hiddenThinkingLabel);
			}
		}
		this.streamingComponent?.setHiddenThinkingLabel(this.hiddenThinkingLabel);
		this.requestRender();
	}

	private setTerminalProgress(active: boolean): void {
		if (active) {
			process.stdout.write(TERMINAL_PROGRESS_ACTIVE);
			this.progressInterval ??= setInterval(
				() => process.stdout.write(TERMINAL_PROGRESS_ACTIVE),
				TERMINAL_PROGRESS_KEEPALIVE_MS,
			);
			return;
		}
		if (!this.progressInterval) return;
		clearInterval(this.progressInterval);
		this.progressInterval = undefined;
		process.stdout.write(TERMINAL_PROGRESS_CLEAR);
	}

	// --- ModeContext: view state -----------------------------------------------------------------

	getToolsExpanded(): boolean {
		return this.toolOutputExpanded;
	}

	setToolsExpanded(expanded: boolean): void {
		if (expanded === this.toolOutputExpanded) return;
		this.toolOutputExpanded = expanded;
		const activeHeader = this.customHeader ?? this.builtInHeader;
		if (isExpandable(activeHeader)) activeHeader.setExpanded(expanded);
		if (this.ui) {
			for (const child of [...this.transcript.resourcesContainer.children, ...this.transcript.chat.children]) {
				if (isExpandable(child)) child.setExpanded(expanded);
			}
		}
		this.showStatus(`Tool output: ${expanded ? "expanded" : "collapsed"}`);
	}

	private toggleToolOutputExpansion(): void {
		this.setToolsExpanded(!this.toolOutputExpanded);
	}

	getHideThinkingBlock(): boolean {
		return this.hideThinkingBlock;
	}

	setHideThinkingBlock(hidden: boolean): void {
		this.hideThinkingBlock = hidden;
		if (this.ui) {
			for (const child of this.transcript.chat.children) {
				if (child instanceof AssistantMessageComponent) child.setHideThinkingBlock(hidden);
			}
		}
		this.requestRender();
	}

	private toggleThinkingBlockVisibility(): void {
		const hidden = !this.hideThinkingBlock;
		this.settingsManager.setHideThinkingBlock(hidden);
		this.setHideThinkingBlock(hidden);
		this.showStatus(`Thinking blocks: ${hidden ? "hidden" : "visible"}`);
	}

	// --- ModeContext: settings and chrome --------------------------------------------------------

	refreshChrome(): void {
		this.footer.setSession(this.session);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.footer.invalidate();
		this.updateAvailableProviderCount();
		this.updateEditorBorderColor();
		this.updateTerminalTitle();
		this.requestRender();
	}

	applySettings(): void {
		setCapabilityOverrides(this.settingsManager.getTerminalCapabilityOverrides());
		configureHttpDispatcher(this.settingsManager.getHttpIdleTimeoutMs());
		this.ui?.viewport.setScrollbar(this.settingsManager.getFullscreenScrollbar());
		this.footer.setSession(this.session);
		this.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		this.footerDataProvider.setCwd(this.sessionManager.getCwd());
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.outputPad = this.settingsManager.getOutputPad();
		this.tui.setShowHardwareCursor(this.settingsManager.getShowHardwareCursor());
		const editorPaddingX = this.settingsManager.getEditorPaddingX();
		const autocompleteMaxVisible = this.settingsManager.getAutocompleteMaxVisible();
		this.defaultEditor.setPaddingX(editorPaddingX);
		this.defaultEditor.setAutocompleteMaxVisible(autocompleteMaxVisible);
		if (this.currentEditor !== this.defaultEditor) {
			this.currentEditor.setPaddingX?.(editorPaddingX);
			this.currentEditor.setAutocompleteMaxVisible?.(autocompleteMaxVisible);
		}
		this.requestRender();
	}

	refreshAutocomplete(): void {
		this.setupAutocompleteProvider();
	}

	private updateAvailableProviderCount(): void {
		const models =
			this.session.scopedModels.length > 0
				? this.session.scopedModels.map((scoped) => scoped.model)
				: this.session.modelRuntime.getAvailableSnapshot();
		this.footerDataProvider.setAvailableProviderCount(new Set(models.map((model) => model.provider)).size);
	}

	private updateEditorBorderColor(): void {
		this.defaultEditor.setPlanMode(this.isPlanMode);
		if (this.currentEditor !== this.defaultEditor && "setPlanMode" in this.currentEditor) {
			const setPlanMode = this.currentEditor.setPlanMode;
			if (typeof setPlanMode === "function") setPlanMode.call(this.currentEditor, this.isPlanMode);
		}
		const color = this.isPlanMode
			? (text: string) => theme.fg("borderAccent", text)
			: this.isBashMode
				? theme.getBashModeBorderColor()
				: theme.getThinkingBorderColor(this.session.thinkingLevel || "off");
		this.defaultEditor.borderColor = color;
		this.currentEditor.borderColor = color;
		this.activeStatusIndicator?.invalidate();
		this.requestRender();
	}

	private updateTerminalTitle(): void {
		const cwdBasename = path.basename(this.sessionManager.getCwd());
		const sessionName = this.sessionManager.getSessionName();
		this.ui?.renderer.setTerminalTitle(
			sessionName ? `${APP_TITLE} - ${sessionName} - ${cwdBasename}` : `${APP_TITLE} - ${cwdBasename}`,
		);
	}

	private applyThemeChange(): void {
		this.currentUiTheme = createUiTheme(theme);
		this.tui.invalidate();
		this.ui?.shell.applyTheme(this.currentUiTheme);
		this.ui?.viewport.setScrollbar(this.settingsManager.getFullscreenScrollbar());
		this.updateEditorBorderColor();
	}

	// --- ModeContext: session lifecycle ----------------------------------------------------------

	/** `/reload`: shows a progress box in the editor slot while resources reload. */
	async reload(): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("Wait for the current response to finish before reloading.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Wait for compaction to finish before reloading.");
			return;
		}
		this.resetExtensionUI();
		const reloadBox = new Container();
		const borderColor = (text: string) => theme.fg("border", text);
		reloadBox.addChild(new DynamicBorder(borderColor));
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(
			new Text(
				theme.fg("muted", "Reloading keybindings, extensions, skills, prompts, themes, and context files..."),
				1,
				0,
			),
		);
		reloadBox.addChild(new Spacer(1));
		reloadBox.addChild(new DynamicBorder(borderColor));
		const previousEditor = this.currentEditor;
		this.setEditorSlot(reloadBox);
		await new Promise((resolve) => setTimeout(resolve, 0));
		let chatRestored = false;
		const restoreChatBeforeSessionStart = () => {
			if (chatRestored) return;
			this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
			this.outputPad = this.settingsManager.getOutputPad();
			this.transcript.clear();
			this.renderSessionEntries(this.sessionManager.buildContextEntries());
			chatRestored = true;
		};
		let reloadBoxDismissed = false;
		try {
			await this.session.reload({ beforeSessionStart: restoreChatBeforeSessionStart });
			restoreChatBeforeSessionStart();
			this.keybindings.reload();
			const activeHeader = this.customHeader ?? this.builtInHeader;
			if (isExpandable(activeHeader)) activeHeader.setExpanded(this.toolOutputExpanded);
			setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
			this.applySettings();
			await this.themeController.applyFromSettings();
			this.setupAutocompleteProvider();
			this.setupExtensionShortcuts(this.session.extensionRunner);
			this.showLoadedResources();
			const savedImplicitProjectTrust = this.maybeSaveImplicitProjectTrustAfterReload();
			const modelsJsonError = this.session.modelRuntime.getError();
			if (modelsJsonError) this.showError(`models.json error: ${modelsJsonError}`);
			this.showStatus(
				savedImplicitProjectTrust
					? "Reloaded keybindings, extensions, skills, prompts, themes, and context files; saved project trust"
					: "Reloaded keybindings, extensions, skills, prompts, themes, and context files",
			);
			this.restoreEditorSlot();
			reloadBoxDismissed = true;
		} catch (error) {
			if (!reloadBoxDismissed) this.setEditorSlot(previousEditor);
			this.showError(`Reload failed: ${errorText(error)}`);
		}
	}

	private maybeSaveImplicitProjectTrustAfterReload(): boolean {
		const cwd = this.sessionManager.getCwd();
		if (this.autoTrustOnReloadCwd !== cwd) return false;
		if (!this.settingsManager.isProjectTrusted() || !hasTrustRequiringProjectResources(cwd)) return false;
		const trustStore = new ProjectTrustStore(this.runtimeHost.services.agentDir);
		try {
			if (trustStore.get(cwd) !== null) {
				this.autoTrustOnReloadCwd = undefined;
				return false;
			}
			trustStore.set(cwd, true);
			this.autoTrustOnReloadCwd = undefined;
			return true;
		} catch (error) {
			this.showWarning(`Could not save project trust after reload: ${errorText(error)}`);
			return false;
		}
	}

	createProjectTrustContext(cwd: string): ProjectTrustContext {
		const ui = this.createExtensionUIContext();
		return {
			cwd,
			mode: "tui",
			hasUI: true,
			ui: { select: ui.select, confirm: ui.confirm, input: ui.input, notify: ui.notify },
		};
	}

	/** Write the rendered screen and the session messages to the debug log. Returns its path. */
	writeDebugLog(): string {
		const ui = this.requireUi();
		const width = ui.renderer.width;
		const height = ui.renderer.height;
		const allLines = [...ui.transcript.renderedLines(), ...ui.regionHosts.flatMap((host) => [...host.renderedLines])];
		const debugLogPath = getDebugLogPath();
		const debugData = [
			`Debug output at ${new Date().toISOString()}`,
			`Terminal: ${width}x${height}`,
			`Total lines: ${allLines.length}`,
			"",
			"=== All rendered lines with visible widths ===",
			...allLines.map((line, index) => `[${index}] (w=${visibleWidth(line)}) ${JSON.stringify(line)}`),
			"",
			"=== Agent messages (JSONL) ===",
			...this.session.messages.map((message) => JSON.stringify(message)),
			"",
		].join("\n");
		fs.mkdirSync(path.dirname(debugLogPath), { recursive: true });
		fs.writeFileSync(debugLogPath, debugData);
		return debugLogPath;
	}

	async runExternal<T>(task: () => Promise<T>): Promise<T> {
		const renderer = this.renderer;
		renderer.suspend();
		try {
			return await task();
		} finally {
			renderer.resume();
			this.tui.invalidate();
			this.requestRender();
		}
	}

	async maybeWarnAboutAnthropicSubscriptionAuth(model: Model<Api> | undefined = this.session.model): Promise<void> {
		if (this.settingsManager.getWarnings().anthropicExtraUsage === false) return;
		if (this.anthropicSubscriptionWarningShown) return;
		if (!model || model.provider !== "anthropic") return;
		try {
			if ((await this.session.modelRuntime.checkAuth("anthropic"))?.type === "oauth") {
				this.anthropicSubscriptionWarningShown = true;
				this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
				return;
			}
			const apiKey = (await this.session.modelRuntime.getAuth(model.provider))?.auth.apiKey;
			if (!isAnthropicSubscriptionAuthKey(apiKey)) return;
			this.anthropicSubscriptionWarningShown = true;
			this.showWarning(ANTHROPIC_SUBSCRIPTION_AUTH_WARNING);
		} catch {
			// Auth lookup failures only skip this warning.
		}
	}

	// --- Extension UI ----------------------------------------------------------------------------

	private createExtensionUIContext(): ExtensionUIContext {
		return {
			select: (title, options, opts) =>
				this.dialogs.select({
					title,
					items: options.map((option) => ({ value: option, label: option })),
					signal: opts?.signal,
					timeoutMs: opts?.timeout,
				}),
			confirm: (title, message, opts) =>
				this.dialogs.confirm({ title, message, signal: opts?.signal, timeoutMs: opts?.timeout }),
			input: (title, placeholder, opts) =>
				this.dialogs.input({ title, placeholder, signal: opts?.signal, timeoutMs: opts?.timeout }),
			notify: (message, type) => {
				if (type === "error") this.showError(message);
				else if (type === "warning") this.showWarning(message);
				else this.showStatus(message);
			},
			onTerminalInput: (handler) => this.addExtensionTerminalInputListener(handler),
			setStatus: (key, text) => this.setExtensionStatus(key, text),
			setWorkingMessage: (message) => {
				this.workingMessage = message;
				if (this.activeStatusIndicator?.kind === "working") {
					this.activeStatusIndicator.setMessage(message ?? DEFAULT_WORKING_MESSAGE);
				}
			},
			setWorkingVisible: (visible) => this.setWorkingVisible(visible),
			setWorkingIndicator: (options) => this.setWorkingIndicator(options),
			setHiddenThinkingLabel: (label) => this.setHiddenThinkingLabel(label),
			setWidget: (key: string, content: unknown, options?: ExtensionWidgetOptions) =>
				this.setExtensionWidget(key, content as WidgetContent, options),
			setFooter: (factory) => this.setExtensionFooter(factory),
			setHeader: (factory) => this.setExtensionHeader(factory),
			setTitle: (title) => this.ui?.renderer.setTerminalTitle(title),
			custom: (factory, options) => this.showExtensionCustom(factory, options),
			pasteToEditor: (text) => this.currentEditor.handleInput(`\x1b[200~${text}\x1b[201~`),
			setEditorText: (text) => this.currentEditor.setText(text),
			getEditorText: () => this.currentEditor.getExpandedText?.() ?? this.currentEditor.getText(),
			editor: (title, prefill) =>
				this.dialogs.editor({
					title,
					prefill,
					openExternalEditor: async (text) => {
						const command = this.settingsManager.getExternalEditorCommand();
						const result = await this.runExternal(() => editInExternalEditor({ command, content: text }));
						return result.status === "complete" ? result.content : undefined;
					},
				}),
			addAutocompleteProvider: (factory) => {
				this.autocompleteProviderWrappers.push(factory);
				this.setupAutocompleteProvider();
			},
			setEditorComponent: (factory) => this.setCustomEditorComponent(factory),
			getEditorComponent: () => this.editorComponentFactory,
			get theme() {
				return theme;
			},
			getAllThemes: () => getAvailableThemesWithPaths(),
			getTheme: (name) => getThemeByName(name),
			setTheme: (themeOrName) => {
				if (themeOrName instanceof Theme) return this.themeController.setThemeInstance(themeOrName);
				const result = this.themeController.setThemeName(themeOrName);
				if (result.success && this.settingsManager.getTheme() !== themeOrName) {
					this.settingsManager.setTheme(themeOrName);
				}
				return result;
			},
			getToolsExpanded: () => this.toolOutputExpanded,
			setToolsExpanded: (expanded) => this.setToolsExpanded(expanded),
		};
	}

	/** `nek.mode` is a signal for the editor border (plan mode), not footer text. */
	private setExtensionStatus(key: string, text: string | undefined): void {
		if (key === "nek.mode") {
			this.isPlanMode = text === "plan";
			this.updateEditorBorderColor();
			return;
		}
		this.footerDataProvider.setExtensionStatus(key, text);
		this.requestRender();
	}

	private addExtensionTerminalInputListener(
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	): () => void {
		const unsubscribe = this.tui.addInputListener(handler);
		const release = () => {
			unsubscribe();
			this.extensionTerminalInputUnsubscribers.delete(release);
		};
		this.extensionTerminalInputUnsubscribers.add(release);
		return release;
	}

	private clearExtensionTerminalInputListeners(): void {
		for (const release of [...this.extensionTerminalInputUnsubscribers]) release();
	}

	private setExtensionWidget(key: string, content: WidgetContent, options?: ExtensionWidgetOptions): void {
		const removeExisting = (widgets: Map<string, DisposableComponent>) => {
			widgets.get(key)?.dispose?.();
			widgets.delete(key);
		};
		removeExisting(this.extensionWidgetsAbove);
		removeExisting(this.extensionWidgetsBelow);
		if (content === undefined) {
			this.renderWidgets();
			return;
		}
		let component: DisposableComponent;
		if (Array.isArray(content)) {
			const container = new Container();
			for (const line of content.slice(0, MAX_WIDGET_LINES)) container.addChild(new Text(line, 1, 0));
			if (content.length > MAX_WIDGET_LINES) {
				container.addChild(new Text(theme.fg("muted", "... (widget truncated)"), 1, 0));
			}
			component = container;
		} else {
			component = content(this.tui, theme);
		}
		const target = options?.placement === "belowEditor" ? this.extensionWidgetsBelow : this.extensionWidgetsAbove;
		target.set(key, component);
		this.renderWidgets();
	}

	private clearExtensionWidgets(): void {
		for (const widget of this.extensionWidgetsAbove.values()) widget.dispose?.();
		for (const widget of this.extensionWidgetsBelow.values()) widget.dispose?.();
		this.extensionWidgetsAbove.clear();
		this.extensionWidgetsBelow.clear();
		this.renderWidgets();
	}

	private renderWidgets(): void {
		const fill = (
			container: Container,
			widgets: Map<string, DisposableComponent>,
			spacerWhenEmpty: boolean,
			leadingSpacer: boolean,
		) => {
			container.clear();
			if (widgets.size === 0) {
				if (spacerWhenEmpty) container.addChild(new Spacer(1));
				return;
			}
			if (leadingSpacer) container.addChild(new Spacer(1));
			for (const component of widgets.values()) container.addChild(component);
		};
		fill(this.widgetContainerAbove, this.extensionWidgetsAbove, true, true);
		fill(this.widgetContainerBelow, this.extensionWidgetsBelow, false, false);
		this.requestRender();
	}

	private setExtensionFooter(
		factory:
			| ((tui: FacadeTui, thm: Theme, footerData: ReadonlyFooterDataProvider) => DisposableComponent)
			| undefined,
	): void {
		this.customFooter?.dispose?.();
		this.footerContainer.clear();
		if (factory) {
			this.customFooter = factory(this.tui, theme, this.footerDataProvider);
			this.footerContainer.addChild(this.customFooter);
		} else {
			this.customFooter = undefined;
			this.footerContainer.addChild(this.footer);
		}
		this.requestRender();
	}

	private setExtensionHeader(factory: ((tui: FacadeTui, thm: Theme) => DisposableComponent) | undefined): void {
		// The header may not exist yet during early initialization.
		if (!this.builtInHeader || !this.ui) return;
		this.customHeader?.dispose?.();
		const header = this.transcript.headerContainer;
		const currentHeader = this.customHeader ?? this.builtInHeader;
		const index = header.children.indexOf(currentHeader);
		if (factory) {
			this.customHeader = factory(this.tui, theme);
			if (isExpandable(this.customHeader)) this.customHeader.setExpanded(this.toolOutputExpanded);
			if (index !== -1) header.children[index] = this.customHeader;
			else header.children.unshift(this.customHeader);
		} else {
			this.customHeader = undefined;
			if (isExpandable(this.builtInHeader)) this.builtInHeader.setExpanded(this.toolOutputExpanded);
			if (index !== -1) header.children[index] = this.builtInHeader;
		}
		this.requestRender();
	}

	/** Swap the prompt editor for an extension editor (`setEditorComponent`), or restore the default. */
	private setCustomEditorComponent(factory: EditorFactory | undefined): void {
		this.editorComponentFactory = factory;
		const currentText = this.currentEditor.getText();
		if (factory) {
			const newEditor = factory(this.tui, getEditorTheme(), this.keybindings);
			newEditor.onSubmit = this.defaultEditor.onSubmit;
			newEditor.onChange = this.defaultEditor.onChange;
			newEditor.setText(currentText);
			if (newEditor.borderColor !== undefined) newEditor.borderColor = this.defaultEditor.borderColor;
			newEditor.setPaddingX?.(this.defaultEditor.getPaddingX());
			newEditor.setAutocompleteMaxVisible?.(this.defaultEditor.getAutocompleteMaxVisible());
			if (newEditor.setAutocompleteProvider && this.autocompleteProvider) {
				newEditor.setAutocompleteProvider(this.autocompleteProvider);
			}
			// Extensions that extend CustomEditor get the app-level handlers (duck typing across module copies).
			const customEditor = newEditor as unknown as Record<string, unknown>;
			if ("actionHandlers" in customEditor && customEditor.actionHandlers instanceof Map) {
				customEditor.onEscape ??= () => this.defaultEditor.onEscape?.();
				customEditor.onCtrlD ??= () => this.defaultEditor.onCtrlD?.();
				customEditor.onPasteImage ??= () => this.defaultEditor.onPasteImage?.();
				customEditor.onExtensionShortcut ??= (data: string) => this.defaultEditor.onExtensionShortcut?.(data);
				for (const [action, handler] of this.defaultEditor.actionHandlers) {
					(customEditor.actionHandlers as Map<string, () => void>).set(action, handler);
				}
			}
			this.currentEditor = newEditor;
		} else {
			this.defaultEditor.setText(currentText);
			this.currentEditor = this.defaultEditor;
		}
		this.restoreEditorSlot();
		this.updateEditorBorderColor();
		if (this.activeStatusIndicator) {
			this.statusContainer.clear();
			this.activeWorkingIndicatorEmbedded = this.setEditorWorkingStatusIndicator(this.activeStatusIndicator);
			if (!this.activeWorkingIndicatorEmbedded) this.statusContainer.addChild(this.activeStatusIndicator);
		}
	}

	/** `ctx.ui.custom`: a component in the editor slot, or a pi-tui overlay with `overlay: true`. */
	private showExtensionCustom<T>(
		factory: (
			tui: FacadeTui,
			thm: Theme,
			keybindings: KeybindingsManager,
			done: (result: T) => void,
		) => DisposableComponent | Promise<DisposableComponent>,
		options?: {
			overlay?: boolean;
			overlayOptions?: OverlayOptions | (() => OverlayOptions);
			onHandle?: (handle: OverlayHandle) => void;
		},
	): Promise<T> {
		const savedText = this.currentEditor.getText();
		const isOverlay = options?.overlay ?? false;
		const restoreEditor = () => {
			this.restoreEditorSlot();
			this.currentEditor.setText(savedText);
		};
		return new Promise((resolve, reject) => {
			let component: DisposableComponent | undefined;
			let overlayHandle: OverlayHandle | undefined;
			let closed = false;
			const close = (result: T) => {
				if (closed) return;
				closed = true;
				if (isOverlay) overlayHandle?.hide();
				else restoreEditor();
				resolve(result);
				try {
					component?.dispose?.();
				} catch {
					// Dispose errors must not block the result.
				}
			};
			Promise.resolve(factory(this.tui, theme, this.keybindings, close))
				.then((created) => {
					if (closed) return;
					component = created;
					if (!isOverlay) {
						this.setEditorSlot(created);
						return;
					}
					const overlayOptions =
						typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions;
					const width = (created as { width?: number }).width;
					overlayHandle = this.tui.showOverlay(created, overlayOptions ?? (width ? { width } : undefined));
					options?.onHandle?.(overlayHandle);
				})
				.catch((error: unknown) => {
					if (closed) return;
					if (!isOverlay) restoreEditor();
					reject(error);
				});
		});
	}

	/** Undo extension UI before the session is replaced or reloaded. */
	private resetExtensionUI(): void {
		this.ui?.piOverlays.closeAll();
		this.clearExtensionTerminalInputListeners();
		this.setExtensionFooter(undefined);
		this.setExtensionHeader(undefined);
		this.clearExtensionWidgets();
		this.footerDataProvider.clearExtensionStatuses();
		this.isPlanMode = false;
		this.updateEditorBorderColor();
		this.footer.invalidate();
		this.autocompleteProviderWrappers = [];
		this.setCustomEditorComponent(undefined);
		this.setupAutocompleteProvider();
		this.defaultEditor.onExtensionShortcut = undefined;
		this.updateTerminalTitle();
		this.workingMessage = undefined;
		this.workingVisible = true;
		this.setWorkingIndicator();
		if (this.activeStatusIndicator?.kind === "working") {
			this.activeStatusIndicator.setMessage(`${DEFAULT_WORKING_MESSAGE} (${keyText("app.interrupt")} to interrupt)`);
		}
		this.setHiddenThinkingLabel();
	}

	// --- Internals -------------------------------------------------------------------------------

	private requireUi(): ModeUi {
		if (!this.ui) throw new Error("The OpenTUI mode is not initialized");
		return this.ui;
	}
}

type WidgetContent = string[] | ((tui: FacadeTui, thm: Theme) => DisposableComponent) | undefined;

/** `MainOptions.createInteractiveMode` for the OpenTUI frontend. */
export function createOpenTuiModeFactory(
	rendererHost: RendererHost,
): (runtime: AgentSessionRuntime, options: InteractiveModeOptions) => OpenTuiMode {
	return (runtime, options) => new OpenTuiMode(runtime, options, rendererHost);
}
