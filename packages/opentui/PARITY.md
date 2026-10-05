# OpenTUI native frontend: parity checklist

Feature parity of `nek --ui opentui` (native OpenTUI, same process) with the pi-tui interactive mode.
Every item names its source, owner, and how it is verified.

- **Owner** `native`: the native-UI worker (`feat/opentui-native`), in `src/mode`, `src/bridge`, `src/ui`, `src/theme`.
- **Owner** `commands`: the commands worker (`feat/opentui-commands`), in `src/commands/*` (except `registry.ts`), `src/selectors/*`, `src/startup/*`.
- **Verify** `T:<name>` means a `bun test` case in `test/native/` (written or to be written by the owner). `M:<steps>` means a manual check in a real terminal with `nek --ui opentui`.
- `H:<spec>` means a harness run in a real ConPTY (`conpty_probe.py`, exact output bytes, screens replayed with `@xterm/headless`); the spec names are listed in the acceptance report.
- `[x]` means the item is implemented and verified.

Source abbreviations (coding-agent paths are relative to `packages/coding-agent/src/`):

| Abbreviation | Path |
| --- | --- |
| `im` | `modes/interactive/interactive-mode.ts` |
| `c/` | `modes/interactive/components/` |
| `ext` | `core/extensions/types.ts` (`ExtensionUIContext`) |
| `kb` | `core/keybindings.ts` (`app.*`) |
| `tkb` | `packages/tui/src/keybindings.ts` (`tui.*`) |
| `alt` | `packages/tui/src/tui-alt-screen.ts` |
| `search` | `packages/tui/src/alt-screen-search.ts` |
| `ed` | `packages/tui/src/components/editor.ts` |

## 0. Foundation (phase 0)

| | Item | Source | Owner | Verify |
| --- | --- | --- | --- | --- |
| [x] | `MainOptions.createInteractiveMode` builds the mode; `--ui opentui` does not relaunch when a factory is set | `main.ts:558` | native | `M: bun packages/opentui/src/main.ts --version`; launcher test `opentui-launcher.test.ts` |
| [x] | `MainOptions.startupUi` hooks for pre-mode prompts | `cli/startup-ui-hooks.ts` | native | existing startup tests (`first-time-setup*.test.ts`) pass |
| [x] | Node launcher spawns `bun packages/opentui/src/main.ts <args>` with inherited stdio | `cli/opentui-launcher.ts` | native | `opentui-launcher.test.ts` |
| [x] | ANSI parser: SGR 16/256/truecolor fg/bg, attributes, OSC 8, cursor marker | `src/bridge/ansi.ts` | native | `T:parseAnsiLine *` |
| [x] | Raw input forwarding, bracketed paste re-wrap, raw listeners (consume/replace) | `src/bridge/input.ts` | native | `T:raw input helpers *` |
| [x] | Virtual terminal + facade pi-tui `TUI` (size, render requests, invalidate, input listeners) | `src/bridge/facade-tui.ts` | native | `T:FacadeTui *` |
| [x] | Component host: render at layout width, re-render on width/requestRender/invalidate, focus, keys, paste, dispose | `src/bridge/component-host.ts` | native | `T:ComponentHostRenderable *` |
| [x] | Theme mapping with base/panel/raised/overlay shades; links and Web Search use `mdLink` blue | `src/theme/ui-theme.ts` | native | `T:createUiTheme *` |
| [x] | Overlay stack: modal focus, key priority, hide/show, focus restore | `src/ui/overlay-stack.ts` | native | `T:OverlayStack *` |
| [x] | Dialog primitives: select (filter, wrap, highlight), confirm, input, editor; abort and timeout | `src/ui/dialogs.ts` | native | `T:dialogs *` |
| [x] | Shell layout: transcript (header, resources, chat), pending, status, widgets above/below, editor, footer; overlay layers on the renderer root | `src/mode/shell.ts` | native | `T:lays out header, editor, and footer with the editor focused` |
| [x] | Basic loop: type prompt, stream assistant text and tool rows | `im:3286-3431` | native | `T:a typed prompt streams the assistant reply and tool rows into the transcript` |
| [x] | Command registry, `ModeContext`, selector and startup contracts, one stub per built-in command | `src/commands/registry.ts` | native | `T:command registry *`, `T:built-in commands dispatch through the registry and clear the editor` |

