# MCP Servers

nekcode connects to [Model Context Protocol](https://modelcontextprotocol.io) servers over stdio or Streamable HTTP and exposes their tools and resources through the normal tool pipeline. MCP tools are **deferred by default**: the model discovers them with `tool_search`, then calls the loaded tools directly.

## Quick setup

Add a local stdio server, check it, then start nekcode:

```bash
nek mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
nek mcp list
nek
```

For a remote server with a bearer token:

```bash
nek mcp add docs --url https://example.com/mcp --bearer-token-env-var DOCS_TOKEN
```

Commands write user-level configuration by default. Use `--local` or `-l` for project configuration:

```bash
nek mcp add -l tools --env API_KEY='${TOOLS_KEY}' -- uvx tools-mcp
```

Use `/mcp` in a session to inspect connections, sign in or out, reconnect, enable or disable a server, or change exposure. Run `/reload` after changing configuration outside the session.

## Configure servers

User-level servers live in `~/.nek/agent/mcp.json`, or the agent directory selected by `NEK_CODING_AGENT_DIR`. Project servers live in `.nek/mcp.json` and are read only when [project trust](security.md#understand-project-trust) is granted. A project entry replaces the user-level entry with the same name.

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    },
    "docs": {
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${DOCS_TOKEN}" },
      "description": "Search and read the product documentation"
    }
  }
}
```

Stdio servers accept `command`, `args`, `env`, and `cwd`. Relative `cwd` resolves against the session directory. A leading `~/` in a command, argument, or working directory expands to the home directory. `command` is one executable, not a shell command string.

HTTP servers accept `url`, `headers`, and `oauth`. `type` is optional; when supplied it must be `stdio`, `http`, or `streamable-http`. Legacy SSE endpoints are not supported; use a Streamable HTTP endpoint, commonly `/mcp`.

Both types support:

- `enabled: false`: retain the entry without connecting.
- `timeout`: per-request timeout in seconds, default 60. Progress notifications reset it.
- `exposure` and `toolExposure`: control discovery and activation.
- `description`: one-line namespace summary used by tool search and the system prompt. Without it, the first line of server instructions is used after connection.

Environment and header values can contain `${NAME}` references. A value consisting entirely of `!command` runs that command to obtain the value. Keep credentials in the user-level file and load project commands only in trusted projects.

A project entry without `command`, `url`, or `type` can override only `enabled`, `exposure`, and `toolExposure` of a user-level server. Its command, environment, headers, and OAuth settings remain unchanged:

```json
{
  "mcpServers": {
    "internal-tools": { "enabled": false }
  }
}
```

Server names use letters, digits, `_`, and `-`. Names differing only in `-` and `_` share a namespace and cannot coexist. Invalid entries are reported without preventing other servers from connecting.

## Control tool exposure

Tools are named `mcp__<server>__<tool>`, with non-identifier characters replaced by `_`. Names longer than 64 characters are shortened with a hash suffix. When sanitization collides, every colliding tool receives a stable hash suffix, independent of discovery order. Tools carry the server's namespace and description.

| Exposure | Behavior |
|---|---|
| `deferred` (default) | Registered but inactive. `tool_search` loads matches into the active set for the next model request. |
| `direct` | Activated and declared like a built-in tool. |
| `hidden` | Registered but never declared, discovered, or activated. |

Legacy `codemode` and `codemode-deferred` exposure values are accepted only as aliases for `deferred`, including per-tool overrides. No script execution or codemode functionality is provided.

`toolExposure` keys are original server tool names or patterns where `*` matches any characters. Exact names win; otherwise the first matching pattern wins. For example:

```json
{
  "mcpServers": {
    "github": {
      "url": "https://api.githubcopilot.com/mcp/",
      "exposure": "deferred",
      "toolExposure": {
        "search_code": "direct",
        "get_*": "deferred",
        "delete_*": "hidden"
      }
    }
  }
}
```

Deferred servers appear in the `mcp_servers` system-prompt section with their summary and discovery instructions. The section updates at prompt boundaries through transcript deltas; earlier tool declarations are not rewritten. Servers offering only direct or hidden tools do not need an indirect-discovery section.

All enabled servers start connecting in the background. The first prompt waits up to 10 seconds only for servers with direct tools, including direct per-tool overrides. Deferred servers do not delay it. Generic pending-source registration keeps `tool_search` declared while deferred servers are connecting, even before tools are listed. Executing `tool_search` waits up to 10 seconds for those sources before taking its tool snapshot; timeout leaves unfinished sources discoverable for a later call. Cancellation stops the wait.

Discovery activates only allowed, inactive deferred tools. It never loads direct or hidden tools, and obeys tool allowlists and exclusions. If discovery is unavailable, MCP warns that deferred tools cannot be reached. Loaded tools are recorded on the session branch and survive resume, reload, tree navigation, and fork when their definitions are available. A restored tool still loading is reinstated before the next run, but not after that run has started.

## Inspect and diagnose

`/mcp` lists connection state, tool count, exposure, and configuration source. Select a server to inspect tools, reconnect, sign in or out, change exposure, or enable and disable it. Changes preserve unrelated configuration. Trusted projects can save enable/disable overrides for user-level servers; extension registrations change only for the current session.

Outside the terminal UI, `/mcp` prints status. `/mcp login <server>`, `/mcp logout <server>`, and `/mcp reconnect <server>` perform those actions directly.

Shell commands do not load extensions:

```bash
nek mcp add <server> [options] -- <command> [args...]
nek mcp add <server> [options] --url <url>
nek mcp remove <server> [--local]
nek mcp list [--json]
nek mcp login <server> [--timeout <seconds>]
nek mcp logout <server>
```

Use `nek mcp --help` for add options. `list` connects to each enabled server, prints tools and errors, and exits 1 if configuration is invalid or any enabled server cannot connect. Disabled servers remain listed. Login's browser timeout defaults to 300 seconds.

Server logging notifications go to `<agent-dir>/mcp.log`, rotated to `mcp.log.1` after 5 MB. Connection errors and the stderr tail of failed stdio servers are available in `/mcp`. HTTP connection setup retries transient network errors and 408, 429, or 5xx responses twice. Dropped connections reconnect on the next call. Tool-list changes add new tools and make withdrawn tools unavailable. Tool calls are not automatically retried because the server may already have performed them.

Stopping stdio servers closes stdin and terminates the process tree, including launch wrappers such as `npx` or `uvx`.

## Authenticate with OAuth

HTTP servers without an `Authorization` header automatically attempt stored OAuth credentials when challenged. They never open a browser during background connection. Sign in explicitly:

```bash
nek mcp add sentry --url https://mcp.sentry.dev/mcp
nek mcp login sentry
```

Or use `/mcp login sentry`. Login shows a clickable authorization URL and opens the browser. Over SSH, paste the redirected URL if the browser cannot reach the loopback callback.

nekcode uses PKCE and dynamic client registration. Tokens, refresh tokens, and client information are persisted in `<agent-dir>/mcp-auth.json`, keyed by **server name and URL**. Different names at one URL sign in independently. Changing a server URL does not reuse another endpoint's credentials. Matching names and URLs across configuration files share credentials. Logout deletes that server's stored state.

Access tokens refresh when near expiry or rejected. File-backed refresh locks serialize independent processes so rotating refresh tokens are not consumed twice. Running sessions notice external sign-ins on the next turn. A later scope challenge requests the new scopes together with previously granted scopes. Authorization responses carrying RFC 9207 `iss` must match the expected issuer.

For pre-registered clients:

```json
{
  "mcpServers": {
    "example": {
      "url": "https://mcp.example.com/mcp",
      "oauth": {
        "clientId": "my-client",
        "clientSecret": "${EXAMPLE_SECRET}",
        "callbackPort": 8765
      }
    }
  }
}
```

`clientSecret` is optional and supports environment or command values. `callbackPort` produces `http://127.0.0.1:<port>/callback`. `callbackUrl` can specify an HTTP redirect on `localhost`, `127.0.0.1`, or `[::1]`, without a query or fragment; its port must agree with `callbackPort`. Without a fixed port, an available port is inserted as permitted by RFC 8252.

