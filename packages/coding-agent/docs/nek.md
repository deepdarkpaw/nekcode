# nekcode

nekcode is an independent fork with Cursor-style planning and delegation, plus the file tools of Cursor and Claude Code. The additions ship as a built-in extension named `nek`, and as replacements for the built-in `read` and `edit` tools.

## Command and configuration

nekcode runs as the `nek` command. Its configuration lives in `~/.nek/agent/` (`settings.json`, `models.json`, `auth.json`, sessions), and project configuration in `.nek/`. It uses a separate data directory and does not migrate data from another installation automatically. The environment variable for a custom agent directory is `NEK_CODING_AGENT_DIR`.

nek does not install, update, or discover extension packages: the `install`, `remove`, `update`, `list`, and `config` commands are removed, and `extensions`/`packages` entries in settings are ignored. Extensions passed with `-e <path>` still load for that run.

## Tools

A new session activates `read`, `bash`, `edit`, `write`, `ast_grep`, and the `nek` tools below. A `--tools` allowlist still applies: `nek` tools appear only when listed.

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
| `await` | Waits for background subagents to finish. |

## Modes

- **Agent mode** is the default.
- **Plan mode** researches and writes a plan without changing code. In plan mode, `edit` and `write` may only target Markdown files, and subagents are read-only. The plan is saved under `.nek/plans/`.

Enter Plan with `/plan`, switch modes with `alt+m`, or start in it with `nek --plan`. Repeating `/plan` stays in Plan and displays the saved revision. `/plan <text>` submits a planning or revision request; `/agent` exits without implementing anything. The editor uses a distinct border color and a persistent `PLAN` badge.

`create_plan` writes a new plan file and displays the complete Markdown document before approval. When a plan already exists, same-task revisions are incremental: read the plan file, change only the parts that need changing with `edit` (including the frontmatter `overview` and `todos`), then call `update_plan` to save the next revision. `update_plan` reads the file back as the source of truth, so edits made directly in an editor are picked up too. The revision number increases only when the document changed, and the tool result shows only a diff. The review panel keeps its actions separate from the scrollable body: implement here, implement in a fresh session, keep planning, or exit Plan. Page Up/Down review long plans. The same saved body is returned in print/JSON modes.

Implementation runs in Agent, not in a third Plan execution mode. Approval covers one plan revision and its immutable body. Escape interrupts execution and revokes that authorization; old todos and completed progress are retained but cannot automatically resume after a new request. `/nek-build` explicitly starts or resumes a reviewed revision; `--fresh` starts it in a new session.

Re-entering Plan treats the previous plan as reference, following Claude Code's reentry rule: compare the latest request with the existing plan, replace it for a different task, or revise it for the same task. Ask new questions when a decision is genuinely unresolved, then save and review the revised plan. An older approval cannot execute a draft or a plan file changed after review.

Subagent rows render like Cursor: a status icon, the title, and a muted `model · type · elapsed` line, with the current `activity` on the second line. Rows update live while the subagent runs, and expand to the full Markdown result with `ctrl+o`.

## Subagents

`subagent` runs a child session in the same process. The child shares the parent's model credentials, but it has its own tools, its own read history, and read-only settings, and it cannot start further subagents. Background subagents notify the parent once they finish, unless the parent already collected the result with `await`. After a parent interruption, or while plan execution is no longer authorized, completion notices wait for the next explicit user request instead of restarting the old subagent. Background child cancellation itself remains controlled by `/subagents`.

Built-in subagent types:

| Type | Tools |
|---|---|
| `generalPurpose` (default) | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`, `ast_grep`, `todo_write` |
| `explore` | `read`, `grep`, `find`, `ls`, `ast_grep` (read-only) |
| `shell` | `bash`, `read` |

Define custom types as Markdown files in `~/.nek/agent/agents/` or, for trusted projects, `.nek/agents/`. Project types override user types, which override built-in types. The body becomes the subagent's instructions.

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

`readonly: true` always selects the read-only tool set. `model` is used when the `subagent` call does not name one.

Use `/subagents` to list subagents, show a result, or cancel a running subagent.

## Commands and shortcuts

| Command | Action |
|---|---|
| `/plan [text]` | Enter Plan or view the saved plan; with text, submit a planning request |
| `/agent` | Exit Plan without implementing anything |
| `/nek-build [--fresh]` | Start or resume the reviewed revision, optionally in a new session |
| `/todos` | Show the todo list of the current branch |
| `/subagents` | List, inspect, or cancel subagents |
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
