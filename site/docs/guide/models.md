# 选择模型

nek 通过**服务商（provider）**访问**模型（model）**。内置的服务商直接用 `/login` 登录，再用 `/model` 选择模型即可；只有在 nek 不内置你要的服务商或接口时，才需要写 `models.json`。

## 选择连接方式

| 你手上有什么 | 推荐做法 |
|---|---|
| 支持的订阅（Claude Pro/Max、ChatGPT、GitHub Copilot 等） | `/login` 选择服务商，浏览器登录 |
| 某个服务商的 API key | `/login` 保存，或设置对应的环境变量 |
| 本地 GGUF 模型 | 连接 llama.cpp 路由服务，见 [本地模型](/guide/local-models) |
| OpenAI / Anthropic / Google 兼容的接口（中转、Ollama、vLLM、LM Studio 等） | 写进 `models.json`，见 [配置兼容接口](#compatible-endpoint) |
| 需要自定义协议或登录流程的服务 | 编写服务商扩展，见 [自定义服务商](/develop/custom-provider) |

nek 自带一份模型目录（服务商、模型 ID、能力、上下文长度、价格），可以在 [pi.dev/models](https://pi.dev/models) 浏览。联网启动时最多每 4 小时刷新一次；离线或设置了 `NEK_OFFLINE=1` 时使用缓存的数据。

## 登录 {#login}

在 nek 里输入 `/login`，选择服务商，按提示完成 OAuth 登录或粘贴 API key。凭据保存在 `~/.nek/agent/auth.json`。

- `/login <服务商>` 直接进入某个服务商的登录流程。
- `/logout` 删除某个服务商的已保存凭据。它不会清除环境变量、不会删除 `models.json` 里的 key，也不会在服务商那边吊销凭据。
- 在远程或无图形界面的机器上，OAuth 回调可能到不了本机进程。出现提示时，把浏览器最终跳转到的地址或授权码粘贴回 nek。

::: warning 保护好 auth.json
`auth.json` 里有 API key 和 OAuth token，不要提交到仓库，也不要发给别人。
:::

### 用环境变量提供 key

在 CI 或不想把 key 写到磁盘的环境里，启动前设置服务商对应的环境变量：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
nek
```

完整的变量列表、云服务商（Azure、Bedrock、Vertex、Cloudflare）的配置，以及“从命令读取 key”的写法，见 [服务商认证](/reference/providers)。

### 凭据的优先级

同一个服务商配置了多种凭据时，nek 按以下顺序使用：

1. 命令行 `--api-key`（只对本次运行有效）；
2. `auth.json` 里保存的凭据；
3. `models.json` 里该服务商的 `apiKey`；
4. 服务商的环境变量或云平台的默认凭据。

服务商扩展可以定义自己的认证方式。

## 选择模型 {#select}

| 操作 | 方式 |
|---|---|
| 搜索并切换模型 | `/model` 或 `Ctrl+L`。只列出凭据可用的服务商的模型 |
| 把选中的模型设为新会话默认 | 在模型选择器里按 `Ctrl+S` |
| 直接指定 | `/model anthropic/claude-sonnet-4-5` |
| 在一组模型之间循环 | `Ctrl+P` 下一个，`Shift+Ctrl+P` 上一个（Windows/WSL 为 `Alt+P`） |
| 限定循环范围 | `/scoped-models`，或设置 `enabledModels`，或启动参数 `--models` |

启动时也可以指定模型：

```bash
nek --model sonnet                     # 模糊匹配
nek --model openai/gpt-4o              # 服务商/模型 ID
nek --model sonnet:high                # 带思考等级
nek --models "sonnet:high,haiku:low"   # 设定循环范围
nek --list-models gpt                  # 列出可用模型并退出
```

会话会记录模型和思考等级的变化。续接会话时恢复会话里的设置，不影响新会话的默认值。

## 思考等级 {#thinking}

支持推理的模型可以设置思考等级：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。nek 只显示当前模型支持的等级。

- `/thinking` 打开选择器，按 `Ctrl+S` 保存为启动时的等级；
- `Shift+Tab` 循环切换；
- 启动参数 `--thinking high`，或在 `--model` 后加 `:high`；
- 设置 `defaultThinkingLevel`（默认 `medium`），或用 `modelThinkingLevels` 为每个模型单独设置。

输入框边框颜色表示当前思考等级。`Ctrl+T` 显示或隐藏对话里的思考内容。

## 配置兼容接口 {#compatible-endpoint}

接口使用的是 nek 已支持的 API 协议时，在 `~/.nek/agent/models.json` 里添加即可。大多数 Ollama、LM Studio、vLLM、SGLang 和各类中转都属于这种情况。

### 最小示例：Ollama

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

Ollama 不检查 key，这里的 `apiKey` 只是让 nek 认为这个服务商“有凭据可用”。

### 完整示例：OpenAI 兼容的中转

```json
{
  "providers": {
    "my-proxy": {
      "name": "My Proxy",
      "baseUrl": "https://proxy.example.com/v1",
      "api": "openai-completions",
      "apiKey": "${MY_PROXY_KEY}",
      "models": [
        {
          "id": "deepseek-v4-flash",
          "name": "DeepSeek V4 Flash",
          "reasoning": true,
          "input": ["text", "image"],
          "contextWindow": 500000,
          "maxTokens": 32000,
          "cost": { "input": 0.3, "output": 1.2, "cacheRead": 0.03, "cacheWrite": 0 }
        },
        {
          "id": "claude-sonnet-5",
          "api": "anthropic-messages",
          "baseUrl": "https://proxy.example.com",
          "reasoning": true,
          "contextWindow": 200000,
          "maxTokens": 64000
        }
      ]
    }
  }
}
```

保存后打开 `/model`（会重新读取文件），就能看到 `my-proxy/deepseek-v4-flash` 等模型。

### 服务商字段

| 字段 | 说明 |
|---|---|
| `name` | 显示名称 |
| `baseUrl` | 接口地址 |
| `api` | 协议，例如 `openai-completions`、`openai-responses`、`anthropic-messages`、`google-generative-ai` |
| `apiKey` | key。支持字面值、`$NAME` 或 `${NAME}` 环境变量，以及以 `!` 开头的命令（每次请求时执行，不缓存） |
| `headers` | 额外的请求头，值的写法同 `apiKey` |
| `authHeader` | 为 `true` 时以 `Authorization: Bearer` 发送 key |
| `compat` | 协议兼容开关，只在确认接口行为确实不同时使用 |
| `models` | 模型列表。与内置模型 ID 相同时替换该模型 |
| `modelOverrides` | 只修改已有模型（内置或扩展提供）的元数据，不替换模型列表 |

在字符串里写字面的 `$` 用 `$$`，写以 `!` 开头的字面值用 `$!`。

### 模型字段

| 字段 | 说明 |
|---|---|
| `id` | 必填。请求时发送的模型 ID |
| `name` | 显示名称 |
| `api`、`baseUrl`、`headers` | 覆盖服务商级别的设置 |
| `reasoning` | 是否支持推理（思考等级） |
| `thinkingLevelMap` | 把 nek 的思考等级映射到接口接受的值；值为 `null` 表示不支持该等级 |
| `input` | `["text"]` 或 `["text", "image"]` |
| `contextWindow`、`maxTokens` | 上下文长度和最大输出 token，影响压缩时机 |
| `cost` | 每百万 token 的价格（美元）：`input`、`output`、`cacheRead`、`cacheWrite`，可选分档 `tiers` |
| `promptCache` | 提示词缓存的有效期（秒），见下文 |
| `inputLimits` | 图片缩放和请求大小限制，见下文 |
| `samplingParams` | 固定的采样参数，例如 `{ "temperature": 0.8 }` |
| `samplingParamsByThinkingLevel` | 按思考等级设置采样参数 |
| `compat` | 该模型的协议兼容开关 |

### 思考等级映射示例

有的接口只接受部分推理强度。下面的配置让 nek 只提供 `off`、`low`、`high`、`max` 四档，并把它们映射到接口的值：

```json
{
  "id": "deepseek-v4.1-flash",
  "reasoning": true,
  "thinkingLevelMap": {
    "off": null,
    "minimal": null,
    "low": "low",
    "medium": null,
    "high": "high",
    "xhigh": null,
    "max": "max"
  }
}
```

### 修改内置模型：modelOverrides

只想改内置模型的上下文长度、价格或请求头时，用 `modelOverrides`，不要重新定义整个模型列表：

```json
{
  "providers": {
    "anthropic": {
      "modelOverrides": {
        "claude-sonnet-4-5": { "contextWindow": 1000000 }
      }
    }
  }
}
```

不存在的模型 ID 会被忽略。

### 图片输入限制

`inputLimits.images.resize` 控制新的图片附件、`read` 读到的图片和工具结果里的图片在存入对话前如何编码：

```json
{
  "id": "vision-model",
  "input": ["text", "image"],
  "inputLimits": {
    "images": {
      "resize": { "maxWidth": 1568, "maxHeight": 1568, "maxBytes": 524288, "jpegQuality": 75 }
    }
  }
}
```

`maxBytes` 限制 base64 编码后的大小。省略的字段使用保守的默认值：2000×2000 像素、4.5 MiB、JPEG 质量 80。图片只编码一次，换模型不会重写历史里的图片。

### 提示词缓存有效期 {#prompt-cache}

`promptCache` 声明服务商缓存的有效期（秒），分 `short` 和 `long` 两档：

```json
{ "id": "claude-sonnet-5", "promptCache": { "short": 300, "long": 3600 } }
```

如果官方给的是一个范围，取保守的一端。没有声明当前档位有效期的模型不会做缓存预热，见设置 [`cacheWarming`](/reference/settings#model)。

### 按思考等级设置采样参数

```json
{
  "id": "custom-reasoning-model",
  "samplingParams": { "temperature": 0.8 },
  "samplingParamsByThinkingLevel": {
    "off": { "temperature": 0.4 },
    "high": { "temperature": null, "topP": 0.95 }
  }
}
```

值为 `null` 表示不发送该参数。

::: tip 兼容开关要谨慎
`compat` 用来描述**已经确认**的接口差异（例如不支持 `developer` 角色、用 `max_tokens` 而不是 `max_completion_tokens`）。不要仅仅因为某个接口自称“兼容 OpenAI”就打开这些开关。
:::

## 本地模型

nek 直接支持 llama.cpp 的路由服务，用 `/login llama.cpp` 配置地址，再用 `/model` 选择已加载的模型。见 [本地模型（llama.cpp）](/guide/local-models)。Ollama、LM Studio 等其他本地服务按上面的 [兼容接口](#compatible-endpoint) 配置。

## 压缩用的模型

上下文压缩默认用当前模型写摘要。可以单独指定一个便宜或上下文更长的模型，见 [上下文压缩](/reference/compaction#compaction-model)。

## 常见问题

### `/model` 里看不到某个模型

确认它的服务商有可用的凭据。`models.json` 里的模型只有在 nek 能解析到凭据时才会出现在 `/model` 里。llama.cpp 只显示路由服务当前已加载的模型。

### 在一个终端里能用，换个终端就不行

key 可能来自环境变量而不是 `auth.json`。环境变量必须存在于启动 nek 的那个进程里。

### 在远程机器上登录会打开浏览器

使用服务商的无头登录流程。部分服务商允许你把最终跳转的地址或授权码粘贴回 nek，见 [服务商认证](/reference/providers#interactive)。

### 兼容接口拒绝请求

检查 `models.json` 里的 `api` 类型和 `compat` 设置。上游服务必须支持对应协议的请求字段和行为。用 `/debug` 或扩展的 `provider_stream_event` 可以查看原始响应。
