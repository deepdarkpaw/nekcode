# 自定义服务商

服务商扩展把 nek 连接到需要自定义认证、模型发现、请求处理或流式协议的模型服务。如果服务已经使用 nek 支持的 API 协议，直接写 [`models.json`](/guide/models#compatible-endpoint) 更简单。

服务商扩展在 nek 内运行，能看到凭据、提示词、工具定义、模型回复和用量。请当作可信代码对待，不要把密钥或服务商的原始数据写进日志。

## 选择最小的集成方式

| 需求 | 用 |
|---|---|
| 在已支持的协议后面加几个模型 | `models.json` |
| 修改已有服务商的地址或请求头 | `models.json` 或一个小的服务商扩展 |
| 动态发现模型 | 带 `refreshModels` 的服务商 |
| 增加 `/login` 登录流程 | 带 OAuth 配置的服务商 |
| 实现一种不支持的传输协议 | 带 `stream` 或 `streamSimple` 的服务商 |

服务商扩展就是一个 [扩展](/develop/extensions)，加载、信任、重新加载和错误处理规则都相同。

## 注册服务商

在扩展工厂里调用 `pi.registerProvider()`。nek 会等异步工厂完成再继续启动，所以这里注册的服务商在启动时选择模型和 `nek --list-models` 中都可用。

两种注册形式：

- 注册一个来自 `@earendil-works/pi-ai` 的完整 `Provider`：拥有原生的认证、过滤、发现、刷新和流式行为。新的集成如果不只是静态的地址和模型元数据，推荐用这种形式。
- 用服务商名加 `ProviderConfig` 注册：旧的配置形式，现有扩展使用。

nek 会把 `models.json` 的覆盖叠加在注册的原生服务商之上。

只为已有服务商注册 `baseUrl` 或 `headers` 时，保留它的内置模型。旧形式里提供 `models` 会替换该服务商在对话、图片、分类器各类操作中的模型。省略 `type` 表示 `"chat"`；图片和分类器模型需要显式的类型，并通过 `images`、`classifiers` 字段按 `api` 值提供实现：

```typescript
pi.registerProvider("media-tools", {
  apiKey: "$MEDIA_TOOLS_API_KEY",
  models: [
    {
      type: "image",
      id: "image-v1",
      name: "Image V1",
      api: "media-images",
      baseUrl: "https://media.example.com/v1",
      input: ["text"],
      output: ["image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ],
  images: {
    "media-images": { generateImages: async (model, context, options) => result },
  },
});
```

模型级的 `baseUrl` 优先于服务商的地址。初始加载之后的调用立即生效。`pi.unregisterProvider()` 移除动态服务商，恢复被它替换的内置行为。

完整的示例见源码中的 `examples/extensions/custom-provider-gitlab-duo/`，它把流式处理委托给内置的 API 实现。

## 认证

静态服务商的 API key 可以是字面值、环境变量或命令，写法与 `models.json` 相同：

- `$NAME`、`${NAME}` 读取环境变量；
- 以 `!` 开头时使用命令的输出；
- `$$` 表示字面的 `$`，`$!` 表示字面的开头 `!`。

需要保存凭据、自定义解析、服务商作用域的环境变量或多种登录方式时，使用原生服务商认证。

OAuth 服务商提供显示名、登录流程、token 刷新和 access token 解析。注册后它出现在 `/login` 里，返回的凭据保存在 `~/.nek/agent/auth.json`。OAuth 回调与界面无关：可以打开授权链接、显示设备码、报告进度、请求输入或让用户选择登录方式。请响应取消，并把中止信号传给网络请求。

不要把 access token、refresh token、Authorization 头或完整的服务商响应写进普通日志。

## 模型与刷新

每个模型都需要 ID、显示名、输入能力和价格元数据。对话和分类器模型还需要上下文窗口；对话模型需要输出上限和是否支持推理；图片模型要声明输出模态。API 实现一般在服务商级别选择，只有个别模型需要覆盖。

需要 nek 保持空闲时的提示词缓存预热时，设置 `promptCache.short` / `promptCache.long` 为服务商缓存的有效期（秒）。

模型列表来自在线服务时使用 `refreshModels`，把 `context.signal` 传给阻塞的 I/O 以便取消：

- 完整的 `Provider` 不返回值，而是调用 `context.publish({ update })` 安装服务商自己的模型状态，之后同步的 `getModels()` 返回最新列表；
- 旧形式的 `ProviderConfig.refreshModels` 返回模型定义列表，nek 用它替换该注册的在线模型。

只有需要跨运行保留的目录数据才持久化。llama.cpp 这样的在线服务只更新内存中的列表；远程目录可以保存快照供离线启动使用。

## 复用已支持的流式 API

协议匹配时，使用 nek AI 库中已有的 API 实现：Anthropic Messages、OpenAI Chat Completions 和 Responses、Google Generative AI 和 Vertex、Azure OpenAI Responses、Mistral Conversations、Bedrock Converse。

服务商仍然可以自定义认证、地址、请求头、模型过滤和发现，只把请求转换和流式处理交给现有实现。这比复制一份流实现更安全，因为保留了 nek 的消息转换、工具处理、用量统计、取消和兼容行为。

## 实现自定义流

只有在没有任何现有实现能表示该服务时才实现 `streamSimple`。先研究 [`packages/ai/src/api`](https://github.com/deepdarkpaw/nekcode/tree/nek/packages/ai/src/api) 下的实现。

流收到的是规范化的 `TranscriptContext`。系统提示词和工具声明在对话的系统消息里，用 `getCurrentSystemPrompt(context.messages)` 和 `getCurrentTools(context.messages)` 读取。支持对话中途系统消息的模型可以原样接收；否则调用 `collapseSystemMessages(context)` 把后来的系统消息折叠进开头的那条。

自定义流必须：

1. 创建一条助手消息，包含服务商、模型、时间戳、pending 状态的停止原因、内容和清零的用量；
2. 请求建立成功后，在内容事件之前发出一次 `start` 事件；
3. 更新消息的同时发出成对的文本、思考和工具调用事件；
4. 最终确定用量、费用、内容和停止原因；
5. 发出且只发出一个终止事件 `done` 或 `error`，然后关闭流；
6. 把取消转换为 aborted 结果。

请求建立阶段就失败时，可以直接以 `error` 结束。缺少认证时也可以在返回流之前同步抛出。

还必须遵守 `SimpleStreamOptions` 中的请求观测钩子：

- 发送请求前调用 `options.onPayload`，并使用它返回的替换 payload；
- 收到响应、读取响应体之前调用 `options.onResponse`；
- 规范化每个解析出的服务商事件之前 `await options.onProviderStreamEvent?.(providerEvent, model)`；
- 传递中止信号和服务商作用域的环境变量。

这些钩子支撑着扩展的请求检查、响应头事件和流观测，省略它们会让服务商的行为与内置服务商不一致。

## 失败与用量

设置具体的终止原因。错误和中止的消息需要 `errorMessage`；成功的消息需要准确的输入、输出、缓存、总 token 和费用。

nek 能在识别出的上下文溢出错误后压缩并重试。如果服务返回的是未知格式的溢出错误，只在一个受条件保护的 `message_end` 处理函数里把该服务商的溢出响应规范化为 `context_length_exceeded`。不要把限流或临时错误改写成上下文溢出，它们走正常的重试逻辑。

## 测试

至少测试：普通和空的文本回复、工具调用和结果、图片输入和图片工具结果（如支持）、用量和费用、中止、上下文溢出、格式错误或不完整的流、Unicode 边界、跨服务商的会话交接、认证刷新与取消。

[`packages/ai/test`](https://github.com/deepdarkpaw/nekcode/tree/nek/packages/ai/test) 下的服务商测试定义了内置服务商应有的行为，请改编相关的测试套件，而不是只靠手工提问验证。
