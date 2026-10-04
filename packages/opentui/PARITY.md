# OpenTUI native frontend: parity checklist

Feature parity of `nek --ui opentui` (native OpenTUI, same process) with the pi-tui interactive mode.
Every item names its source, owner, and how it is verified.

- **Owner** `native`: the native-UI worker (`feat/opentui-native`), in `src/mode`, `src/bridge`, `src/ui`, `src/theme`.
- **Owner** `commands`: the commands worker (`feat/opentui-commands`), in `src/commands/*` (except `registry.ts`), `src/selectors/*`, `src/startup/*`.
- **Verify** `T:<name>` means a `bun test` case in `test/native/` (written or to be written by the owner). `M:<steps>` means a manual check in a real terminal with `nek --ui opentui`.
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
| [x] | Shell layout: header, transcript, pending, status, widgets above/below, editor, footer, overlay layer | `src/mode/shell.ts` | native | `T:lays out transcript, editor, and footer` |
| [x] | Basic loop: type prompt, stream assistant text and tool rows | `im:3286-3431` | native | `T:a typed prompt streams the assistant reply and tool rows into the transcript` |
| [x] | Command registry, `ModeContext`, selector and startup contracts, one stub per built-in command | `src/commands/registry.ts` | native | `T:command registry *`, `T:built-in commands dispatch through the registry and clear the editor` |

## 1. Transcript and message rendering (phase 1)

| | Item | Source | Owner | Verify |
| --- | --- | --- | --- | --- |
| [ ] | User messages (markdown, `userMessageBg`, OSC 133 prompt zones for prompt jumps) | `c/user-message.ts`, `im:3691` | native | T:user message block |
| [ ] | Assistant messages: markdown, code highlight, tables | `c/assistant-message.ts`, `im:3732` | native | T:assistant markdown renders table and code |
| [ ] | Thinking blocks; hidden label (`setHiddenThinkingLabel`); per-block visibility override | `c/assistant-message.ts:58-73`, `im:2197` | native | T:thinking toggle |
| [ ] | Mermaid rendering per `mermaid-rendering` setting | `c/mermaid.ts`, `im:467` | native | T:mermaid transformer applied |
| [ ] | LaTeX/markdown transformers from extensions (`getMarkdownTransformers`) | `im:2042` | native | T:extension markdown transformer |
| [ ] | Tool rows: pending/success/error backgrounds, args streaming, partial results, expand/collapse | `c/tool-execution.ts`, `im:3390-3431` | native | T:tool row states |
| [ ] | Built-in tool renderers (read, bash, edit diff, write, grep, find, ls, ast_grep) | `core/tools/renderers/*` | native | T:edit tool diff row |
| [ ] | Web Search tool row in blue (`mdLink`) | `core/tools/renderers/web-search.ts:12` | native | T:web search row color |
| [ ] | Custom tool `renderCall`/`renderResult` components from extensions | `ext:534-540` | native | T:extension tool renderer |
| [ ] | Images in tool results (`show-images`, `image-width-cells`, Kitty/iTerm) | `im:3323` | native | M: read a PNG with show-images on |
| [ ] | Bash execution blocks (`!`, `!!`), streaming output, exit code, excluded marker | `c/bash-execution.ts`, `im:6581` | native | T:bash mode block |
| [ ] | Compaction summary message (collapsed/expanded) | `c/compaction-summary-message.ts`, `im:3675` | native | T:compaction summary |
| [ ] | Branch summary message | `c/branch-summary-message.ts`, `im:3682` | native | T:branch summary |
| [ ] | Custom messages (`display`), extension message renderers | `c/custom-message.ts`, `im:3661` | native | T:custom message renderer |
| [ ] | Custom entries (`addCustomEntryToChat`) | `c/custom-entry.ts`, `im:3623` | native | T:custom entry |
| [ ] | Skill invocation message | `c/skill-invocation-message.ts` | native | T:skill invocation block |
| [ ] | Entry-appended handling incl. boundary compaction rebuild | `im:3230-3273` | native | T:compaction rebuild keeps retained entries |
| [ ] | Aborted/error assistant messages mark pending tools as failed | `im:3345-3384` | native | T:abort marks tools failed |
| [ ] | Cache-miss, cache-warming, compaction-cost, thinking-drop notices | `im:3870-3960` | native | T:usage notices |
| [ ] | Project-not-trusted warning in transcript | `im:3981` | native | T:trust warning shown |
| [ ] | "Session compacted N times" status on load | `im:3972` | native | T:compaction count status |
| [ ] | Session history render on load/switch (`renderInitialMessages`, `populateHistory`) | `im:3964`, `im:3754` | native | T:history renders tool results |
| [ ] | `showStatus` replaces consecutive status lines; `showWarning`/`showError` | `im:3603`, `im:4377-4383` | native | T:status lines collapse |
| [ ] | Managed tool (fd/rg) download status lines | `im:3584`, `im:1007` | native | M: first run without fd |
| [ ] | Startup header (logo, compact/expanded key hints from keybindings, onboarding) | `im:943-1001` | native | T:header uses configured keys |
| [ ] | Loaded resources listing (context files, skills, prompts, extensions, themes, diagnostics) | `im:1618` | native | T:loaded resources listing |
| [ ] | Extension errors in transcript (`showExtensionError`) | `im:2855` | native | T:extension error block |
| [ ] | Retry indicator with countdown (`auto_retry_start/end`) | `c/status-indicator.ts:50`, `im:3517` | native | T:retry countdown |
| [ ] | Compaction indicator and abort (`compaction_start/end`) | `im:3452-3516` | native | T:compaction indicator |
| [ ] | Summarization retry events | `im:3545-3573` | native | T:summarization retry status |
| [ ] | Highlight grammar lazy load re-render | `im:1041` | native | M: code block highlights after start |
| [ ] | Wide/emoji width parity between pi-tui and OpenTUI | `src/bridge/ansi.ts` | native | T:wide characters in hosted component |

