# RPC Commands

This reference lists commands accepted on stdin in [RPC mode](rpc.md). Each command and response is one JSON object. Shared message values use the [message types](message-types.md).

## Bounded GUI history (`historyPages: 1`)

`nek gui-info --json` advertises `capabilities.historyPages: 1`. New GUI consumers must require it, not fall back to `read_session_snapshot` or full `get_entries`. Those older commands retain their existing semantics for other callers. The exported TypeScript contract is `src/modes/rpc/gui/history-protocol.ts` (also exported from `gui/protocol.ts` and `rpc-types.ts`).

All six read-only commands work in session and `--control` modes. Pass `sessionPath` in control mode; omitting it in session mode selects only that process's active persisted session. Explicit paths never substitute the current session. No command imports/repairs legacy files, acquires a writer lock, resumes work, or calls a provider.

| Command | Options beyond `sessionPath?`, `branchRevision?`, `maxBytes?` | Result |
| --- | --- | --- |
| `read_session_metadata` | none | Summary/lock holder, effective persisted leaf, full-branch usage and model/thinking selection, child count; no entries/messages |
| `read_history_page` | `beforeCursor?`, `afterCursor?`, `aroundEntryId?` (choose one), `turnLimit?`, `view?: "entries" \| "summary"` | Latest 20 user rounds by default; entries view loads real headers plus bounded tail/around windows, summary view returns only current turn boundaries; older/newer and within-turn cursors |
| `read_history_turn` | `turnId`, `cursor?` | Bounded details continuation with the actual owning header repeated |
| `read_history_directory` | `query?`, `cursor?`, `direction?: "oldest" \| "newest"`, `aroundEntryId?`, `limit?` | Bounded 256-character summaries and stable entry/turn targets; decoded case-insensitive string search streams on nek |
| `read_history_content` | `ref`, `offset?`, `limit?` | Base64-encoded raw UTF8 JSON bytes, total byte length and `nextOffset?` |
| `read_history_subagent` | `subagentId` for lookup; OR omit it and pass `cursor?`, `limit?` for enumeration | Parent-branch-authorized persisted child metadata/path and original spawn anchors; never `finalText` or inferred live status |

The child command has an explicit query union. `{subagentId:string}` retains the original `{subagent:RpcHistorySubagentRecord}` result. Without `subagentId`, enumeration returns `{kind:"subagents",subagents,total,count,hasMore,nextCursor?}` plus the common identity; default20/max100 records under the response byte budget. Records cover the whole persisted parent branch even if their spawn is outside the latest20. First-spawn order/anchors never move on resume/update. Enumeration cursors bind the parent session/effective branch; no child final text is included. Single-ID plus cursor/limit is rejected.

Responses use the usual RPC envelope. History errors are explicit `data: {ok:false,error:{code,message}}`; successful data starts with `ok:true`, `sessionPath`, `sessionId`, `leafId`, `branchRevision`, and `watermark:{entryId,conversationId,nextSeq}`. The watermark describes **persisted storage**, not a live event sequence. Control observes the latest persisted projected leaf; only a session process knows navigation-only selection. Fence pages separately against the GUI's existing live epoch/sequence owner. An explicit `branchRevision` requires an exact match. Cursor/ref capabilities authenticate their observed branch prefix: compatible append remains valid, fork/truncation/navigation away fails. Capabilities expire on process restart; refetch a page after reconnect.

`maxBytes` budgets the actual complete UTF8 response envelope: default 1 MB (1048576 bytes), accepted 65536..4194304 bytes. Turns default/max20, entries max256 per response; directory limit default20/max100, query max256 characters; content limit default65536/max262144 bytes. Invalid limits reject. Request ids are max256 bytes (invalid overlarge ids are not echoed). Leading configuration is included in the first actual user round, not counted as an extra round; its header still points at the user entry and its selection is included in the seed. Only a session with no user yet has a non-user `preamble` descriptor. Selection seeds are metadata, not fabricated display entries.

`read_history_page` defaults to `view:"entries"` (also explicitly echoed in the result). Each selected turn includes its actual user/header and a contiguous bounded tail, including the final persisted assistant reply when present. Long earlier turns cannot consume the budget before other selected turns' tails. With `aroundEntryId`, the owning turn instead loads a window containing that exact entry's display projection; other selected turns still tail-load. Entries are returned in original `position` order with unchanged IDs/anchors. A missing prefix or suffix is **not** a completed turn.

Each page turn's `continuationCursor` is one opaque authenticated itinerary of at most two remaining half-open position ranges (prefix, then suffix). Pass it unchanged to `read_history_turn`; that response's top-level `continuationCursor` is the next itinerary and `hasMore` is exactly its presence. Drain until absent to expose every omitted entry exactly once, except the repeated actual header as explicit context. Merge by stable entry ID and sort by authoritative `position`, never assume continuation means append-only or infer a visual direction. With no cursor, `read_history_turn` starts a full forward turn read. Itineraries pin the original observed range ends: appending does not invalidate them or silently add new entries to an old chain. Refetch latest boundaries for subsequent growth. Same-cursor retries are deterministic for unchanged storage; following returned cursors strictly advances. Invalid/foreign/stale/wrong-turn/wrong-kind capabilities fail explicitly.

