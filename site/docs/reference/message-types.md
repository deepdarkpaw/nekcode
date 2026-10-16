# 消息类型

nek 在 SDK 状态、生命周期事件、RPC 响应和会话的消息条目中使用 `AgentMessage`。这一页定义这些消息和它们的内容块。

消息的时间戳是毫秒级 Unix 时间戳，与 [会话条目](/reference/session-format#entry-base) 上的 ISO 8601 时间戳不同。

源码定义：

- `packages/ai/src/types.ts`：面向服务商的消息和内容块；
- `packages/agent/src/types.ts`：可扩展的 `AgentMessage` 联合类型；
- `packages/coding-agent/src/core/messages.ts`：coding agent 增加的消息角色。

## 内容块

### TextContent

```typescript
interface TextContent {
  type: "text";
  text: string;
  textSignature?: string; // 服务商相关的元数据，视为不透明
}
```

### ImageContent

```typescript
interface ImageContent {
  type: "image";
  data: string;     // base64 编码的图片数据
  mimeType: string; // 例如 image/png、image/jpeg
}
```

### ThinkingContent

```typescript
interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string; // 服务商相关的回放数据，视为不透明
  redacted?: boolean;         // 被隐去时可能没有可见文本，但保留加密的签名
}
```

### ToolCall

```typescript
interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, any>;
  thoughtSignature?: string; // 服务商相关
  namespace?: string;        // OpenAI Responses 中动态加载或带命名空间的工具
}
```

## Usage

助手消息总是带有用量；工具内部调用了模型时，工具结果也可以带用量。

```typescript
interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cacheWrite1h?: number; // cacheWrite 中以一小时保留写入的部分
  reasoning?: number;    // 已包含在 output 中，不要重复相加
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}
```

## 基础消息

### SystemMessage

```typescript
interface SystemMessage {
  role: "system";
  content: string | TextContent[];
  sections?: Record<string, string | null>;
  toolsAdded?: Tool[];
  toolsRemoved?: ToolReference[];
  replace?: boolean;
  timestamp: number;
}
```

开头的系统消息声明初始的提示词和工具。之后的系统消息可以追加指令、替换或删除命名的分节、增加或移除工具；按顺序重放得到当前状态。`replace: true` 丢弃之前的状态，建立一个全新的基线。

### UserMessage

```typescript
interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}
```

### AssistantMessage

```typescript
interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: string;
  provider: string;
  model: string;
  responseModel?: string;          // 与请求的模型不同时，服务商实际响应的模型
  responseId?: string;
  providerThinkingLevel?: string;
  diagnostics?: AssistantMessageDiagnostic[];
  usage: Usage;
  stopReason: "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
  deferred?: DeferredHandle;
  errorMessage?: string;
  rawStopReason?: string;
  endTurn?: boolean;
  timestamp: number;
}
```

`"pending"` 用于流式输出中的部分消息；`message_end` 中的完整消息带有终止的停止原因，nek 不会持久化 `"pending"` 的助手消息。`"deferred"` 的回复带一个 `DeferredHandle`，包含之后取回结果所需的服务商数据。

### ToolResultMessage

```typescript
interface ToolResultMessage<TDetails = any> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails; // 工具相关
  usage?: Usage;      // 工具内部的模型调用，计入整个会话的统计
  isError: boolean;
  timestamp: number;
}
```

## coding agent 的消息

### BashExecutionMessage

由你直接执行的 shell 命令（包括 RPC 的 `bash` 命令）创建，不是模型的工具结果。

```typescript
interface BashExecutionMessage {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode: number | undefined;
  cancelled: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp: number;
}
```

除非 `excludeFromContext` 为真，否则在下一次模型请求前转换为用户角色的文本。

### CustomMessage

扩展发送的上下文消息：

```typescript
interface CustomMessage<T = unknown> {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean; // 是否在终端中显示
  details?: T;      // 不发送给模型
  timestamp: number;
}
```

发送给模型时转换为用户消息。

### BranchSummaryMessage

```typescript
interface BranchSummaryMessage {
  role: "branchSummary";
  summary: string;
  fromId: string | null;
  timestamp: number;
}
```

由持久化的 `branch_summary` 条目生成。

### CompactionSummaryMessage

```typescript
interface CompactionSummaryMessage {
  role: "compactionSummary";
  summary: string;
  tokensBefore: number;
  timestamp: number;
}
```

由持久化的 `compaction` 条目生成。

## AgentMessage 联合类型

```typescript
type AgentMessage =
  | SystemMessage
  | UserMessage
  | AssistantMessage
  | ToolResultMessage
  | BashExecutionMessage
  | CustomMessage
  | BranchSummaryMessage
  | CompactionSummaryMessage;
```

在底层的 agent 包中，`AgentMessage` 是 `Message | CustomAgentMessages[keyof CustomAgentMessages]`。应用可以通过 TypeScript 声明合并增加角色，所以接收来自扩展宿主的消息时，应当容忍未知的自定义角色。
