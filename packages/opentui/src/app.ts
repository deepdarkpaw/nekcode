/**
 * The OpenTUI application: layout, state, key handling, and wiring to the RPC client.
 *
 * Data flow: RPC records → `reduce()` → `ViewState` → `sync()` updates renderables. Input goes the
 * other way through `routeInput()` to RPC commands.
 */

import { homedir } from "node:os";
import { BoxRenderable, type CliRenderer, type KeyEvent, TextareaRenderable } from "@opentui/core";
import { keyLabel, matchesAction } from "./keys.ts";
import { type RpcClient, RpcCommandError } from "./rpc/client.ts";
import type { RpcEventRecord, UiRequest } from "./rpc/protocol.ts";
import { routeInput } from "./state/commands.ts";
import { formatTokens } from "./state/format.ts";
import {
	type Action,
	createInitialState,
	isExpanded,
	type ReducerState,
	reduce,
	runningSubagents,
} from "./state/reducer.ts";
import type { Palette } from "./theme/palette.ts";
import { type BlockContext, createMarkdownSyntax } from "./view/blocks.ts";
import { DialogView } from "./view/dialog.ts";
import { Footer, PanelStack, Toasts } from "./view/panels.ts";
import { Transcript } from "./view/transcript.ts";

/** Toasts disappear after this long. */
const TOAST_MS = 4000;
/** UI requests that change the view state are batched into one render per frame. */
const RENDER_THROTTLE_MS = 16;

export interface AppOptions {
	renderer: CliRenderer;
	client: RpcClient;
	palette: Palette;
	cwd: string;
	initialMessages: readonly string[];
	/** Called once when the user quits or the backend exits. */
	onExit: (code: number) => void;
}

export class App {
	private readonly renderer: CliRenderer;
	private readonly client: RpcClient;
	private readonly palette: Palette;
	private readonly onExitCallback: (code: number) => void;
	private state: ReducerState;
	private readonly transcript: Transcript;
	private readonly panels: PanelStack;
	private readonly footer: Footer;
	private readonly toasts: Toasts;
	private readonly dialog: DialogView;
	private readonly input: TextareaRenderable;
	private readonly inputFrame: BoxRenderable;
	private readonly syntax;
	private readonly home = homedir();
	private syncTimer: ReturnType<typeof setTimeout> | undefined;
	private tickTimer: ReturnType<typeof setInterval> | undefined;
	private thinkingExpanded = false;
	private lastCtrlC = 0;
	private exiting = false;
	private appliedEditorTextSeq = 0;
	private readonly initialMessages: readonly string[];

	constructor(options: AppOptions) {
		this.renderer = options.renderer;
		this.client = options.client;
		this.palette = options.palette;
		this.onExitCallback = options.onExit;
		this.initialMessages = options.initialMessages;
		this.state = createInitialState(options.cwd);
		this.syntax = createMarkdownSyntax(this.palette);
		const { renderer, palette } = this;

		renderer.setBackgroundColor(palette.base);
		const layout = new BoxRenderable(renderer, {
			id: "layout",
			flexDirection: "column",
			width: "100%",
			height: "100%",
			backgroundColor: palette.base,
		});
		this.transcript = new Transcript(renderer, palette);
		this.panels = new PanelStack(renderer, palette);
		this.inputFrame = new BoxRenderable(renderer, {
			id: "input-frame",
			border: true,
			borderStyle: "rounded",
			borderColor: palette.borderMuted,
			focusedBorderColor: palette.border,
			backgroundColor: palette.raised,
			marginX: 1,
			marginTop: 1,
			paddingX: 1,
			flexShrink: 0,
		});
		this.input = new TextareaRenderable(renderer, {
			id: "input",
			minHeight: 1,
			maxHeight: 10,
			wrapMode: "word",
			backgroundColor: palette.raised,
			focusedBackgroundColor: palette.raised,
			textColor: palette.text,
			focusedTextColor: palette.text,
			placeholder: "Message nek…  / for commands",
			placeholderColor: palette.dim,
			cursorColor: palette.accent,
			// Submission and newlines are handled in `handleKey`, so the textarea never submits on its own.
			keyBindings: [
				{ name: "return", action: "newline" },
				{ name: "return", meta: true, action: "newline" },
			],
		});
		this.inputFrame.add(this.input);
		this.footer = new Footer(renderer, palette);
		this.toasts = new Toasts(renderer, palette);
		this.dialog = new DialogView(renderer, palette);

		layout.add(this.transcript.root);
		layout.add(this.panels.root);
		layout.add(this.inputFrame);
		layout.add(this.footer.root);
		renderer.root.add(layout);
		renderer.root.add(this.toasts.root);
		renderer.root.add(this.dialog.root);

		this.input.focus();
		renderer.keyInput.on("keypress", (key) => this.handleKey(key));
		this.client.onEvent((event) => this.handleEvent(event));
		this.client.onUiRequest((request) => this.handleUiRequest(request));
		this.client.onExit((exit) => {
			if (exit.expected || this.exiting) return;
			const detail = exit.stderrTail.trim().split("\n").slice(-3).join(" | ");
			this.dispatch({ type: "backend_exit", code: exit.code, error: detail || undefined });
			this.dispatch({
				type: "notice",
				level: "error",
				text: `Backend exited (code ${exit.code ?? "?"})${detail ? `: ${detail}` : ""}. Press Ctrl+C to quit.`,
			});
		});
		this.tickTimer = setInterval(() => this.tick(), 1000);
		this.sync();
	}

