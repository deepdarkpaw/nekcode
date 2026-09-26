# nekcode

nekcode is a fork of Pi with Cursor-style planning and delegation, plus the file tools of Cursor and Claude Code. The additions ship as a built-in extension named `nek`, and as replacements for the built-in `read` and `edit` tools.

## Tools

A new session activates `read`, `bash`, `edit`, `write`, `ast_grep`, and the `nek` tools below. A `--tools` allowlist still applies: `nek` tools appear only when listed.

| Tool | Purpose |
|---|---|
| `read` | Reads a file. Output lines carry a `%6d|` line-number prefix. Files over 10,000 characters are returned as symbol-aligned chunks, with long function bodies folded; languages without an outline use 50-line chunks. `offset` may be negative (`-1` is the last line). |
| `edit` | Replaces `old_string` with `new_string` in `file_path`. The file must have been read first and must not have changed since. `old_string` must be unique unless `replace_all` is true. Encoding, BOM, and line endings are preserved, and writes are atomic. |
| `write` | Creates or overwrites a file. Overwriting an existing file requires a prior read. |
| `ast_grep` | Structural code search with ast-grep patterns. |
| `todo_write` | Maintains the todo list shown above the editor. |
| `switch_mode` | Asks to switch between agent and plan mode. The user must confirm. |
| `create_plan` | Plan mode only: writes the plan file and ends planning. |
| `ask_question` | Shows multiple-choice questions to the user. |
| `task` | Delegates a bounded task to a subagent, in the foreground or background. |
| `await` | Waits for background subagents to finish. |

## Modes

- **Agent mode** is the default.
- **Plan mode** researches and writes a plan without changing code. In plan mode, `edit` and `write` may only target Markdown files, and subagents are read-only. The plan is saved under `.pi/plans/`.

Toggle plan mode with `/plan` or the `alt+m` shortcut, or start in it with `pi --plan`. `/plan <text>` enters plan mode and submits the text. When the model finishes a plan, an approval panel offers to implement it in the current session or in a new one. `/nek-build` implements the current plan; `/nek-build --fresh` does so in a new session.

## Subagents

`task` runs a child session in the same process. The child shares the parent's model credentials, but it has its own tools, its own read history, and read-only settings, and it cannot start further subagents. Background tasks notify the parent once they finish, unless the parent already collected the result with `await`.

Built-in subagent types:

| Type | Tools |
|---|---|
| `generalPurpose` (default) | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `ast_grep`, `todo_write` |
| `explore` | `read`, `grep`, `find`, `ls`, `ast_grep` (read-only) |
| `shell` | `bash`, `read` |

Define custom types as Markdown files in `~/.pi/agent/agents/` or, for trusted projects, `.pi/agents/`. Project types override user types, which override built-in types. The body becomes the subagent's instructions.

```markdown
---
name: reviewer
description: Reviews a diff for correctness and style issues.
model: anthropic/claude-sonnet-4-5
readonly: true
is_background: false
tools: [read, grep, ast_grep]
---
Review the changes and report concrete issues with file and line references.
```

`readonly: true` always selects the read-only tool set. `model` is used when the `task` call does not name one.

Use `/tasks` to list subagents, show a result, or cancel a running task.

## Commands and shortcuts

| Command | Action |
|---|---|
| `/plan [text]` | Toggle plan mode; with text, enter plan mode and submit the text |
| `/nek-build [--fresh]` | Implement the current plan, optionally in a new session |
| `/todos` | Show the todo list of the current branch |
| `/tasks` | List, inspect, or cancel subagents |
| `alt+m` | Toggle plan mode |

## Configuration

Settings are read from `~/.pi/agent/nek.yaml`, then from `.pi/nek.yaml` in trusted projects. Unknown keys and mistyped values are rejected. Defaults:

```yaml
plan:
  dir: .pi/plans
  shortcut: alt+m
todo:
  settleReminder: true   # continue once when a run ends with open todos
  widgetMaxLines: 8
subagent:
  maxConcurrent: 6
  maxRetained: 32
  awaitDefaultMs: 30000
  awaitMaxMs: 7140000
  finalTextMaxBytes: 32768
  progressMaxLines: 5
```
