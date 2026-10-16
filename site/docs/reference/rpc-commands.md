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
| [`get_entries`](#get-entries) | 所有会话条目（支持游标） |
| [`get_tree`](#get-tree) | 会话树 |
| [`get_last_assistant_text`](#get-last-assistant-text) | 最后一条助手文本 |
| [`set_session_name`](#set-session-name) | 设置会话显示名 |
| [`get_commands`](#get-commands) | 可用的扩展命令、模板和 Skills |

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
{"type": "get_entries", "since": "abc123"}
```

```json
{"type": "response", "command": "get_entries", "success": true, "data": {"entries": [{"type": "message", "id": "def456", "parentId": "abc123", "timestamp": "...", "message": {"role": "user"}}], "leafId": "def456"}}
```

`leafId` 是当前叶节点 ID（空会话为 `null`），一次往返就能判断活动分支是否移动。`since` 不匹配任何条目时返回 `success: false`。

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
