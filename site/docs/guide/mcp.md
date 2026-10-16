# MCP 服务器

nek 内置 [Model Context Protocol](https://modelcontextprotocol.io)（MCP）客户端，可以连接 stdio 和 Streamable HTTP 两种服务器，把它们的工具和资源交给模型使用。

MCP 工具**默认延迟加载**：首次请求不声明它们，模型需要时先用 `tool_search` 搜索，匹配的工具才会激活。这样即使连了很多服务器，请求也不会变得臃肿。

## 快速配置

添加一个本地 stdio 服务器，检查连接，然后启动 nek：

```bash
nek mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem .
nek mcp list
nek
```

添加一个需要 bearer token 的远程服务器（token 从环境变量读取）：

```bash
nek mcp add docs --url https://example.com/mcp --bearer-token-env-var DOCS_TOKEN
```

命令默认写入用户级配置。加 `-l` 或 `--local` 写入项目配置：

```bash
nek mcp add -l tools --env API_KEY='${TOOLS_KEY}' -- uvx tools-mcp
```

在会话里用 `/mcp` 查看连接状态、登录或退出、重连、启用或禁用服务器、修改暴露方式。在会话外改了配置文件后，运行 `/reload`。

## 配置文件 {#config}

| 位置 | 作用范围 |
|---|---|
| `~/.nek/agent/mcp.json` | 用户级，所有项目 |
| `.nek/mcp.json` | 项目级，只在[信任项目](/guide/security#project-trust)后读取 |

项目里的同名条目替换用户级的条目。

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

### stdio 服务器

| 字段 | 说明 |
|---|---|
| `command` | 可执行文件（单个程序，不是 shell 命令字符串） |
| `args` | 参数数组 |
| `env` | 额外的环境变量 |
| `cwd` | 工作目录，相对路径相对于会话目录解析 |

`command`、`args`、`cwd` 开头的 `~/` 会展开为用户主目录。

### HTTP 服务器

| 字段 | 说明 |
|---|---|
| `url` | Streamable HTTP 端点，常见为 `/mcp` |
| `headers` | 请求头 |
| `oauth` | OAuth 客户端设置，见 [OAuth](#oauth) |
| `type` | 可选；指定时必须是 `stdio`、`http` 或 `streamable-http` |

不支持旧的 SSE 端点。

### 通用字段

| 字段 | 说明 |
|---|---|
| `enabled: false` | 保留配置但不连接 |
| `timeout` | 单次请求超时（秒），默认 60。收到进度通知会重置计时 |
| `exposure`、`toolExposure` | 控制工具如何暴露给模型，见下文 |
| `description` | 一行概要，用于 `tool_search` 和系统提示词。没写时，连接后使用服务器说明的第一行 |

`env` 和 `headers` 的值可以包含 `${NAME}` 引用环境变量；整个值是 `!命令` 时执行该命令取得值。凭据请放在用户级文件里，项目里的命令只在受信任的项目中执行。

### 项目里只覆盖开关

项目条目不写 `command`、`url`、`type` 时，只能覆盖用户级服务器的 `enabled`、`exposure`、`toolExposure`，命令、环境变量、请求头和 OAuth 设置不变。例如在某个项目里禁用一个服务器：

```json
{
  "mcpServers": {
    "internal-tools": { "enabled": false }
  }
}
```

服务器名只能包含字母、数字、`_`、`-`。只差 `-` 和 `_` 的两个名字视为同一个命名空间，不能同时存在。无效的条目会被报告，但不影响其他服务器连接。

## 工具的暴露方式 {#exposure}

MCP 工具命名为 `mcp__<服务器>__<工具>`，非标识符字符替换为 `_`；超过 64 个字符的名字用哈希后缀缩短，冲突时所有冲突的工具都加上稳定的哈希后缀。在界面上显示为 `服务器 › 工具`。

| 暴露方式 | 行为 |
|---|---|
| `deferred`（默认） | 注册但不激活，`tool_search` 搜到后在下一次请求时激活 |
| `direct` | 像内置工具一样直接激活并声明 |
| `hidden` | 注册但永不声明、不可发现、不可激活 |

旧值 `codemode` 和 `codemode-deferred` 只作为 `deferred` 的别名接受，nek 不提供 codemode 功能。

`toolExposure` 按工具单独设置，键是服务器上的原始工具名或含 `*` 的模式。精确名字优先，否则使用第一个匹配的模式：

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

### 连接时机

- 所有启用的服务器在后台同时开始连接。
- 第一条提示词最多等待 10 秒，而且**只等**有 `direct` 工具的服务器；纯 `deferred` 的服务器不会拖慢首次请求。
- 延迟加载的服务器还在连接时，`tool_search` 就已经可用；执行搜索前它最多等这些服务器 10 秒。
- 有延迟工具的服务器会出现在系统提示词的 `mcp_servers` 部分，附带概要和发现方式说明。

加载过的工具记录在会话分支上，续接、`/reload`、`/tree`、`/fork` 后仍然有效（前提是工具定义还在）。

## 查看与诊断 {#diagnose}

`/mcp` 列出每个服务器的连接状态、工具数量、暴露方式和配置来源。选中一个服务器可以查看工具、重连、登录或退出、修改暴露方式、启用或禁用。修改会保留无关的配置；受信任的项目可以保存对用户级服务器的启用/禁用覆盖。

非交互模式下 `/mcp` 只打印状态；`/mcp login <服务器>`、`/mcp logout <服务器>`、`/mcp reconnect <服务器>` 直接执行对应操作。

命令行（不加载扩展）：

```bash
nek mcp add <服务器> [选项] -- <命令> [参数...]   # 添加或替换 stdio 服务器
nek mcp add <服务器> [选项] --url <url>           # 添加或替换 HTTP 服务器
nek mcp remove <服务器> [--local]
nek mcp list [--json]
nek mcp login <服务器> [--timeout <秒>]
nek mcp logout <服务器>
```

`add` 的常用选项：可重复的 `--env KEY=VALUE` 和 `--header KEY=VALUE`、`--cwd`、`--bearer-token-env-var`、OAuth 客户端设置、`--description`、`--exposure deferred|direct|hidden`。完整列表见 `nek mcp --help`。

`nek mcp list` 会实际连接每个启用的服务器并打印工具和错误；配置无效或任一启用的服务器连不上时退出码为 1。

日志与重试：

- 服务器的日志通知写入 `~/.nek/agent/mcp.log`，超过 5 MB 时轮转为 `mcp.log.1`；
- 连接错误和失败的 stdio 服务器的 stderr 末尾可以在 `/mcp` 里查看；
- HTTP 连接建立时，对临时网络错误和 408、429、5xx 响应重试两次；
- 连接断开后在下一次调用时重连；
- 服务器的工具列表变化时，新增工具可用，被撤回的工具不可用；
- **工具调用不会自动重试**，因为服务器可能已经执行过了；
- 停止 stdio 服务器时关闭 stdin 并结束整个进程树（包括 `npx`、`uvx` 这类启动器）。

## OAuth 登录 {#oauth}

没有配置 `Authorization` 请求头的 HTTP 服务器，在收到认证质询时会自动尝试已保存的 OAuth 凭据。后台连接**从不**自动打开浏览器，需要你显式登录：

```bash
nek mcp add sentry --url https://mcp.sentry.dev/mcp
nek mcp login sentry
```

或在会话里 `/mcp login sentry`。登录时会显示可点击的授权链接并打开浏览器；通过 SSH 使用时，如果浏览器无法访问本机回调地址，把跳转后的完整 URL 粘贴回来即可。浏览器等待超时默认 300 秒。

- 使用 PKCE 和动态客户端注册；
- token、refresh token 和客户端信息保存在 `~/.nek/agent/mcp-auth.json`，按**服务器名 + URL** 区分：同一 URL 的不同名字分别登录；改了 URL 不会复用另一个端点的凭据；
- access token 快过期或被拒绝时自动刷新；多个进程之间用文件锁串行刷新，避免轮换的 refresh token 被消耗两次；
- 运行中的会话在下一轮发现外部完成的登录；
- 之后的权限质询会在申请新 scope 时保留已授予的 scope；
- 带有 RFC 9207 `iss` 的授权响应必须与预期的签发方一致；
- `nek mcp logout <服务器>` 删除该服务器保存的状态。

预注册客户端的写法：

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

| `oauth` 字段 | 说明 |
|---|---|
| `clientId`、`clientSecret` | 预注册的客户端。`clientSecret` 可选，支持环境变量和命令写法 |
| `callbackPort` | 回调地址为 `http://127.0.0.1:<端口>/callback` |
| `callbackUrl` | 自定义回调地址，主机只能是 `localhost`、`127.0.0.1` 或 `[::1]`，不能带查询串或片段，端口须与 `callbackPort` 一致 |
| `scope` | 空格分隔的 scope，用于不公布 scope 的服务器 |
| `clientName` | 动态注册时的客户端名，默认 `nek`。要以新名字注册需先退出登录 |
| `authServerMetadataUrl` | 指定授权服务器元数据文档，代替自动发现；除回环地址外必须是 HTTPS |

不支持服务商登录式认证和 OAuth client-ID 元数据文档。

## 资源 {#resources}

连接的、非 hidden 的服务器提供资源时，会增加三个工具：

| 工具 | 作用 |
|---|---|
| `list_mcp_resources` | 列出资源。指定服务器时返回一页和 `nextCursor`，不指定时汇总所有服务器 |
| `list_mcp_resource_templates` | 列出 URI 模板，分页方式同上 |
| `read_mcp_resource` | 按服务器和 URI 读取资源。文本和图片交给模型，其他二进制数据保存到临时文件 |

这些工具的暴露方式取所有相关服务器中最宽的那个（direct 优先于 deferred）。MCP App 资源（`ui://` 或 `text/html;profile=mcp-app`）和图标会被忽略，nek 不渲染它们。

## 结果与权限

- MCP 调用经过普通的 `tool_call` / `tool_result` 处理流程，扩展的权限检查同样生效；
- 服务器的注解（`readOnlyHint`、`destructiveHint` 等）只是提示，不是安全保证；
- 超过 20 KB 的文本结果保留开头和结尾，中间插入截断标记和完整输出的路径；
- 图片保持为图片；`isError` 会把结果标记为失败。

## 子代理与扩展

- 子代理**不加载** MCP，没有 MCP 工具。
- 扩展可以用 `pi.registerMcpServer(name, config)` 为当前会话注册服务器（配置格式与 `mcpServers` 条目相同），用 `pi.unregisterMcpServer(name)` 断开。文件中配置的同名服务器优先。见 [编写扩展](/develop/extensions#mcp)。
