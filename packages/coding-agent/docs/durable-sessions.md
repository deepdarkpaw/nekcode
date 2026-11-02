# Durable Sessions and Recovery

nekcode runs every turn on a durable engine ([`@earendil-works/pi-durable`](../../durable/README.md)). Each step of a turn is committed to the session database before the next one starts: the user input, streamed text, each tool call and its result, queued messages, and compactions.

## CLI restart policy

Closing the CLI terminates the active work. When `nek -c`, `--resume`, or `/resume` opens a session, it restores the transcript but does **not** automatically send another model request. Any run left behind by a killed process or closed terminal is aborted during startup; queued steering/follow-up inputs and unfinished compactions are discarded. Send a new message to start a new run.

This policy prevents a terminal restart from silently repeating model requests or tools. SDK callers retain durable crash recovery by default (`resumeInterruptedWork: true`); the CLI passes `resumeInterruptedWork: false`.

After a CLI restart:

- A partial model answer remains in history as an aborted answer.
- An interrupted tool is not run again automatically.
- The session is idle and does not show `Working` until a new prompt is submitted.

Extension tools can still declare whether they may run twice with `replay: "safe"` (see [Extensions](extensions.md#custom-tools)) for SDK callers that opt into durable crash recovery.

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
