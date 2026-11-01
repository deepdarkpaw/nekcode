# GUI RPC acceptance matrix

This matrix covers the GUI additions on `gui/rpc-v1` (the 21 commits on top of nek v0.3.2). Tests use the in-memory/faux provider, temporary session directories, local MCP transports, and intercepted `fetch`/auth/share boundaries. They do not call a model provider.

| Command or event | Source file | Test file and test name | Added in acceptance |
|---|---|---|---|
| `get_info` | `src/modes/rpc/gui/handlers.ts` | `test/rpc-gui-control-mode.test.ts` — `answers get_info without a session` | no |
| `reload` | `src/modes/rpc/gui/config.ts` | `test/suite/rpc-gui-acceptance.test.ts` — `reloads immediately and defers a busy reload until the faux turn settles` | **yes** |
| `validate_config` | `src/modes/rpc/gui/config.ts` | `test/rpc-gui-control-mode.test.ts` — `answers get_changelog and validate_config`; `test/suite/rpc-gui-acceptance.test.ts` — `reports invalid configuration diagnostics rather than hiding them` | **yes** (diagnostic regression) |
| `get_changelog` | `src/modes/rpc/gui/info.ts` | `test/rpc-gui-control-mode.test.ts` — `answers get_changelog and validate_config` | no |
| `get_mention_targets` | `src/modes/rpc/gui/mentions.ts` | `test/rpc-gui-mentions.test.ts` — `is a control command and answers through the dispatcher` | no |
| `list_builtin_tools` | `src/modes/rpc/gui/tools.ts` | `test/rpc-gui-tools.test.ts` — `answers the command through the GUI dispatch table` | no |
| `list_sessions` | `src/modes/rpc/gui/sessions.ts` | `test/rpc-gui-sessions.test.ts` — `lists sessions newest first and truncates the first message` | no |
| `delete_session` | `src/modes/rpc/gui/sessions.ts` | `test/rpc-gui-sessions.test.ts` — `deletes every file of a session` | no |
| `rename_session` | `src/modes/rpc/gui/sessions.ts` | `test/rpc-gui-sessions.test.ts` — `renames a session and reports the new name` | no |
| `read_session_snapshot` / `lockedBy` | `src/modes/rpc/gui/sessions.ts` | `test/rpc-gui-sessions.test.ts` — `reads a snapshot without opening the session`; `test/rpc-gui-session-lock.test.ts` — `reports the holder in a session snapshot` | no |
| `import_session` | `src/modes/rpc/gui/sessions.ts` | `test/suite/rpc-gui-acceptance.test.ts` — `lists, snapshots, renames, imports and deletes a faux-generated session` | **yes** |
| `export_session` | `src/modes/rpc/gui/session-current.ts` | `test/suite/rpc-gui-acceptance.test.ts` — `exports both formats, labels entries and navigates a faux conversation` | **yes** |
| `share_session` | `src/modes/rpc/gui/session-current.ts` | `test/suite/rpc-gui-acceptance.test.ts` — `shares a faux transcript through an intercepted artifact upload` | **yes** |
| `navigate_tree` | `src/modes/rpc/gui/session-current.ts` | `test/suite/rpc-gui-acceptance.test.ts` — `exports both formats, labels entries and navigates a faux conversation` | **yes** |
| `set_entry_label` | `src/modes/rpc/gui/session-current.ts` | `test/suite/rpc-gui-acceptance.test.ts` — `exports both formats, labels entries and navigates a faux conversation` | **yes** |
| `auth_status` | `src/modes/rpc/gui/auth.ts` | `test/rpc-gui-auth.test.ts` — `keeps the existing fields of every row`; `test/suite/rpc-gui-acceptance.test.ts` — `answers runtime, catalog, mention, tool and auth queries with a faux session` | **yes** (dispatcher coverage) |
| `auth_login` / `auth_event` | `src/modes/rpc/gui/auth.ts` | `test/suite/rpc-gui-acceptance.test.ts` — `round-trips login prompts, auth events and logout with a faux auth method` | **yes** |
| `auth_logout` | `src/modes/rpc/gui/auth.ts` | `test/suite/rpc-gui-acceptance.test.ts` — `round-trips login prompts, auth events and logout with a faux auth method` | **yes** |
| `get_model_catalog` | `src/modes/rpc/gui/models.ts` | `test/rpc-gui-models.test.ts` — `lists OpenAI-compatible models with a bearer token and extension limit fields`; `test/suite/rpc-gui-acceptance.test.ts` — `answers runtime, catalog, mention, tool and auth queries with a faux session` | **yes** (dispatcher coverage) |
| `fetch_provider_models` | `src/modes/rpc/gui/models.ts` | `test/rpc-gui-models.test.ts` — `pages through Anthropic models and maps capabilities`; `test/suite/rpc-gui-acceptance.test.ts` — `tests the faux provider and dispatches model discovery without a model API` | **yes** (dispatcher coverage) |
| `test_provider` | `src/modes/rpc/gui/models.ts` | `test/rpc-gui-models.test.ts` — `tests a draft endpoint with one minimal completion`; `test/rpc-gui-provider-overrides.test.ts` — `tests a saved provider with an edited key`; `test/suite/rpc-gui-acceptance.test.ts` — `tests the faux provider and dispatches model discovery without a model API` | **yes** (faux end-to-end dispatch) |
| `get_project_trust` / `set_project_trust` | `src/modes/rpc/gui/trust.ts` | `test/suite/rpc-gui-acceptance.test.ts` — `persists project trust decisions and reports discovered resources` | **yes** |
| `test_web_search` | `src/modes/rpc/gui/probes.ts` | `test/suite/rpc-gui-acceptance.test.ts` — `probes web search and MCP with intercepted JSON-RPC transports` | **yes** |
| `mcp_test` | `src/modes/rpc/gui/probes.ts` | `test/suite/rpc-gui-acceptance.test.ts` — `probes web search and MCP with intercepted JSON-RPC transports`; `test/suite/rpc-nek-extension.test.ts` — `reports MCP status and reconnects through extension_call` | **yes** |
| `extension_call` / `extension_event` | `src/modes/rpc/gui/handlers.ts`, `src/modes/rpc/rpc-mode.ts` | `test/rpc-gui-extension-channel.test.ts` — `invokes a registered handler through extension_call`, `forwards emitRpcEvent only when a mode listens` | no |
| `nek.get_state` / `nek.state` | `src/extensions/nek/index.ts` | `test/suite/rpc-nek-extension.test.ts` — `exposes nek state and control methods and emits state changes` | no |
| `nek.set_mode` | `src/extensions/nek/index.ts` | `test/suite/rpc-nek-extension.test.ts` — `exposes nek state and control methods and emits state changes`; `test/nek-plan-ui.test.ts` — `uses structured RPC payloads for questions, plan review, and mode approval` | no |
| `nek.get_plan` | `src/extensions/nek/index.ts` | `test/suite/rpc-nek-extension.test.ts` — `exposes nek state and control methods and emits state changes` (unknown-plan failure path) | **yes** |
| `nek.stop_subagent` / `nek.get_subagent_transcript` / `nek.list_agent_types` | `src/extensions/nek/subagent-wiring.ts` | `test/suite/rpc-nek-extension.test.ts` — `exposes nek state and control methods and emits state changes` | **yes** (stop failure path) |
| `nek.subagent` | `src/extensions/nek/subagent-wiring.ts` | `test/suite/nek-subagent.test.ts` — subagent lifecycle and completion tests; `src/extensions/nek/subagent-wiring.ts` emits the bounded RPC projection | no |
| `mcp.status` / `mcp.test` / `mcp.reconnect` / `mcp.login` / `mcp.logout` | `src/extensions/mcp/index.ts` | `test/suite/rpc-nek-extension.test.ts` — `reports MCP status and reconnects through extension_call` | **yes** (`mcp.test`, login, logout) |
| `mcp.status_changed` | `src/extensions/mcp/index.ts` | `test/suite/rpc-nek-extension.test.ts` — `reports MCP status and reconnects through extension_call` | no |
| structured `extension_ui_request` / `extension_ui_cancel` | `src/modes/rpc/gui/ui-requests.ts`, `src/modes/rpc/rpc-mode.ts` | `test/rpc-gui-extension-channel.test.ts` — `round-trips a structured request`, `emits extension_ui_cancel when a dialog is aborted`, `cancels every pending structured request when the turn is aborted`; `test/nek-plan-ui.test.ts` — `reports an aborted RPC approval as an abort` | no |

## Documentation coverage

- `docs/rpc-commands.md` contains the canonical section for every GUI command (`get_info` through `extension_call`) and describes the control-mode allowlist.
- `docs/rpc-extension-ui.md` documents structured nek kinds, `auth.prompt`, cancellation, `extension_call`, and `extension_event`.
- `docs/json.md` documents `auth_event`, `extension_event`, `nek.state`, `nek.subagent`, and `mcp.status_changed` payloads.
- `docs/rpc.md` documents process startup, control mode, framing, response/error semantics, and links to the detailed references.