## 2. Editor (phase 2)

| | Item | Source | Owner | Verify |
| --- | --- | --- | --- | --- |
| [ ] | Cursor movement keys `tui.editor.cursor*`, word, line, page, jump | `tkb:9-22`, `ed:1899-2195` | native | T:editor cursor keys follow keybindings |
| [ ] | Deletion keys `tui.editor.delete*` | `tkb:23-28` | native | T:editor delete keys |
| [ ] | Kill ring: yank, yank-pop | `tkb:29-30`, `ed:2003-2083` | native | T:yank and yank-pop |
| [ ] | Undo | `tkb:31`, `ed:2125` | native | T:undo |
| [ ] | Submit / newline (`tui.input.submit`, `tui.input.newLine`, backslash-enter) | `tkb:33-34`, `ed:1358` | native | T:submit and newline bindings |
| [ ] | History previous/next (first/last visual line) | `tkb:11-12`, `ed:459` | native | T:history navigation |
| [ ] | Bracketed paste; large pastes collapse into markers; `getExpandedText` | `ed:1265`, `ed:1095` | native | T:large paste marker expands on submit |
| [ ] | Autocomplete: slash commands, argument completions, files (`@`), tab, debounce, trigger chars | `ed:2195-2474`, `im:665-781` | native | T:slash autocomplete lists built-ins and extension commands |
| [ ] | `CombinedAutocompleteProvider` reuse + extension `addAutocompleteProvider` wrappers | `im:765`, `ext:238` | native | T:autocomplete provider wrapper |
| [ ] | Built-in/extension command conflict diagnostics | `im:650` | native | T:conflict diagnostic |
| [ ] | Border color: thinking level, bash mode, plan mode | `im:4264`, `c/custom-editor.ts:46` | native | T:editor border follows thinking level |
| [ ] | Bash mode (`!`/`!!`) submit path, "already running" warning | `im:3133-3149` | native | T:bash submit |
| [ ] | Submit while streaming steers; while compacting queues | `im:3151-3172` | native | T:steer while streaming |
| [ ] | Follow-up queue (`app.message.followUp`) and dequeue (`app.message.dequeue`) | `im:4223`, `im:4255` | native | T:follow-up queued and restored |
| [ ] | Pending messages display | `im:4425` | native | T:pending messages shown |
| [ ] | External editor (`app.editor.external`) via `external-editor.ts` | `im:4350` | native | M: ctrl+g opens $EDITOR |
| [ ] | Clipboard image paste (`app.clipboard.pasteImage`) with text fallback | `im:2962` | native | M: paste screenshot |
| [ ] | Right-click paste | `im:530`, `alt:1001` | native | M: right click in fullscreen |
| [ ] | Startup submit guard ("Startup is still in progress") | `im:2987` | native | T:submit during startup |
| [ ] | Editor padding, autocomplete max visible settings | `im:1934-1941` | native | T:settings applied to editor |
| [ ] | Working indicator embedded in editor border | `c/custom-editor.ts:41`, `im:2120` | native | T:working indicator in border |
| [ ] | Drop files to attach | `im:968` | native | M: drag file into terminal |