	/** Handshake with the backend: state, stats, and history (for resumed sessions). */
	async start(): Promise<void> {
		const state = await this.client.request({ type: "get_state" });
		this.dispatch({ type: "session_state", state });
		this.dispatch({ type: "backend_ready" });
		await this.refreshStats();
		const history = await this.client.request({ type: "get_messages" });
		if ((history?.messages.length ?? 0) > 0)
			this.dispatch({ type: "history", messages: history?.messages, now: Date.now() });
		for (const message of this.initialMessages) this.submit(message);
	}

	/** Current state, for the smoke check. */
	get viewState(): ReducerState {
		return this.state;
	}

	dispose(): void {
		if (this.syncTimer) clearTimeout(this.syncTimer);
		if (this.tickTimer) clearInterval(this.tickTimer);
	}

	// ==========================================================================
	// State
	// ==========================================================================

	private dispatch(action: Action): void {
		this.state = reduce(this.state, action);
		this.scheduleSync();
	}

	private scheduleSync(): void {
		if (this.syncTimer) return;
		this.syncTimer = setTimeout(() => {
			this.syncTimer = undefined;
			this.sync();
		}, RENDER_THROTTLE_MS);
	}

	/** Push the view state into the renderables. */
	sync(): void {
		const { state, palette } = this;
		const now = Date.now();
		const ctx: BlockContext = {
			renderer: this.renderer,
			palette,
			syntax: this.syntax,
			cwd: state.cwd,
			now,
			toolExpanded: (id) => isExpanded(state, id),
			thinkingExpanded: this.thinkingExpanded,
			expandKey: keyLabel("toggleTools"),
			thinkingKey: keyLabel("toggleThinking"),
			onToggle: (id) => this.dispatch({ type: "toggle_expanded", id }),
		};
		this.transcript.sync(state.blocks, state.droppedBlocks, ctx);
		this.panels.update(state, now);
		this.footer.update({ state, home: this.home, hints: this.hints() });
		this.toasts.update(state.toasts);
		const dialog = state.dialogs[0];
		this.dialog.show(dialog);
		if (!dialog && !this.input.focused) this.input.focus();
		this.inputFrame.borderColor = state.running
			? palette.accent
			: state.mode === "plan"
				? palette.warning
				: palette.borderMuted;
		if (state.editorText && state.editorText.seq !== this.appliedEditorTextSeq) {
			this.appliedEditorTextSeq = state.editorText.seq;
			this.input.setText(state.editorText.text);
		}
		if (state.title) this.renderer.setTerminalTitle(state.title);
		this.renderer.requestRender();
	}

	private hints(): string {
		const { state } = this;
		if (state.backend.status === "starting") return "Starting backend…";
		if (state.backend.status === "exited") return "Backend exited · Ctrl+C quit";
		const tools = `${keyLabel("toggleTools")} tools`;
		const thinking = `${keyLabel("toggleThinking")} thinking`;
		if (state.running) {
			const working = state.compacting ? "Compacting" : "Working";
			const subagents = runningSubagents(state).length;
			return `${working}…${subagents > 0 ? ` (${subagents} subagent${subagents === 1 ? "" : "s"})` : ""} · ${keyLabel("submit")} steer · ${keyLabel("submitFollowUp")} follow-up · ${keyLabel("abort")} stop · ${tools}`;
		}
		return `${keyLabel("submit")} send · ${keyLabel("newline")} newline · PgUp/PgDn scroll · ${tools} · ${thinking} · Ctrl+C clear/quit`;
	}

	private tick(): void {
		const now = Date.now();
		for (const toast of this.state.toasts) {
			if (now - toast.createdAt > TOAST_MS) this.dispatch({ type: "toast_expired", id: toast.id });
		}
		// Elapsed times of running tools and subagents.
		if (this.state.running || runningSubagents(this.state).length > 0) this.scheduleSync();
	}

