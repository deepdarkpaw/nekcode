# nekcode coding agent

nekcode is an extensible terminal coding agent. The CLI is installed as `nek`, stores user data under `~/.nek/agent`, and uses `.nek/` for trusted project resources.

It provides file inspection, search, shell execution, deterministic editing, session persistence, multiple model providers, plan mode, todo tracking, and bounded subagents. The built-in `nek` extension also provides `ast_grep`, Cursor-style read output, and Claude Code-style edit semantics.

The published npm package identifier remains `@earendil-works/pi-coding-agent` so that the existing workspace dependency graph and package distribution remain usable. This does not change the application name or command.

## Install

nekcode is not published to the npm registry. The registry package `@earendil-works/pi-coding-agent` is upstream pi and installs the `pi` command, not `nek`. Build and install from a checkout instead:

```bash
git clone https://github.com/deepdarkpaw/nekcode.git
cd nekcode
npm ci --ignore-scripts
npm run build
npm install -g --ignore-scripts ./packages/coding-agent
nek --version
```

Node.js 22.19 or newer is required. The global install links to the checkout, so keep the checkout in place.

Start it in the directory it should inspect and modify:

```bash
cd /path/to/project
nek
```

Authenticate with `/login`, then give the agent a task. For Linux, macOS, Windows, WSL, and Termux details, see the [documentation](docs/index.md).

## Run from source

From the repository root:

```bash
npm install --ignore-scripts
./nek-test.sh
```

The script can be called from any directory. It preserves the caller's working directory and loads the source CLI directly.

## Built-in tools and modes

A new session activates `read`, `bash`, `edit`, `write`, and `ast_grep` by default. The `nek` extension adds:

- `todo_write` for bounded task lists
- `switch_mode`, `create_plan`, and `ask_question` for plan mode
- `task` and `await` for foreground and background subagents

Agent data is stored in `~/.nek/agent/`; trusted project resources are stored in `.nek/`. Configure plan and subagent behavior in `~/.nek/agent/nek.yaml` or `.nek/nek.yaml`.

See [docs/nek.md](docs/nek.md) for the full nekcode-specific behavior and [docs/index.md](docs/index.md) for the general CLI documentation.
