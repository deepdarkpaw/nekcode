# TypeScript SDK

`@earendil-works/pi-coding-agent` 可以把 nek 的代理嵌入 Node.js 或 Bun 进程，直接用 TypeScript 访问命令行程序使用的代理、会话、工具、模型和资源。

需要跨语言或进程隔离时，用 [RPC 模式](/develop/cli-integration#rpc)。

::: info 包名与安装
nek 的 SDK 就是仓库里的 `packages/coding-agent`。npm 上同名的包是上游 pi 的版本，不包含 nek 的 Plan、子代理等内置扩展。需要 nek 的完整行为时，请在 nek 源码仓库内（或以本地路径依赖）使用它。
:::

## 最小示例

```typescript
import { createAgentSession } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession();

try {
  await session.prompt("What files are in the current directory?");
  console.log(session.getLastAssistantText());
} finally {
  session.dispose();
}
```

这会使用当前工作目录、自动发现的资源、保存的设置和配置好的凭据。`prompt()` 在运行结束时返回。

## 会话生命周期 {#session}

`createAgentSession()` 创建一个 `AgentSession`。会话拥有一段对话、它的模型和工具、排队的消息、压缩状态和扩展运行时。

读取当前状态：`session.messages`、`session.model`、`session.thinkingLevel`、`session.systemPrompt`、`session.getActiveToolNames()`。`session.systemPrompt` 只读，返回当前生效的系统提示词（包括尚未发给模型的变化）。

### 会话存储

会话默认持久化。`SessionManager` 管理持久化或内存中的条目树，并跟踪活动叶节点。分支只改变叶节点，不删除被放弃的分支。重建模型上下文时，管理器选择活动分支并应用压缩。

`SessionManager` 是最终模型上下文的权威来源。要恢复外部的历史，用包含这些条目的管理器构造会话；给 `session.agent.state.messages` 赋值**不会**替换持久化的上下文。

持久化的会话是由 durable 引擎写入的 SQLite 数据库：打开一个最后一轮因崩溃中断的会话，会接着跑完那一轮。`session.agent` 为兼容而保留会话状态，它自己的循环不再运行，`agent.subscribe()` 的监听器会收到该轮的循环事件。见 [Durable 会话](/reference/durable-sessions)。

不需要会话文件时用内存管理器：

```typescript
import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";

const { session } = await createAgentSession({
  sessionManager: SessionManager.inMemory(),
});
```

- `cwd` 决定项目资源发现、指令文件、会话分组和内置工具路径所用的工作目录。目标与 `process.cwd()` 不同时显式传入。
- `session.dispose()` 中止进行中的工作、使扩展上下文失效、断开代理并移除事件监听器。不再需要会话时调用它。
- `AgentSessionRuntime` 提供 `newSession()`、`switchSession()`、`fork()`、`importFromJsonl()`。每个操作都会替换活动的 `AgentSession` 并为目标工作目录重建服务。替换之后，订阅属于旧会话，需要重新绑定。

## 发送提示词

`prompt()` 先处理扩展命令、展开基于文件的提示词模板，再把普通用户消息交给代理。被接受的运行结束（包括自动重试）后才返回。

会话正在流式输出时发送的提示词，必须说明是插话还是追加，否则 `prompt()` 会拒绝而不是猜测：

- `steer()`：插话，在当前助手轮及其工具调用之后送达；
- `followUp()`：追加，在当前运行完成所有待办工作之后送达。

两者返回 `"queued"`（已排队，包括被扩展改写后排队）或 `"handled"`（被扩展消费）。

`abort()` 中止当前操作并等待会话空闲；`waitForIdle()` 只等待、不中止。

## 订阅事件

需要流式输出时，在发送提示词之前订阅：

```typescript
const unsubscribe = session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

try {
  await session.prompt("Explain this repository");
} finally {
  unsubscribe();
}
```

- 会话事件报告消息更新、工具执行、队列、压缩、重试和运行生命周期；
- `message_end` 包含权威的完整消息；
- `agent_end` 表示一次底层运行结束，之后可能还有自动恢复或排队的工作；
- `agent_settled` 表示 nek 不会再自动继续。

事件格式见 [JSON 事件流](/reference/json)（SDK 中的 `message_update` 额外带有累积快照）。

## 配置会话

不传参数时，工厂会创建 `ModelRuntime`、基于文件的 `SettingsManager`、持久化的 `SessionManager`、`DefaultResourceLoader` 和配置的默认工具。每一项都可以显式提供：

| 选项 | 作用 |
|---|---|
| `modelRuntime`、`model`、`thinkingLevel`、`scopedModels` | 模型访问与选择 |
| `settingsManager` | 合并后的设置或内存中的配置 |
| `sessionManager` | 持久化或内存中的对话历史 |
| `resourceLoader` | 扩展、Skills、提示词模板、主题和指令文件 |
| `tools`、`noTools`、`excludeTools`、`customTools` | 激活的工具集 |
| `cwd`、`agentDir` | 工作目录和用户数据目录 |

想要标准发现加少量覆盖时用 `DefaultResourceLoader`；宿主完全掌控资源存储和发现时提供自定义的 `ResourceLoader`。内联扩展工厂可以通过 `DefaultResourceLoader` 提供；只有需要在诊断和启动输出中显示稳定名称时才给它一个 `InlineExtension` 名字。

::: tip MCP 需要显式加载
SDK 嵌入时，如果需要 MCP，资源加载器里必须包含 MCP 和 tool-search 扩展并绑定会话扩展；只注册服务器不会建立连接。
:::

## 示例

源码 `packages/coding-agent/examples/sdk/` 下的示例都随仓库做类型检查：

| 示例 | 内容 |
|---|---|
| `01-minimal.ts` | 创建、提问、观察、销毁会话 |
| `02-custom-model.ts` | 选择模型和思考等级 |
| `03-custom-prompt.ts` | 替换或追加系统提示词 |
| `04-skills.ts` | 发现、过滤、添加 Skills |
| `05-tools.ts` | 选择内置工具及其工作目录 |
| `06-extensions.ts` | 加载文件扩展和内联扩展 |
| `07-context-files.ts` | 添加或替换项目指令 |
| `08-prompt-templates.ts` | 添加文件式提示词模板 |
| `09-api-keys-and-oauth.ts` | 配置凭据和模型存储 |
| `10-settings.ts` | 文件或内存设置 |
| `11-sessions.ts` | 控制会话持久化与恢复 |
| `12-full-control.ts` | 替换默认的发现和状态服务 |
| `13-session-runtime.ts` | 安全地替换活动会话 |

精确的方法和签名以导出的 TypeScript 声明为准。
