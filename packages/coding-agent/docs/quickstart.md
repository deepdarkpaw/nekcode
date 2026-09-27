# Quickstart

nekcode runs in your terminal and works with files on your machine. You need access to a model through a supported provider, subscription, API key, local model, or compatible endpoint.

For native Windows setup, read [Windows Setup](windows.md). For Android, read [Termux Setup](termux.md).

## 1. Install nekcode

nekcode is not published to the npm registry. The registry package `@earendil-works/pi-coding-agent` is upstream pi and installs `pi`, not `nek`. Build and install from a checkout:

```bash
git clone https://github.com/deepdarkpaw/nekcode.git
cd nekcode
npm ci --ignore-scripts
npm run build
npm install -g --ignore-scripts ./packages/coding-agent
```

This requires Node.js 22.19 or newer. The global install links to the checkout, so keep the checkout in place. To run without installing, use `./nek-test.sh` from the checkout.

Verify the installation:

```bash
nek --version
```

On Linux, macOS, WSL, and Termux, ensure the npm global binary directory is on `PATH`.

## 2. Start nekcode

Change to the folder nekcode should inspect and modify:

```bash
cd /path/to/folder
nek
```

The working folder helps nekcode discover relevant files, instructions, and configuration. It also determines the default session group.

<p align="center"><img src="images/interactive-mode.png" alt="nekcode running in a terminal with a conversation, input editor, and status footer" width="750"></p>

The interface shows the conversation, an editor for prompts and commands, and a footer with the current folder, model, and session status. See [Use nekcode in the terminal](usage.md) for input, commands, queued messages, and result management.

## 3. Choose a model

A **model** generates responses. A **provider** is the service or account nekcode uses to access that model.

Inside nekcode, run:

```text
/login
```

Choose a provider, then follow the prompts to use a subscription or store an API key. Run `/model` afterward to select a different available model.

See [Choose a model and provider](models.md) for supported providers, environment-variable authentication, local models, and custom endpoints.

## 4. Give nekcode a task

nekcode shows each file read, search, command, and edit it performs. It does not ask before every tool call.

For example:

```text
Summarize @meeting-notes.md and save the action items to action-items.md.
```

```text
Explain how this repository is structured and how to run its checks.
```

```text
Compare @previous.csv with @current.csv and summarize the important changes.
```

Type `@` in the editor to search for a file instead of entering its full path. When nekcode finishes, review its response and changed files. Use version control or backups for important work. For untrusted or unattended work, use a container or another sandbox. See [Security](security.md).

## Continue later

nekcode saves sessions automatically. Exit it, then resume the most recent session for the same working folder:

```bash
nek --continue
```

Use `/resume` to choose another saved session. See [Continue or branch a session](sessions.md) for naming, branching, compaction, export, and sharing.

## Next steps

- [Use nekcode interactively](usage.md)
- [Add instructions](configuration.md#context-files)
- [Choose a model and provider](models.md)
- [Use plan mode and subagents](nek.md)

### Choose how to customize nekcode

Start with the least powerful mechanism that meets the need:

| Need | Start with |
|---|---|
| Give nekcode persistent instructions for a folder | [`AGENTS.md`](configuration.md#context-files) |
| Reuse a prompt from the `/` menu | [Prompt template](prompt-templates.md) |
| Add task-specific instructions and supporting files | [Skill](skills.md) |
| Add executable tools, commands, or event handlers | [Explicit extension](extensions.md) |
| Build a custom terminal component | [Terminal UI](tui.md) |
| Connect an unsupported model service | [Custom provider](custom-provider.md) |

## Uninstall nekcode

If installed with npm:

```bash
npm uninstall -g @earendil-works/pi-coding-agent
```

This does not remove `~/.nek/agent/`, which contains configuration, credentials, sessions, prompts, skills, and themes.