## 1. Transcript and message rendering (phase 1)

| | Item | Source | Owner | Verify |
| --- | --- | --- | --- | --- |
| [x] | User messages (markdown, `userMessageBg`, OSC 133 prompt zones for prompt jumps) | `c/user-message.ts`, `im:3691` | native | `T:renders every message kind on load` (prompt zones via `promptRows`) |
| [x] | Assistant messages: markdown, code highlight, tables | `c/assistant-message.ts`, `im:3732` | native | `T:a typed prompt streams the assistant reply and tool rows into the transcript`, `T:renders every message kind on load` (same `AssistantMessageComponent`) |
| [x] | Thinking blocks; hidden label (`setHiddenThinkingLabel`); per-block visibility override | `c/assistant-message.ts:58-73`, `im:2197` | native | `T:thinking visibility, hidden label, and tool expansion update rendered messages` |
| [ ] | Mermaid rendering per `mermaid-rendering` setting | `c/mermaid.ts`, `im:467` | native | open: transformer is passed to every message component; no test yet |
| [x] | LaTeX/markdown transformers from extensions (`getMarkdownTransformers`) | `im:2042` | native | `T:extension markdown transformers apply to assistant messages` |
| [x] | Tool rows: pending/success/error backgrounds, args streaming, partial results, expand/collapse | `c/tool-execution.ts`, `im:3390-3431` | native | `T:a typed prompt streams …`, `T:renders every message kind on load` (aborted row) |
| [x] | Built-in tool renderers (read, bash, edit diff, write, grep, find, ls, ast_grep) | `core/tools/renderers/*` | native | `T:a typed prompt streams …` (read row); same `withBuiltInRenderers` as the built-in TUI |
| [x] | Web Search tool row in blue (`mdLink`) | `core/tools/renderers/web-search.ts:12` | native | `T:tokens map to theme colors; links and Web Search use the mdLink blue`; the row uses the built-in renderer |
| [x] | Custom tool `renderCall`/`renderResult` components from extensions | `ext:534-540` | native | `T:extension tool renderCall/renderResult components render in the tool row` |
| [ ] | Images in tool results (`show-images`, `image-width-cells`, Kitty/iTerm) | `im:3323` | native | open: needs a real terminal with an image protocol |
| [x] | Bash execution blocks (`!`, `!!`), streaming output, exit code, excluded marker | `c/bash-execution.ts`, `im:6581` | native | `T:bash mode runs the command and shows the output block`, `T:renders every message kind on load` |
| [x] | Compaction summary message (collapsed/expanded) | `c/compaction-summary-message.ts`, `im:3675` | native | `T:renders every message kind on load`, `T:thinking visibility, hidden label, and tool expansion …` (expanded summary) |
| [x] | Branch summary message | `c/branch-summary-message.ts`, `im:3682` | native | `T:branch summaries render from the session` |
| [x] | Custom messages (`display`), extension message renderers | `c/custom-message.ts`, `im:3661` | native | `T:renders every message kind on load` |
| [x] | Custom entries (`addCustomEntryToChat`) | `c/custom-entry.ts`, `im:3623` | native | `T:custom entries render through registered entry renderers` |
| [x] | Skill invocation message | `c/skill-invocation-message.ts` | native | `T:renders every message kind on load` |
| [ ] | Entry-appended handling incl. boundary compaction rebuild | `im:3230-3273` | native | open: ported verbatim; no boundary-compaction test yet |
| [x] | Aborted/error assistant messages mark pending tools as failed | `im:3345-3384` | native | `T:renders every message kind on load` ("Operation aborted") |
| [ ] | Cache-miss, cache-warming, compaction-cost, thinking-drop notices | `im:3870-3960` | native | open: ported; notices are off by default (`showCacheMissNotices`), no test yet |
| [ ] | Project-not-trusted warning in transcript | `im:3981` | native | open: ported; needs a project with trust-requiring resources |
| [x] | "Session compacted N times" status on load | `im:3972` | native | `T:renders every message kind on load` |
| [x] | Session history render on load/switch (`renderInitialMessages`, `populateHistory`) | `im:3964`, `im:3754` | native | `T:renders every message kind on load` |
| [x] | `showStatus` replaces consecutive status lines; `showWarning`/`showError` | `im:3603`, `im:4377-4383` | native | `T:notify levels, warnings, and errors go to the transcript; status lines collapse` |
| [ ] | Managed tool (fd/rg) download status lines | `im:3584`, `im:1007` | native | open: M: first run without fd (tests run offline) |
| [x] | Startup header (logo, compact/expanded key hints from keybindings, onboarding) | `im:943-1001` | native | `T:lays out header, editor, and footer with the editor focused` (keys from `keyHint`/`keyText`) |
| [x] | Loaded resources listing (context files, skills, prompts, extensions, themes, diagnostics) | `im:1618` | native | `T:loaded resources list context files`; H:checklist (`[Context]` lists both AGENTS.md files) |
| [x] | Extension errors in transcript (`showExtensionError`) | `im:2855` | native | `T:extension errors show in the transcript` |
| [ ] | Retry indicator with countdown (`auto_retry_start/end`) | `c/status-indicator.ts:50`, `im:3517` | native | open: ported; no retry test yet |
| [ ] | Compaction indicator and abort (`compaction_start/end`) | `im:3452-3516` | native | open: `T:/compact runs session compaction and reports its result` (indicator cleared, editor refocused); escape abort of a running compaction not tested |
| [ ] | Summarization retry events | `im:3545-3573` | native | open: ported; no test yet |
| [ ] | Highlight grammar lazy load re-render | `im:1041` | native | open: M: code block highlights after start |
| [ ] | Wide/emoji width parity between pi-tui and OpenTUI | `src/bridge/ansi.ts` | native | open: `T:wide characters count two cells`; OpenTUI and pi-tui width tables differ for some emoji (documented) |