## 3. Footer, widgets, panels, working indicator, notifications (phase 3)

| | Item | Source | Owner | Verify |
| --- | --- | --- | --- | --- |
| [x] | Footer component hosted (cwd, branch, tokens, cache, context %, cost, model, thinking, auto-compact) | `c/footer.ts:150` | native | `T:lays out transcript, editor, and footer` |
| [ ] | Footer: session name, provider count, extension statuses (`setStatus`) | `c/footer.ts`, `im:2109`, `ext:161` | native | T:extension status in footer |
| [ ] | Git branch watcher re-render | `im:1032` | native | M: switch branch while running |
| [ ] | Extension footer replacement (`setFooter`) | `im:2341`, `ext:196` | native | T:custom footer component |
| [ ] | Extension header replacement (`setHeader`) | `im:2368`, `ext:203` | native | T:custom header component |
| [ ] | Widgets above/below editor (string lines or components, max 10 lines) | `im:2213-2330`, `ext:183-195` | native | T:widget placement |
| [ ] | Working indicator: message, visibility, custom frames, hidden-thinking label | `im:2161-2200`, `ext:164-180` | native | T:working indicator options |
| [ ] | Interrupt hint uses configured `app.interrupt` key | `im:2296` | native | T:working message shows configured key |
| [ ] | Notifications (`notify` info/warning/error) | `im:2762`, `ext:155` | native | T:notify levels |
| [ ] | Flash/toast messages (copy confirmation) | `alt:644` | native | T:flash toast |
| [ ] | Terminal title (`setTitle`, session name + cwd) | `im:1051`, `ext:206` | native | T:title updated on rename |
| [ ] | Terminal progress (OSC 9;4) per `showTerminalProgress` | `im:3212`, `im:3434` | native | M: progress in Windows Terminal |
| [ ] | Theme hot reload (`onThemeChange`), terminal color queries, auto light/dark | `im:1025`, `theme/theme-controller.ts` | native | T:theme change re-renders hosted components |
| [ ] | Runtime settings re-apply (`applyRuntimeSettings`) | `im:1916` | native | T:applySettings |
| [ ] | `/reload` progress box and rebind (mode side: `ModeContext.reload`) | `im:6037` | native | T:reload rebinds extensions |
| [ ] | Anthropic subscription auth warning | `im:4968` | native | T:anthropic warning once |
| [ ] | tmux keyboard setup warning | `im:1158` | native | M: run inside tmux without extended-keys |
| [ ] | Debug log (`ModeContext.writeDebugLog`) | `im:6524` | native | T:debug log written |

