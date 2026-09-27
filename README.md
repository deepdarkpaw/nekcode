# nekcode

nekcode is a terminal coding agent for software development, research, writing, and automation. It can inspect files, run commands, edit content, manage sessions, and delegate bounded work to subagents.

The interactive CLI is installed as `nek`. The default user data directory is `~/.nek/agent`, and project resources live under `.nek/`. The built-in extension adds plan mode, todo tracking, subagents, structural search with `ast_grep`, Cursor-style reading, and deterministic string-replacement editing.

## Packages

| Package | Description |
|---------|-------------|
| `@earendil-works/chord` | Application-composition runtime for services, replicated state, RPC, and plugins |
| `@earendil-works/pi-telemetry` | Vendor-neutral telemetry contracts and schemas |
| `@earendil-works/pi-ai` | Unified multi-provider LLM API |
| `@earendil-works/pi-durable` | Durable conversation, task, and document runtime |
| `@earendil-works/pi-agent-core` | Agent runtime with tool calling and state management |
| `@earendil-works/pi-coding-agent` | Interactive coding-agent CLI |
| `@earendil-works/pi-tui` | Terminal UI library with differential rendering |

The npm package identifiers are retained for dependency compatibility; the application name, executable, configuration paths, documentation, and release artifacts use the nekcode branding.

## Linux

Linux is a supported target. Requirements:

- Node.js 22.19 or newer
- npm
- Bash
- a terminal with Unicode and ANSI support for interactive mode
- optional: `rg`, `fd`, and `ast-grep` on `PATH`. When missing, nekcode downloads them into `~/.nek/agent/bin` on first use (not with `NEK_OFFLINE=1`). The `ast-grep` download is a zip and needs `unzip`; the downloaded `ast-grep` is a glibc build, so on musl distributions such as Alpine install it from the system package manager.
- optional clipboard support: `wl-clipboard` on Wayland, `xclip` or `xsel` on X11

Run from a checkout:

```bash
npm ci --ignore-scripts
npm run check
./nek-test.sh --help
```

Install the CLI globally from the checkout. nekcode is not published to the npm registry; the registry package `@earendil-works/pi-coding-agent` is upstream pi and installs `pi`, not `nek`.

```bash
npm run build
npm install -g --ignore-scripts ./packages/coding-agent
nek --version
cd /path/to/project
nek
```

The release script cross-compiles `nek-linux-x64.tar.gz` or `nek-linux-arm64.tar.gz` with Bun. It runs `npm ci` and the full build first; the Linux native clipboard helpers are prebuilt in `packages/tui/native/linux/prebuilds`:

```bash
./scripts/build-binaries.sh --platform linux-x64 --offline-model-data --out "$PWD/out"
```

For headless use:

```bash
nek --mode text -p "Explain this repository"
nek --mode json -p "List the files that need attention"
```

## Configuration and features

- Global settings, credentials, sessions, prompts, skills, and themes: `~/.nek/agent/`
- Trusted project settings and resources: `.nek/`
- Project plan files: `.nek/plans/`
- Environment variable prefix: `NEK_`
- `/plan`, `/todos`, `/tasks`, and `/nek-build` are provided by the built-in `nek` extension.

Read the [coding-agent documentation](packages/coding-agent/docs/index.md) for setup, configuration, providers, sessions, terminal integration, and extension APIs. The nekcode-specific behavior is documented in [docs/nek.md](packages/coding-agent/docs/nek.md).

## Development

```bash
npm install --ignore-scripts
npm run check
./test.sh
./nek-test.sh
```

`nek-test.sh` can be called from any directory and preserves the caller's working directory. It runs the source CLI without requiring a global installation.

## Security

The agent runs with the permissions of the user and process that launched it. Project trust controls which project resources are loaded; it is not a sandbox. Use a container or another sandbox for untrusted or unattended work. See [packages/coding-agent/docs/security.md](packages/coding-agent/docs/security.md).

## License

MIT