## 2. Editor (phase 2)

| | Item | Source | Owner | Verify |
| --- | --- | --- | --- | --- |
| [x] | Cursor movement keys `tui.editor.cursor*`, word, line, page, jump | `tkb:9-22`, `ed:1899-2195` | native | the prompt editor is the bridged pi-tui `CustomEditor` (pi-tui editor tests); keys reach it through `T:forwards keys and pastes to handleInput while focused` |
| [x] | Deletion keys `tui.editor.delete*` | `tkb:23-28` | native | same editor component as the built-in TUI (pi-tui editor tests) |
| [x] | Kill ring: yank, yank-pop | `tkb:29-30`, `ed:2003-2083` | native | same editor component as the built-in TUI (pi-tui editor tests) |
| [x] | Undo | `tkb:31`, `ed:2125` | native | same editor component as the built-in TUI (pi-tui editor tests) |
| [x] | Submit / newline (`tui.input.submit`, `tui.input.newLine`, backslash-enter) | `tkb:33-34`, `ed:1358` | native | `T:a typed prompt streams …` (submit); newline via the same editor |
| [x] | History previous/next (first/last visual line) | `tkb:11-12`, `ed:459` | native | `T:a typed prompt streams …` (up arrow recalls the prompt) |
| [x] | Bracketed paste; large pastes collapse into markers; `getExpandedText` | `ed:1265`, `ed:1095` | native | `T:large pastes collapse into a marker and expand on read; terminal input listeners see the paste` |
| [x] | Autocomplete: slash commands, argument completions, files (`@`), tab, debounce, trigger chars | `ed:2195-2474`, `im:665-781` | native | `T:slash autocomplete lists matching commands with descriptions` |
| [x] | `CombinedAutocompleteProvider` reuse + extension `addAutocompleteProvider` wrappers | `im:765`, `ext:238` | native | `T:addAutocompleteProvider wraps the provider` |
| [x] | Built-in/extension command conflict diagnostics | `im:650` | native | `T:built-in command conflicts are reported in the loaded resources` |
| [ ] | Border color: thinking level, bash mode, plan mode | `im:4264`, `c/custom-editor.ts:46` | native | open: `T:editor border follows bash mode`; thinking-level and plan-mode colors not asserted (faux model has no reasoning; plan mode needs the nek extension in the fixture) |
| [x] | Bash mode (`!`/`!!`) submit path, "already running" warning | `im:3133-3149` | native | `T:bash mode runs the command and shows the output block` |
| [x] | Submit while streaming steers; while compacting queues | `im:3151-3172` | native | `T:submitting while streaming queues a steering message` |
| [x] | Follow-up queue (`app.message.followUp`) and dequeue (`app.message.dequeue`) | `im:4223`, `im:4255` | native | `T:follow-up queue and dequeue use their keybindings` |
| [x] | Pending messages display | `im:4425` | native | `T:submitting while streaming queues a steering message` |
| [ ] | External editor (`app.editor.external`) via `external-editor.ts` | `im:4350` | native | open: M: ctrl+g opens $EDITOR (renderer suspended via `runExternal`) |
| [ ] | Clipboard image paste (`app.clipboard.pasteImage`) with text fallback | `im:2962` | native | open: M: paste screenshot |
| [ ] | Right-click paste | `im:530`, `alt:1001` | native | open: M: right click |
| [ ] | Startup submit guard ("Startup is still in progress") | `im:2987` | native | open: ported; no test yet |
| [ ] | Editor padding, autocomplete max visible settings | `im:1934-1941` | native | open: `T:runtime settings re-apply editor padding`; autocomplete max visible not asserted |
| [x] | Working indicator embedded in editor border | `c/custom-editor.ts:41`, `im:2120` | native | `T:the working indicator shows the extension message while streaming` |
| [ ] | Drop files to attach | `im:968` | native | open: M: drag a file into the terminal |