## 4. Fullscreen, scroll, search, selection, suspend/exit (phase 4)

| | Item | Source | Owner | Verify |
| --- | --- | --- | --- | --- |
| [ ] | Transcript scroll keys `tui.altScreen.pageUp/Down`, `halfPage*`, `line*`, `top`, `bottom` | `alt:727-770`, `tkb:45-58` | native | T:scroll keys follow keybindings |
| [ ] | Mouse wheel scroll, scrollbar drag/hover (`fullscreen-scrollbar`) | `alt:942-1116` | native | M: wheel and drag scrollbar |
| [ ] | Sticky bottom; scroll-to-end indicator | `alt:1019`, `alt:1624` | native | T:sticky scroll resumes at bottom |
| [ ] | Prompt jumps (`tui.altScreen.previousPrompt/nextPrompt`) | `alt:485`, `alt:755-762` | native | T:prompt jumps |
| [ ] | Transcript search: open/close, next/prev, match highlight, navigation buttons | `alt:499-640`, `search:156-260` | native | T:search highlights matches |
| [ ] | Mouse selection (word/line clicks, auto-scroll), copy-on-select (`fullscreen-copy-on-select`) | `alt:1120-1452` | native | M: drag-select copies |
| [ ] | `tui.input.copy` copies selection; `app.message.copy` copies last message or selection | `tkb:36`, `im:2922` | native | T:copy key copies selection |
| [ ] | `tui-mode` regular vs fullscreen behavior and exit output (`fullscreen-exit-output`) | `im:813-880`, `im:821` | native | M: exit prints transcript when set |
| [ ] | Suspend (`app.suspend`): SIGTSTP, ignore SIGINT while suspended, restore on SIGCONT (no-op on Windows) | `im:4186` | native | M: ctrl+z then fg |
| [ ] | Double `app.clear` exits; `app.exit` exits on empty editor | `im:4024-4037` | native | T:double clear exits |
| [x] | Single `app.clear` clears the editor | `im:4029` | native | `T:app.clear clears the editor` |
| [ ] | Interrupt (`app.interrupt`): abort streaming, abort bash, leave bash mode, double-escape tree/fork | `im:2880-2906` | native | T:interrupt restores queued messages |
| [ ] | Graceful shutdown: resume hint, `session_shutdown`, signal handlers (SIGTERM/SIGHUP) | `im:4046`, `im:4139` | native | M: kill -TERM shows clean terminal |
| [ ] | Uncaught exception: restore terminal, crash record, extension hint | `im:4107`, `im:2000` | native | T:fatal error restores terminal |
| [ ] | Terminal EIO emergency exit | `im:4087`, `im:4166` | native | M: close terminal tab |
| [ ] | Resize: layout and hosted components follow width | `src/bridge/component-host.ts` | native | `T:re-renders on width changes and on tui.requestRender` |
| [ ] | Kitty keyboard protocol sync with pi-tui key decoding | `src/mode/renderer-host.ts` | native | M: shift+enter in Kitty/WezTerm |

## 5. Extension UI (phase 5)

