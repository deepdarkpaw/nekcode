# nekcode

nekcode is an independent fork with Cursor-style planning and delegation, plus the file tools of Cursor and Claude Code. The additions ship as a built-in extension named `nek`, and as replacements for the built-in `read` and `edit` tools.

## Command and configuration

nekcode runs as the `nek` command. Its configuration lives in `~/.nek/agent/` (`settings.json`, `models.json`, `auth.json`, sessions), and project configuration in `.nek/`. It uses a separate data directory and does not migrate data from another installation automatically. The environment variable for a custom agent directory is `NEK_CODING_AGENT_DIR`.

nek does not install, update, or discover extension packages: the `install`, `remove`, `update`, `list`, and `config` commands are removed, and `extensions`/`packages` entries in settings are ignored. Extensions passed with `-e <path>` still load for that run.

## Tools

A new session activates `read`, `bash`, `edit`, `write`, `ast_grep`, `web_search`, and the `nek` tools below. A `--tools` allowlist still applies: `nek` tools appear only when listed.

| Tool | Purpose |
|---|---|
| `read` | Reads a file. Output lines carry a `%6d|` line-number prefix. Files over 10,000 characters are returned as symbol-aligned chunks, with long function bodies folded; languages without an outline use 50-line chunks. `offset` may be negative (`-1` is the last line). |
| `edit` | Replaces `old_string` with `new_string` in `file_path`. `old_string` must match the current file content and be unique unless `replace_all` is true; no prior read is required. Encoding, BOM, and line endings are preserved, and writes are atomic. |
| `write` | Creates or overwrites a file. Overwriting an existing file requires a prior read. |
| `ast_grep` | Structural code search with ast-grep patterns. |
| `todo_write` | Maintains the todo list shown above the editor. |
| `switch_mode` | Asks to switch between agent and plan mode. The user must confirm. |
| `create_plan` | Plan mode only: writes a new plan file and ends planning. |
| `update_plan` | Plan mode only: submits the plan file after incremental `edit`s and ends planning. |
| `ask_question` | Shows multiple-choice questions to the user. |
| `subagent` | Delegates a bounded task to a subagent, in the foreground or background. |
| `await` | Waits for background subagents to finish; a user steer ends the wait without stopping the child. |
| `web_search` | Searches current public-web information through Exa's keyless hosted MCP endpoint. |

## Modes

- **Agent mode** is the default.
- **Plan mode** researches and writes a plan without changing code. In plan mode, `edit` and `write` may only target Markdown files, and subagents are read-only. The plan is saved under `.nek/plans/`.

Enter Plan with `/plan`, switch modes with `alt+m`, or start in it with `nek --plan`. `/plan` is silent when no text is supplied; use `/plans` to select and explicitly preview one of the saved plans. `/plan <text>` submits a planning or revision request; `/agent` exits without implementing anything. The editor uses a distinct border color and a persistent `PLAN` badge.

`create_plan` creates a new plan file when `plan_id` is omitted. A session may contain multiple plans. To fully rewrite an existing plan, pass its stable `plan_id`; to make an incremental revision, read/edit the selected file and call `update_plan` (optionally with `plan_id`). The revision number increases only when the document changed, and the tool result shows only a diff for updates. `/plans` selects and previews a saved plan without printing it during mode changes. The `create_plan` row shows only the plan name, revision, and overview. When a review opens, the full reviewed revision is appended to the transcript, where fullscreen paging (PageUp/PageDown or the mouse wheel) and native terminal scrollback both work. The review panel above the editor stays compact: implement here, implement in a fresh session, keep planning, or exit Plan. Plan previews are display-only and never sent to the model; the plan already reaches it through the plan tool call or the approved-plan message.

Plan mode only plans; Agent mode implements. Approving a reviewed revision switches to Agent, writes the plan's todos as ordinary todos, and sends the approved plan body as a user message. There is no separate execution phase: Escape stops the current run like any other Agent run, and the todos stay as they are. `/nek-build` approves a reviewed revision the same way; `--fresh` does it in a new session.

Re-entering Plan treats the previous plan as reference, following Claude Code's reentry rule: compare the latest request with the existing plan, replace it for a different task, or revise it for the same task. Ask new questions when a decision is genuinely unresolved, then save and review the revised plan. A pending approval never applies to a draft or to a plan file changed after review.

Subagent rows render like Cursor: a status icon, the title, and muted `model · type · ↑input ↓output · elapsed` metadata, for example `✓ Map the cache layer  claude-sonnet-4 · explore · ↑12k ↓3.4k · 1m 5s`. Input tokens include cache reads and writes; the total time runs from start to finish. While the subagent runs, the second line shows its current activity and how long ago it changed, for example `bash npm test · 5s ago`. Tool cards, `await` results, completion notices, and the background list above the editor use the same format. Rows update live while the subagent runs, and expand to the full Markdown result with `ctrl+o`.

## Subagents

`subagent` runs a child session in the same process. The child shares the parent's model credentials, but it has its own tools, its own read history, and read-only settings, and it cannot start further subagents. Background subagents notify the parent once they finish, unless the parent already collected the result with `await`. After a parent interruption, completion notices wait for the next explicit user request instead of restarting the old subagent. Background child cancellation itself remains controlled by `/subagents`.

Built-in subagent types:

| Type | Tools |
|---|---|
| `generalPurpose` (default) | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `ast_grep`, `todo_write` |
| `gpt-6.1-sol-worker` | all built-in tools, including `powershell`, `edit`, and `write`; model `CPA/gpt-6.1-sol`, thinking `xhigh` |
| `kimi-3-ui-worker` | all built-in tools, including `powershell`, `edit`, and `write`; model `CPA/kimi-k3`, thinking `max` |
| `explore` | `read`, `grep`, `find`, `ls`, `ast_grep`, `web_search` (read-only) |
| `shell` | `bash`, `read` |

Define custom types as Markdown files in `~/.nek/agent/agents/` or, for trusted projects, `.nek/agents/`. Project types override user types, which override built-in types. The body becomes the subagent's instructions.

```markdown
---
name: reviewer
description: Reviews a diff for correctness and style issues.
model: anthropic/claude-sonnet-4-5
readonly: true
is_background: false
tools: [read, grep, ast_grep, web_search]
thinking: low
context_window: 500000
disallowed_tools: bash
---
Review the changes and report concrete issues with file and line references.
```

`readonly: true` always selects the read-only tool set. `model` is used when the `subagent` call does not name one. `thinking` overrides the parent's thinking level, `context_window` caps the child's automatic-compaction window, and `disallowed_tools` removes tools from the allowlist. The available preset list includes these fields in the `subagent` description and `/agents` shows it to the user.

Use `/subagents` to list subagents, show a result, or cancel a running subagent. A normal user steer while `await` or a foreground child is waiting ends that wait; a foreground child continues in the background and later sends a completion notice.

## Commands and shortcuts

| Command | Action |
|---|---|
| `/plan [text]` | Enter Plan silently; with text, submit a planning request |
| `/agent` | Exit Plan without implementing anything |
| `/plans` | Select and preview one saved plan |
| `/nek-build [plan_id] [--fresh]` | Implement a selected reviewed revision in Agent, optionally in a new session |
| `/todos` | Show the todo list of the current branch |
| `/subagents` | List, inspect, or cancel subagents |
| `/agents` | List configured subagent presets |
| `alt+m` | Toggle plan mode |

## Configuration

Settings are read from `~/.nek/agent/nek.yaml`, then from `.nek/nek.yaml` in trusted projects. Unknown keys and mistyped values are rejected. Defaults:

```yaml
plan:
  dir: .nek/plans
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
```
