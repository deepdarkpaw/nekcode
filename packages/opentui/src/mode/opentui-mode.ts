/**
 * The OpenTUI interactive mode: a same-process replacement for coding-agent `InteractiveMode`.
 *
 * `main()` builds it through `MainOptions.createInteractiveMode` and drives `init()`, `run()`, and
 * `stop()`. The mode uses the session, settings, keybindings, and theme objects directly, renders
 * with native OpenTUI renderables, and hosts pi-tui components (messages, tool rows, indicators,
 * extension UI) through the bridge.
 *
 * Phase 0 scope: shell layout, overlay stack, prompt loop with streamed assistant and tool output,
 * built-in command dispatch, interrupt/clear/exit keys, and the `ModeContext` contract. Members
 * that later phases complete are marked "Phase N".
 */

import * as path from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import { createProjectTrustContext } from "@earendil-works/pi-coding-agent/cli/project-trust";
import { APP_TITLE } from "@earendil-works/pi-coding-agent/config";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent/core/agent-session";
import type { AgentSessionRuntime } from "@earendil-works/pi-coding-agent/core/agent-session-runtime";
import type { ProjectTrustContext } from "@earendil-works/pi-coding-agent/core/extensions/types";
import { FooterDataProvider } from "@earendil-works/pi-coding-agent/core/footer-data-provider";
import { KeybindingsManager } from "@earendil-works/pi-coding-agent/core/keybindings";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent/core/session-manager";
import type { SettingsManager } from "@earendil-works/pi-coding-agent/core/settings-manager";
import { withBuiltInRenderers } from "@earendil-works/pi-coding-agent/core/tools/renderers/index";
import { AssistantMessageComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/assistant-message";
import { FooterComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/footer";
import { keyText } from "@earendil-works/pi-coding-agent/modes/interactive/components/keybinding-hints";
import {
	BranchSummaryStatusIndicator,
	CompactionStatusIndicator,
	RetryStatusIndicator,
	type StatusIndicator,
	WorkingStatusIndicator,
} from "@earendil-works/pi-coding-agent/modes/interactive/components/status-indicator";
import { ToolExecutionComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/tool-execution";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent/modes/interactive/components/user-message";
import {
	formatResumeCommand,
	type InteractiveModeOptions,
} from "@earendil-works/pi-coding-agent/modes/interactive/interactive-mode";
import type { InteractiveModeLike } from "@earendil-works/pi-coding-agent/modes/interactive/interactive-mode-factory";
import {
	getAvailableThemes,
	getMarkdownTheme,
	setRegisteredThemes,
	stopThemeWatcher,
	theme,
} from "@earendil-works/pi-coding-agent/modes/interactive/theme/theme";
import { InteractiveThemeController } from "@earendil-works/pi-coding-agent/modes/interactive/theme/theme-controller";
import { type Component, setKeybindings } from "@earendil-works/pi-tui";
import { CliRenderEvents, type CliRenderer, type KeyEvent } from "@opentui/core";
import { ComponentHostRenderable } from "../bridge/component-host.ts";
import { FacadeTui } from "../bridge/facade-tui.ts";
import { keyToSequence, matchesKeybinding, RawInputRouter } from "../bridge/input.ts";
import { dispatchBuiltinCommand, findKeyAction, runKeyAction } from "../commands/registry.ts";
import { MODE_STARTUP_FLOWS } from "../startup/index.ts";
import type { ModeStartupPhase } from "../startup/types.ts";
import { createUiTheme, type UiTheme } from "../theme/ui-theme.ts";
import { DialogFrame } from "../ui/dialog-frame.ts";
import { openDialog, showConfirmDialog, showEditorDialog, showInputDialog, showSelectDialog } from "../ui/dialogs.ts";
import { OverlayStack } from "../ui/overlay-stack.ts";
import type {
	ComponentFactory,
	DialogApi,
	ModeContext,
	ShowComponentOptions,
	StatusIndicatorKind,
	StatusIndicatorSpec,
	ThemeApi,
} from "./mode-context.ts";
import { PromptEditor } from "./prompt-editor.ts";
import type { RendererHost } from "./renderer-host.ts";
import { Shell } from "./shell.ts";
import { TranscriptView } from "./transcript.ts";

/** Two `app.clear` presses within this window exit. */
const DOUBLE_CLEAR_EXIT_MS = 500;

/** Created during `init()`; everything that needs the renderer. */
interface ModeUi {
	readonly renderer: CliRenderer;
	readonly shell: Shell;
	readonly overlays: OverlayStack;
	readonly transcript: TranscriptView;
	readonly editor: PromptEditor;
	readonly inputRouter: RawInputRouter;
	readonly footerData: FooterDataProvider;
	readonly footer: FooterComponent;
}

export class OpenTuiMode implements InteractiveModeLike, ModeContext {
	readonly runtimeHost: AgentSessionRuntime;
	readonly keybindings: KeybindingsManager;
	readonly tui: FacadeTui;
	readonly dialogs: DialogApi;
	readonly theme: ThemeApi;
	private readonly options: InteractiveModeOptions;
	private readonly rendererHost: RendererHost;
	private readonly themeController: InteractiveThemeController;
	private ui: ModeUi | undefined;
	private currentUiTheme: UiTheme;
	private unsubscribe: (() => void) | undefined;
	private initialized = false;
	private stopped = false;
	private shuttingDown = false;
	private submitting = false;
	private lastClearTime = 0;
	private toolsExpanded = false;
	private hideThinkingBlock: boolean;
	private streamingComponent: AssistantMessageComponent | undefined;
	private streamingHost: ComponentHostRenderable | undefined;
	private readonly pendingTools = new Map<string, ToolExecutionComponent>();
	private readonly toolComponents = new Set<ToolExecutionComponent>();
	private readonly assistantComponents = new Set<AssistantMessageComponent>();
	private statusHost: ComponentHostRenderable | undefined;
	private statusKind: StatusIndicatorKind | undefined;
	private readonly escapeHandlers: Array<() => void> = [];
	private readonly pendingInputs: string[] = [];
	private inputWaiter: ((text: string) => void) | undefined;
	private readonly keyHandler = (key: KeyEvent): void => this.handleGlobalKey(key);
	private readonly signalHandler = (): void => void this.shutdown({ fromSignal: true });

	constructor(runtimeHost: AgentSessionRuntime, options: InteractiveModeOptions, rendererHost: RendererHost) {
		this.runtimeHost = runtimeHost;
		this.options = options;
		this.rendererHost = rendererHost;
		this.keybindings = KeybindingsManager.create();
		setKeybindings(this.keybindings);
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.tui = new FacadeTui({
			size: () => {
				const renderer = this.rendererHost.current;
				return {
					columns: renderer?.width ?? process.stdout.columns ?? 80,
					rows: renderer?.height ?? process.stdout.rows ?? 24,
				};
			},
			onTitle: (title) => this.rendererHost.current?.setTerminalTitle(title),
		});
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

	get editor(): PromptEditor {
		return this.requireUi().editor;
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
		const renderer = await this.rendererHost.get();
		const shell = new Shell(renderer, this.currentUiTheme);
		renderer.root.add(shell.root);
		const overlays = new OverlayStack(renderer, shell.overlayHost);
		overlays.onChange(() => shell.setOverlaysVisible(overlays.hasVisible()));
		const transcript = new TranscriptView({
			renderer,
			scrollBox: shell.transcript,
			tui: this.tui,
			uiTheme: () => this.currentUiTheme,
			rebuild: () => this.renderSessionHistory(),
		});
		const editor = new PromptEditor(renderer, this.currentUiTheme);
		shell.editor.add(editor.root);
		const footerData = new FooterDataProvider(this.sessionManager.getCwd());
		const footer = new FooterComponent(this.session, footerData);
		footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		shell.footer.add(new ComponentHostRenderable(renderer, { component: footer, tui: this.tui, focusable: false }));
		footerData.onBranchChange(() => this.requestRender());
		const inputRouter = new RawInputRouter(renderer);
		this.ui = { renderer, shell, overlays, transcript, editor, inputRouter, footerData, footer };

		this.tui.bind({
			onRenderRequest: () => renderer.requestRender(),
			// Phase 5: pi-tui overlays (`tui.showOverlay`) map onto the overlay stack.
			showOverlay: () => {
				throw new Error("pi-tui overlays are not supported in the OpenTUI interface yet");
			},
			hideTopOverlay: () => {},
			hasOverlay: () => false,
			onFocusRequest: (component) => {
				if (component === null) editor.focus();
			},
			onInvalidate: () => renderer.requestRender(),
		});
		this.tui.start();
		inputRouter.attach();
		inputRouter.add((data) => {
			const result = this.tui.dispatchInput(data);
			if (result.consumed) return { consume: true };
			return result.data === data ? undefined : { data: result.data };
		});
		renderer.keyInput.on("keypress", this.keyHandler);
		renderer.on(CliRenderEvents.RESIZE, () => this.tui.virtualTerminal.notifyResize());
		process.on("SIGTERM", this.signalHandler);
		process.on("SIGHUP", this.signalHandler);
		editor.focus();

		await this.themeController.applyFromSettings();
		await this.runStartupFlows("init");
		await this.rebindCurrentSession();
		this.renderSessionHistory();
		this.updateTerminalTitle();
		await this.runStartupFlows("ready");
		this.requestRender();
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

	stop(): void {
		if (this.stopped) return;
		this.stopped = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		// Release `run()`: it returns once it sees `stopped`.
		const waiter = this.inputWaiter;
		this.inputWaiter = undefined;
		waiter?.("");
		process.off("SIGTERM", this.signalHandler);
		process.off("SIGHUP", this.signalHandler);
		const ui = this.ui;
		if (ui) {
			ui.renderer.keyInput.off("keypress", this.keyHandler);
			ui.inputRouter.detach();
			ui.overlays.dispose();
			ui.footerData.dispose();
		}
		this.themeController.dispose();
		this.tui.stop();
		this.rendererHost.destroy();
	}

	async shutdown(options?: { fromSignal?: boolean }): Promise<void> {
		if (this.shuttingDown) return;
		this.shuttingDown = true;
		this.themeController.disableAutoSync();
		if (options?.fromSignal) {
			await this.runtimeHost.dispose();
			this.stop();
			process.exit(0);
		}
		this.stop();
		await this.runtimeHost.dispose();
		stopThemeWatcher();
		const resumeCommand = formatResumeCommand(this.sessionManager);
		if (resumeCommand) process.stdout.write(`${theme.fg("dim", "To resume this session:")} ${resumeCommand}\n`);
		process.exit(0);
	}

	async handleFatalRuntimeError(prefix: string, error: unknown): Promise<never> {
		const message = error instanceof Error ? error.message : String(error);
		this.stop();
		stopThemeWatcher();
		process.stderr.write(`${prefix}: ${message}\n`);
		process.exit(1);
	}

	/** Phase 5: complete extension UI context (dialogs, widgets, header/footer, editor component). */
	private async rebindCurrentSession(options: { renderBeforeBind?: boolean } = {}): Promise<void> {
		const session = this.session;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.applySettings();
		if (options.renderBeforeBind) {
			this.transcript.rebuildFromSession();
			this.subscribe();
		}
		await session.bindExtensions({
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
							this.editor.setText(result.selectedText ?? "");
							this.showStatus("Forked to new session");
						}
						return { cancelled: result.cancelled };
					} catch (error) {
						return this.handleFatalRuntimeError("Failed to fork session", error);
					}
				},
				navigateTree: async (targetId, navigateOptions) => {
					const result = await this.session.navigateTree(targetId, navigateOptions);
					if (result.cancelled) return { cancelled: true };
					this.transcript.rebuildFromSession();
					if (result.editorText && !this.editor.getText().trim()) this.editor.setText(result.editorText);
					this.showStatus("Navigated to selected point");
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
				if (this.session.isIdle) void this.shutdown();
			},
			onError: (error) => {
				this.showError(`Extension "${error.extensionPath}" error: ${error.error}`);
			},
		});
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		if (this.session !== session) return;
		if (!options.renderBeforeBind) this.subscribe();
		this.refreshChrome();
	}

	private subscribe(): void {
		this.unsubscribe = this.session.subscribe((event) => this.handleEvent(event));
	}

	private async runStartupFlows(phase: ModeStartupPhase): Promise<void> {
		for (const flow of MODE_STARTUP_FLOWS) {
			if (flow.phase !== phase) continue;
			try {
				await flow.run(this, this.options);
			} catch (error) {
				this.showError(
					`Startup step "${flow.id}" failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}
	}

	// --- Input -----------------------------------------------------------------------------------

	private getUserInput(): Promise<string> {
		const queued = this.pendingInputs.shift();
		if (queued !== undefined) return Promise.resolve(queued);
		return new Promise((resolve) => {
			this.inputWaiter = resolve;
		});
	}

	private deliverUserInput(text: string): void {
		const waiter = this.inputWaiter;
		this.inputWaiter = undefined;
		if (waiter) waiter(text);
		else this.pendingInputs.push(text);
	}

	private async promptSafely(text: string, images?: InteractiveModeOptions["initialImages"]): Promise<void> {
		try {
			await this.session.prompt(text, images ? { images } : undefined);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : "Unknown error occurred");
		}
	}

	/** Editor-level keys. Overlays handle their keys first (registered earlier on `keyInput`). */
	private handleGlobalKey(key: KeyEvent): void {
		const ui = this.ui;
		if (!ui || key.defaultPrevented || ui.overlays.hasModal() || !ui.editor.isFocused) return;
		const consume = () => {
			key.preventDefault();
			key.stopPropagation();
		};
		if (matchesKeybinding(this.keybindings, key, "app.interrupt")) {
			consume();
			this.handleInterrupt();
			return;
		}
		if (matchesKeybinding(this.keybindings, key, "app.clear")) {
			consume();
			this.handleClear();
			return;
		}
		if (matchesKeybinding(this.keybindings, key, "app.exit") && ui.editor.getText().length === 0) {
			consume();
			void this.shutdown();
			return;
		}
		if (matchesKeybinding(this.keybindings, key, "tui.input.newLine")) {
			consume();
			ui.editor.insertTextAtCursor("\n");
			return;
		}
		if (matchesKeybinding(this.keybindings, key, "tui.input.submit")) {
			consume();
			void this.submitEditor();
			return;
		}
		if (matchesKeybinding(this.keybindings, key, "app.tools.expand")) {
			consume();
			this.setToolsExpanded(!this.toolsExpanded);
			return;
		}
		if (matchesKeybinding(this.keybindings, key, "app.thinking.toggle")) {
			consume();
			this.setHideThinkingBlock(!this.hideThinkingBlock);
			return;
		}
		const action = findKeyAction(this.keybindings, keyToSequence(key));
		if (action) {
			consume();
			void runKeyAction(this, action);
		}
	}

	private handleInterrupt(): void {
		const handler = this.escapeHandlers[this.escapeHandlers.length - 1];
		if (handler) {
			handler();
			return;
		}
		if (this.session.isStreaming) {
			this.restoreQueuedMessagesToEditor({ abort: true });
		}
	}

	private handleClear(): void {
		const now = Date.now();
		if (now - this.lastClearTime < DOUBLE_CLEAR_EXIT_MS) {
			void this.shutdown();
			return;
		}
		this.lastClearTime = now;
		this.editor.setText("");
	}

	/** Phase 2: bash mode (`!`/`!!`), compaction queueing, follow-up queueing. */
	private async submitEditor(): Promise<void> {
		if (this.submitting) return;
		const text = this.editor.getText().trim();
		if (!text) return;
		this.submitting = true;
		try {
			if (await dispatchBuiltinCommand(this, text)) return;
			if (text.startsWith("!")) {
				this.showWarning("Bash mode is not implemented in the OpenTUI interface yet");
				return;
			}
			this.editor.addToHistory(text);
			this.editor.setText("");
			if (this.session.isStreaming) {
				await this.session.prompt(text, { streamingBehavior: "steer" });
				this.requestRender();
				return;
			}
			this.deliverUserInput(text);
		} catch (error) {
			this.showError(error instanceof Error ? error.message : String(error));
		} finally {
			this.submitting = false;
		}
	}

	// --- Session events --------------------------------------------------------------------------

	/** Phase 1: compaction, retry, branch summary, custom entries, queue display, notices. */
	private handleEvent(event: AgentSessionEvent): void {
		if (!this.ui) return;
		switch (event.type) {
			case "agent_start":
				this.pendingTools.clear();
				this.showWorkingIndicator();
				break;
			case "message_start":
				if (event.message.role === "user") {
					this.appendUserMessage(event.message.content);
				} else if (event.message.role === "assistant") {
					const component = this.createAssistantComponent();
					this.streamingComponent = component;
					this.streamingHost = this.transcript.appendComponent(component);
					component.updateContent(event.message, true);
				}
				break;
			case "message_update":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.streamingComponent.updateContent(event.message, true);
					for (const content of event.message.content) {
						if (content.type !== "toolCall") continue;
						const existing = this.pendingTools.get(content.id);
						if (existing) existing.updateArgs(content.arguments);
						else
							this.pendingTools.set(
								content.id,
								this.appendToolComponent(content.name, content.id, content.arguments),
							);
					}
				}
				break;
			case "message_end":
				if (this.streamingComponent && event.message.role === "assistant") {
					this.finishAssistantMessage(event.message);
				}
				break;
			case "tool_execution_start": {
				let component = this.pendingTools.get(event.toolCallId);
				if (!component) {
					component = this.appendToolComponent(event.toolName, event.toolCallId, event.args);
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
				this.clearStatusIndicator("working");
				if (this.streamingHost) this.transcript.removeBlock(this.streamingHost);
				this.streamingComponent = undefined;
				this.streamingHost = undefined;
				this.pendingTools.clear();
				break;
			case "thinking_level_changed":
			case "session_info_changed":
				this.refreshChrome();
				break;
			default:
				break;
		}
		this.requestRender();
	}

	private finishAssistantMessage(message: AssistantMessage): void {
		const component = this.streamingComponent;
		if (!component) return;
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
			const text = errorMessage ?? message.errorMessage ?? "Error";
			for (const tool of this.pendingTools.values()) {
				tool.updateResult({ content: [{ type: "text", text }], isError: true });
			}
			this.pendingTools.clear();
		} else {
			for (const tool of this.pendingTools.values()) tool.setArgsComplete();
		}
		this.streamingComponent = undefined;
		this.streamingHost = undefined;
	}

	private createAssistantComponent(): AssistantMessageComponent {
		const component = new AssistantMessageComponent(
			undefined,
			this.hideThinkingBlock,
			{ ...getMarkdownTheme(), codeBlockIndent: this.settingsManager.getCodeBlockIndent() },
			"Thinking...",
			this.settingsManager.getOutputPad(),
			this.session.extensionRunner.getMarkdownTransformers(),
		);
		this.assistantComponents.add(component);
		return component;
	}

	private appendUserMessage(content: string | ReadonlyArray<{ type: string }>): void {
		const text =
			typeof content === "string"
				? content
				: content
						.filter((part): part is { type: "text"; text: string } => part.type === "text" && "text" in part)
						.map((part) => part.text)
						.join("");
		if (!text) return;
		const component = new UserMessageComponent(text, getMarkdownTheme(), this.settingsManager.getOutputPad());
		this.transcript.appendComponent(component);
	}

	private appendToolComponent(toolName: string, toolCallId: string, args: unknown): ToolExecutionComponent {
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
		component.setExpanded(this.toolsExpanded);
		this.toolComponents.add(component);
		this.transcript.appendComponent(component);
		return component;
	}

	/** Phase 1: custom messages, compaction/branch summaries, bash executions, usage notices, trust warning. */
	private renderSessionHistory(): void {
		this.streamingComponent = undefined;
		this.streamingHost = undefined;
		this.pendingTools.clear();
		this.toolComponents.clear();
		this.assistantComponents.clear();
		const rendered = new Map<string, ToolExecutionComponent>();
		for (const entry of this.sessionManager.buildContextEntries()) {
			for (const message of sessionEntryToContextMessages(entry)) {
				if (message.role === "user") {
					this.appendUserMessage(message.content);
				} else if (message.role === "assistant") {
					const component = this.createAssistantComponent();
					component.updateContent(message, false);
					this.transcript.appendComponent(component);
					for (const content of message.content) {
						if (content.type !== "toolCall") continue;
						const tool = this.appendToolComponent(content.name, content.id, content.arguments);
						if (message.stopReason === "aborted" || message.stopReason === "error") {
							const text =
								message.stopReason === "aborted" ? "Operation aborted" : message.errorMessage || "Error";
							tool.updateResult({ content: [{ type: "text", text }], isError: true });
						} else {
							rendered.set(content.id, tool);
						}
					}
				} else if (message.role === "toolResult") {
					const tool = rendered.get(message.toolCallId);
					if (tool) {
						tool.updateResult(message);
						rendered.delete(message.toolCallId);
					}
				}
			}
		}
		for (const [id, tool] of rendered) this.pendingTools.set(id, tool);
		this.requestRender();
	}

	// --- ModeContext: transcript and notices -----------------------------------------------------

	showStatus(message: string): void {
		this.transcript.showStatus(message);
	}

	showWarning(message: string): void {
		this.transcript.appendText(`Warning: ${message}`, { tone: "warning" });
	}

	showError(message: string): void {
		if (!this.ui) {
			process.stderr.write(`Error: ${message}\n`);
			return;
		}
		this.transcript.appendText(`Error: ${message}`, { tone: "error" });
	}

	/** Phase 3: transient toast. */
	flash(message: string): void {
		this.showStatus(message);
	}

	// --- ModeContext: overlays -------------------------------------------------------------------

	showComponent<T>(factory: ComponentFactory<T>, options?: ShowComponentOptions): Promise<T | undefined> {
		return openDialog<T>(
			this,
			(controller) => {
				const component: Component = factory((result) => controller.resolve(result), this.tui);
				const host = new ComponentHostRenderable(this.renderer, { component, tui: this.tui, focusable: true });
				if (!options?.title) return { root: host, focusTarget: host, layout: options?.layout };
				const frame = new DialogFrame(this, { title: options.title });
				frame.add(host);
				return { root: frame.root, focusTarget: host, layout: options.layout };
			},
			{ signal: options?.signal },
		);
	}

	// --- ModeContext: working state --------------------------------------------------------------

	showStatusIndicator(spec: StatusIndicatorSpec): void {
		let indicator: StatusIndicator;
		if (spec.kind === "compaction") indicator = new CompactionStatusIndicator(this.tui, spec.reason);
		else if (spec.kind === "branchSummary") indicator = new BranchSummaryStatusIndicator(this.tui);
		else indicator = new RetryStatusIndicator(this.tui, spec.attempt, spec.maxAttempts, spec.delayMs);
		this.setStatusComponent(indicator, spec.kind);
	}

	clearStatusIndicator(kind?: StatusIndicatorKind): void {
		if (kind !== undefined && this.statusKind !== kind) return;
		const host = this.statusHost;
		this.statusHost = undefined;
		this.statusKind = undefined;
		if (host && this.ui) {
			this.ui.shell.status.remove(host);
			host.destroyRecursively();
		}
		this.requestRender();
	}

	pushEscapeHandler(handler: () => void): () => void {
		this.escapeHandlers.push(handler);
		return () => {
			const index = this.escapeHandlers.lastIndexOf(handler);
			if (index !== -1) this.escapeHandlers.splice(index, 1);
		};
	}

	/** Phase 3: custom working message/indicator (`setWorkingMessage`, `setWorkingIndicator`). */
	private showWorkingIndicator(): void {
		const message = `Working... (${keyText("app.interrupt")} to interrupt)`;
		this.setStatusComponent(new WorkingStatusIndicator(this.tui, message), "working");
	}

	private setStatusComponent(indicator: StatusIndicator, kind: StatusIndicatorKind): void {
		const ui = this.requireUi();
		this.clearStatusIndicator();
		const host = new ComponentHostRenderable(ui.renderer, { component: indicator, tui: this.tui, focusable: false });
		ui.shell.status.add(host);
		this.statusHost = host;
		this.statusKind = kind;
		this.requestRender();
	}

	// --- ModeContext: view state -----------------------------------------------------------------

	getToolsExpanded(): boolean {
		return this.toolsExpanded;
	}

	setToolsExpanded(expanded: boolean): void {
		this.toolsExpanded = expanded;
		for (const component of this.toolComponents) component.setExpanded(expanded);
		this.requestRender();
	}

	getHideThinkingBlock(): boolean {
		return this.hideThinkingBlock;
	}

	setHideThinkingBlock(hidden: boolean): void {
		this.hideThinkingBlock = hidden;
		for (const component of this.assistantComponents) component.setHideThinkingBlock(hidden);
		this.requestRender();
	}

	// --- ModeContext: settings and chrome --------------------------------------------------------

	refreshChrome(): void {
		const ui = this.ui;
		if (!ui) return;
		ui.footer.setSession(this.session);
		ui.footer.setAutoCompactEnabled(this.session.autoCompactionEnabled);
		ui.footer.invalidate();
		ui.editor.setBorderColor(this.currentUiTheme.thinkingBorder(this.session.thinkingLevel || "off"));
		this.updateTerminalTitle();
		this.requestRender();
	}

	/** Phase 3: padding, hardware cursor, scrollbar, copy-on-select, autocomplete limits. */
	applySettings(): void {
		this.hideThinkingBlock = this.settingsManager.getHideThinkingBlock();
		this.ui?.footerData.setCwd(this.sessionManager.getCwd());
	}

	/** Phase 2: the editor autocomplete provider. */
	refreshAutocomplete(): void {}

	// --- ModeContext: session lifecycle ----------------------------------------------------------

	/** Phase 3: reload progress box, header and widget reset, full settings re-apply. */
	async reload(): Promise<void> {
		if (this.session.isStreaming) {
			this.showWarning("Wait for the current response to finish before reloading.");
			return;
		}
		if (this.session.isCompacting) {
			this.showWarning("Wait for compaction to finish before reloading.");
			return;
		}
		await this.session.reload({ beforeSessionStart: () => this.transcript.rebuildFromSession() });
		this.keybindings.reload();
		setRegisteredThemes(this.session.resourceLoader.getThemes().themes);
		await this.themeController.applyFromSettings();
		this.refreshChrome();
		this.showStatus("Reloaded keybindings, extensions, skills, prompts, themes, and context files");
	}

	restoreQueuedMessagesToEditor(options?: { abort?: boolean; currentText?: string }): number {
		const { steering, followUp } = this.session.clearQueue();
		const queued = [...steering, ...followUp];
		if (queued.length > 0) {
			const currentText = options?.currentText ?? this.editor.getText();
			this.editor.setText([queued.join("\n\n"), currentText].filter((text) => text.trim()).join("\n\n"));
		}
		if (options?.abort) void this.session.abort();
		return queued.length;
	}

	/** Phase 1: messages queued during compaction. */
	async flushCompactionQueue(): Promise<void> {}

	createProjectTrustContext(cwd: string): ProjectTrustContext {
		return createProjectTrustContext({
			cwd,
			mode: "interactive",
			settingsManager: this.settingsManager,
			hasUI: true,
			startupUi: {
				select: (_settings, title, options) =>
					this.dialogs.select({
						title,
						items: options.map((option) => ({ value: option.value, label: option.label })),
					}),
				input: (_settings, title, placeholder) => this.dialogs.input({ title, placeholder }),
			},
		});
	}

	/** Phase 3: debug log. */
	writeDebugLog(): string {
		throw new Error("The debug log is not available in the OpenTUI interface yet");
	}

	async runExternal<T>(task: () => Promise<T>): Promise<T> {
		const renderer = this.renderer;
		renderer.suspend();
		try {
			return await task();
		} finally {
			renderer.resume();
			renderer.requestRender();
		}
	}

	/** Phase 3: Anthropic subscription auth warning. */
	async maybeWarnAboutAnthropicSubscriptionAuth(_model?: Model<Api>): Promise<void> {}

	// --- Internals -------------------------------------------------------------------------------

	private requireUi(): ModeUi {
		if (!this.ui) throw new Error("The OpenTUI mode is not initialized");
		return this.ui;
	}

	private applyThemeChange(): void {
		this.currentUiTheme = createUiTheme(theme);
		const ui = this.ui;
		if (!ui) return;
		ui.shell.applyTheme(this.currentUiTheme);
		ui.editor.applyTheme(this.currentUiTheme);
		this.refreshChrome();
	}

	private updateTerminalTitle(): void {
		const cwdBasename = path.basename(this.sessionManager.getCwd());
		const sessionName = this.sessionManager.getSessionName();
		this.ui?.renderer.setTerminalTitle(
			sessionName ? `${APP_TITLE} - ${sessionName} - ${cwdBasename}` : `${APP_TITLE} - ${cwdBasename}`,
		);
	}
}

/** `MainOptions.createInteractiveMode` for the OpenTUI frontend. */
export function createOpenTuiModeFactory(
	rendererHost: RendererHost,
): (runtime: AgentSessionRuntime, options: InteractiveModeOptions) => OpenTuiMode {
	return (runtime, options) => new OpenTuiMode(runtime, options, rendererHost);
}
