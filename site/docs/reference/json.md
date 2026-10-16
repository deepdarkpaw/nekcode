# JSON 事件流

JSON 模式输出一次调用的结构化进度：

```bash
nek --mode json "审查这个仓库"
```

nek 先写出一条会话头，然后是会话事件，提供的提示词处理完后退出。RPC 模式输出同样形状的会话事件，但没有会话头（它是长期运行的双向协议），见 [RPC 协议](/reference/rpc)。

这一页是 JSON 和 RPC 模式共用事件的规范参考。消息值使用 [消息类型](/reference/message-types)。

## 分帧与进程 I/O {#framing}

使用严格的 JSONL 分帧：每条记录是一个 JSON 对象，以 LF（`\n`）结尾。只按 LF 切分，并去掉 LF 前可选的 CR。JSON 字符串里的 Unicode 行分隔符和段落分隔符（U+2028、U+2029）是合法内容，**不是**记录边界。

Node.js 的 `readline` 不适合读这个流，因为它也会在这两个 Unicode 分隔符处切行。请用字节流或 UTF-8 流解码器自己按 LF 切分。

持续读取 stdout，停止读取的客户端会在管道缓冲区写满后让 nek 卡住。stdout 只用于 JSONL，诊断信息和日志写到 stderr。

## 会话头