## 3. Footer, widgets, panels, working indicator, notifications (phase 3)

| | Item | Source | Owner | Verify |
| --- | --- | --- | --- | --- |
| [x] | Footer component hosted (cwd, branch, tokens, cache, context %, cost, model, thinking, auto-compact) | `c/footer.ts:150` | native | `T:lays out header, editor, and footer with the editor focused` |
| [x] | Footer: session name, provider count, extension statuses (`setStatus`) | `c/footer.ts`, `im:2109`, `ext:161` | native | `T:extension widgets, statuses, and custom components render through the UI context` |
| [ ] | Git branch watcher re-render | `im:1032` | native | open: M: switch branch while running |
| [x] | Extension footer replacement (`setFooter`) | `im:2341`, `ext:196` | native | `T:custom header and footer replace the built-in ones and restore` |
| [x] | Extension header replacement (`setHeader`) | `im:2368`, `ext:203` | native | `T:custom header and footer replace the built-in ones and restore` |
| [x] | Widgets above/below editor (string lines or components, max 10 lines) | `im:2213-2330`, `ext:183-195` | native | `T:extension widgets, statuses, and custom components …`, `T:reload resets extension UI, rebinds, and reports` |
| [x] | Working indicator: message, visibility, custom frames, hidden-thinking label | `im:2161-2200`, `ext:164-180` | native | `T:the working indicator shows the extension message while streaming`, `T:thinking visibility, hidden label …` |
| [x] | Interrupt hint uses configured `app.interrupt` key | `im:2296` | native | `T:interrupt hints use the configured app.interrupt key` |
| [x] | Notifications (`notify` info/warning/error) | `im:2762`, `ext:155` | native | `T:notify levels, warnings, and errors go to the transcript; status lines collapse` |
| [x] | Flash/toast messages (copy confirmation) | `alt:644` | native | `T:flash shows a transient toast` |
| [ ] | Terminal title (`setTitle`, session name + cwd) | `im:1051`, `ext:206` | native | open: `renderer.setTerminalTitle`; the test renderer does not expose the title |
| [ ] | Terminal progress (OSC 9;4) per `showTerminalProgress` | `im:3212`, `im:3434` | native | open: M: progress in Windows Terminal (written to stdout, see docs) |
| [ ] | Theme hot reload (`onThemeChange`), terminal color queries, auto light/dark | `im:1025`, `theme/theme-controller.ts` | native | open: `T:setTheme switches the theme and the shell shades`; terminal background queries are not forwarded (documented) |
| [x] | Runtime settings re-apply (`applyRuntimeSettings`) | `im:1916` | native | `T:runtime settings re-apply editor padding` |
| [x] | `/reload` progress box and rebind (mode side: `ModeContext.reload`) | `im:6037` | native | `T:reload resets extension UI, rebinds, and reports` |
| [ ] | Anthropic subscription auth warning | `im:4968` | native | open: ported (`maybeWarnAboutAnthropicSubscriptionAuth`); needs Anthropic auth to test |
| [ ] | tmux keyboard setup warning | `im:1158` | native | open: startup flow (`commands`, `src/startup`); M: tmux without extended-keys |
| [x] | Debug log (`ModeContext.writeDebugLog`) | `im:6524` | native | `T:debug log writes the rendered lines` |