| | Item | Source | Owner | Verify |
| --- | --- | --- | --- | --- |
| [ ] | `select` (with timeout/signal) | `ext:146`, `im:2507` | native | T:extension select dialog |
| [ ] | `confirm` | `ext:149`, `im:2563` | native | T:extension confirm dialog |
| [ ] | `input` | `ext:152`, `im:2583` | native | T:extension input dialog |
| [ ] | `editor` | `ext:235`, `im:2639` | native | T:extension editor dialog |
| [ ] | `custom(factory(tui, theme, keybindings, done), { overlay })` incl. overlay options | `ext:209`, `im:2773` | native | T:custom component overlay |
| [ ] | pi-tui `tui.showOverlay` / `hideOverlay` from extension components | `src/bridge/facade-tui.ts` | native | T:facade overlay maps to stack |
| [ ] | `onTerminalInput` (incl. pastes) | `ext:158`, `im:2409` | native | T:terminal input listener sees paste |
| [ ] | `pasteToEditor`, `setEditorText`, `getEditorText` | `ext:226-232` | native | T:editor text APIs |
| [ ] | `setEditorComponent` / `getEditorComponent` (custom editors via bridge) | `ext:273-276`, `im:2681` | native | T:custom editor component |
| [ ] | `getAllThemes`, `getTheme`, `setTheme`, `theme` | `ext:279-288` | native | T:extension setTheme |
| [ ] | `getToolsExpanded` / `setToolsExpanded` | `ext:290-293` | native | T:tools expanded API |
| [ ] | Extension shortcuts (`registerShortcut`) with conflict handling | `im:2049` | native | T:extension shortcut runs |
| [ ] | `resetExtensionUI` on session invalidate/reload | `im:2267` | native | T:widgets cleared on reload |
| [ ] | Command context actions: newSession, fork, navigateTree, switchSession, reload, waitForIdle | `im:1843-1891` | native | T:extension newSession |
| [ ] | nek: plan approval (`custom`, `select`) | `extensions/nek/ui/plan-approval.ts:52` | native | M: /plan then approve |
| [ ] | nek: question dialog (`custom`, `select`, `input`, `confirm`) | `extensions/nek/ui/question-dialog.ts:55` | native | M: ask_user tool |
| [ ] | nek: plan view and todo widgets (`setWidget`) | `extensions/nek/ui/plan-view.ts:41`, `todo-widget.ts:51` | native | M: /todos |
| [ ] | nek: subagent view (`select`, `custom`) | `extensions/nek/ui/subagent-view.ts:369` | native | M: /subagents |
| [ ] | nek: mode status (`setStatus`) | `extensions/nek/plan-wiring.ts:201` | native | M: footer shows plan |
| [ ] | MCP: `/mcp` panel (`custom`), auth prompts (`select`, `input`) | `extensions/mcp/ui.ts:241`, `extensions/mcp/index.ts:879` | native | M: /mcp |
| [ ] | Easter egg components (Armin, Daxnuts, Earendil announcement) render via bridge | `c/armin.ts`, `c/daxnuts.ts` | commands | M: /arminsayshi |

## 6. Slash commands (phase 1-6, parallel)

| | Item | Source | Owner | Verify |
| --- | --- | --- | --- | --- |
| [x] | Dispatch: exact `/name`, `/name args` for argument commands, editor clear timing | `im:2998-3131` | native | `T:matching follows the interactive mode` |
| [ ] | `/settings` (all settings ids incl. theme, tui-mode, fullscreen-*, images, warnings) | `im:4611`, `c/settings-selector.ts:147-738` | commands | T:settings selector toggles autocompact |
| [ ] | `/model [search]` + argument completions | `im:4900`, `im:673` | commands | T:/model unique match switches |
| [ ] | `/thinking [level]` + completions | `im:4851`, `im:699` | commands | T:/thinking high |
| [ ] | `/scoped-models` (`app.models.*` keys) | `im:5086`, `c/scoped-models-selector.ts` | commands | T:scoped models save |
| [ ] | `/export [path]` | `im:6127` | commands | T:/export writes html |
| [ ] | `/import <path>` | `im:6174` | commands | T:/import resumes |
| [ ] | `/share` | `im:6218` | commands | M: gh gist created |
| [ ] | `/copy` | `im:2922` | commands | T:/copy copies last message |
| [ ] | `/name [name]` | `im:6260` | commands | T:/name sets session name |
| [ ] | `/session` | `im:6284` | commands | T:/session shows stats |
| [ ] | `/changelog` | `im:6357` | commands | T:/changelog markdown |
| [ ] | `/hotkeys` (from configured keybindings) | `im:6392` | commands | T:/hotkeys lists configured keys |
| [ ] | `/fork` | `im:5208`, `c/user-message-selector.ts` | commands | T:/fork selector |
| [ ] | `/clone` | `im:5246` | commands | T:/clone duplicates |
| [ ] | `/tree` (`app.tree.*` keys, filters, labels) | `im:5267`, `c/tree-selector.ts` | commands | T:/tree navigates |
| [ ] | `/trust` | `im:5024`, `c/trust-selector.ts` | commands | T:/trust saves decision |
| [ ] | `/login [provider]` + completions; OAuth, API key, ambient auth dialogs | `im:5552-6036`, `c/login-dialog.ts`, `c/oauth-selector.ts` | commands | T:/login api key flow |
| [ ] | `/logout` | `im:5686` | commands | T:/logout removes credential |
| [ ] | `/new` | `im:6509` | commands | T:/new starts session |
| [ ] | `/compact [instructions]` | `im:6674` | commands | T:/compact runs |
| [ ] | `/reload` | `im:6037` | commands | T:/reload |
| [ ] | `/debug` (hidden) | `im:6524` | commands | T:/debug writes log |
| [ ] | `/resume` (`app.session.*` keys) | `im:5416`, `c/session-selector.ts` | commands | T:/resume switches |
| [ ] | `/quit` | `im:3127` | commands | T:/quit shuts down (stub calls `ctx.shutdown`) |
| [ ] | `/arminsayshi`, `/dementedelves` | `im:6557-6580` | commands | M: run both |
| [ ] | Extension commands, prompt templates, `skill:` commands fall through to `session.prompt` | `im:727-756` | native | T:extension command runs |

