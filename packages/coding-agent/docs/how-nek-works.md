# How nekcode works

nekcode coordinates model requests, tool execution, context assembly, and session storage. A session records conversation messages, tool calls and results, model changes, compaction, and other events.

Messages and events form a tree. Each path through that tree is a branch. The branch ending at the current entry is the active branch and supplies history for the next model request.

## Agent loop

A submitted message is added to the active branch. nekcode builds a model request from the system prompt, active branch, available tools, and model settings, then sends it through the selected provider.

The provider streams an assistant response, which can contain text and tool calls. nekcode records the response, executes each tool call, and records the results. If tool results or queued messages require another model request, nekcode starts another turn. Otherwise, the run ends.

Steering messages enter after the current assistant turn. Follow-up messages enter after pending work finishes. Aborting stops the current run and returns queued messages to the editor.

## Context

The active branch supplies conversation history. nekcode converts its session entries into model-compatible user, assistant, and tool-result messages.

The system prompt is built from base instructions and discovered context files. The request also carries tool definitions and skill descriptions. Full skill instructions load on demand, and extensions can add instructions or transform context.

Prompt templates expand editor input before it becomes a user message. Selected files, images, pasted text, and shell output can become message content.

## Sessions

Persistent sessions are JSONL files. Each tree entry has an ID and refers to its parent. The current entry identifies the active branch.

Continuing from an earlier entry creates another branch in the same file. Forking and cloning copy selected history into a new session file.

Model context is reconstructed from the active branch. Compaction inserts a summary entry that replaces older messages in later model requests; the original entries remain in the session tree.

## Interfaces

Interactive mode renders session and agent events in the terminal. Print mode runs a prompt and writes the final response. JSON mode writes agent events as JSONL. RPC mode accepts JSONL commands on stdin and writes responses and events to stdout. The TypeScript SDK creates and controls agent sessions in process.

All interfaces use the same agent and session mechanisms.

## Built-in extension and resources

The built-in `nek` extension provides plan mode, todo tracking, bounded subagents, structural search, and the `nek`-specific read/edit behavior. Explicit extensions can register tools, commands, shortcuts, providers, event handlers, renderers, and terminal UI.

Skills provide on-demand instructions and supporting files. Prompt templates provide reusable message text. Themes provide terminal colors. nekcode does not install or discover extension packages from settings; use `-e` for an explicit extension path.

## Trust and permissions

nekcode resolves project trust before loading project settings and resources. Enabled tools use the operating-system permissions of the nekcode process. Extensions execute inside that process, so use a container or another sandbox for untrusted code.
