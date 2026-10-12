# Durable Sessions and Crash Recovery

nekcode runs every turn on a durable engine ([`@earendil-works/pi-durable`](../../durable/README.md)). Each step of a turn is committed to the session database before the next one starts: the user input, streamed text, each tool call and its result, queued messages, compactions. If the process dies (crash, `kill`, closed terminal, power loss), reopening the session continues the interrupted turn instead of losing it.

## Resume an interrupted turn

Reopen the session as usual, for example with `nek -c` or `/resume`. The interrupted work continues by itself:

| Interrupted during | After reopening |
|---|---|
| Model streaming | The partial answer stays in the history as an aborted answer, and the request is sent again. |
| A read-only tool (`read`, `grep`, `find`, `ls`, `ast_grep`, `web_search`) | The tool runs again. |
| Any other tool (`bash`, `edit`, `write`, MCP and extension tools) | The call's result keeps its partial output and says it was interrupted, and the turn continues; the model decides whether to run it again. The tool is not rerun automatically, because its side effects may already have happened. |
| A foreground subagent | The same child session is reopened and continues its own interrupted turn; its result returns to the parent. |
| A question or mode-switch dialog | The dialog opens again. |
| Queued steering or follow-up messages | They are still queued and are delivered in order. |
| `/compact` | The compaction runs again. |
| An `agent_before_settle` extension handler | Settlement runs again. |

Interrupted work resumes after extensions receive `session_start`, so extension state is restored before a replayed tool runs.

Extension tools declare whether they may run twice with `replay: "safe"` (see [Extensions](extensions.md#custom-tools)). A replay-safe tool can keep values for its rerun with `ctx.getToolCallMemo(toolCallId)`: values stored with `set()` are returned by `get()` when the same call runs again after a crash. The subagent tool uses this to find the child it started.

## Storage

Each session is one SQLite database (`<timestamp>_<session-id>.sqlite`) with a `.meta.json` file next to it. The `.meta.json` file only caches the `/resume` listing and is rebuilt from the database when missing or stale. A `.lock` file marks the process that has the session open; a second process cannot open the same session at the same time.

Opening an old `.jsonl` session imports it into a `.sqlite` database with the same name. The `.jsonl` file is left unchanged. See [Session Format](session-format.md).

## Differences from the previous agent loop

The session API, events, and extension hooks are unchanged. A few behaviors differ:

- **Retries.** One run covers its automatic retries: listeners get a single `agent_end` (with `willRetry: false`) at the end. Each failed attempt still ends its turn (`turn_end` with the error), and `auto_retry_start`/`auto_retry_end` work as before.
- **Streaming granularity.** Streamed text is committed about ten times per second, so `message_update` events arrive in larger steps.
- **Parallel tools.** `tool_execution_end` events of parallel calls arrive in completion order.
- **Aborts before a request.** Aborting while the run prepares its first request sends no request. The history still gets an empty aborted answer, as before.
- **System prompt and tool changes** are stored as positional system entries in the history; requests show the same prompt and tools as before.
- **`session.agent`** holds the session's state (`state`, `transport`) for compatibility. Its own loop never runs. `agent.subscribe()` listeners receive the turn's loop events and are awaited per event.
- **Branches** are stored as forked conversations inside the same database. `/tree`, `/fork`, and branch summaries work as before.
