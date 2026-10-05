# OpenTUI Frontend (experimental)

`nek --ui opentui` starts the interactive mode with a terminal UI built on [OpenTUI](https://opentui.com) (`@opentui/core`). The built-in TUI stays the default and is unchanged.

## How it works

OpenTUI loads a native Zig core through Bun FFI and does not run on Node 22. The launcher therefore re-runs the CLI under Bun; the agent and the UI then share that one Bun process:

```
nek --ui opentui                         (Node: parses args, finds Bun)
  └─ bun packages/opentui/src/main.ts …  (Bun: the regular CLI main() with the OpenTUI interactive mode)
```

The Bun entry calls the same `main()` as `nek`, so argument parsing, sessions, settings, extensions, startup prompts, and print/RPC modes behave exactly as usual. Only the interactive UI differs: instead of `InteractiveMode`, `main()` builds the OpenTUI mode through `MainOptions.createInteractiveMode`. The mode uses the session, settings, keybindings, and theme objects directly (no RPC).

The UI is native OpenTUI where it matters for look and input (layout, scrolling, overlays, dialogs, search, selection) and reuses the interactive mode's pi-tui components for content (messages, tool rows, the prompt editor, indicators, extension components). A bridge renders pi-tui components into OpenTUI renderables and feeds them keys through pi-tui's own input pipeline, so every component and extension behaves as in the built-in TUI.

## Requirements

- Bun 1.3 or newer. The launcher looks for it in this order:
  1. `NEK_BUN` (path to the Bun executable)
  2. `bun` on `PATH`
  3. `~/.bun/bin/bun` (`bun.exe` on Windows)

  If Bun is missing, install it from https://bun.sh, or rerun the nek installer with `NEK_INSTALL_BUN=1`.
- A source checkout of nek, such as the one the installer creates. The frontend lives in `packages/opentui` and is not part of the npm package.
- A terminal with truecolor and the alternate screen. The kitty keyboard protocol is used when the terminal supports it.

## Start

```bash
nek --ui opentui
nek --ui opentui -c                      # continue the last session
nek --ui opentui --model sonnet "explain this repo"
bun packages/opentui/src/main.ts         # same, without the Node launcher
```

Every interactive option works (`-c`, `-r`, `--session`, `--model`, `@file` arguments, initial messages, `--verbose`, …). `--ui opentui` cannot be combined with `--mode` or `--print`.

The theme follows `--use-theme` or the `theme` setting (built-in `dark`/`light` or a custom theme). The UI derives layered backgrounds from the theme's page background: the transcript (base), the footer (panel), the editor (raised), and dialogs and toasts (overlay, with rounded borders). Secondary text uses the theme's muted and dim colors; links and Web Search rows use the theme's link blue (`mdLink`).

## Keys

All keys come from the configurable keybindings (`keybindings.json`), exactly as in the built-in TUI. `/hotkeys` lists the effective bindings. The defaults (Windows and WSL use the alternatives in parentheses):

| Key | Action |
|---|---|
| Enter | Send. While the agent works: queue a steering message. While compacting: queue for after compaction |
| Alt+Enter (Ctrl+Q) | Queue a follow-up message (`app.message.followUp`) |
| Shift+Enter | New line |
| Alt+Up (Alt+Q) | Move all queued messages back into the editor (`app.message.dequeue`) |
| Esc | Abort the running turn (queued messages return to the editor), cancel bash, leave bash mode; twice on an empty editor opens `/tree` or `/fork` (`doubleEscapeAction` setting) |
| Ctrl+C | Clear the editor; twice to quit |
| Ctrl+D | Quit on an empty editor |
| Ctrl+Z | Suspend (not on Windows) |
| Ctrl+O | Expand or collapse tool output, the startup help, and loaded resources |
| Ctrl+T | Show or hide thinking blocks |
| Shift+Tab | Cycle the thinking level |
| Ctrl+P, Shift+Ctrl+P (Alt+P) | Next / previous model |
| Ctrl+L | Model selector |
| Ctrl+G | Edit the prompt in the external editor (`$VISUAL`/`$EDITOR` or the `externalEditor` setting) |
| Ctrl+V (Alt+V) | Paste an image from the clipboard (falls back to text) |
| `/`, `!`, `!!`, `@` | Commands, bash, bash without context, file paths (autocomplete) |
| PgUp / PgDn | Scroll the transcript (`tui.altScreen.*`; half-page and line bindings are unbound by default) |
| Home / End | Scroll to the top / to the latest message |
| Ctrl+Up / Ctrl+Down | Jump to the previous / next prompt |
| Ctrl+Shift+F (Ctrl+F) | Search the transcript; Enter / Shift+Enter next / previous match, Esc closes |

Every editor key of the built-in TUI works (word movement, kill ring and yank, undo, history, large-paste markers), because the prompt editor is the interactive mode's editor.

Mouse: the wheel scrolls the transcript; dragging selects text and copies it when `fullscreenCopyOnSelect` is on (otherwise the copy key, `app.message.copy`, copies the selection); a right click pastes into the editor. The transcript follows new output while it is at the bottom; scrolling up stops following and shows a "Jump to latest message" button.

## Regular mode

`tuiMode: "regular"` (settings) or `--tui-mode regular` keeps the transcript in the terminal's own scrollback, like the built-in regular TUI. OpenTUI runs in its `split-footer` screen mode: only the area from the editor down is redrawn, and transcript blocks are written above it once they stop changing. The streaming reply, running tools, a running `!` command, and the latest status line stay above the editor until they are done. Dialogs and selectors use the whole screen while they are open.

Output already in the scrollback cannot be edited. When it must change (terminal width, theme, tool-output expansion, thinking visibility, a rebuilt chat, or a closed dialog), the screen and scrollback are cleared and the transcript is written again, as the built-in TUI does on a full redraw. Regular mode has no mouse tracking, transcript scrolling keys, or transcript search: the terminal scrolls and searches its own scrollback. `/settings` switches modes at runtime; the switch is refused while extension overlays are open.

## Feature parity

The OpenTUI mode is a port of the built-in interactive mode and aims for full feature parity. Implemented:

- Transcript: user and assistant messages (markdown, code highlighting, thinking blocks and the hidden-thinking label, mermaid and extension markdown transformers), tool rows with every built-in and extension renderer and images, bash executions, compaction and branch summaries, custom messages and entries, skill invocations, retry/compaction/summarization indicators, usage and cache notices, the project-trust warning, the startup header, and the loaded-resources listing with diagnostics.
- Editor: the full prompt editor, slash-command autocomplete with descriptions and argument completions, `@file` fuzzy completion, path completion, extension autocomplete providers, bash mode, steering/follow-up/compaction queues, the external editor, clipboard image paste.
- Chrome: footer (all fields and extension statuses), widgets above and below the editor, extension header and footer, working indicator message/visibility/frames, plan-mode border, notifications, terminal title and progress.
- Fullscreen: keyboard and mouse scrolling, scrollbar (`fullscreenScrollbar`), transcript search with highlighted matches, prompt jumps, selection and copy-on-select, flash toasts, suspend, `fullscreenExitOutput`.
- Extension UI: `select`, `confirm`, `input`, `editor`, `custom` (inline and overlay, with pi-tui overlay options), `tui.showOverlay`, component widgets, `setEditorComponent`, `onTerminalInput`, themes, shortcuts, and command-context actions.
- Slash commands, selectors, and startup prompts follow the built-in TUI (`packages/opentui/PARITY.md` tracks every item and its verification).

## Known limitations

- **Regular mode redraws**: a replay rewrites the whole transcript (see [Regular mode](#regular-mode)). A streaming reply taller than the screen shows its newest lines until it is complete. After switching from fullscreen to regular at runtime, exiting clears the visible screen: OpenTUI fixes `clearOnShutdown` when the renderer is created, and its shutdown clear in split-footer mode wipes the top of the screen. Starting in regular mode keeps the last frame.
- **Automatic light/dark themes** cannot query the terminal background through OpenTUI yet; automatic theme settings fall back to their default appearance.
- **Terminal progress** (OSC 9;4) is written outside OpenTUI's frame output (and outside regular mode's stdout capture); a terminal that does not ignore unknown OSC sequences can show stray characters.
- **Hardware cursor**: with `showHardwareCursor` the terminal cursor follows the editor cursor; IME preedit text is not shown inline (OpenTUI has no IME composition support).
- **tmux**: without `extended-keys` (and `extended-keys-format csi-u`) modified keys such as Shift+Enter and Ctrl+Shift+F do not reach the UI.
- **Width tables**: OpenTUI and pi-tui measure a few emoji and East Asian "ambiguous width" characters differently; such lines can be off by a cell.
- **Suspend** (Ctrl+Z) is not supported on Windows, as in the built-in TUI.
- OpenTUI is pre-1.0 (`@opentui/core` 0.5.14, pinned).

## Checks

- `bun test ./test/native` in `packages/opentui` (also run by `./test.sh` when Bun is on `PATH`): drives the real mode on an offscreen renderer with the faux provider (streaming, tool rows, autocomplete, queues, scrolling, search, overlays, extension UI, history rendering) and tests the bridge, dialogs, and theme mapping.