## 4. Fullscreen, scroll, search, selection, suspend/exit (phase 4)

| | Item | Source | Owner | Verify |
| --- | --- | --- | --- | --- |
| [x] | Transcript scroll keys `tui.altScreen.pageUp/Down`, `halfPage*`, `line*`, `top`, `bottom` | `alt:727-770`, `tkb:45-58` | native | `T:PageUp scrolls the transcript and search highlights matches` |
| [ ] | Mouse wheel scroll, scrollbar drag/hover (`fullscreen-scrollbar`) | `alt:942-1116` | native | open: M: wheel and scrollbar drag (native ScrollBox) |
| [x] | Sticky bottom; scroll-to-end indicator | `alt:1019`, `alt:1624` | native | `T:PageUp scrolls the transcript and search highlights matches` (indicator, scroll to bottom) |
| [x] | Prompt jumps (`tui.altScreen.previousPrompt/nextPrompt`) | `alt:485`, `alt:755-762` | native | `T:renders every message kind on load` (prompt rows); keys share the scroll-key path |
| [x] | Transcript search: open/close, next/prev, match highlight, navigation buttons | `alt:499-640`, `search:156-260` | native | `T:PageUp scrolls the transcript and search highlights matches` |
| [ ] | Mouse selection (word/line clicks, auto-scroll), copy-on-select (`fullscreen-copy-on-select`) | `alt:1120-1452` | native | open: M: drag-select copies (OpenTUI selection; word/line clicks are OpenTUI's) |
| [ ] | `tui.input.copy` copies selection; `app.message.copy` copies last message or selection | `tkb:36`, `im:2922` | native | open: `app.message.copy` copies the selection when copy-on-select is off; M: needs mouse selection |
| [x] | `tui-mode` regular vs fullscreen behavior and exit output (`fullscreen-exit-output`) | `im:813-880`, `im:821` | native | `T:regular TUI mode *`; H:regular (`--tui-mode regular`: scrollback, footer, dialog, exit keeps the transcript), H:switch (`/settings` switches both ways) |
| [ ] | Suspend (`app.suspend`): SIGTSTP, ignore SIGINT while suspended, restore on SIGCONT (no-op on Windows) | `im:4186` | native | open: M: ctrl+z then fg (status message on Windows) |
| [x] | Double `app.clear` exits; `app.exit` exits on empty editor | `im:4024-4037` | native | `T:double app.clear and app.exit on an empty editor shut down`; H:checklist (Ctrl+D exits, transcript printed) |
| [x] | Single `app.clear` clears the editor | `im:4029` | native | `T:app.clear clears the editor` |
| [x] | Interrupt (`app.interrupt`): abort streaming, abort bash, leave bash mode, double-escape tree/fork | `im:2880-2906` | native | `T:the working indicator shows the extension message while streaming` (escape aborts), `T:submitting while streaming queues a steering message` |
| [ ] | Graceful shutdown: resume hint, `session_shutdown`, signal handlers (SIGTERM/SIGHUP) | `im:4046`, `im:4139` | native | open: M: kill -TERM shows a clean terminal |
| [ ] | Uncaught exception: restore terminal, crash record, extension hint | `im:4107`, `im:2000` | native | open: ported; M: throw from an extension |
| [ ] | Terminal EIO emergency exit | `im:4087`, `im:4166` | native | open: M: close the terminal tab |
| [x] | Resize: layout and hosted components follow width | `src/bridge/component-host.ts` | native | `T:re-renders on width changes and on tui.requestRender` |
| [ ] | Kitty keyboard protocol sync with pi-tui key decoding | `src/mode/renderer-host.ts` | native | open: M: shift+enter in Kitty/WezTerm |

## 5. Extension UI (phase 5)

| | Item | Source | Owner | Verify |
| --- | --- | --- | --- | --- |
| [x] | `select` (with timeout/signal) | `ext:146`, `im:2507` | native | `T:extension select dialogs resolve the chosen option`, `T:dialogs resolve undefined on abort and timeout` |
| [x] | `confirm` | `ext:149`, `im:2563` | native | `T:confirm dialog resolves true for Yes and false on cancel` |
| [x] | `input` | `ext:152`, `im:2583` | native | `T:input dialog submits the typed text` |
| [x] | `editor` | `ext:235`, `im:2639` | native | `T:editor dialog inserts newlines and submits multi-line text` |
| [x] | `custom(factory(tui, theme, keybindings, done), { overlay })` incl. overlay options | `ext:209`, `im:2773` | native | `T:extension widgets, statuses, and custom components render through the UI context` (inline); overlay mode uses `tui.showOverlay` |
| [x] | pi-tui `tui.showOverlay` / `hideOverlay` from extension components | `src/bridge/facade-tui.ts` | native | `T:pi-tui overlays show above the shell and give focus back when hidden` |
| [x] | `onTerminalInput` (incl. pastes) | `ext:158`, `im:2409` | native | `T:large pastes collapse into a marker …` (listener sees the paste) |
| [x] | `pasteToEditor`, `setEditorText`, `getEditorText` | `ext:226-232` | native | `T:extension editor text APIs` |
| [x] | `setEditorComponent` / `getEditorComponent` (custom editors via bridge) | `ext:273-276`, `im:2681` | native | `T:setEditorComponent swaps the editor and keeps the text and submit handler` |
| [x] | `getAllThemes`, `getTheme`, `setTheme`, `theme` | `ext:279-288` | native | `T:setTheme switches the theme and the shell shades` |
| [x] | `getToolsExpanded` / `setToolsExpanded` | `ext:290-293` | native | `T:thinking visibility, hidden label, and tool expansion update rendered messages` |
| [ ] | Extension shortcuts (`registerShortcut`) with conflict handling | `im:2049` | native | open: `T:extension shortcuts run their handlers`; conflict handling not tested |
| [x] | `resetExtensionUI` on session invalidate/reload | `im:2267` | native | `T:reload resets extension UI, rebinds, and reports` |
| [ ] | Command context actions: newSession, fork, navigateTree, switchSession, reload, waitForIdle | `im:1843-1891` | native | open: `T:command context actions: newSession and waitForIdle`; fork, navigateTree, switchSession, reload not tested |
| [x] | nek: plan approval (`custom`, `select`) | `extensions/nek/ui/plan-approval.ts:52` | native | H:mgr-nek (live `create_plan`: plan preview in transcript, approval panel Implement/Fresh context/Keep planning/Exit; screen identical to the built-in TUI run H:mgr-old-plan) |
| [x] | nek: question dialog (`custom`, `select`, `input`, `confirm`) | `extensions/nek/ui/question-dialog.ts:55` | native | H:live (`ask_question` dialog in the editor slot, answer `choice: A`) |
| [x] | nek: plan view and todo widgets (`setWidget`) | `extensions/nek/ui/plan-view.ts:41`, `todo-widget.ts:51` | native | H:live (`Todos 0/2 ▶ Check docs`); H:mgr-nek (plan status widget `Ready for review  Print hello / r1`, `/plans` selector) |
| [ ] | nek: subagent view (`select`, `custom`) | `extensions/nek/ui/subagent-view.ts:369` | native | open: H:mgr-nek `/agents` lists agent types; the `/subagents` view with live subagent records not exercised |
| [x] | nek: mode status (`setStatus`) | `extensions/nek/plan-wiring.ts:201` | native | H:mgr-nek (`/plan`: `Drafting plan  alt+m switch mode  /agent exit`, `PLAN` in the editor border) |
| [ ] | MCP: `/mcp` panel (`custom`), auth prompts (`select`, `input`) | `extensions/mcp/ui.ts:241`, `extensions/mcp/index.ts:879` | native | open: H:mgr-nek `/mcp` panel opens and closes with escape (no servers configured); server list and auth prompts need a configured server |
| [x] | Easter egg components (Armin, Daxnuts, Earendil announcement) render via bridge | `c/armin.ts`, `c/daxnuts.ts` | commands | `T:/arminsayshi and /dementedelves render their components` |

## 6. Slash commands (phase 1-6, parallel)

| | Item | Source | Owner | Verify |
| --- | --- | --- | --- | --- |
| [x] | Dispatch: exact `/name`, `/name args` for argument commands, editor clear timing | `im:2998-3131` | native | `T:matching follows the interactive mode` |
| [x] | `/settings` (all settings ids incl. theme, tui-mode, fullscreen-*, images, warnings) | `im:4611`, `c/settings-selector.ts:147-738` | commands | `T:/settings toggles auto-compact`, `T:/settings routes keys to the settings list: type to filter, Esc closes`; H:overlays, H:switch |
| [x] | `/model [search]` + argument completions | `im:4900`, `im:673` | commands | `T:/model with a unique match switches without a selector`, `T:/model runs the selector dispose when the overlay closes`, `T:preserves argument matching and completions`; H:checklist |
| [x] | `/thinking [level]` + completions | `im:4851`, `im:699` | commands | `T:/thinking with a level sets it; an unknown level is an error`; H:overlays (selector); completions share `fuzzyFilter` with `/model` |
| [x] | `/scoped-models` (`app.models.*` keys) | `im:5086`, `c/scoped-models-selector.ts` | commands | `T:/scoped-models saves the selection with its save key`, `T:/scoped-models closes with Esc`; H:checklist |
| [x] | `/export [path]` | `im:6127` | commands | `T:/export writes html and jsonl; /import replaces the session after confirmation` |
| [x] | `/import <path>` | `im:6174` | commands | `T:/export writes html and jsonl; /import replaces the session after confirmation` |
| [ ] | `/share` | `im:6218` | commands | open: creates a real GitHub gist (needs `gh` auth and network); not run |
| [ ] | `/copy` | `im:2922` | commands | open: `T:/copy without a reply reports it; ...`; copying a reply writes the system clipboard, not run in tests |
| [x] | `/name [name]` | `im:6260` | commands | `T:/copy without a reply reports it; /name sets the session name; /session shows stats` |
| [x] | `/session` | `im:6284` | commands | `T:/copy without a reply reports it; /name sets the session name; /session shows stats` |
| [x] | `/changelog` | `im:6357` | commands | `T:/changelog renders the What's New block` |
| [x] | `/hotkeys` (from configured keybindings) | `im:6392` | commands | `T:matches the interactive mode's table, including extension shortcuts` |
| [x] | `/fork` | `im:5208`, `c/user-message-selector.ts` | commands | `T:/fork puts the selected message in the editor of a new session`, `T:/fork routes keys to the message list` |
| [x] | `/clone` | `im:5246` | commands | `T:/clone duplicates the session at the current leaf` |
| [x] | `/tree` (`app.tree.*` keys, filters, labels) | `im:5267`, `c/tree-selector.ts` | commands | `T:/tree navigates to an earlier entry`; H:checklist, H:live |
| [x] | `/trust` | `im:5024`, `c/trust-selector.ts` | commands | `T:/trust saves a decision` |
| [ ] | `/login [provider]` + completions; OAuth, API key, ambient auth dialogs | `im:5552-6036`, `c/login-dialog.ts`, `c/oauth-selector.ts` | commands | open: `T:/login <provider> runs the API key flow; /logout removes the stored key`; H:live (`/login` list, Esc); OAuth and ambient-auth flows need real providers |
| [x] | `/logout` | `im:5686` | commands | `T:/login <provider> runs the API key flow; /logout removes the stored key` |
| [x] | `/new` | `im:6509` | commands | `T:/new starts an empty session` |
| [x] | `/compact [instructions]` | `im:6674` | commands | `T:/compact runs session compaction and reports its result` |
| [x] | `/reload` | `im:6037` | commands | `T:/reload reloads resources and gives the editor back` |
| [x] | `/debug` (hidden) | `im:6524` | commands | `T:/debug writes the debug log` |
| [x] | `/resume` (`app.session.*` keys) | `im:5416`, `c/session-selector.ts` | commands | `T:/resume switches to a stored session`; H:live |
| [x] | `/quit` | `im:3127` | commands | `T:/quit shuts down` |
| [x] | `/arminsayshi`, `/dementedelves` | `im:6557-6580` | commands | `T:/arminsayshi and /dementedelves render their components` |
| [x] | Extension commands, prompt templates, `skill:` commands fall through to `session.prompt` | `im:727-756` | native | `T:an extension command falls through to the extension handler` |

## 7. Command-owned keys and lifecycle flows

| | Item | Source | Owner | Verify |
| --- | --- | --- | --- | --- |
| [x] | `app.thinking.cycle` | `im:4281` | commands | `T:thinking and model cycling report the faux model's limits` (non-reasoning model path) |
| [x] | `app.model.cycleForward` / `cycleBackward` (scoped models) | `im:4292` | commands | `T:thinking and model cycling report the faux model's limits` (single-model path) |
| [x] | `app.model.select`, `app.session.new/tree/fork/resume` open command flows | `im:2918-2931` | commands | `T:app.model.select opens the model selector`; the session keys run the same command handlers (`T:/new`, `/tree`, `/fork`, `/resume` tests) |
| [x] | `app.tools.expand` (tools, header) | `im:4311` | native | `T:thinking visibility, hidden label, and tool expansion update rendered messages` (the key action calls the same `setToolsExpanded`) |
| [x] | `app.thinking.toggle` | `im:4343` | native | `T:thinking visibility, hidden label, and tool expansion update rendered messages` (the key action persists the setting and calls `setHideThinkingBlock`) |
| [ ] | First-time setup (theme, analytics) | `c/first-time-setup.ts`, `main.ts:668` | commands | open: `shouldRunFirstTimeSetup` requires the official distribution and experimental features; H:firstrun with a fresh agent dir starts without it (same gate as the built-in TUI) |
| [x] | `--resume` session picker (pre-mode) | `main.ts:403` | commands | H:resume (picker, key hints fixed, Esc exits) |
| [ ] | `--session` fork confirmation (pre-mode) | `main.ts:389` | commands | open: needs a session from another project; not run |
| [ ] | Project trust prompts at startup and on session switch | `cli/project-trust.ts`, `im:2435` | commands | open: needs an untrusted project with trust-requiring resources; not run |
| [ ] | Missing session cwd prompt | `main.ts:547` | commands | open: needs a stored session whose cwd was deleted; not run |
| [ ] | Deprecation warnings acknowledgement | `main.ts:908` | commands | open: needs a legacy extension layout; not run |
| [x] | Startup notices: changelog, diagnostics, migrated providers, models.json error, model fallback, crash notice | `im:783`, `im:1094-1121` | commands | `T:startup diagnostics show once the mode is ready` |
| [ ] | Model catalog refresh and provider count | `im:1068-1075`, `im:4959` | commands | open: refresh verified in H:checklist (`Model catalogs refreshed.`); provider count not asserted |
| [ ] | Implicit project trust save after reload | `im:4998` | commands | open: needs `autoTrustOnReloadCwd` from a trust prompt; not tested |

## 8. Removal and docs (phase 7)

| | Item | Source | Owner | Verify |
| --- | --- | --- | --- | --- |
| [x] | Remove RPC frontend (`src/rpc`, `src/state`, `src/app.ts`, `src/keys.ts`, old tests) | `packages/opentui/src` | native | `npm run check` |
| [x] | Rewrite `packages/coding-agent/docs/opentui.md` | `docs/opentui.md` | native | review |
