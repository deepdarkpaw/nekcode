# Use nekcode in the terminal

Run `nek` from the folder you want to work in. nekcode uses that folder to discover files, instructions, and configuration, and to group saved sessions. If you have not installed it or chosen a model yet, follow the [Quickstart](quickstart.md).

nekcode may ask whether you trust the working folder before loading project resources. See [Project trust](security.md#understand-project-trust).

<p align="center"><img src="images/interactive-mode.png" alt="nekcode interactive mode showing a conversation, editor, and status information" width="750"></p>

The transcript shows your prompts, nekcode responses, tool calls, results, and errors. You write prompts and commands in the editor. The footer shows the current folder, session, model, context usage, and accumulated usage and cost.

## Enter a prompt

Type a request and press `Enter` to send it. Use `Shift+Enter` to add a line, or press `Ctrl+G` to work on a longer prompt in your configured external editor.

To include files or images:

- Type `@` to search for a file and add it to your prompt.
- Press `Tab` to complete a path.
- Paste an image or drag it into a compatible terminal.

## Follow nekcode's work

nekcode shows each tool call and result while it works. Press `Ctrl+O` to expand or collapse tool output. Press `Ctrl+T` to show or hide thinking blocks.

The startup header lists the instructions and resources loaded. The editor border indicates the current thinking level. The footer updates as the model uses context and reports usage.

nekcode does not ask before every tool call. Review commands and changed files, and use a sandbox for untrusted or unattended work. See [Security](security.md).

## Change direction

You can send more input while nekcode is working:

| What you want | Action |
|---|---|
| Adjust the current task | Type a message and press `Enter` |
| Add work after the current task | Type a message and press `Alt+Enter` |
| Return queued messages to the editor | Press `Alt+Up` |
| Stop the current task | Press `Escape` |

## Change the model or settings

Type `/` to search available commands. Common commands are `/model`, `/thinking`, `/login`, `/logout`, and `/settings`. Plan mode and the built-in `nek` extension add `/plan`, `/todos`, and `/subagents`.

See [Choose a Model](models.md), [Configuration](configuration.md), and the [Slash Commands reference](slash-commands.md).

## Continue or start over

nekcode saves sessions automatically unless persistence is disabled.

- `/new` starts a new session.
- `/resume` opens another saved session.
- `/name` gives the current session a recognizable name.
- `/session` shows its file, ID, message count, token usage, and cost.

Use `/tree`, `/fork`, or `/clone` to explore another approach without losing existing work. Use `/compact` to reduce conversation history.

After leaving nekcode, run `nek --continue` from the same folder to resume the most recent session.

## Run a terminal command

Prefix a command with `!` to run it and include its output in the conversation:

```text
!git status
```

Use `!!` to run a command without sending its output to the model.

## Copy, export, or share results

Press `Ctrl+X` or run `/copy` to copy the last response. Use `/export` to save the session as HTML or JSONL. `/share` can upload a session; review it first because it may contain prompts, tool output, file contents, and credentials exposed during the conversation.

## Adjust the terminal

Fullscreen mode is the default: it keeps the editor and status area fixed while the transcript scrolls within the terminal window. Regular mode uses normal scrollback. Choose a mode through `/settings`, the `tuiMode` setting, or `--tui-mode regular|fullscreen`.

Terminal support for mouse input, keyboard shortcuts, and inline images varies. See [Terminal Setup](terminal-setup.md) and [Keybindings](keybindings.md). Run `/hotkeys` to inspect active shortcuts.

## Collect diagnostics

When troubleshooting terminal rendering or conversation state, run `/debug`. nekcode writes rendered terminal lines and current session messages to `nek-debug.log` in the [agent directory](configuration.md#agent-directory). Review it before sharing because it can contain prompts, model responses, tool output, file contents, and terminal data.
