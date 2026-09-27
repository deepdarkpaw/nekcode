# Sessions and Context

nekcode saves a conversation as a session. The active branch supplies conversation history for the next model request. Use session commands to continue work, explore another branch, or reduce the amount of history sent to the model.

## Continue or switch sessions

Sessions are saved automatically unless started with `--no-session`.

```bash
nek --continue
nek --resume
```

`--continue` opens the most recent session for the current working directory. `--resume` opens the session picker. In interactive mode, `/resume` opens the same picker and `/new` starts a new session.

Use `/name` or `--name` to assign a recognizable session name. Run `/session` to verify the current session file, ID, message count, token usage, and cost.

The session picker lets you search, rename, and delete sessions. See [Keybindings](keybindings.md#sessions) for its shortcuts.

## Branch a session

Sessions store entries as a tree, so returning to an earlier point does not erase the branch you leave.

| Action | Result | Use it when |
|---|---|---|
| `/tree` | Moves within the current session file | Related alternatives should stay together |
| `/fork` | Creates a new session from an earlier user message | The alternative should become separate work |
| `/clone` | Copies the active branch into a new session | You want a separate copy of the current state |

When you leave a branch, nekcode can summarize it and attach that summary to the branch you enter. This preserves relevant work without including every message from the abandoned path.

For persisted tree and entry types, see [Session Format](session-format.md).

## Manage conversation context

The model receives the active branch, not every branch in the session file. nekcode combines that history with the system prompt, discovered context files, available tools, and loaded skill descriptions. [How nekcode works](how-nek-works.md#context) describes how those inputs are assembled.

When the active context approaches the model's limit, nekcode normally compacts older history automatically. Compaction adds a summary and keeps recent messages; it does not delete original session entries.

Run `/compact` to compact manually. See [Compaction Reference](compaction.md) for thresholds, retained boundaries, branch-summary behavior, and extension hooks.

## Control session storage

By default, sessions are stored under `~/.nek/agent/sessions/`, grouped by working directory. Use `--session-dir`, `NEK_CODING_AGENT_SESSION_DIR`, or the `sessionDir` setting to choose another location. The CLI option has highest precedence.

Use `--no-session` for an ephemeral run. Use `--session` when you already know the session path or ID, and `--fork` to create a new session before interactive mode starts.

## Export or share a session

Use `/export` to write the current session as HTML or JSONL. Use `/share` to upload it and get a viewer link. Review exported or shared sessions first: they can contain prompts, model responses, tool arguments, command output, file contents, and extension messages.

## Report a bug

Run `/bug [description]` to prepare a private report for the nekcode developers. Review any transcript or generated summary because it can contain sensitive conversation data. If uploads are unavailable, nekcode can export the report as a zip for inspection and manual sharing.