`view:"summary"` uses the same turn selection, older/newer cursors, source identity/watermark and totals, but returns a distinct `RpcHistorySummaryPage`: no `entries`, loaded `header`, selection seed or content omissions/refs. Each turn contains `id`, `userEntryId`, `position`, metadata `preview`, `entryCount`, `headerEntryId`, `headerPosition`, and a full-observed-turn `continuationCursor`. It uses the existing bounded request-local storage metadata index and does not open selected-entry body sources, tokenize display fields, resolve tool anchors, or generate omission capabilities. Legacy JSONL still requires its normal bounded structural/index scan; summary is not a persisted index or body cache. A host can refresh current latest boundaries after long live growth without replaying bodies. **Do not mark summary turns loaded, replace existing loaded entries, or overwrite a loaded window's remaining-range cursor with a summary's full-turn cursor.** Keep existing epoch/live-sequence admission; the persisted watermark is not a live stream sequence. No new command or handler is needed; capability stays `historyPages:1` until publication.

Display entries carry `entry: Record<string,unknown>` and `omissions: {pointer,ref,totalBytes,mediaType,encoding,format?}[]`. Only an empty omissions list means a complete entry. Oversized fields/subtrees are **explicitly** replaced with null, never silently truncated. Reconstruct an omitted JSON value by concatenating the decoded byte chunks, then `JSON.parse`; offsets are bytes of its original JSON encoding, not character offsets or decoded image bytes. Root omissions with `format:"durable-record"` contain the original durable record and require the normal `projectRecord` projection. Never feed a display projection into model context. Tool results include their original `toolCallOrigin` (or null if none was persisted); child facts carry bounded summaries with original spawn positions even when the spawn lies outside the page. Further children are available through targeted lookup. Child files in the `subagents` directory are checked against their persisted parent's current branch before reading.

SQLite uses indexed ID batches and native scalar/substr reads inside one read transaction. Legacy version-1/2/3 JSONL uses bounded token scanning, not whole-line parsing. Old migrations are virtual: v1 entry IDs are stable `j<hex original byte offset>` and hookMessage becomes custom without modifying files. Root `session-entry` sources from v1 need the wrapper's authoritative IDs when projecting. Request-local indexes expire when the request closes: at most100000 records and64 MB entry metadata,16384 child identities/16 MB child metadata, and256 cached tool anchors, with visible `INDEX_LIMIT` errors when exhausted. No historical body/result cache is retained. The durable owner treats SQLite rows as immutable; cursor fingerprints include row identity/commit sequence/length/metadata. External in-place database tampering outside that storage contract is unsupported. Legacy cursors additionally fingerprint the full raw record bytes. Legacy append racing an index scan returns a visible retryable storage error rather than claiming a newer snapshot.

## Opt-in bounded live conversation events (`historyStream: 1`)

`gui-info.capabilities.historyStream:1` advertises the session-only command `{type:"set_history_stream",version:1}`. Negotiate before prompting/history bootstrap. Response data is `{version:1,epoch,maxEventBytes:1048576}`; version0 explicitly restores the original event wire. The default remains exactly the pre-existing RPC `toJsonEvent` behavior. Control mode rejects negotiation. No settings, TUI, model context or durable write format changes.

Public wire types are `src/modes/rpc/gui/history-stream-protocol.ts`, re-exported by GUI protocol/rpc-types. New frames carry `version:1`, an epoch and increasing per-record `seq`:

- `history_stream_reset {sessionPath?,sessionId}` starts a fresh epoch on enable/rebind (before the negotiation acknowledgement).
- `history_event {eventId,event,omissions}` wraps the normalized live event. An omission is `{pointer,resolution:"history",reason:"persisted_body"|"redundant_delta"}`; metadata-only messages/results are **not** complete snapshots.
- `history_entry_appended {sessionPath,sessionId,entryId,leafId,ref:{command:"read_history_page",sessionPath,aroundEntryId}}` announces an entry only after the non-consuming `SessionManager.waitForWrites()` barrier observes existing writes. The observer never clears a write error that the original owner must still receive through `flush()`. Cached committed identity indexes are checked without a body read/write; an unobserved/uncommitted ID emits `history_entry_pending`. This storage locator is admitted by a bounded around read, which validates the current branch and supplies opaque content refs. It is not permission to hydrate all history. Deduplicate by path+entry ID. Ordinary committed messages are announced too, using an independent incremental committed cursor; no full get_entries/snapshot scan. Setup entries with no file yet emit `history_entry_pending {sessionPath?,sessionId,entryId}` instead of falsely claiming persistence.
- Oversized nonredundant transient events use `history_event_start {eventId,eventType,encoding:"json-utf8/base64",omissions}`, then `history_event_chunk {eventId,offset,data,final:false}`, and a terminal chunk `{eventId,offset,data:"",final:true,totalBytes}`. Base64 decodes to contiguous raw JSON UTF8 bytes (<=49152 bytes/chunk). A bounded streaming decoder/explicit oversized placeholder must consume these; do not automatically reconstruct a huge v4 object. Final immutable content remains refetchable through history pages.
- `history_stream_error {code,message}` is visible and stops negotiated emission without legacy fallback or model rerun. Explicitly refetch bounded history and renegotiate. Discard incomplete fragments on error/reset; never admit old-epoch fragments into the new session.

Cumulative message/end/turn/agent snapshots, final tool content/details, repeated tool arguments, compaction results and text/thinking/tool-call end copies resolve through persisted history/preceding deltas rather than being serialized again. Original durable records remain unchanged. Authoritative replacement starts, field-path/replace deltas, transient tool progress and nonpersisted structured result extras remain exact; large values stream without serializing or buffering the entire JSON object first. Extension events use the same negotiated bounded transport. Extension **UI dialogs/commands/responses** retain their separate existing protocol and are not a history transport.

Every new frame is checked on actual UTF8 JSON size and limited to1 MB; encoding uses a <=1 MB admission window,64 KB byte chunks,8192-code-unit string escapes,64 nesting levels,32 queued events and4096 new committed entries per drain. Existing RPC stdout backpressure is awaited between chunks. There is no completed body spool/cache. Stream errors never abort/resume/rerun a provider. Existing GUI live epoch/sequence/projection ownership must reconcile ephemeral deltas and authoritative persisted entry identities; storage watermarks are not live sequence numbers.

