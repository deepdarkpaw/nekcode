# OpenTUI Frontend (experimental)

`nek --ui opentui` starts an alternative terminal UI built on [OpenTUI](https://opentui.com) (`@opentui/core`). The built-in TUI stays the default and is unchanged.

## How it works

OpenTUI loads a native Zig core through Bun FFI and does not run on Node 22. The frontend therefore runs as its own Bun process, and the agent keeps running on Node:

```
nek --ui opentui            (Node: parses args, finds Bun)
  └─ bun packages/opentui/src/main.ts        (Bun: owns the terminal)
       └─ node … cli.ts --mode rpc …         (Node: the agent, JSONL RPC on stdio)
```

The launcher passes the backend command to the frontend in `NEK_OPENTUI_BACKEND`: the same Node executable and `execArgv` (which carry the source resolver), the CLI path, `--mode rpc`, and every other argument you gave except `--ui`. So `nek --ui opentui --model sonnet -c` resumes the last session with that model. The protocol is the regular [RPC mode](rpc.md), including [extension UI requests](rpc-extension-ui.md).

## Requirements

- Bun 1.3 or newer. The launcher looks for it in this order:
  1. `NEK_BUN` (path to the Bun executable)
  2. `bun` on `PATH`
  3. `~/.bun/bin/bun` (`bun.exe` on Windows)

  If Bun is missing, install it from https://bun.sh.
- A source checkout of nek, such as the one the installer creates. The frontend lives in `packages/opentui` and is not part of the npm package.

## Start

```bash
nek --ui opentui
nek --ui opentui -c                      # continue the last session
nek --ui opentui "explain this repo"     # send a first message
nek --ui opentui --smoke --no-session    # non-interactive self-check, see below
```

`@file` arguments, `--mode`, and `--print` cannot be combined with `--ui opentui`.

The theme follows `--use-theme` or the `theme` setting (built-in `dark`/`light` or a custom theme). The frontend derives three background layers from it (base, panel, raised) and uses the theme's text, muted, accent, and blue tokens.

## Keys

| Key | Action |
|---|---|
| Enter | Send. While the agent works: queue a steering message |
| Alt+Enter | While the agent works: queue a follow-up message |
| Shift+Enter, Ctrl+J | New line |
| Esc | Stop the running turn; cancel a dialog |
| Ctrl+C | Clear the input; on empty input press twice to quit |
| Ctrl+D | Quit on empty input |
| PgUp / PgDn, mouse wheel | Scroll the transcript |
| Ctrl+Home / Ctrl+End | Jump to top / bottom (Home / End too while the input is empty) |
| Ctrl+O | Expand or collapse all tool rows (click a row to toggle one) |
| Ctrl+T | Show or hide thinking |

In dialogs: ↑/↓ and Enter for select, Y/N for confirm, Enter to submit input, Ctrl+S or Alt+Enter to submit the editor. All bindings are defined in one table in `packages/opentui/src/keys.ts`.

The transcript follows new output while it is scrolled to the bottom. Scrolling up stops following; scrolling back to the bottom resumes it.

## Features

- Streaming assistant markdown, collapsible thinking, user messages, and notices (compaction, retries, extension errors).
- Tool rows that use the same display names as the built-in TUI (`Read`, `Search`, `Bash`, `Web Search`, `server › tool`, …). Each row shows the name, the main argument, and muted metadata, followed by a short preview. Web Search is drawn in blue and lists numbered titles with their hostnames.
- Panels above the input: todos from `todo_write`, and running subagents shown as `model · type · ↑in ↓out · elapsed` with their latest activity. Queued steering and follow-up messages are listed below the panels.
- Footer: mode badge (PLAN/AGENT), working directory, session name, ↑↓ tokens, context usage, model, and thinking level.
- Extension UI: select, confirm, input, and editor dialogs; notifications as toasts; `setStatus`, `setWidget` (string lines), `setTitle`, and `set_editor_text`.
- Slash commands: extension, prompt, and skill commands go to the agent unchanged. `/new`, `/compact`, `/name`, `/thinking`, `/model <provider/model>`, `/export`, `/clone`, `/session`, `/hotkeys`, and `/quit` map to RPC commands.

## Not available yet

`/login`, `/logout`, `/settings`, `/tree`, `/resume`, `/fork`, `/scoped-models`, `/import`, `/share`, `/copy`, `/changelog`, `/trust`, and `/reload` show a short notice; use the built-in TUI for them. Images are not displayed (user messages show an image count). The model selector, autocomplete, and custom extension components (`ctx.ui.custom()`, component widgets) are not available over RPC.

## Known limitations

- **tmux**: tmux's `modifyOtherKeys` mode 1 breaks Ctrl+Shift combinations, and without the kitty keyboard protocol many terminals send Shift+Enter as plain Enter. Use Ctrl+J for a new line if Shift+Enter sends.
- **IME**: OpenTUI has no native IME composition support. CJK input methods that commit text work, but the preedit text is not shown inline.
- **Terminals**: the UI uses truecolor and the alternate screen. Terminals without truecolor show approximated colors. Status glyphs (`●`, `◐`) are East Asian "ambiguous width" characters and can misalign in terminals configured to draw them double-width.
- Only the 80 most recent transcript blocks are mounted; older ones collapse into an "N earlier messages" line. The transcript keeps at most 1500 blocks in memory.
- OpenTUI is pre-1.0 (`@opentui/core` 0.5.14, pinned).

## Checks

- `npm test -w packages/opentui`: Node tests for JSONL framing, request correlation, the state reducer, and tool-row text.
- `bun packages/opentui/test/view.smoke.ts`: renders scripted RPC records offscreen through the real view and checks the frame.
- `nek --ui opentui --smoke --no-session`: launcher → Bun frontend → `nek --mode rpc` handshake → first frame rendered offscreen → clean shutdown. It prints the frame and exits non-zero on failure.
