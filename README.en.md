# nekcode

[中文](README.md) | **English**

nekcode (command: `nek`) is a terminal coding agent built on [pi](https://github.com/earendil-works/pi). It reads code, runs commands, and edits files, and adds:

- **Plan mode**: research and write a plan first, implement after approval.
- **Todo list**: task progress pinned above the editor.
- **Subagents**: delegate bounded tasks to separate child sessions, in the foreground or background.
- **Structural search with `ast_grep`**, Cursor-style chunked reading, and Claude Code-style exact-replacement editing.
- **MCP servers** and `tool_search` for on-demand tool loading.
- **`web_search`** without an API key.

## One-line install

You only need [Git](https://git-scm.com/) and [Node.js](https://nodejs.org/) 22.19 or newer.

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/scripts/install.sh | bash
```

**Windows (PowerShell)**

```powershell
irm https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/scripts/install.ps1 | iex
```

The installer:

1. checks the Git, Node.js, and npm versions;
2. downloads the source (`~/.local/share/nekcode` on Linux/macOS, `%LOCALAPPDATA%\nekcode` on Windows), by default the latest release (`nek-v*` tag, see [Update](#update));
3. installs dependencies and generates the built-in model catalog;
4. creates the `nek` command (`~/.local/bin` on Linux/macOS; `%LOCALAPPDATA%\nekcode\bin` on Windows, added to PATH automatically);
5. sets up the search tools fd, rg, and ast-grep (see [Search tools](#search-tools)).

Open a new terminal and verify:

```bash
nek --version
```

> nek runs directly from source; there is no build step. If the installer reports that the bin directory is not on PATH, add the printed line to `~/.bashrc` or `~/.zshrc`.

## Update

```bash
nek --version          # e.g. nek 0.1.0 (pi 1.0.2): the nek version, with the pi base in parentheses
nek update --check     # check only; changes nothing
nek update             # update to the latest version of the selected channel
```

There are two update channels:

| Channel | Tracks | Notes |
|---|---|---|
| `stable` (default) | the highest `nek-v*` release tag | released versions |
| `dev` | the latest commit on the `nek` branch | work in progress, updated more often |

Switch with `nek update --channel dev` (or `stable`). The choice is saved in the global setting `updateChannel`; `--check` does not save it.

- `nek update --check` only runs `git ls-remote` against the checkout's `origin`. It does not call the GitHub API. Exit codes: `0` no update, `2` update available, `1` could not check.
- nek never checks for updates on its own at startup.
- `nek update` reruns the installer with your original install options, which are saved in `.nek-install-state.json` in the source directory. It reinstalls dependencies only when they changed.
- Running the one-line install command again also updates.
- Running nek sessions keep the old code until you restart them.

If you edited the source in the install directory or committed there, the installer stops instead of overwriting your work.

## Getting started

Run `nek` in a project directory:

```bash
cd /path/to/project
nek
```

On first use, pick a model: type `/login`, choose a provider, and sign in or enter an API key; use `/model` to switch models later. Custom endpoints (for example an OpenAI-compatible proxy) go in `~/.nek/agent/models.json`; see [Models and providers](packages/coding-agent/docs/models.md).

Common actions:

| Action | Description |
|---|---|
| `/plan <request>` | Enter Plan mode: plan first, then implement |
| `alt+m` | Toggle between Agent and Plan mode |
| `/model` | Switch model |
| `/todos` | Show the todo list |
| `/subagents` | Inspect and manage subagents |
| `/mcp` | Show MCP server status |
| `nek -c` | Continue the latest session in this directory |
| `nek -p "question"` | Non-interactive: print the answer and exit |

## Interface

nek runs in fullscreen mode by default, and scrolls the transcript itself:

- Use `PageUp` / `PageDown` to page, `Home` / `End` to jump to the start or the latest message, or the mouse wheel.
- In tmux, the mouse wheel needs `set -g mouse on`; keyboard paging always works. See [tmux](packages/coding-agent/docs/tmux.md).
- To use your terminal's own scrollbar and scrollback instead, run `nek --tui-mode regular`, or set the TUI mode to regular in `/settings`.

When a plan is ready in Plan mode, the full plan appears in the transcript, where it scrolls like any other message. The editor area shows only the actions: implement, implement in a fresh session, keep planning, or exit Plan.

**OpenTUI interface (experimental)**: `nek --ui opentui` starts a new interface built on [OpenTUI](https://opentui.com). The default interface is unchanged. It needs [Bun](https://bun.sh) 1.3 or newer; set `NEK_INSTALL_BUN=1` before running the installer to install Bun automatically. `/login`, `/settings`, the session tree, and images are not supported yet; see [OpenTUI frontend](packages/coding-agent/docs/opentui.md).

## Search tools

Some nek features rely on three external CLI tools:

| Tool | Used by |
|---|---|
| [fd](https://github.com/sharkdp/fd) | `find` |
| [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) | `grep` |
| [ast-grep](https://ast-grep.github.io/) | `ast_grep` structural search, and code outlines when `read` opens large files |

nek looks for them in this order:

1. `~/.nek/agent/bin/` (`%USERPROFILE%\.nek\agent\bin\` on Windows);
2. the system PATH (`fdfind` on Debian/Ubuntu is recognized);
3. if neither has it, nek downloads it from GitHub into the directory in step 1.

The installer runs this step ahead of time and checks each tool with `--version`, so the first session does not wait for downloads. To check again later, run from the install directory:

```bash
node --import ./packages/coding-agent/src/experimental/source-resolver.ts scripts/setup-tools.ts
```

**ast-grep on Linux**: the downloaded build needs `unzip` to extract and glibc 2.34 or newer (Ubuntu 22.04+, Debian 12+, RHEL 9+). On older systems or Alpine, install it yourself, for example `npm install -g @ast-grep/cli`; nek uses any `ast-grep` on PATH.

**Offline machines**: with `NEK_OFFLINE=1`, nek never downloads tools. Install all three with your package manager beforehand.

## Installer options

Set these environment variables before running the installer:

| Variable | Effect | Default |
|---|---|---|
| `NEK_INSTALL_DIR` | source directory | `~/.local/share/nekcode` / `%LOCALAPPDATA%\nekcode` |
| `NEK_BIN_DIR` | directory of the `nek` command | `~/.local/bin` / `%LOCALAPPDATA%\nekcode\bin` |
| `NEK_CHANNEL` | update channel: `stable` or `dev` | `stable` |
| `NEK_BRANCH` | branch the `dev` channel tracks | `nek` |
| `NEK_REPO_URL` | repository URL (for example a mirror) | `https://github.com/deepdarkpaw/nekcode.git` |
| `NEK_SKIP_TOOLS=1` | skip the fd / rg / ast-grep setup | not skipped |
| `NEK_INSTALL_BUN=1` | install Bun when missing (needed by the OpenTUI interface) | not installed |

For example:

```bash
curl -fsSL https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/scripts/install.sh | NEK_INSTALL_DIR=~/src/nekcode bash
```

```powershell
$env:NEK_INSTALL_DIR = 'D:\tools\nekcode'; irm https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/scripts/install.ps1 | iex
```

## Uninstall

Delete the source directory and the `nek` command:

- Linux/macOS: `rm -rf ~/.local/share/nekcode ~/.local/bin/nek`
- Windows: delete `%LOCALAPPDATA%\nekcode` and remove `%LOCALAPPDATA%\nekcode\bin` from the user PATH

`~/.nek/` holds settings, credentials, and session history; delete it only if you want to remove those too.

## Configuration files

| Location | Contents |
|---|---|
| `~/.nek/agent/settings.json` | global settings |
| `~/.nek/agent/models.json` | custom providers and models |
| `~/.nek/agent/auth.json` | credentials (keep private) |
| `~/.nek/agent/mcp.json` | MCP servers, see [MCP](packages/coding-agent/docs/mcp.md) |
| `~/.nek/agent/agents/*.md` | custom subagent types |
| `~/.nek/agent/AGENTS.md` | instructions for all projects |
| `.nek/` in a project | project settings, plans (`.nek/plans/`), subagents |
| `AGENTS.md` in a project | project instructions |

More documentation:

- [nekcode features](packages/coding-agent/docs/nek.md): Plan mode, subagents, tool list
- [Documentation index](packages/coding-agent/docs/index.md): settings, sessions, keybindings, extension API
- [Security](packages/coding-agent/docs/security.md)

## Security

nek runs with the permissions of the user who started it. It reads and writes files and runs commands without asking before each tool call. Project trust only controls whether project configuration is loaded; it is not a sandbox. Use a container or another sandbox for untrusted code or unattended runs.

## Development

```bash
git clone https://github.com/deepdarkpaw/nekcode.git
cd nekcode
npm ci --ignore-scripts
npm run hydrate:model-data   # generate the built-in model catalog
npm run check                # type check and formatting
./test.sh                    # tests that need no network
./nek-test.sh                # run nek from this checkout
```

See [AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md) for code conventions.

## License

MIT