## Prompting

### prompt

Send a user prompt to the agent. The command response is emitted after the prompt is accepted, queued, or handled. Events continue streaming asynchronously after acceptance.

```json
{"id": "req-1", "type": "prompt", "message": "Hello, world!"}
```

With images:
```json
{"type": "prompt", "message": "What's in this image?", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

**During streaming**: If the agent is already streaming, you must specify `streamingBehavior` to queue the message:

```json
{"type": "prompt", "message": "New instruction", "streamingBehavior": "steer"}
```

- `"steer"`: Queue the message while the agent is running. It is delivered after the current assistant turn finishes executing its tool calls, before the next LLM call.
- `"followUp"`: Wait until the agent finishes. Message is delivered only when agent stops.

If the agent is streaming and no `streamingBehavior` is specified, the command returns an error.

**Extension commands**: If the message is an extension command (e.g., `/mycommand`), it executes immediately even during streaming. Extension commands manage their own LLM interaction via `pi.sendMessage()`.

**Input expansion**: Skill commands (`/skill:name`) and prompt templates (`/template`) are expanded before sending/queueing.

Response:
```json
{"id": "req-1", "type": "response", "command": "prompt", "success": true, "data": {"disposition": "started"}}
```

`data.disposition` is `"handled"` if an extension command or input handler consumed the prompt, `"queued"` if nekcode queued it during a run, or `"started"` if nekcode accepted it to start a run. This describes the submitted prompt, not independent work started by an extension or a guarantee of completion.

`success: true` means the prompt was accepted, queued, or handled immediately. `success: false` means the prompt was rejected before acceptance. Failures after acceptance are reported through the normal event and message stream, not as a second `response` for the same request id.

The `images` field is optional. Each image uses `ImageContent` format: `{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}`.

### steer

Queue a steering message while the agent is running. It is delivered after the current assistant turn finishes executing its tool calls, before the next LLM call. Skill commands and prompt templates are expanded. Extension commands are not allowed (use `prompt` instead).

```json
{"type": "steer", "message": "Stop and do this instead"}
```

With images:
```json
{"type": "steer", "message": "Look at this instead", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

The `images` field is optional. Each image uses `ImageContent` format (same as `prompt`).

Response:
```json
{"type": "response", "command": "steer", "success": true, "data": {"disposition": "queued"}}
```

`data.disposition` is `"handled"` if an input handler consumed this steer, or `"queued"` if nekcode queued it (including after a handler transformed it). It does not guarantee this message remains queued.

See [set_steering_mode](#set_steering_mode) for controlling how steering messages are processed.

### follow_up

Queue a follow-up message to be processed after the agent finishes. Delivered only when agent has no more tool calls or steering messages. Skill commands and prompt templates are expanded. Extension commands are not allowed (use `prompt` instead).

```json
{"type": "follow_up", "message": "After you're done, also do this"}
```

With images:
```json
{"type": "follow_up", "message": "Also check this image", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

The `images` field is optional. Each image uses `ImageContent` format (same as `prompt`).

Response:
```json
{"type": "response", "command": "follow_up", "success": true, "data": {"disposition": "queued"}}
```

`data.disposition` has the same `"handled"` or `"queued"` meaning as for `steer`, applied to this follow-up.

See [set_follow_up_mode](#set_follow_up_mode) for controlling how follow-up messages are processed.

### abort

Abort the current operation and wait for the session to become idle before responding.

```json
{"type": "abort"}
```

Response:
```json
{"type": "response", "command": "abort", "success": true}
```

### clear_queue

Remove queued steering and follow-up messages and return their text.

```json
{"type": "clear_queue"}
```

Response:
```json
{
  "type": "response",
  "command": "clear_queue",
  "success": true,
  "data": {
    "steering": ["Change direction"],
    "followUp": ["Summarize when finished"]
  }
}
```

To implement interactive Esc behavior, send `clear_queue` before `abort`, then restore the returned text in the client editor. `abort` continues queued messages when they remain in the session.

### new_session

Start a fresh session. Can be canceled by a `session_before_switch` extension event handler.

```json
{"type": "new_session"}
```

With optional parent session tracking:
```json
{"type": "new_session", "parentSession": "/path/to/parent-session.sqlite"}
```

Response:
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": false}}
```

If an extension canceled:
```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": true}}
```

## State

### get_state

Get current session state.

```json
{"type": "get_state"}
```

Response:
```json
{
  "type": "response",
  "command": "get_state",
  "success": true,
  "data": {
    "model": {...},
    "thinkingLevel": "medium",
    "isStreaming": false,
    "isCompacting": false,
    "steeringMode": "all",
    "followUpMode": "one-at-a-time",
    "sessionFile": "/path/to/session.sqlite",
    "sessionId": "abc123",
    "sessionName": "my-feature-work",
    "autoCompactionEnabled": true,
    "messageCount": 5,
    "pendingMessageCount": 0
  }
}
```

The `model` field is a full [Model](#model-object) object, or omitted when no model is selected. The `sessionName` field is the display name set via `set_session_name`, or omitted if not set.

### get_messages

Get all messages in the conversation.

```json
{"type": "get_messages"}
```

Response:
```json
{
  "type": "response",
  "command": "get_messages",
  "success": true,
  "data": {"messages": [...]}
}
```

Messages are `AgentMessage` objects (see [Message Types](message-types.md)).

## Model

### set_model

Switch to a specific model.

```json
{"type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-20250514"}
```

Response contains the full [Model](#model-object) object:
```json
{
  "type": "response",
  "command": "set_model",
  "success": true,
  "data": {...}
}
```

### cycle_model

Cycle to the next available model. Returns `null` data if only one model available.

```json
{"type": "cycle_model"}
```

Response:
```json
{
  "type": "response",
  "command": "cycle_model",
  "success": true,
  "data": {
    "model": {...},
    "thinkingLevel": "medium",
    "isScoped": false
  }
}
```

The `model` field is a full [Model](#model-object) object.

### get_available_models

List all configured models.

```json
{"type": "get_available_models"}
```

Response contains an array of full [Model](#model-object) objects:
```json
{
  "type": "response",
  "command": "get_available_models",
  "success": true,
  "data": {
    "models": [...]
  }
}
```

## Thinking

### set_thinking_level

Set the reasoning/thinking level for models that support it.

```json
{"type": "set_thinking_level", "level": "high"}
```

Levels: `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"`

`"xhigh"` and `"max"` are exposed only when supported by the selected model. Some models, including GPT-5.6, expose both.

Response:
```json
{"type": "response", "command": "set_thinking_level", "success": true}
```

### cycle_thinking_level

Cycle through available thinking levels. Returns `null` data if model doesn't support thinking.

```json
{"type": "cycle_thinking_level"}
```

Response:
```json
{
  "type": "response",
  "command": "cycle_thinking_level",
  "success": true,
  "data": {"level": "high"}
}
```

### get_available_thinking_levels

List the thinking levels supported by the current model. Returns `["off"]` for a model without reasoning support.

```json
{"type": "get_available_thinking_levels"}
```

Response:
```json
{
  "type": "response",
  "command": "get_available_thinking_levels",
  "success": true,
  "data": {
    "levels": ["off", "minimal", "low", "medium", "high"]
  }
}
```

## Queue modes

### set_steering_mode

Control how steering messages (from `steer`) are delivered.

```json
{"type": "set_steering_mode", "mode": "one-at-a-time"}
```

Modes:
- `"all"`: Deliver all steering messages after the current assistant turn finishes executing its tool calls
- `"one-at-a-time"`: Deliver one steering message per completed assistant turn (default)

Response:
```json
{"type": "response", "command": "set_steering_mode", "success": true}
```

### set_follow_up_mode

Control how follow-up messages (from `follow_up`) are delivered.

```json
{"type": "set_follow_up_mode", "mode": "one-at-a-time"}
```

Modes:
- `"all"`: Deliver all follow-up messages when agent finishes
- `"one-at-a-time"`: Deliver one follow-up message per agent completion (default)

Response:
```json
{"type": "response", "command": "set_follow_up_mode", "success": true}
```

## Compaction

### compact

Manually compact conversation context to reduce token usage.

```json
{"type": "compact"}
```

With custom instructions:
```json
{"type": "compact", "customInstructions": "Focus on code changes"}
```

Response:
```json
{
  "type": "response",
  "command": "compact",
  "success": true,
  "data": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "estimatedTokensAfter": 32000,
    "usage": {
      "input": 32000,
      "output": 1200,
      "cacheRead": 0,
      "cacheWrite": 0,
      "totalTokens": 33200,
      "cost": {"input": 0.01, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.03}
    },
    "details": {}
  }
}
```

`estimatedTokensAfter` is a heuristic estimate over the rebuilt message context immediately after compaction, not a provider-exact token count. `usage` reports the LLM call or calls that generated the summary and may be omitted by custom compaction handlers.

### set_auto_compaction

Enable or disable automatic compaction when context is nearly full.

```json
{"type": "set_auto_compaction", "enabled": true}
```

Response:
```json
{"type": "response", "command": "set_auto_compaction", "success": true}
```

## Retry

### set_auto_retry

Enable or disable automatic retry on transient errors (overloaded, rate limit, 5xx).

```json
{"type": "set_auto_retry", "enabled": true}
```

Response:
```json
{"type": "response", "command": "set_auto_retry", "success": true}
```

### abort_retry

Abort an in-progress retry (cancel the delay and stop retrying).

```json
{"type": "abort_retry"}
```

Response:
```json
{"type": "response", "command": "abort_retry", "success": true}
```

## Bash

### bash

Execute a shell command and add output to conversation context. Output streams as `bash_execution_update` events while the command runs; the response contains the final result.

```json
{"id": "req-1", "type": "bash", "command": "ls -la"}
```

Set `excludeFromContext` to `true` when the command output should be stored in the session but omitted from the model context on the next prompt.

Include an `id` to associate streamed `bash_execution_update` events with this command.

Response:
```json
{
  "id": "req-1",
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "total 48\ndrwxr-xr-x ...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": false
  }
}
```

If output was truncated, includes `fullOutputPath`:
```json
{
  "type": "response",
  "command": "bash",
  "success": true,
  "data": {
    "output": "truncated output...",
    "exitCode": 0,
    "cancelled": false,
    "truncated": true,
    "fullOutputPath": "/tmp/pi-bash-abc123.log"
  }
}
```

**How bash results reach the LLM:**

The `bash` command executes immediately and returns a `BashResult`. Internally, a `BashExecutionMessage` is created and stored in the agent's message state.

When the next `prompt` command is sent, nekcode transforms context messages before sending them to the model. Unless `excludeFromContext` is true, the `BashExecutionMessage` becomes a `UserMessage` with this format:

````
Ran `ls -la`
```
total 48
drwxr-xr-x ...
```
````

This means:
1. Included bash output reaches the model on the **next prompt**, not immediately.
2. Multiple bash commands can run before a prompt; nekcode includes each output that does not set `excludeFromContext`.

### abort_bash

Abort a running bash command.

```json
{"type": "abort_bash"}
```

Response:
```json
{"type": "response", "command": "abort_bash", "success": true}
```

## Session

### get_session_stats

Get token usage, cost statistics, and current context window usage.

```json
{"type": "get_session_stats"}
```

Response:
```json
{
  "type": "response",
  "command": "get_session_stats",
  "success": true,
  "data": {
    "sessionFile": "/path/to/session.sqlite",
    "sessionId": "abc123",
    "userMessages": 5,
    "assistantMessages": 5,
    "toolCalls": 12,
    "toolResults": 12,
    "totalMessages": 22,
    "tokens": {
      "input": 50000,
      "output": 10000,
      "cacheRead": 40000,
      "cacheWrite": 5000,
      "total": 105000
    },
    "cost": 0.45,
    "contextUsage": {
      "tokens": 60000,
      "contextWindow": 200000,
      "percent": 30
    }
  }
}
```

`tokens` and `cost` include assistant messages, usage reported by tools, and compaction/branch-summary generation across the full session. `contextUsage` contains the actual current context-window estimate used for compaction and footer display.

`contextUsage` is omitted when no model or context window is available. `contextUsage.tokens` and `contextUsage.percent` are `null` immediately after compaction until a fresh post-compaction assistant response provides valid usage data.

### export_html

Export session to an HTML file.

```json
{"type": "export_html"}
```

With custom path:
```json
{"type": "export_html", "outputPath": "/tmp/session.html"}
```

Response:
```json
{
  "type": "response",
  "command": "export_html",
  "success": true,
  "data": {"path": "/tmp/session.html"}
}
```

### switch_session

Load a different session file. Can be canceled by a `session_before_switch` extension event handler.

```json
{"type": "switch_session", "sessionPath": "/path/to/session.sqlite"}
```

Response:
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": false}}
```

If an extension canceled the switch:
```json
{"type": "response", "command": "switch_session", "success": true, "data": {"cancelled": true}}
```

### fork

Create a new fork from a previous user message on the active branch. Can be canceled by a `session_before_fork` extension event handler. Returns the text of the message being forked from.

```json
{"type": "fork", "entryId": "abc123"}
```

Response:
```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"text": "The original prompt text...", "cancelled": false}
}
```

If an extension canceled the fork:
```json
{
  "type": "response",
  "command": "fork",
  "success": true,
  "data": {"cancelled": true}
}
```

### clone

Duplicate the current active branch into a new session at the current position. Can be canceled by a `session_before_fork` extension event handler.

```json
{"type": "clone"}
```

Response:
```json
{
  "type": "response",
  "command": "clone",
  "success": true,
  "data": {"cancelled": false}
}
```

If an extension canceled the clone:
```json
{
  "type": "response",
  "command": "clone",
  "success": true,
  "data": {"cancelled": true}
}
```

### get_fork_messages

Get user messages available for forking.

```json
{"type": "get_fork_messages"}
```

Response:
```json
{
  "type": "response",
  "command": "get_fork_messages",
  "success": true,
  "data": {
    "messages": [
      {"entryId": "abc123", "text": "First prompt..."},
      {"entryId": "def456", "text": "Second prompt..."}
    ]
  }
}
```

### get_entries

Get all session entries in append order (excluding the session header). The session is an append-only tree of entries with stable ids, so an entry id works as a durable cursor: pass the last entry id you have seen as `since` to get only entries strictly after it, even across client restarts. Unlike `get_messages`, this includes pre-compaction history and abandoned branches.

```json
{"type": "get_entries"}
```

With a cursor:
```json
{"type": "get_entries", "since": "abc123"}
```

One page, newest first:
```json
{"type": "get_entries", "limit": 50}
```

The page older than an entry:
```json
{"type": "get_entries", "limit": 50, "beforeEntryId": "abc123"}
```

Response:
```json
{
  "type": "response",
  "command": "get_entries",
  "success": true,
  "data": {
    "entries": [
      {"type": "message", "id": "def456", "parentId": "abc123", "timestamp": "...", "message": {"role": "user", "...": "..."}}
    ],
    "leafId": "def456",
    "hasMore": false
  }
}
```

`leafId` is the id of the current leaf entry (`null` for an empty session), so a client can tell in one round trip whether the active branch moved. If `since` does not match any entry id, the response is `success: false`.

`limit` and `beforeEntryId` page the same list without changing what it means: a page is the newest `limit` entries older than `beforeEntryId`, so `{"limit": 50}` is the last 50 entries and `{"limit": 50, "beforeEntryId": "<first entry of that page>"}` is the 50 before them. `beforeEntryId` alone returns every older entry, and `hasMore` says whether entries older than the page exist, so a client walks history back from the leaf. Without both parameters, the response is the full list with `hasMore: false`, exactly as before; `since` still applies first, so the page is taken from the entries after that cursor. A `limit` that is not a positive integer, or a `beforeEntryId` that matches no entry, is `success: false`.

### get_tree

Get the session as a tree of entries. Each node is `{entry, children, label?, labelTimestamp?}`. The result is an array because navigation APIs can create multiple roots; orphaned entries with broken parent chains also appear as roots.

```json
{"type": "get_tree"}
```

Response:
```json
{
  "type": "response",
  "command": "get_tree",
  "success": true,
  "data": {
    "tree": [
      {
        "entry": {"type": "message", "id": "abc123", "parentId": null, "...": "..."},
        "children": [
          {"entry": {"type": "message", "id": "def456", "parentId": "abc123", "...": "..."}, "children": []}
        ]
      }
    ],
    "leafId": "def456"
  }
}
```

### get_last_assistant_text

Get the text content of the last assistant message.

```json
{"type": "get_last_assistant_text"}
```

Response:
```json
{
  "type": "response",
  "command": "get_last_assistant_text",
  "success": true,
  "data": {"text": "The assistant's response..."}
}
```

The `text` value is `null` if no assistant text exists.

### set_session_name

Set a display name for the current session. The name appears in session listings and helps identify sessions.

```json
{"type": "set_session_name", "name": "my-feature-work"}
```

Response:
```json
{
  "type": "response",
  "command": "set_session_name",
  "success": true
}
```

The current session name is available via `get_state` in the `sessionName` field. To set the initial name when starting RPC mode, pass `--name <name>` or `-n <name>` to the `nek --mode rpc` process.

## Discoverable commands

### get_commands

Get available commands (extension commands, prompt templates, and skills). Run one through the `prompt` command by prefixing its name with `/`.

```json
{"type": "get_commands"}
```

Response:
```json
{
  "type": "response",
  "command": "get_commands",
  "success": true,
  "data": {
    "commands": [
      {
        "name": "fix-tests",
        "description": "Fix failing tests",
        "source": "prompt",
        "sourceInfo": {
          "path": "/home/user/myproject/.nek/agent/prompts/fix-tests.md",
          "source": "local",
          "scope": "project",
          "origin": "top-level"
        }
      }
    ]
  }
}
```

Each command has:
- `name`: Command name (use `/name`)
- `description`: Human-readable description (optional for extension commands)
- `source`: What kind of command:
  - `"extension"`: Registered via `pi.registerCommand()` in an extension
  - `"prompt"`: Loaded from a prompt template `.md` file
  - `"skill"`: Loaded from a skill directory (name is prefixed with `skill:`)
- `sourceInfo`: Metadata for the resource that registered the command:
  - `path`: Absolute path to the resource
  - `source`: How nekcode discovered it, such as `"local"`, `"auto"`, or `"cli"`
  - `scope`: `"user"`, `"project"`, or `"temporary"`
  - `origin`: `"top-level"` for a directly loaded resource or `"package"` for a package resource
  - `baseDir`: Package base directory, when applicable

**Note**: Built-in TUI commands (`/settings`, `/hotkeys`, etc.) are not included. They are handled only in interactive mode and would not execute if sent via `prompt`.

## GUI commands

These commands serve desktop and IDE clients that manage configuration and sessions alongside a session. Every one answers with the usual `response` record; a failure is `success: false` with `error` unless the command documents a structured result instead.

`nek --mode rpc --control` runs a **control process**: no session, no extensions, no MCP servers. It accepts only these commands plus `get_available_models`, and answers anything else with `{"success": false, "error": "Command not available in control mode: <type>"}`.

### get_info

Identity of the running process.

```json
{"type": "get_info"}
```

Response data: `protocolVersion`, `nekVersion`, `piVersion`, `mode` (`"session"` or `"control"`), `agentDir`, `sessionDir`, `cwd`, `platform`, `nodeVersion`.

### reload

Re-read `settings.json`, `models.json`, credentials, and MCP configuration. In a session process it also reloads extensions, skills, prompts, themes, and context files through the session.

```json
{"type": "reload"}
```

Response data: `deferred` and `diagnostics`. `deferred: true` means a run is in flight: the reload is queued and applied after `agent_settled`, and the response carries a validation pass of the current configuration instead of reload results.

### validate_config

Check configuration files without applying them.

```json
{"type": "validate_config", "cwd": "/home/user/project"}
```

Response data: `diagnostics`, an array of `{file, severity, message}`. Without `cwd` only global files are checked: `models.json` (schema), the global `settings.json`, and the global `mcp.json`, `nek.yaml`, and `agents/*.md`. With `cwd`, the project `settings.json`, `mcp.json`, `nek.yaml`, and `agents/*.md` are checked too, once the project is trusted.

### get_changelog

Bundled `CHANGELOG.md` as Markdown, newest entry first.

```json
{"type": "get_changelog", "sinceVersion": "0.3.0"}
```

Response data: `markdown`. `sinceVersion` limits the result to entries newer than that version.

### get_mention_targets

What `@agent:<type>` and `@skill:<name>` can complete to.

```json
{"type": "get_mention_targets", "cwd": "/home/user/project"}
```

Response data: `targets`, each with `kind` (`"agent"` or `"skill"`), `name`, optional `description`, and, for skills, `location` (the skill's `SKILL.md`).

Subagent types come first, in the order of the `subagents` system prompt section: the built-in types, then user presets, then project presets. Skills follow in the order of the session's loaded skills.

`cwd` names the directory to describe. A session answers from its live resources, so extension-provided skills and its own trust decision apply; asked about a different directory, it answers from that directory's files instead. The control process always answers from the files of `cwd` (default: its working directory), which means `<agentDir>/skills` and, once the project is trusted, `<cwd>/.nek/skills`.

### list_builtin_tools

The built-in tools a settings page can select in `defaultTools`.

```json
{"type": "list_builtin_tools"}
```

Response data: `tools`, each with `name`, `description` (as the model sees it), and `defaultActive` (the tool is offered in a new session when neither settings nor options select tools). The list is nek's own: the names and their order come from the built-in tool table, so it always matches what `defaultTools` accepts.

### list_sessions

List sessions, newest first.

```json
{"type": "list_sessions", "cwd": "/home/user/project", "all": true, "limit": 100}
```

`cwd` selects the project directory (default: the process working directory). `all: true` lists every project under the session root. `limit` defaults to 500.

Response data: `sessions`, each with `path`, `id`, `cwd`, `name?`, `parentSessionPath?`, `createdAt`, `modifiedAt`, `messageCount`, `firstMessage` (truncated to 200 characters), and `locked` (a live process holds the session lock).

### delete_session

Delete a session and every file it owns: the database, its sidecar, and SQLite journal files.

```json
{"type": "delete_session", "sessionPath": "/home/user/.nek/agent/sessions/--home-user-project--/2026-01-01T00-00-00-000Z_uuid.sqlite"}
```

The current session and sessions whose lock a live process holds are refused.

### rename_session

Set a session's display name.

```json
{"type": "rename_session", "sessionPath": "...sqlite", "name": "Refactor the parser"}
```

The name is stored as a `session_info` entry, the same entry `/resume` writes. A locked session is refused.

### read_session_snapshot

Read a session without opening it as a session and without taking its lock.

```json
{"type": "read_session_snapshot", "sessionPath": "...sqlite"}
```

Response data: `session` (as in `list_sessions`), `entries` (same shape as `get_entries`), `leafId`, `messages` (same shape as `get_messages` on the leaf branch), and `lockedBy` while a live process holds the session lock.

`lockedBy` names that process: `pid`, `hostname`, `kind` (`"tui"` for the terminal UI, `"rpc"`, or a one-shot run as `"print"` or `"json"`), and `startedAt` (ISO 8601). It is omitted while the session is unlocked, when the lock is stale, and for a lock written before nek recorded the holder, so `session.locked` remains the field that says whether a session is in use.

### import_session

Import a JSONL session or session database as a new session of another working directory.

```json
{"type": "import_session", "inputPath": "/home/user/export.jsonl", "cwd": "/home/user/project"}
```

Response data: `sessionPath`, the new session file. The source file is left untouched.

### export_session

Export the current session.

```json
{"type": "export_session", "format": "html"}
```

`format` is `"html"` (self-contained page) or `"jsonl"`. `outputPath` is optional; without it the export lands next to the session or in the working directory. Response data: `path`. Session processes only.

### share_session

Upload the current session and return a viewer URL. It uses Radius when configured and otherwise a private GitHub gist, which needs `gh auth login`. Response data: `url`. Session processes only.

### navigate_tree

Move the session leaf to an entry, optionally summarizing the branch that is left behind.

```json
{"type": "navigate_tree", "entryId": "a1b2c3d4", "summarize": true, "label": "checkpoint"}
```

Response data: `cancelled`, and `editorText` when the target restores editor text. Session processes only.

### set_entry_label

Set or clear an entry label. Same storage as the `/tree` label editor.

```json
{"type": "set_entry_label", "entryId": "a1b2c3d4", "label": "before refactor"}
```

### auth_status

Credential status of every known provider.

```json
{"type": "auth_status"}
```

Response data: `providers`, each with `provider`, `name` (auth display name), `kind` (`"oauth"`, `"api_key"`, `"env"`, or `"none"`), `loginMethods` (`"oauth"` and/or `"api_key"`), `expiresAt` for stored OAuth credentials, and `state`. nek refreshes expiring OAuth tokens itself.

`state` is `"expired"` when a stored OAuth access token is past its `expires`, and `"ok"` otherwise, including rows with a stored API key, an ambient key, or no credential at all (nothing dated to judge). `"refresh_failed"` is part of the value union but nek never sends it: it persists no refresh outcome, so a token whose refresh failed keeps reporting `"expired"` until a refresh succeeds. `expiresAt` is preserved for every stored OAuth credential, so the existing fields are unchanged.

### auth_login

Run a provider's interactive login.

```json
{"type": "auth_login", "provider": "anthropic", "method": "oauth"}
```

`method` defaults to the provider's first supported method. While the flow runs, nek writes [`auth_event`](json.md#auth-event) records for progress, URLs, and device codes, and asks for input through the `auth.prompt` structured interaction (see [RPC extension UI](rpc-extension-ui.md#structured)). A cancelled or aborted prompt ends the login with an error response. Response data: `provider`.

### auth_logout

Remove a provider's stored credential.

```json
{"type": "auth_logout", "provider": "anthropic"}
```

### get_model_catalog

Models nek knows about: built-in providers plus `models.json` entries.

```json
{"type": "get_model_catalog", "provider": "anthropic", "ids": ["claude-sonnet-4-5"]}
```

Response data: `models`, each with `provider`, `id`, `name`, `api`, `contextWindow`, `maxTokens`, `reasoning`, `thinkingLevels` (the levels this model accepts), optional `thinkingLevelMap`, `input`, and `cost`.

### fetch_provider_models

List the models an endpoint serves, either from a configured provider or from a draft provider entry.

```json
{
  "type": "fetch_provider_models",
  "draft": {"api": "openai-completions", "baseUrl": "https://api.example.com/v1", "apiKey": "$EXAMPLE_KEY"}
}
```

`draft` has `api` (`openai-completions`, `openai-responses`, `anthropic-messages`, or `google-generative-ai`), `baseUrl`, optional `apiKey` (literal, `$ENV`, or `!command`), optional `headers`, and optional `authHeader`.

A saved provider is asked for the same list by id, and `overrides` edits its configuration before the request, so a settings page can test edits before saving them:

```json
{
  "type": "fetch_provider_models",
  "provider": "my-endpoint",
  "overrides": {"baseUrl": "https://staging.example.com/v1", "headers": {"X-Debug": "1"}}
}
```

`overrides` has the same fields as a draft, all optional: `api`, `baseUrl`, `apiKey` (literal, `$ENV`, or `!command`; `""` sends no key), `headers` (added to the saved headers, replacing entries of the same name), and `authHeader`. Each field replaces the saved value, and absent fields keep it, so the request uses the saved provider's resolved API key and headers unless they are overridden. An unknown `provider` is a command error: `Unknown provider: <id>`. Passing `overrides` with `draft` is refused, because a draft carries its whole configuration already.

The request matches what nek sends for that API: an OpenAI-compatible base URL is asked for `<base>/models` with a bearer token, an Anthropic base URL for `<base>/v1/models` with `x-api-key` and `anthropic-version`, and a Gemini base URL (which already carries its version) for `<base>/models` with `x-goog-api-key`. Discovery follows `after_id` (Anthropic) and `pageToken` (Gemini) pagination, up to 20 pages and 2000 models, within 15 seconds. The `httpProxy` setting and `$ENV`/`!command` keys resolve exactly as they do for real requests.

Response data is `{"ok": true, "endpoint": "<url>", "models": [...]}` or `{"ok": false, "endpoint": "<url>", "status": 401, "message": "..."}`. A failed discovery is data, not a command error, so a client can map `401`, `403`, and `404` in its UI. Each model has `id`, optional `name`, `contextWindow`, `maxTokens`, `reasoning`, `thinkingLevels`, and `input`.

### test_provider

Send one minimal completion to verify an endpoint and model.

```json
{"type": "test_provider", "provider": "anthropic", "modelId": "claude-sonnet-4-5"}
```

Pass `draft` instead of `provider` to test an unsaved endpoint. The request uses the provider's resolved auth or the draft's configuration, with a 30 second timeout. Response data is `{"ok": true, "latencyMs": 812}` or `{"ok": false, "status": 401, "message": "..."}`.

`overrides` works as it does for `fetch_provider_models`, so an edited base URL, header, or key can be tried before it is saved:

```json
{
  "type": "test_provider",
  "provider": "my-endpoint",
  "modelId": "my-model",
  "overrides": {"apiKey": "$STAGING_KEY"}
}
```

### get_project_trust

Trust decision for a directory and the project resources that need one.

```json
{"type": "get_project_trust", "cwd": "/home/user/project"}
```

Response data: `cwd`, `trusted` (`true`, `false`, or `null` when nothing is stored), `defaultProjectTrust` (`"ask"`, `"always"`, or `"never"`), and `resources`, each with `kind` (`settings`, `mcp`, `extensions`, `skills`, `prompts`, `themes`, `agents`, `system_prompt`) and `path`.

### set_project_trust

Store a trust decision for a directory. This writes the same `trust.json` as the trust prompt and `/trust`.

```json
{"type": "set_project_trust", "cwd": "/home/user/project", "trusted": true}
```

### test_web_search

Run one web search with the configured `webSearch` settings.

```json
{"type": "test_web_search", "query": "nek rpc"}
```

Response data is `{"ok": true, "latencyMs": 640, "resultCount": 8}` or `{"ok": false, "message": "..."}`.

### mcp_test

Connect to an MCP server, list its tools, and disconnect.

```json
{"type": "mcp_test", "name": "docs", "cwd": "/home/user/project"}
```

The name is looked up in the global `mcp.json` and, for a trusted project, in `<cwd>/.nek/mcp.json`. Pass `config` instead to test an entry that is not saved yet. Response data is `{"ok": true, "latencyMs": 220, "tools": [{"name": "search", "description": "..."}]}` or `{"ok": false, "message": "..."}`.

### extension_call

Call an RPC method an extension registered with `pi.registerRpcHandler()`. Session processes only.

```json
{"type": "extension_call", "method": "nek.get_state", "params": {}}
```

Response data: `{ "result": <handler return value> }`. An unknown method is a command error: `No RPC handler registered for method: <method>`. Extensions push updates the other way with `pi.emitRpcEvent()`, which becomes an [`extension_event`](json.md#extension-event) record.

The built-in `nek` extension exposes these session methods:

| method | params | result |
|---|---|---|
| `nek.get_state` | `{}` | `{mode, todos, plans, activePlanPath?, subagents}` |
| `nek.set_mode` | `{mode: "agent"|"plan"}` | the complete state snapshot |
| `nek.stop_subagent` | `{id}` | `{status}` |
| `nek.get_subagent_transcript` | `{id}` | `{messages}` |
| `nek.list_agent_types` | `{}` | `{types:[{name,description,source,readonly,background,autonomous,model?,thinking?}]}` |
| `nek.get_plan` | `{path}` | `{path,name,overview,revision,status,todos,markdown}` |

The built-in MCP extension exposes these session methods:

- `mcp.status` with `{}` returns `{servers:[...]}`.
- `mcp.test` with `{name}` connects, lists the server tools, and disconnects. It returns `{ok:true,latencyMs,tools}` or `{ok:false,message}`.
- `mcp.reconnect` with `{name}`, `mcp.login` with `{name}`, and `mcp.logout` with `{name}` each return `{server:<status>}`. Login reuses the normal OAuth browser/callback flow.

An `extension_event` named `nek.state` carries the complete state snapshot. `nek.subagent` carries one subagent record (including background activity) and is throttled to at most ten records per second per subagent. `mcp.status_changed` carries `{servers:[...]}`. The control process does not load extensions or MCP and therefore does not expose these methods.

## Model object

Model commands return the complete configured model definition. Costs are in US dollars per million tokens.

```json
{
  "id": "claude-sonnet-4-20250514",
  "name": "Claude Sonnet 4",
  "api": "anthropic-messages",
  "provider": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "reasoning": true,
  "input": ["text", "image"],
  "contextWindow": 200000,
  "maxTokens": 16384,
  "cost": {
    "input": 3.0,
    "output": 15.0,
    "cacheRead": 0.3,
    "cacheWrite": 3.75
  }
}
```

For model configuration, see [Configure a compatible endpoint](models.md#configure-a-compatible-endpoint). For TypeScript, use the exported `Model` type from `@earendil-works/pi-ai`.