## 7. Command-owned keys and lifecycle flows

| | Item | Source | Owner | Verify |
| --- | --- | --- | --- | --- |
| [ ] | `app.thinking.cycle` | `im:4281` | commands | T:thinking cycles |
| [ ] | `app.model.cycleForward` / `cycleBackward` (scoped models) | `im:4292` | commands | T:model cycles within scope |
| [ ] | `app.model.select`, `app.session.new/tree/fork/resume` open command flows | `im:2918-2931` | commands | T:key opens selector |
| [ ] | `app.tools.expand` (tools, header) | `im:4311` | native | T:tools expand toggles rows |
| [ ] | `app.thinking.toggle` | `im:4343` | native | T:thinking toggle hides blocks |
| [ ] | First-time setup (theme, analytics) | `c/first-time-setup.ts`, `main.ts:668` | commands | M: fresh agent dir |
| [ ] | `--resume` session picker (pre-mode) | `main.ts:403` | commands | M: nek --ui opentui --resume |
| [ ] | `--session` fork confirmation (pre-mode) | `main.ts:389` | commands | M: --session from other project |
| [ ] | Project trust prompts at startup and on session switch | `cli/project-trust.ts`, `im:2435` | commands | M: untrusted project with .pi |
| [ ] | Missing session cwd prompt | `main.ts:547` | commands | M: resume session with deleted cwd |
| [ ] | Deprecation warnings acknowledgement | `main.ts:908` | commands | M: legacy extension layout |
| [ ] | Startup notices: changelog, diagnostics, migrated providers, models.json error, model fallback, crash notice | `im:783`, `im:1094-1121` | commands | T:startup diagnostics shown |
| [ ] | Model catalog refresh and provider count | `im:1068-1075`, `im:4959` | commands | T:provider count in footer |
| [ ] | Implicit project trust save after reload | `im:4998` | commands | T:auto trust on reload |

## 8. Removal and docs (phase 7)

| | Item | Source | Owner | Verify |
| --- | --- | --- | --- | --- |
| [ ] | Remove RPC frontend (`src/rpc`, `src/state`, `src/app.ts`, `src/keys.ts`, old tests) | `packages/opentui/src` | native | `npm run check` |
| [ ] | Rewrite `packages/coding-agent/docs/opentui.md` | `docs/opentui.md` | native | review |
