# Configuration

nekcode supports user-level and project configuration. User-level data lives in `~/.nek/agent`. Project configuration lives in `.nek` under the working directory and loads after [project trust](security.md#understand-project-trust). The exception is `sessionDir`, which is read before trust so sessions can be located.

In interactive mode, use `/settings` to change common preferences. Run `/reload` after manually changing settings, keybindings, instructions, or resources.

## Agent directory

Set the user data directory with `NEK_CODING_AGENT_DIR` or the SDK's [`agentDir`](sdk.md) option.

| Path | Responsibility |
|---|---|
| `<agent-dir>/settings.json` | User-level [settings](settings.md), preferences, defaults, and resource paths |
| `<agent-dir>/keybindings.json` | Custom terminal UI and application [keybindings](keybindings.md) |
| `<agent-dir>/models.json` | [Compatible endpoints, models, and model overrides](models.md#configure-a-compatible-endpoint) |
| `<agent-dir>/auth.json` | Saved API keys and OAuth credentials |
| `<agent-dir>/AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, or `CLAUDE.MD` | User instructions applied across working directories |
| `<agent-dir>/SYSTEM.md` | Replaces the default system prompt |
| `<agent-dir>/APPEND_SYSTEM.md` | Adds instructions to the system prompt |
| `<agent-dir>/extensions/` | User extensions loaded by the resource loader |
| `<agent-dir>/skills/` | User skills and supporting files |
| `<agent-dir>/prompts/` | User prompt templates exposed as slash commands |
| `<agent-dir>/themes/` | User theme files |

## Project `.nek` directory

| Path | Responsibility |
|---|---|
| `.nek/settings.json` | Project-level settings and resource paths |
| `.nek/SYSTEM.md` | Replaces the system prompt for the project |
| `.nek/APPEND_SYSTEM.md` | Adds project-specific instructions to the system prompt |
| `.nek/extensions/` | Project extensions |
| `.nek/skills/` | Project skills and supporting files |
| `.nek/prompts/` | Project prompt templates exposed as slash commands |
| `.nek/themes/` | Project theme files |
| `.nek/plans/` | Plan files created by the built-in `nek` extension |

Project resources load only after trust is granted. The built-in `nek` extension does not install or discover extension packages from settings; use `-e` to load an explicit extension.

## Context files

Context files are separate from `.nek` configuration. nekcode loads them from the user data directory, the working directory, and parent directories. A context file applies whenever nekcode runs in its directory or below it.

An `AGENTS.override.md` replaces `AGENTS.md` or `CLAUDE.md` only in the same directory. It does not suppress context files from the user data directory or other directories.

Context-file discovery does not require project trust.