`scope` supplies space-separated scopes for servers that do not advertise them. `clientName` changes the dynamic registration name, which defaults to `nek`; log out first to register under a new name. `authServerMetadataUrl` selects a trusted authorization-server metadata document instead of discovery, using HTTPS except on loopback hosts. Provider-login authentication and OAuth client-ID metadata documents are not supported.

## Use resources

Connected non-hidden servers with resources add these tools:

- `list_mcp_resources`: lists resources; with a server it returns one page and `nextCursor`, without one it aggregates servers.
- `list_mcp_resource_templates`: lists URI templates, with the same server/cursor behavior.
- `read_mcp_resource`: reads a resource by server and URI. Text and images are model-facing; other binary data is saved to a temporary file.

Their exposure is the widest among eligible servers: direct, then deferred. Resource execution waits for outstanding connections within the startup bound. Read/list operations retry one transient HTTP failure. Resource links identify the reader and server. MCP App resources (`ui://` or `text/html;profile=mcp-app`) and icons are omitted because nekcode does not render them.

## Results and permissions

MCP calls pass through normal `tool_call` and `tool_result` handlers, including permission gates. Server annotations such as `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint` are reported by `pi.getAllTools()`; resource tools are marked read-only. Server claims are hints, not security guarantees.

Text over 20 KB keeps its beginning and end, with a truncation marker and the path to the full output. Images remain images. Full `CallToolResult` data is exposed through `structuredContent` and the output schema, without server `_meta`; `isError` marks the model-facing result as failed. Terminal previews are bounded by wrapped visual lines and can be expanded.

## Extensions and SDK

Extensions can register session-only servers using the normal config shape:

```typescript
pi.registerMcpServer("docs", {
  url: "https://example.com/mcp",
  description: "Product documentation"
});
```

Use `pi.unregisterMcpServer("docs")` to disconnect. An extension can replace its own registration, but cannot overwrite another extension's server or alias. A file-configured server takes precedence over an extension registration with the same namespace. Registration changes emit `mcp_servers_change` and connect/disconnect during the session.

The root CLI loads MCP and tool-search as built-in extensions. Shell-level `nek mcp` commands always use the built-in implementation. Custom integrations that provide their own `/mcp` command or `tool_search` tool must control extension ownership explicitly; nekcode does not automatically unload the built-in extension when names overlap.

[SDK](sdk.md) embeddings must include the MCP and tool-search extensions in their resource loader and bind the session extensions; server registration alone does not create connections. nek subagent child sessions intentionally load only their nek extension and remain MCP-free.
