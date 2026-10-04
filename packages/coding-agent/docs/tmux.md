# Run nekcode in tmux

nekcode works inside tmux, but tmux can report `Shift+Enter`, `Ctrl+Enter`, and plain `Enter` as the same key. Enable extended keys so nekcode can distinguish them.

## Check your tmux version

```bash
tmux -V
```

For tmux 3.5 or newer, use the recommended CSI-u configuration below. For tmux 3.2 through 3.4, use the older-version configuration.

## Enable extended keys in tmux 3.5 or newer

Add these lines to `~/.tmux.conf`:

```tmux
set -g extended-keys on
set -g extended-keys-format csi-u
```

nekcode requests extended-key reporting when the terminal does not provide the Kitty keyboard protocol directly. CSI-u is the most reliable format for forwarding modified keys through tmux.

## Restart tmux

The configuration applies to the tmux server. To guarantee that it is active, close your tmux sessions and start a new server.

If you choose to stop the server from the command line, save your work first. This command terminates every session managed by that server:

```bash
tmux kill-server
tmux
```

## Verify modified keys

Start nekcode inside the new tmux session and check that:

1. `Shift+Enter` inserts a new line in the editor.
2. `Enter` submits the prompt.
3. `Alt+Enter` queues a follow-up on macOS and Linux. Windows and WSL use `Ctrl+Q` by default.

If these keys still behave like plain `Enter`, verify that the terminal outside tmux can report modified keys. See [Configure your terminal](terminal-setup.md).

## Use tmux 3.2 through 3.4

These versions support extended keys but not `extended-keys-format csi-u`. Add only:

```tmux
set -g extended-keys on
```

nekcode supports the xterm `modifyOtherKeys` format used by these versions. Restart tmux and repeat the verification steps.

For older versions, upgrade tmux or use nekcode outside tmux rather than relying on modified Enter shortcuts.

## Scroll in fullscreen mode

nekcode starts in fullscreen mode by default. It draws its own transcript on the alternate screen, so tmux's scrollback (copy mode) does not contain the conversation.

- The keyboard always works: `PageUp` and `PageDown` scroll the transcript by a page, `Home` jumps to the beginning, and `End` returns to the end and follows new output. These bindings are configurable as `tui.altScreen.*` in [Keybindings](keybindings.md).
- The mouse wheel reaches nekcode only when tmux forwards mouse events. Add this line to `~/.tmux.conf`, then run `tmux source-file ~/.tmux.conf` or restart tmux:

```tmux
set -g mouse on
```

Without `set -g mouse on`, tmux handles the wheel itself and nekcode's transcript does not move.

## Switch back to regular mode

Regular mode prints the transcript into the normal terminal output, so tmux copy mode and scrollback work as usual. Use it for one run with:

```bash
nek --tui-mode regular
```

To make it the default, choose it in `/settings` or set `"tuiMode": "regular"` in `~/.nek/agent/settings.json`. See [Settings](settings.md).