	private async refreshStats(): Promise<void> {
		try {
			const stats = await this.client.request({ type: "get_session_stats" });
			this.dispatch({ type: "session_stats", stats });
		} catch {
			// Stats are cosmetic; the footer keeps its streamed totals.
		}
	}

	// ==========================================================================
	// RPC events
	// ==========================================================================

	private handleEvent(event: RpcEventRecord): void {
		this.dispatch({ type: "rpc_event", event, now: Date.now() });
		if (event.type === "agent_settled" || event.type === "compaction_end") void this.refreshStats();
	}

	private handleUiRequest(request: UiRequest): void {
		this.dispatch({ type: "ui_request", request, now: Date.now() });
	}

	// ==========================================================================
	// Input
	// ==========================================================================

	private handleKey(key: KeyEvent): void {
		if (matchesAction(key, "clearOrExit")) {
			key.preventDefault();
			this.handleCtrlC();
			return;
		}
		if (this.state.dialogs.length > 0) {
			const response = this.dialog.handleKey(key);
			if (response) {
				this.client.respondUi(response);
				this.dispatch({ type: "dialog_closed", id: response.id });
			}
			return;
		}
		if (matchesAction(key, "exit") && this.input.plainText === "") {
			key.preventDefault();
			this.quit();
			return;
		}
		if (matchesAction(key, "submitFollowUp")) {
			key.preventDefault();
			this.submitFromInput("followUp");
			return;
		}
		if (matchesAction(key, "submit")) {
			key.preventDefault();
			this.submitFromInput("steer");
			return;
		}
		if (matchesAction(key, "newline")) {
			key.preventDefault();
			this.input.newLine();
			return;
		}
		if (matchesAction(key, "abort")) {
			key.preventDefault();
			if (this.state.running) void this.runCommand(() => this.client.request({ type: "abort" }));
			return;
		}
		if (matchesAction(key, "scrollPageUp")) {
			key.preventDefault();
			this.transcript.scrollPage(-1);
			return;
		}
		if (matchesAction(key, "scrollPageDown")) {
			key.preventDefault();
			this.transcript.scrollPage(1);
			return;
		}
		const inputEmpty = this.input.plainText === "";
		if (matchesAction(key, "scrollTop") && (key.ctrl || inputEmpty)) {
			key.preventDefault();
			this.transcript.scrollToTop();
			return;
		}
		if (matchesAction(key, "scrollBottom") && (key.ctrl || inputEmpty)) {
			key.preventDefault();
			this.transcript.scrollToBottom();
			return;
		}
		if (matchesAction(key, "toggleTools")) {
			key.preventDefault();
			this.dispatch({ type: "toggle_expand_all" });
			return;
		}
		if (matchesAction(key, "toggleThinking")) {
			key.preventDefault();
			this.thinkingExpanded = !this.thinkingExpanded;
			this.sync();
		}
	}

	private handleCtrlC(): void {
		if (this.state.dialogs.length > 0) {
			const id = this.state.dialogs[0].id;
			this.client.respondUi({ type: "extension_ui_response", id, cancelled: true });
			this.dispatch({ type: "dialog_closed", id });
			return;
		}
		if (this.input.plainText !== "") {
			this.input.setText("");
			return;
		}
		const now = Date.now();
		if (now - this.lastCtrlC < 1500 || this.state.backend.status === "exited") {
			this.quit();
			return;
		}
		this.lastCtrlC = now;
		this.dispatch({ type: "toast", level: "info", text: "Press Ctrl+C again to quit", now });
	}

	private submitFromInput(whileRunning: "steer" | "followUp"): void {
		const text = this.input.plainText;
		if (text.trim() === "") return;
		this.input.setText("");
		this.submit(text, whileRunning);
	}

	/** Send one submission: a prompt, a queued steer/follow-up, or a routed slash command. */
	private submit(text: string, whileRunning: "steer" | "followUp" = "steer"): void {
		const action = routeInput(text);
		if (!action) return;
		this.transcript.scrollToBottom();
		switch (action.kind) {
			case "quit":
				this.quit();
				return;
			case "help":
				this.dispatch({ type: "notice", level: "info", text: this.helpText() });
				return;
			case "usage":
				this.dispatch({ type: "notice", level: "warning", text: action.text });
				return;
			case "unsupported":
				this.dispatch({
					type: "notice",
					level: "warning",
					text: `/${action.name} is not available in the OpenTUI frontend yet. Run nek without --ui opentui for it.`,
				});
				return;
			case "rpc":
				void this.runRpcCommand(action.command, action.arg);
				return;
			case "prompt":
				if (this.state.running) {
					const type = whileRunning === "followUp" ? "follow_up" : "steer";
					void this.runCommand(() => this.client.request({ type, message: action.text }));
				} else {
					void this.runCommand(() =>
						this.client.request({ type: "prompt", message: action.text }, { timeoutMs: 0 }),
					);
				}
				return;
		}
	}

