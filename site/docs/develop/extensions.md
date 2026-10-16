# 编写扩展

扩展是给 nek 添加可执行行为的 TypeScript 模块。当一个工作流需要的不只是说明文字，而是工具、命令、事件处理、模型服务商、会话状态或终端界面时，就用扩展。

典型用途：添加一个模型可调用的工具、保护某些路径不被修改、在执行危险命令前确认、响应会话事件、改写上下文、提供一个 `/` 命令、在状态栏显示信息。

::: warning
扩展在 nek 进程内运行，权限与 nek 相同，能看到提示词、工具调用、文件、凭据和会话历史。只加载可信来源的扩展。
:::

## 第一个扩展 {#quick-start}

扩展默认导出一个工厂函数，接收 `ExtensionAPI`（约定命名为 `pi`），在里面注册能力。

创建 `~/.nek/agent/extensions/hello.ts`：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Show a greeting",
    handler: async (name, ctx) => {
      ctx.ui.notify(`Hello, ${name || "world"}!`, "info");
    },
  });
}
```

启动 nek，输入 `/hello 小明`。开发时也可以直接用命令行加载：

```bash
nek -e ./hello.ts
```

nek 用 jiti 加载扩展，本地 TypeScript 不需要编译。`@earendil-works/pi-coding-agent`、`@earendil-works/pi-ai`、`@earendil-works/pi-tui` 由 nek 提供，扩展可以直接 import。加载方式见 [加载扩展](/customize/loading-extensions)。

## 添加工具 {#tools}

工具需要名字、给模型看的描述、TypeBox 参数 schema 和 `execute()` 函数：

```typescript
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const helloTool = defineTool({
  name: "hello",
  label: "Hello",
  description: "A simple greeting tool",
  parameters: Type.Object({
    name: Type.String({ description: "Name to greet" }),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
    return {
      content: [{ type: "text", text: `Hello, ${params.name}!` }],
      details: { greeted: params.name },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(helloTool);
}
```

工具的约定：

- 结果必须有给模型看的 `content`，以及用于渲染或状态重建的 `details`（没有时写 `details: undefined`）。
- 抛出异常或返回 `isError: true` 表示失败。只在 `content` 里描述失败**不会**把结果标记为错误。
- 工具内部又调用了模型时，在结果里带上 `usage`，会话的用量统计才准确。
- 只有当这一批的所有工具都同意终止时，返回 `terminate: true` 才会跳过自动的后续请求。
- 可以声明 `outputSchema` 并返回 `structuredContent` 给程序使用，这部分不发给模型。
- 同一条助手回复里的多个工具调用可能**并行**执行。共享内存状态的工具请使用顺序执行；修改文件的工具用 `withFileMutationQueue()` 包住完整的读-改-写过程。
- 输出很大时截断，并告诉模型去哪里读完整内容。

### 崩溃后重跑

nek 崩溃时正在执行的工具调用，重开会话后会得到“已中断”的错误结果。如果同一个调用执行两次没有害处，声明 `replay: "safe"`，它会被重新执行。重跑安全的工具可以用 `ctx.getToolCallMemo(toolCallId)` 在两次执行之间保存值。见 [Durable 会话](/reference/durable-sessions)。

### 暴露方式

工具的 `exposure` 决定它如何进入模型的工具声明：

| 暴露方式 | 行为 |
|---|---|
| `direct`（默认） | 激活时声明，可调用 |
| `model-only` | 在 nek 中等同 `direct` |
| `deferred` | 注册但默认不激活，通过 `pi.setActiveTools()` 或 `tool_search` 加载后才声明 |
| `hidden` | 只为扩展内部状态注册，永不声明或激活 |

```typescript
pi.registerTool({
  name: "search_docs",
  label: "Search docs",
  description: "Search the project documentation",
  exposure: "deferred",
  parameters: Type.Object({ query: Type.String() }),
  execute: async (_toolCallId, { query }) => ({
    content: [{ type: "text", text: `Results for ${query}` }],
    details: undefined,
  }),
});
```

`direct` 和 `model-only` 的工具注册后即激活，除非设置 `defaultActive: false`。在 `--tools` 白名单里点名一个默认不激活的 direct 工具会启用它。

动态切换工具时，先注册所有工具，再用 `pi.setActiveTools()` 选择激活哪些。nek 在下一次请求前把工具变化追加到对话记录里；不支持中途变更的服务商会收到完整的检查点，可能使缓存失效。

## 拦截工具调用 {#tool-call}

`tool_call` 事件可以修改输入或阻止执行。下面的扩展在执行危险命令前要求确认：

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const dangerous = [/\brm\s+(-rf?|--recursive)/i, /\bsudo\b/i, /\b(chmod|chown)\b.*777/i];

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash") return undefined;
    const command = event.input.command as string;
    if (!dangerous.some((p) => p.test(command))) return undefined;

    if (!ctx.hasUI) {
      return { block: true, reason: "Dangerous command blocked (no UI for confirmation)" };
    }
    const choice = await ctx.ui.select(`Dangerous command:\n\n  ${command}\n\nAllow?`, ["Yes", "No"]);
    if (choice !== "Yes") return { block: true, reason: "Blocked by user" };
    return undefined;
  });
}
```

`tool_call` 处理函数本身出错时，工具会被阻止（失败即安全）。

## 选择集成点 {#api}

| 能力 | 主要 API |
|---|---|
| 观察或修改生命周期行为 | `pi.on(事件, 处理函数)` |
| 添加模型可调用的操作 | `pi.registerTool()` |
| 添加 `/` 命令 | `pi.registerCommand()` |
| 添加快捷键、命令行参数 | `pi.registerShortcut()`、`pi.registerFlag()` / `pi.getFlag()` |
| 发送用户消息或自定义消息 | `pi.sendUserMessage()`、`pi.sendMessage()` |
| 保存不进入上下文的会话数据 | `pi.appendEntry()` |
| 修改激活的工具、模型、思考等级 | `pi.setActiveTools()`、`pi.setModel()`、`pi.setThinkingLevel()` |
| 设置会话名 | `pi.setSessionName()` |
| 执行外部命令 | `pi.exec()` |
| 添加模型服务商 | `pi.registerProvider()` |
| 注册 MCP 服务器 | `pi.registerMcpServer()` |
| 自定义渲染 | `pi.registerMessageRenderer()`、`pi.registerEntryRenderer()`、`pi.registerMarkdownTransformer()`，以及 `ctx.ui` |
| 和其他扩展通信 | `pi.events` |

确切的事件、上下文、工具和结果类型见 [`extensions/types.ts`](https://github.com/deepdarkpaw/nekcode/blob/nek/packages/coding-agent/src/core/extensions/types.ts)。

## 事件 {#events}

`pi.on()` 返回一个取消订阅的函数。处理函数按扩展加载和注册的顺序执行。有的事件只是通知，有的可以改写数据、替换结果或取消操作；请按每个事件声明的返回类型使用。

| 类别 | 事件 |
|---|---|
| 资源与信任 | `resources_discover`、`project_trust` |
| 会话 | `session_start`、`session_shutdown`、`session_info_changed`、`session_before_switch`、`session_before_fork`、`session_before_tree`、`session_tree`、`session_before_compact`、`session_compact`、`session_compact_failed` |
| 运行 | `before_agent_start`、`agent_start`、`agent_end`、`agent_before_settle`、`agent_settled`、`turn_start`、`turn_end` |
| 消息 | `message_start`、`message_update`、`message_end` |
| 上下文 | `context`、`context_with_system` |
| 工具 | `tool_call`、`tool_result`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end` |
| 服务商 | `before_provider_request`、`before_provider_headers`、`after_provider_response`、`provider_stream_event`、`cache_warming_decision` |
| 输入 | `input`、`input_queued`、`user_bash` |
| 选择 | `model_select`、`thinking_level_select` |
| 界面 | `ui_prompt_start`、`ui_prompt_end` |
| MCP | `mcp_servers_change` |

几个常用事件的要点：

- **`before_agent_start`**：拿到当前提示词和结构化的 `systemPromptOptions`。优先修改提示词的分节、选择的工具或指引，让 nek 能以增量的方式记录变化。返回 `systemPrompt`（或设置 `forceSystemPrompt`）会替换整个提示词。
- **`message_end`**：可以替换一条已完成的消息（保持角色不变）。
- **`tool_result`**：多个处理函数依次组合，每个都能看到前面的修改。
- **`context`**：在发送前改写对话消息（不含提示词和工具的系统消息）。只有确实需要掌控完整对话时才用 `context_with_system`，并保持第 0 条是系统消息。
- **`turn_end`、`agent_before_settle`**：可以追加条目，并返回 `continue: true` 请求再进行一次模型请求。请加条件判断，无条件继续会造成循环。
- **`agent_settled`**：最终的通知，表示 nek 不会再自动继续，适合集成方判断“真正结束”。
- **`provider_stream_event`**：每个解析后的服务商流事件都会触发，只读。处理函数按流顺序 await，慢的处理会拖慢流的消费。
- **`user_bash`**：处理用户输入的 `!` 命令。返回 `undefined` 交给下一个处理函数；返回 `operations` 或 `result` 停止传递。
- **`cache_warming_decision`**：返回 `{ action: "warm" }` 或 `{ action: "stop" }` 覆盖空闲时的缓存预热决定。

## 生命周期 {#lifecycle}

- 工厂函数可以是同步或异步的。nek 会等异步工厂完成再继续启动，所以可以在里面获取配置或注册启动时需要的服务商。
- **不要**在工厂函数里启动进程、socket、文件监听或定时器：有些调用只加载扩展、并不启动会话。长期资源在 `session_start` 或需要它的命令/工具里启动。
- 在幂等的 `session_shutdown` 处理函数里释放会话级资源。取消、重新加载、切换会话和进程退出都可能走到同一条清理路径。
- `/reload` 会替换扩展运行时，`await ctx.reload()` 之后的代码不要再使用旧运行时的状态。
- 只有用户级扩展和命令行加载的扩展能参与 `project_trust` 事件（它在项目扩展加载之前运行）。
- 用 `ctx.shutdown()` 请求有序地退出进程。

## 上下文对象 {#context}

`ExtensionContext`（事件和工具里的 `ctx`）提供工作目录、运行模式、界面、会话管理器、模型运行时、中止信号、上下文用量，以及压缩和退出的控制。用 `ctx.modelRegistry.streamSimple()` 发起与服务商无关的嵌套模型调用。

命令处理函数拿到的是 `ExtensionCommandContext`，额外提供等待空闲、重新加载、会话树导航和替换会话的操作。这些操作只在命令里可用，因为在生命周期处理函数里调用可能造成死锁。替换会话后旧的 context 失效，切换前只保存纯数据，之后使用 `withSession` 提供的新 context。

## 状态 {#state}

按状态与对话的关系选择存储方式：

| 状态 | 存储 |
|---|---|
| 跟随活动分支的工具状态 | 工具结果的 `details` |
| 持久保存、但不进入模型上下文的数据 | `pi.appendEntry(customType, data)` |
| 保存并发送给模型的自定义内容 | `pi.sendMessage()` |
| 跨会话的数据 | 外部存储 |

在 `session_start` 里用 `ctx.sessionManager.getBranch()` 重建与分支相关的状态。不要遍历文件里的所有条目，被放弃的分支代表的是另一段历史。希望自定义内容显示在对话记录里时，注册条目或消息渲染器。

## 界面与运行模式 {#ui}

`ctx.ui` 提供对话框、通知、状态文字、小部件、标题、输入框访问和自定义组件：

```typescript
ctx.ui.notify("Saved", "info");                     // 通知
ctx.ui.setStatus("my-ext", "3 files watched");       // 状态栏文字，传 undefined 清除
ctx.ui.setWidget("my-ext", ["line 1", "line 2"]);    // 输入框上方的小部件
const ok = await ctx.ui.confirm("Clear?", "All messages will be lost.");
const pick = await ctx.ui.select("Choose", ["A", "B"]);
const text = await ctx.ui.input("Name", "type here");
```

扩展在交互、RPC、JSON、print 四种模式下都会加载：

- 交互模式提供完整的终端界面；
- RPC 模式能通过 [RPC 扩展 UI 协议](/reference/rpc-extension-ui) 转发支持的对话框和通知，但不支持自定义终端组件；
- JSON 和 print 模式没有界面。

用 `ctx.mode === "tui"` 保护仅终端可用的功能（例如 `ctx.ui.custom()`），用 `ctx.hasUI` 判断交互和 RPC 客户端都支持的交互。让工具和事件行为不依赖渲染，非交互模式才能正常工作。自定义组件见 [终端 UI 组件](/develop/tui)。

## MCP 服务器 {#mcp}

```typescript
pi.registerMcpServer("docs", {
  url: "https://example.com/mcp",
  description: "Product documentation",
});
```

配置格式与 `mcp.json` 的 `mcpServers` 条目相同，默认延迟加载。`pi.unregisterMcpServer(name)` 移除自己的注册，`pi.getMcpServers()` 查看所有注册及其所有者。扩展只能替换自己注册的服务器；文件中配置的同名服务器优先。见 [MCP 服务器](/guide/mcp)。

## 错误处理

nek 报告处理函数的错误并尽量继续运行。`tool_call` 处理函数出错会阻止该工具（失败即安全）；工具执行出错会变成给模型的错误结果。

## 示例

nek 源码的 `packages/coding-agent/examples/extensions/` 下有大量经过类型检查的示例，涵盖工具、生命周期事件、命令、参数、快捷键、状态、渲染、服务商、OAuth、远程执行和终端组件。从最接近你需求的小示例开始：

| 示例 | 演示 |
|---|---|
| `hello.ts` | 最小的工具 |
| `commands.ts` | 命令与参数补全 |
| `permission-gate.ts`、`confirm-destructive.ts`、`protected-paths.ts` | 拦截工具调用 |
| `todo.ts`、`dynamic-tools.ts`、`truncated-tool.ts` | 有状态的工具、动态激活、截断输出 |
| `status-line.ts`、`custom-footer.ts`、`widget-placement.ts` | 状态栏、页脚、小部件 |
| `input-transform.ts` | 改写用户输入 |
| `custom-compaction.ts` | 自定义压缩摘要 |
| `git-checkpoint.ts`、`auto-commit-on-exit.ts` | 与 git 配合 |
| `project-trust.ts` | 处理项目信任 |
| `custom-provider-anthropic/`、`custom-provider-gitlab-duo/` | 服务商扩展 |
| `sandbox/`、`gondolin/` | 把工具路由到隔离环境 |

相关页面：[自定义服务商](/develop/custom-provider)、[终端 UI 组件](/develop/tui)、[加载扩展](/customize/loading-extensions)。
