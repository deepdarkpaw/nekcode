# RPC 命令

这一页列出 [RPC 模式](/reference/rpc) 在 stdin 上接受的命令。每条命令和响应都是一个 JSON 对象，占一行。所有命令都可以带可选的 `id`，响应会原样带回。共用的消息值见 [消息类型](/reference/message-types)。

## 命令一览

| 命令 | 作用 |
|---|---|
| [`prompt`](#prompt) | 发送用户提示词 |
| [`steer`](#steer) | 运行中排队一条插话 |
| [`follow_up`](#follow-up) | 排队一条追加消息 |
| [`abort`](#abort) | 中止当前操作 |
| [`clear_queue`](#clear-queue) | 清空排队消息并返回其文本 |
| [`new_session`](#new-session) | 开始新会话 |
| [`get_state`](#get-state) | 获取会话状态 |
| [`get_messages`](#get-messages) | 获取对话中的所有消息 |
| [`set_model`](#set-model) | 切换模型 |
| [`cycle_model`](#cycle-model) | 切换到下一个模型 |
| [`get_available_models`](#get-available-models) | 列出可用模型 |
| [`set_thinking_level`](#set-thinking-level) | 设置思考等级 |
| [`cycle_thinking_level`](#cycle-thinking-level) | 循环切换思考等级 |
| [`get_available_thinking_levels`](#get-available-thinking-levels) | 列出当前模型支持的思考等级 |
| [`set_steering_mode`](#set-steering-mode) | 插话的送达方式 |
| [`set_follow_up_mode`](#set-follow-up-mode) | 追加消息的送达方式 |
| [`compact`](#compact) | 手动压缩 |
| [`set_auto_compaction`](#set-auto-compaction) | 开关自动压缩 |
| [`set_auto_retry`](#set-auto-retry) | 开关自动重试 |
| [`abort_retry`](#abort-retry) | 中止正在等待的重试 |
| [`bash`](#bash) | 执行 shell 命令并把输出加入上下文 |
| [`abort_bash`](#abort-bash) | 中止正在执行的 shell 命令 |
| [`get_session_stats`](#get-session-stats) | 用量、费用和上下文统计 |
| [`export_html`](#export-html) | 导出为 HTML |
| [`switch_session`](#switch-session) | 切换到另一个会话文件 |
| [`fork`](#fork) | 从较早的用户消息分叉 |
| [`clone`](#clone) | 复制当前活动分支为新会话 |
| [`get_fork_messages`](#get-fork-messages) | 可用于分叉的用户消息 |
| [`get_entries`](#get-entries) | 所有会话条目（支持游标与分页） |
| [`get_tree`](#get-tree) | 会话树 |
| [`get_last_assistant_text`](#get-last-assistant-text) | 最后一条助手文本 |
| [`set_session_name`](#set-session-name) | 设置会话显示名 |
| [`get_commands`](#get-commands) | 可用的扩展命令、模板和 Skills |
| [GUI 与控制进程命令](#gui-commands) | 进程信息、配置校验、会话目录管理、认证、模型探测、项目信任、搜索/MCP 测试、`extension_call` |

## 提示词

### prompt {#prompt}

发送用户提示词。提示词被接受、排队或处理后返回响应，事件在之后异步流出。

```json
{"id": "req-1", "type": "prompt", "message": "Hello, world!"}
```

带图片：

```json
{"type": "prompt", "message": "What's in this image?", "images": [{"type": "image", "data": "base64-encoded-data", "mimeType": "image/png"}]}
```

**正在流式输出时**必须指定 `streamingBehavior`，否则返回错误：

```json
{"type": "prompt", "message": "New instruction", "streamingBehavior": "steer"}
```

- `"steer"`：当前助手轮执行完工具调用后、下一次模型请求前送达；
- `"followUp"`：等代理结束后才送达。

**扩展命令**（如 `/mycommand`）即使在流式输出中也立即执行，由扩展自己通过 `pi.sendMessage()` 与模型交互。**Skill 命令**（`/skill:名字`）和**提示词模板**在发送或排队前展开。

响应：

```json
{"id": "req-1", "type": "response", "command": "prompt", "success": true, "data": {"disposition": "started"}}
```

`data.disposition`：

- `"handled"`：被扩展命令或输入处理函数消费，没有启动运行；
- `"queued"`：运行中被排队；
- `"started"`：被接受并启动了一次运行。

`success: false` 表示提示词在被接受前就被拒绝。被接受之后的失败通过正常的事件和消息流报告，不会为同一个请求再发一条响应。

### steer {#steer}

运行中排队一条插话。Skill 命令和模板会被展开；不允许扩展命令（请用 `prompt`）。

```json
{"type": "steer", "message": "Stop and do this instead"}
```

可选 `images`。响应 `data.disposition` 为 `"handled"` 或 `"queued"`。

### follow_up {#follow-up}

排队一条追加消息，在代理没有更多工具调用和插话时才送达。规则同 `steer`。

```json
{"type": "follow_up", "message": "After you're done, also do this"}
```

### abort {#abort}

中止当前操作，等会话空闲后再响应。

```json
{"type": "abort"}
```

### clear_queue {#clear-queue}

移除排队的插话和追加消息，并返回它们的文本：

```json
{"type": "clear_queue"}
```

```json
{"type": "response", "command": "clear_queue", "success": true, "data": {"steering": ["Change direction"], "followUp": ["Summarize when finished"]}}
```

要实现交互界面里 Esc 的行为：先发 `clear_queue`，再发 `abort`，然后把返回的文本放回客户端的输入框。只发 `abort` 时，仍在会话里的排队消息会继续执行。

### new_session {#new-session}

开始新会话，可被扩展的 `session_before_switch` 取消。可选 `parentSession` 记录父会话：

```json
{"type": "new_session", "parentSession": "/path/to/parent-session.sqlite"}
```

```json
{"type": "response", "command": "new_session", "success": true, "data": {"cancelled": false}}
```

## 状态

### get_state {#get-state}

```json
{"type": "get_state"}
```

```json
{
  "type": "response",
  "command": "get_state",
  "success": true,
  "data": {
    "model": {},
    "thinkingLevel": "medium",
    "isStreaming": false,
    "isCompacting": false,
    "steeringMode": "all",
    "followUpMode": "one-at-a-time",
    "sessionFile": "/path/to/session.sqlite",
    "sessionId": "abc123",
    "sessionName": "my-feature-work",
    "autoCompactionEnabled": true,
    "messageCount": 5,
    "pendingMessageCount": 0
  }
}
```

`model` 是完整的 [模型对象](#model-object)，没有选择模型时省略。`sessionName` 未设置时省略。

### get_messages {#get-messages}

```json
{"type": "get_messages"}
```

返回 `data.messages`，是 `AgentMessage` 数组。

## 模型

### set_model {#set-model}

```json
{"type": "set_model", "provider": "anthropic", "modelId": "claude-sonnet-4-20250514"}
```

响应的 `data` 是完整的 [模型对象](#model-object)。

### cycle_model {#cycle-model}

切换到下一个可用模型，只有一个模型时 `data` 为 `null`。

```json
{"type": "response", "command": "cycle_model", "success": true, "data": {"model": {}, "thinkingLevel": "medium", "isScoped": false}}
```

### get_available_models {#get-available-models}

返回 `data.models`，是完整模型对象的数组。

## 思考等级

### set_thinking_level {#set-thinking-level}

```json
{"type": "set_thinking_level", "level": "high"}
```

等级：`"off"`、`"minimal"`、`"low"`、`"medium"`、`"high"`、`"xhigh"`、`"max"`。`"xhigh"` 和 `"max"` 只在所选模型支持时可用。

### cycle_thinking_level {#cycle-thinking-level}

循环切换，模型不支持思考时 `data` 为 `null`，否则为 `{"level": "high"}`。

### get_available_thinking_levels {#get-available-thinking-levels}

返回当前模型支持的等级，不支持推理的模型返回 `["off"]`：

```json
{"type": "response", "command": "get_available_thinking_levels", "success": true, "data": {"levels": ["off", "minimal", "low", "medium", "high"]}}
```

## 队列模式

### set_steering_mode {#set-steering-mode}

```json
{"type": "set_steering_mode", "mode": "one-at-a-time"}
```

- `"all"`：当前助手轮执行完工具调用后送达所有插话；
- `"one-at-a-time"`：每完成一个助手轮送达一条（默认）。

### set_follow_up_mode {#set-follow-up-mode}

```json
{"type": "set_follow_up_mode", "mode": "one-at-a-time"}
```

- `"all"`：代理结束时送达所有追加消息；
- `"one-at-a-time"`：每次代理结束送达一条（默认）。

## 压缩

### compact {#compact}

```json
{"type": "compact", "customInstructions": "Focus on code changes"}
```

```json
{
  "type": "response",
  "command": "compact",
  "success": true,
  "data": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "estimatedTokensAfter": 32000,
    "usage": {"input": 32000, "output": 1200, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 33200, "cost": {"input": 0.01, "output": 0.02, "cacheRead": 0, "cacheWrite": 0, "total": 0.03}},
    "details": {}
  }
}
```

`estimatedTokensAfter` 是压缩后重建上下文的启发式估算，不是服务商精确计数。`usage` 是生成摘要的模型调用用量，自定义压缩可能省略。

### set_auto_compaction {#set-auto-compaction}

```json
{"type": "set_auto_compaction", "enabled": true}
```

## 重试

### set_auto_retry {#set-auto-retry}

开关对临时错误（过载、限流、5xx 等）的自动重试：

```json
{"type": "set_auto_retry", "enabled": true}
```

### abort_retry {#abort-retry}

取消正在等待的重试延迟，并停止重试：

```json
{"type": "abort_retry"}
```

## Shell 命令

### bash {#bash}

执行 shell 命令并把输出加入对话上下文。命令运行时以 `bash_execution_update` 事件流式输出，响应包含最终结果。

```json
{"id": "req-1", "type": "bash", "command": "ls -la"}
```

设置 `excludeFromContext: true` 时输出保存在会话里，但不会进入下一次提示词的模型上下文。带上 `id` 可以把流式事件和这条命令关联起来。

```json
{"id": "req-1", "type": "response", "command": "bash", "success": true, "data": {"output": "total 48\ndrwxr-xr-x ...", "exitCode": 0, "cancelled": false, "truncated": false}}
```

输出被截断时带 `fullOutputPath`，指向完整输出的临时文件。

输出如何到达模型：命令立即执行并保存为一条 `BashExecutionMessage`。**下一次**发送 `prompt` 时，除非 `excludeFromContext` 为真，它会被转换成这样的用户消息：

````text
Ran `ls -la`
```
total 48
drwxr-xr-x ...
```
````

所以输出在下一次提示词时才到达模型；提示词之前可以执行多条命令，每条的输出都会被包含。

### abort_bash {#abort-bash}

```json
{"type": "abort_bash"}
```

## 会话

### get_session_stats {#get-session-stats}

```json
{
  "type": "response",
  "command": "get_session_stats",
  "success": true,
  "data": {
    "sessionFile": "/path/to/session.sqlite",
    "sessionId": "abc123",
    "userMessages": 5,
    "assistantMessages": 5,
    "toolCalls": 12,
    "toolResults": 12,
    "totalMessages": 22,
    "tokens": {"input": 50000, "output": 10000, "cacheRead": 40000, "cacheWrite": 5000, "total": 105000},
    "cost": 0.45,
    "contextUsage": {"tokens": 60000, "contextWindow": 200000, "percent": 30}
  }
}
```

`tokens` 和 `cost` 包括整个会话中的助手消息、工具报告的用量和压缩/分支摘要的生成。`contextUsage` 是当前上下文窗口的估算（与压缩和状态栏使用的相同）；没有模型或上下文窗口时省略；刚压缩完、还没有新的助手回复提供有效用量时，`tokens` 和 `percent` 为 `null`。

### export_html {#export-html}

```json
{"type": "export_html", "outputPath": "/tmp/session.html"}
```

返回 `data.path`。省略 `outputPath` 时自动生成路径。

### switch_session {#switch-session}

加载另一个会话文件，可被扩展的 `session_before_switch` 取消：

```json
{"type": "switch_session", "sessionPath": "/path/to/session.sqlite"}
```

返回 `data.cancelled`。

### fork {#fork}

从活动分支上一条较早的用户消息创建新的分叉，可被 `session_before_fork` 取消。返回被分叉的那条消息的文本：

```json
{"type": "fork", "entryId": "abc123"}
```

```json
{"type": "response", "command": "fork", "success": true, "data": {"text": "The original prompt text...", "cancelled": false}}
```

### clone {#clone}

在当前位置把活动分支复制为新会话，可被 `session_before_fork` 取消：

```json
{"type": "clone"}
```

### get_fork_messages {#get-fork-messages}

```json
{"type": "response", "command": "get_fork_messages", "success": true, "data": {"messages": [{"entryId": "abc123", "text": "First prompt..."}, {"entryId": "def456", "text": "Second prompt..."}]}}
```

### get_entries {#get-entries}

按追加顺序返回所有会话条目（不含会话头）。会话是只追加的条目树，条目 ID 稳定，所以可以把最后见过的条目 ID 作为 `since` 游标，只获取它之后的条目，即使客户端重启也有效。与 `get_messages` 不同，这里包括压缩前的历史和被放弃的分支。

```json
{"type": "get_entries"}
```

带游标：

```json
{"type": "get_entries", "since": "abc123"}
```

取最新一页：

```json
{"type": "get_entries", "limit": 50}
```

取某个条目之前的一页：

```json
{"type": "get_entries", "limit": 50, "beforeEntryId": "abc123"}
```

响应：

```json
{
  "type": "response",
  "command": "get_entries",
  "success": true,
  "data": {
    "entries": [
      {"type": "message", "id": "def456", "parentId": "abc123", "timestamp": "...", "message": {"role": "user"}}
    ],
    "leafId": "def456",
    "hasMore": false
  }
}
```

`leafId` 是当前叶节点 ID（空会话为 `null`），一次往返就能判断活动分支是否移动。`since` 不匹配任何条目时返回 `success: false`。

`limit` 和 `beforeEntryId` 在同一列表上分页：一页是 `beforeEntryId` 之前最新的 `limit` 条记录，因此 `{"limit": 50}` 取最后 50 条，再用这页第一条记录的 ID 作为 `beforeEntryId` 就能继续向前翻页。只传 `beforeEntryId` 会返回它之前的全部条目，`hasMore` 表示该页之前是否还有更早的条目。两个分页参数都不传时，返回完整列表且 `hasMore: false`；`since` 仍会先过滤，再在游标之后的范围内分页。非正整数的 `limit` 或匹配不到条目的 `beforeEntryId` 都会返回 `success: false`。

### get_tree {#get-tree}

以树的形式返回会话。每个节点是 `{entry, children, label?, labelTimestamp?}`。结果是数组，因为导航 API 可能产生多个根，父链断开的孤立条目也会作为根出现。同样返回 `leafId`。

### get_last_assistant_text {#get-last-assistant-text}

返回 `{"text": "..."}`，没有助手文本时为 `null`。

### set_session_name {#set-session-name}

```json
{"type": "set_session_name", "name": "my-feature-work"}
```

当前名字可通过 `get_state` 的 `sessionName` 获取。启动 RPC 模式时用 `--name` / `-n` 设置初始名字。

## 可发现的命令

### get_commands {#get-commands}

返回可用的命令（扩展命令、提示词模板和 Skills），通过 `prompt` 在名字前加 `/` 执行：

```json
{
  "type": "response",
  "command": "get_commands",
  "success": true,
  "data": {
    "commands": [
      {
        "name": "fix-tests",
        "description": "Fix failing tests",
        "source": "prompt",
        "sourceInfo": {"path": "/home/user/project/.nek/prompts/fix-tests.md", "source": "auto", "scope": "project", "origin": "top-level"}
      }
    ]
  }
}
```

- `source`：`"extension"`（扩展注册）、`"prompt"`（提示词模板）、`"skill"`（Skill，名字带 `skill:` 前缀）；
- `sourceInfo`：注册该命令的资源的元数据，包括 `path`、`source`（`"local"`、`"auto"`、`"cli"` 等）、`scope`（`"user"`、`"project"`、`"temporary"`）、`origin`（`"top-level"` 或 `"package"`），以及适用时的 `baseDir`。

内置的界面命令（`/settings`、`/hotkeys` 等）不包括在内，它们只在交互模式中处理，通过 `prompt` 发送也不会执行。

## GUI 与控制进程命令 {#gui-commands}

这些命令面向桌面端和 IDE 客户端，用于管理配置、模型、认证和会话列表。每条命令都返回标准的 `response` 记录；除单独说明把失败作为结构化数据返回的探测命令外，错误均返回 `success: false` 和 `error`。

`nek --mode rpc --control` 启动**无会话控制进程**：不创建会话、不加载扩展、不连接 MCP 服务器。它只接受以下控制命令及 `get_available_models`，其他命令一律返回 `{"success": false, "error": "Command not available in control mode: <type>"}`。

### get_info {#get-info}

获取当前运行进程的身份信息：

```json
{"type": "get_info"}
```

响应 `data`：`protocolVersion`、`nekVersion`、`piVersion`、`mode`（`"session"` 或 `"control"`）、`agentDir`、`sessionDir`、`cwd`、`platform`、`nodeVersion`。

### reload {#reload}

重新读取 `settings.json`、`models.json`、凭据和 MCP 配置；在会话进程中还会重新加载扩展、Skills、提示词模板、主题和指令文件。

```json
{"type": "reload"}
```

响应 `data`：`deferred` 和 `diagnostics`。`deferred: true` 表示当前有运行正在进行：重载会排队到 `agent_settled` 之后执行，本次响应先返回对当前配置的校验结果。

### validate_config {#validate-config}

校验配置文件但不应用：

```json
{"type": "validate_config", "cwd": "/home/user/project"}
```

响应 `data`：`diagnostics`（`{file, severity, message}` 数组）。不传 `cwd` 时只检查全局文件（`models.json` schema、全局 `settings.json`、`mcp.json`、`nek.yaml`、`agents/*.md`）；传入 `cwd` 且项目已受信任时，一并检查项目下的同类文件。

### get_changelog {#get-changelog}

获取内置的 `CHANGELOG.md`（按版本从新到旧）：

```json
{"type": "get_changelog", "sinceVersion": "0.3.0"}
```

响应 `data`：`markdown`。`sinceVersion` 可选，只返回比该版本更新的记录。

### get_mention_targets {#get-mention-targets}

获取 `@agent:<类型>` 和 `@skill:<名字>` 可补全的目标：

```json
{"type": "get_mention_targets", "cwd": "/home/user/project"}
```

响应 `data`：`targets`，每项含 `kind`（`"agent"` 或 `"skill"`）、`name`、可选 `description`，以及 Skill 的 `location`（`SKILL.md` 路径）。子代理类型排在前面（内置、用户、项目），后面是已加载的 Skills。

### list_builtin_tools {#list-builtin-tools}

列出可在 `defaultTools` 中选择的内置工具：

```json
{"type": "list_builtin_tools"}
```

响应 `data`：`tools`，每项含 `name`、`description`（模型看到的描述）和 `defaultActive`（新会话默认是否启用）。

### list_sessions {#list-sessions}

按修改时间从新到旧列出会话：

```json
{"type": "list_sessions", "cwd": "/home/user/project", "all": true, "limit": 100}
```

`cwd` 指定项目目录（默认当前进程工作目录），`all: true` 列出所有项目的会话，`limit` 默认 500。响应 `data.sessions` 每项含：`path`、`id`、`cwd`、`name?`、`parentSessionPath?`、`createdAt`、`modifiedAt`、`messageCount`、`firstMessage`（最多 200 字符）和 `locked`（是否有存活进程持有锁）。

### delete_session {#delete-session}

删除会话及其全部附属文件（`.sqlite`、`.meta.json` 和 SQLite 日志文件）：

```json
{"type": "delete_session", "sessionPath": "/path/to/session.sqlite"}
```

当前正在使用的会话或被存活进程锁定的会话会被拒绝。

### rename_session {#rename-session}

修改会话显示名（写入与 `/resume` 相同的 `session_info` 条目；被锁定的会话会被拒绝）：

```json
{"type": "rename_session", "sessionPath": "...sqlite", "name": "Refactor the parser"}
```

### read_session_snapshot {#read-session-snapshot}

在不打开会话、不获取会话锁的情况下读取会话快照：

```json
{"type": "read_session_snapshot", "sessionPath": "...sqlite"}
```

响应 `data`：`session`（同 `list_sessions`）、`entries`（同 `get_entries`）、`leafId`、`messages`（叶节点分支上的消息），以及会话被存活进程锁定时附带的 `lockedBy`（`{pid, hostname, kind: "tui"|"rpc"|"print"|"json", startedAt}`）。未锁定或锁过期时省略 `lockedBy`，是否锁定仍以 `session.locked` 为准。

### import_session {#import-session}

把 `.jsonl` 或 `.sqlite` 会话导入为指定工作目录的新会话（原文件保持不变）：

```json
{"type": "import_session", "inputPath": "/home/user/export.jsonl", "cwd": "/home/user/project"}
```

响应 `data`：`sessionPath`。

### export_session {#export-session}

导出当前会话（仅限会话进程）：

```json
{"type": "export_session", "format": "html"}
```

`format` 为 `"html"` 或 `"jsonl"`，可选 `outputPath`。响应 `data`：`path`。

### share_session {#share-session}

上传当前会话并返回查看链接（优先使用已配置的 Radius，否则通过 `gh` 创建私密 GitHub gist；仅限会话进程）。响应 `data`：`url`。

### navigate_tree {#navigate-tree}

将会话叶节点移动到指定条目，可选对离开的分支生成摘要（仅限会话进程）：

```json
{"type": "navigate_tree", "entryId": "a1b2c3d4", "summarize": true, "label": "checkpoint"}
```

响应 `data`：`cancelled`，以及恢复编辑器文本时的 `editorText`。

### set_entry_label {#set-entry-label}

设置或清除条目标签（仅限会话进程）：

```json
{"type": "set_entry_label", "entryId": "a1b2c3d4", "label": "before refactor"}
```

### auth_status {#auth-status}

查询所有已知服务商的凭据状态：

```json
{"type": "auth_status"}
```

响应 `data.providers` 每项含：`provider`、`name`、`kind`（`"oauth"`、`"api_key"`、`"env"`、`"none"`）、`loginMethods`、OAuth 凭据的 `expiresAt`，以及 `state`（已保存的 OAuth access token 过期时为 `"expired"`，其余为 `"ok"`；nek 会在请求时自动刷新即将过期的 OAuth token）。

### auth_login {#auth-login}

执行服务商的交互式登录：

```json
{"type": "auth_login", "provider": "anthropic", "method": "oauth"}
```

流程进行中会写出 [`auth_event`](/reference/json#auth-event) 记录，并通过 [`structured`](/reference/rpc-extension-ui#structured)（`kind: "auth.prompt"`）请求输入。取消或中止会以错误响应结束登录。响应 `data`：`provider`。

### auth_logout {#auth-logout}

删除某个服务商保存的凭据：

```json
{"type": "auth_logout", "provider": "anthropic"}
```

### get_model_catalog {#get-model-catalog}

查询内置与 `models.json` 中的模型定义：

```json
{"type": "get_model_catalog", "provider": "anthropic", "ids": ["claude-sonnet-4-5"]}
```

响应 `data.models` 每项含：`provider`、`id`、`name`、`api`、`contextWindow`、`maxTokens`、`reasoning`、`thinkingLevels`、可选 `thinkingLevelMap`、`input`、`cost`。

### fetch_provider_models {#fetch-provider-models}

向已保存的服务商或未保存的草稿端点请求模型列表（15 秒超时，支持 Anthropic `after_id` 与 Gemini `pageToken` 分页，最多 20 页 / 2000 个模型）：

```json
{
  "type": "fetch_provider_models",
  "draft": {"api": "openai-completions", "baseUrl": "https://api.example.com/v1", "apiKey": "$EXAMPLE_KEY"}
}
```

也可以指定已保存的 `provider` 并用可选 `overrides`（`api`、`baseUrl`、`apiKey`、`headers`、`authHeader`）临时覆盖字段：

```json
{
  "type": "fetch_provider_models",
  "provider": "my-endpoint",
  "overrides": {"baseUrl": "https://staging.example.com/v1", "headers": {"X-Debug": "1"}}
}
```

响应 `data` 为 `{"ok": true, "endpoint": "<url>", "models": [...]}` 或 `{"ok": false, "endpoint": "<url>", "status": 401, "message": "..."}`（探测失败作为结构化数据返回，方便界面展示 HTTP 状态码）。

### test_provider {#test-provider}

发送一次最小补全请求来验证端点和模型（30 秒超时，支持 `provider` + 可选 `overrides` 或 `draft`）：

```json
{"type": "test_provider", "provider": "anthropic", "modelId": "claude-sonnet-4-5"}
```

响应 `data`：`{"ok": true, "latencyMs": 812}` 或 `{"ok": false, "status": 401, "message": "..."}`。

### get_project_trust / set_project_trust {#project-trust}

查询或保存目录的项目信任状态及受保护资源清单：

```json
{"type": "get_project_trust", "cwd": "/home/user/project"}
{"type": "set_project_trust", "cwd": "/home/user/project", "trusted": true}
```

`get_project_trust` 返回 `cwd`、`trusted`（`true`、`false` 或未保存时的 `null`）、`defaultProjectTrust` 和 `resources`（`{kind, path}` 数组）。

### test_web_search {#test-web-search}

用当前的 `webSearch` 设置执行一次联网搜索探测：

```json
{"type": "test_web_search", "query": "nek rpc"}
```

响应 `data`：`{"ok": true, "latencyMs": 640, "resultCount": 8}` 或 `{"ok": false, "message": "..."}`。

### mcp_test {#mcp-test}

连接一个 MCP 服务器、列出工具后断开（可按 `name` 查找配置，或直接传未保存的 `config`）：

```json
{"type": "mcp_test", "name": "docs", "cwd": "/home/user/project"}
```

响应 `data`：`{"ok": true, "latencyMs": 220, "tools": [{"name": "search", "description": "..."}]}` 或 `{"ok": false, "message": "..."}`。

### extension_call {#extension-call}

调用扩展通过 `pi.registerRpcHandler()` 注册的 RPC 方法（仅限会话进程）：

```json
{"type": "extension_call", "method": "nek.get_state", "params": {}}
```

响应 `data`：`{ "result": <处理函数返回值> }`。内置 `nek` 扩展提供的方法：

| 方法 | 参数 | 返回值 |
|---|---|---|
| `nek.get_state` | `{}` | `{mode, todos, plans, activePlanPath?, subagents}` |
| `nek.set_mode` | `{mode: "agent"\|"plan"}` | 完整状态快照 |
| `nek.stop_subagent` | `{id}` | `{status}` |
| `nek.get_subagent_transcript` | `{id}` | `{messages}` |
| `nek.list_agent_types` | `{}` | `{types:[{name,description,source,readonly,background,autonomous,model?,thinking?}]}` |
| `nek.get_plan` | `{path}` | `{path,name,overview,revision,status,todos,markdown}` |

内置 MCP 扩展在会话进程中提供的方法：

- `mcp.status`（`{}`）：返回 `{servers:[...]}`；
- `mcp.test`（`{name}`）：连接、列出工具并断开，返回 `{ok:true,latencyMs,tools}` 或 `{ok:false,message}`；
- `mcp.reconnect`、`mcp.login`、`mcp.logout`（`{name}`）：各返回 `{server:<status>}`。

## 模型对象 {#model-object}

模型相关的命令返回完整的模型定义，价格单位是美元/百万 token：

```json
{
  "id": "claude-sonnet-4-20250514",
  "name": "Claude Sonnet 4",
  "api": "anthropic-messages",
  "provider": "anthropic",
  "baseUrl": "https://api.anthropic.com",
  "reasoning": true,
  "input": ["text", "image"],
  "contextWindow": 200000,
  "maxTokens": 16384,
  "cost": {"input": 3.0, "output": 15.0, "cacheRead": 0.3, "cacheWrite": 3.75}
}
```

TypeScript 中使用 `@earendil-works/pi-ai` 导出的 `Model` 类型。