	private async runRpcCommand(
		command:
			| "new_session"
			| "compact"
			| "set_session_name"
			| "set_thinking_level"
			| "set_model"
			| "export_html"
			| "clone"
			| "get_session_stats",
		arg: string | undefined,
	): Promise<void> {
		await this.runCommand(async () => {
			switch (command) {
				case "new_session": {
					const result = await this.client.request({ type: "new_session" });
					if (result?.cancelled) return;
					this.transcript.reset();
					this.state = {
						...createInitialState(this.state.cwd),
						backend: this.state.backend,
						footer: {
							...this.state.footer,
							inputTokens: 0,
							outputTokens: 0,
							cost: 0,
							contextTokens: undefined,
							contextPercent: undefined,
						},
					};
					this.dispatch({ type: "notice", level: "info", text: "New session" });
					await this.refreshStats();
					return;
				}
				case "clone": {
					const result = await this.client.request({ type: "clone" });
					if (!result?.cancelled) this.dispatch({ type: "notice", level: "info", text: "Session cloned" });
					return;
				}
				case "compact":
					await this.client.request({ type: "compact", customInstructions: arg }, { timeoutMs: 0 });
					return;
				case "set_session_name":
					await this.client.request({ type: "set_session_name", name: arg ?? "" });
					this.dispatch({
						type: "rpc_event",
						event: { type: "session_info_changed", name: arg },
						now: Date.now(),
					});
					return;
				case "set_thinking_level":
					await this.client.request({ type: "set_thinking_level", level: arg as "off" });
					this.dispatch({
						type: "rpc_event",
						event: { type: "thinking_level_changed", level: arg },
						now: Date.now(),
					});
					return;
				case "set_model": {
					const [provider, ...rest] = (arg ?? "").split("/");
					const model = await this.client.request({
						type: "set_model",
						provider: provider ?? "",
						modelId: rest.join("/"),
					});
					this.dispatch({ type: "session_state", state: { model } });
					this.dispatch({ type: "notice", level: "info", text: `Model: ${provider}/${rest.join("/")}` });
					return;
				}
				case "export_html": {
					const result = await this.client.request({ type: "export_html", outputPath: arg });
					this.dispatch({ type: "notice", level: "info", text: `Exported to ${result?.path ?? "?"}` });
					return;
				}
				case "get_session_stats": {
					const stats = await this.client.request({ type: "get_session_stats" });
					this.dispatch({ type: "session_stats", stats });
					if (stats) {
						const lines = [
							`Session ${stats.sessionId}`,
							stats.sessionFile ? `File ${stats.sessionFile}` : "Not saved",
							`${stats.userMessages} user · ${stats.assistantMessages} assistant · ${stats.toolCalls} tool calls`,
							`Tokens ↑${formatTokens(stats.tokens.input)} ↓${formatTokens(stats.tokens.output)} · cache ${formatTokens(stats.tokens.cacheRead)} · $${stats.cost.toFixed(3)}`,
						];
						this.dispatch({ type: "notice", level: "info", text: lines.join("\n") });
					}
					return;
				}
			}
		});
	}

	private async runCommand(run: () => Promise<unknown>): Promise<void> {
		try {
			await run();
		} catch (error) {
			const message =
				error instanceof RpcCommandError
					? `${error.command}: ${error.message}`
					: error instanceof Error
						? error.message
						: String(error);
			this.dispatch({ type: "notice", level: "error", text: message });
		}
	}

	private helpText(): string {
		return [
			"Keys",
			`  ${keyLabel("submit")} send (steer while working) · ${keyLabel("submitFollowUp")} follow-up · ${keyLabel("newline")} newline`,
			`  ${keyLabel("abort")} stop the turn · Ctrl+C clear input, twice to quit · ${keyLabel("exit")} quit on empty input`,
			`  PgUp/PgDn scroll · Ctrl+Home/End top/bottom · ${keyLabel("toggleTools")} expand tools · ${keyLabel("toggleThinking")} thinking`,
			"Commands",
			"  /new /compact [instructions] /name <name> /thinking <level> /model <provider/model> /export [path] /clone /session /quit",
			"  Extension, prompt, and skill commands are passed to the agent.",
		].join("\n");
	}

	private quit(): void {
		if (this.exiting) return;
		this.exiting = true;
		this.onExitCallback(0);
	}
}
