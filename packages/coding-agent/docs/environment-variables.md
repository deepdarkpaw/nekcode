# Environment Variables

nekcode uses environment variables for process configuration, session metadata, and provider credentials.

- `NEK_*` variables configure the nekcode process.
- nekcode sets process markers so child processes can identify the launching agent.
- Commands run by the model-facing shell tools receive `NEK_*` variables describing the current session.
- Shared provider and terminal packages retain a small number of compatibility variables such as `PI_CACHE_RETENTION` and `PI_TRUE_COLOR`.

Provider API-key variables are documented separately in [Provider Authentication](providers.md#use-an-api-key-from-the-environment).

## Process markers

The CLI and RPC entry points set:

- `AI_AGENT=nek` identifies nekcode as the launching agent.
- `NEK_CODING_AGENT=true` identifies a nekcode child process.

Child processes inherit both markers. They are not session-specific and are not set automatically when nekcode is embedded through the SDK.

## Shell-tool session environment

Commands run by the `bash` and `powershell` tools receive the current session state:

| Variable | Description |
|----------|-------------|
| `NEK_SESSION_ID` | Current session ID |
| `NEK_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `NEK_PROVIDER` | Currently selected model provider |
| `NEK_MODEL` | Currently selected model ID |
| `NEK_REASONING_LEVEL` | Current effective reasoning level |

The values are resolved when each command starts. Switching models or changing the reasoning level affects the next shell command without restarting nekcode.

```bash
printf '%s/%s\n' "$NEK_PROVIDER" "$NEK_MODEL"
printf 'reasoning=%s session=%s\n' "$NEK_REASONING_LEVEL" "$NEK_SESSION_ID"
```

These variables are injected into model-facing `bash` and `powershell` tools. They are not injected into user-entered `!` or `!!` commands. Disable injection for a custom shell tool with `exposeSessionEnvironment: false`.

## Process configuration

| Variable | Description |
|----------|-------------|
| `NEK_CODING_AGENT_DIR` | Override the user data directory; default is `~/.nek/agent` |
| `NEK_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
| `NEK_PACKAGE_DIR` | Override the package directory, useful for Nix or Guix store paths |
| `NEK_OFFLINE` | Disable startup network activity and model catalog refreshes |
| `NEK_EXPERIMENTAL` | Enable experimental server/client commands when set to `1` |
| `NEK_TELEMETRY` | Override install/update telemetry and provider attribution headers |
| `NEK_SHARE_VIEWER_URL` | Override the base URL used by `/share` |
| `NEK_RADIUS_GATEWAY` | Override the Radius gateway origin used by bug-report uploads and relay connections |
| `NEK_CLEAR_ON_SHRINK` | Clear terminal content when the terminal shrinks when set to `1` |
| `NEK_HARDWARE_CURSOR` | Show the hardware cursor when set to `1` |
| `NEK_STARTUP_BENCHMARK` | Enable startup benchmarking in interactive mode |
| `NEK_TIMING` | Enable startup timing instrumentation when set to `1` |

Shared provider and terminal compatibility variables remain available under their existing names. In particular, `PI_CACHE_RETENTION`, `PI_HYPERLINKS`, `PI_IMAGE_PROTOCOL`, `PI_TRUE_COLOR`, and `PI_TUI_ESC_TIMEOUT` are consumed by workspace packages outside the nekcode application layer.

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and cloud-provider configuration are listed in [Provider Authentication](providers.md#use-an-api-key-from-the-environment).