JSON 模式的第一条记录是当前的 [会话头](/reference/session-format#entry-types)：

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path"}
```

RPC 模式不输出会话头，用 [`get_state`](/reference/rpc-commands#get-state) 获取会话 ID 和文件。

## 事件顺序

一次简单的运行产生类似这样的记录：

```json
{"type":"agent_start"}
{"type":"turn_start"}
{"type":"message_start","message":{"role":"user","content":"Review this repository","timestamp":1733234401000}}
{"type":"message_end","message":{"role":"user","content":"Review this repository","timestamp":1733234401000}}
{"type":"message_start","message":{"role":"assistant","content":[],"stopReason":"pending","...":"..."}}
{"type":"message_update","usage":{"...":"..."},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello"}}
{"type":"message_end","message":{"role":"assistant","...":"..."}}
{"type":"turn_end","message":{"role":"assistant","...":"..."},"toolResults":[]}
{"type":"agent_end","messages":[{"...":"..."}],"willRetry":false}
{"type":"agent_settled"}
```

`agent_end` 结束一次底层运行，之后还可能有自动重试、溢出恢复、压缩重试、插话或追加的工作。`agent_settled` 表示 nek 对这次会话级运行没有剩余的自动工作了。

## 运行与轮次事件

| 事件 | 字段 | 含义 |
|---|---|---|
| `agent_start` | 无 | 一次底层运行开始 |
| `agent_end` | `messages`、`willRetry` | 这次底层运行结束，`messages` 是这次运行产生的消息 |
| `agent_settled` | 无 | nek 不会再通过重试、压缩恢复或排队消息自动继续 |
| `turn_start` | 无 | 一轮开始 |
| `turn_end` | `message`、`toolResults` | 一次助手回复及其工具调用完成 |

一轮 = 一次助手回复 + 它产生的工具调用和结果。

## 消息事件

| 事件 | 字段 | 含义 |
|---|---|---|
| `message_start` | `message` | 一条消息开始 |
| `message_update` | `usage`、`assistantMessageEvent` | 助手消息的某个内容块有更新 |
| `message_end` | `message` | 一条消息完成，这是权威的最终消息 |

### 重建流式消息

线上的 `message_update` 只包含增量：省略了 SDK 事件中累积的 `message` 字段和每个 `assistantMessageEvent.partial` 快照，保证流的大小线性增长。

嵌套事件是以下之一：

| 类型 | 额外字段 | 含义 |
|---|---|---|
| `start` | 无 | 服务商流开始 |
| `text_start` | `contentIndex` | 文本块开始 |
| `text_delta` | `contentIndex`、`delta` | 追加文本 |
| `text_end` | `contentIndex`、`content` | 文本块结束，带权威内容 |
| `thinking_start` | `contentIndex` | 思考块开始 |
| `thinking_delta` | `contentIndex`、`delta` | 追加思考文本 |
| `thinking_end` | `contentIndex`、`content` | 思考块结束，带权威内容 |
| `toolcall_start` | `contentIndex`、`id`、`toolName` | 工具调用块开始 |
| `toolcall_delta` | `contentIndex`、`delta` | 追加序列化的参数数据 |
| `toolcall_end` | `contentIndex`、`toolCall` | 工具调用结束，带完整的 `ToolCall` |
| `done` | `reason`、`message` | 服务商流成功完成 |
| `error` | `reason`、`error` | 服务商流以错误或中止结束 |

正常的代理循环会把服务商层面的 `start`、`done`、`error` 转换为 `message_start` 和 `message_end`，而不是作为 `message_update` 发出。

用 `contentIndex` 识别内容块。缓冲 `delta` 用于实时显示，但在收到 `text_end`、`thinking_end`、`toolcall_end` 时用其中的完整内容替换；收到 `message_end` 时用 `message_end.message` 替换整条部分消息。

顶层的 `usage` 是服务商最新报告的累计用量。不在流式过程中报告用量的服务商，这个值可能直到完成前都是 0。

```json
{"type":"message_update","usage":{"input":100,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":101,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"assistantMessageEvent":{"type":"text_delta","contentIndex":0,"delta":"Hello "}}
```

## 工具执行事件

| 事件 | 字段 | 含义 |
|---|---|---|
| `tool_execution_start` | `toolCallId`、`toolName`、`args` | 工具开始执行 |
| `tool_execution_update` | `toolCallId`、`toolName`、`args`、`partialResult` | 工具报告了部分结果 |
| `tool_execution_end` | `toolCallId`、`toolName`、`result`、`isError` | 工具执行结束 |

用 `toolCallId` 关联同一次调用。`partialResult` 是工具提供的最新部分结果，是替换还是追加取决于该工具的约定。

```json
{"type":"tool_execution_start","toolCallId":"call_abc123","toolName":"bash","args":{"command":"ls -la"}}
{"type":"tool_execution_update","toolCallId":"call_abc123","toolName":"bash","args":{"command":"ls -la"},"partialResult":{"content":[{"type":"text","text":"partial output"}],"details":{}}}
{"type":"tool_execution_end","toolCallId":"call_abc123","toolName":"bash","result":{"content":[{"type":"text","text":"complete output"}],"details":{}},"isError":false}
```

## 队列与状态事件

| 事件 | 字段 | 含义 |
|---|---|---|
| `queue_update` | `steering`、`followUp` | 插话或追加队列变化，两个字段都是完整的当前队列 |
| `entry_appended` | `entry` | 扩展通过 `pi.appendEntry()` 追加了自定义条目 |
| `session_info_changed` | `name` | 会话显示名变化，没有 `name` 表示被清除 |
| `thinking_level_changed` | `level` | 当前思考等级变化 |

## 压缩事件

```json
{"type":"compaction_start","reason":"threshold"}
```

`reason` 为 `"manual"`、`"threshold"` 或 `"overflow"`。

成功时：

```json
{
  "type": "compaction_end",
  "reason": "threshold",
  "result": {
    "summary": "Summary of conversation...",
    "firstKeptEntryId": "abc123",
    "tokensBefore": 150000,
    "estimatedTokensAfter": 32000,
    "usage": {"...": "..."},
    "details": {}
  },
  "aborted": false,
  "willRetry": false
}
```

被中止时没有 `result`，`aborted` 为真；失败时没有 `result`，`aborted` 为假，`errorMessage` 描述原因。溢出恢复成功时 `willRetry` 为真，之后 nek 重试提示词。见 [上下文压缩](/reference/compaction)。

## 重试事件

助手轮的重试：

```json
{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"529 overloaded"}
{"type":"auto_retry_end","success":true,"attempt":2}
```

最终失败时 `auto_retry_end` 的 `success` 为假，并带 `finalError`。

压缩和分支摘要的重试：

```json
{"type":"summarization_retry_scheduled","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"terminated"}
{"type":"summarization_retry_attempt_start","source":"compaction","reason":"threshold"}
{"type":"summarization_retry_finished"}
```

分支摘要的 `source` 是 `"branchSummary"`，没有 `reason`。

## 仅 RPC 的事件

RPC 的 [`bash`](/reference/rpc-commands#bash) 命令每个输出块发一条 `bash_execution_update`，可选的 `id` 与命令 ID 相同。最终响应里的输出可能被截断，但这些事件包含全部输出：

```json
{"type":"bash_execution_update","id":"req-1","delta":"total 48\n"}
```

扩展处理函数抛出错误时，RPC 还会发出：

```json
{"type":"extension_error","extensionPath":"/path/to/extension.ts","event":"tool_call","error":"Error message"}
```

扩展界面记录是独立的子协议，见 [RPC 扩展 UI](/reference/rpc-extension-ui)。

## TypeScript 类型

SDK 的 `AgentSessionEvent` 为进程内使用者提供累积的流式快照。JSON 和 RPC 只转换 `message_update`：

```typescript
type WithoutPartial<T> = T extends { partial: unknown } ? Omit<T, "partial"> : T;

type JsonAssistantMessageEvent<T> = T extends { type: "toolcall_start"; partial: unknown }
  ? WithoutPartial<T> & { id: string; toolName: string }
  : WithoutPartial<T>;

type JsonAgentSessionEvent =
  | Exclude<AgentSessionEvent, { type: "message_update" }>
  | {
      type: "message_update";
      usage: Usage;
      assistantMessageEvent: JsonAssistantMessageEvent<AssistantMessageEvent>;
    };
```

使用 `@earendil-works/pi-coding-agent` 导出的 `JsonAgentSessionEvent` 类型。

## 示例

只输出完成的消息：

```bash
nek --mode json "列出文件" 2>/dev/null | jq -c 'select(.type == "message_end")'
```

统计这次运行调用了哪些工具：

```bash
nek --mode json "运行测试" 2>/dev/null | jq -r 'select(.type == "tool_execution_start") | .toolName' | sort | uniq -c
```
