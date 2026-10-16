# 服务商认证

大多数托管服务商支持以下一种或两种认证方式：

- 通过浏览器或设备码完成 OAuth 登录（常用于订阅）；
- 提供 API key。

用 `/login [服务商]` 查看某个服务商支持的方式。Amazon Bedrock 和 Google Vertex AI 还可以使用云平台的默认凭据。

## 交互式登录 {#interactive}

运行 `/login` 并选择服务商，nek 会引导你完成 OAuth 或 API key 流程，凭据保存在 `~/.nek/agent/auth.json`。

支持 OAuth 订阅登录的服务商包括 Anthropic（Claude Pro/Max）、OpenAI Codex（ChatGPT）、GitHub Copilot、xAI、Kimi For Coding、OpenRouter、Meta、Radius 等，以 `/login` 中显示的为准。

在远程或无图形界面的机器上，OAuth 回调可能到不了本机进程。出现提示时，把浏览器最终跳转的地址或授权码粘贴回 nek。

`/logout` 删除某个服务商的已保存凭据。它不会清除环境变量、不会删除 `models.json` 中的认证，也不会在服务商处吊销凭据。

`auth.json` 包含 API key 和 OAuth token，请保持私密，不要提交到仓库。

Radius 认证使用其网关的模型目录，并缓存刷新后的模型元数据供离线启动使用。在 `models.json` 中配置的自定义 Radius 网关使用它自己的目录。

## 用环境变量提供 API key {#env}

在 CI 或不希望 nek 保存 key 的环境中，启动前设置变量：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
nek
```

```powershell
$env:ANTHROPIC_API_KEY = 'sk-ant-...'
nek
```

只需要一个主变量的服务商：

| 服务商 | 环境变量 |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| Ant Ling | `ANT_LING_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| NVIDIA NIM | `NVIDIA_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| GitHub Copilot | `COPILOT_GITHUB_TOKEN` |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| xAI | `XAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Vercel AI Gateway | `AI_GATEWAY_API_KEY` |
| ZAI Coding Plan（国际） | `ZAI_API_KEY` |
| ZAI Coding Plan（中国） | `ZAI_CODING_CN_API_KEY` |
| OpenCode Zen 和 Go | `OPENCODE_API_KEY` |
| Radius | `RADIUS_API_KEY` |
| Hugging Face | `HF_TOKEN` |
| Fireworks | `FIREWORKS_API_KEY` |
| Together AI | `TOGETHER_API_KEY` |
| Baseten | `BASETEN_API_KEY` |
| Kimi For Coding | `KIMI_API_KEY` |
| Meta | `META_API_KEY` |
| MiniMax | `MINIMAX_API_KEY` |
| MiniMax（中国） | `MINIMAX_CN_API_KEY` |
| Moonshot AI（国际和中国） | `MOONSHOT_API_KEY` |
| Qwen Token Plan 和个人版 | `QWEN_TOKEN_PLAN_API_KEY` |
| Qwen Token Plan（中国） | `QWEN_TOKEN_PLAN_CN_API_KEY` |
| 小米 MiMo | `XIAOMI_API_KEY` |
| 小米 MiMo Token Plan（中国） | `XIAOMI_TOKEN_PLAN_CN_API_KEY` |
| 小米 MiMo Token Plan（阿姆斯特丹） | `XIAOMI_TOKEN_PLAN_AMS_API_KEY` |
| 小米 MiMo Token Plan（新加坡） | `XIAOMI_TOKEN_PLAN_SGP_API_KEY` |

Anthropic 还识别 `ANTHROPIC_OAUTH_TOKEN`（作为 API 凭据）和 `ANTHROPIC_AUTH_TOKEN`（作为 bearer 认证）。

`nek --help` 末尾列出了你所安装版本识别的全部环境变量。

## 从命令读取 API key {#command}

想用密码管理器、又不想把 key 写到磁盘时，在 `auth.json` 中把服务商的 `key` 设为以 `!` 开头的命令：

```json
{
  "anthropic": {
    "type": "api_key",
    "key": "!security find-generic-password -ws 'anthropic'"
  }
}
```

nek 在第一次需要 key 时执行命令，并在进程生命周期内缓存它的标准输出。输出为空、超时或非零退出时，key 保持未解析，直到 nek 重启。

`models.json` 中的 `apiKey` 也支持 `!命令` 写法，但那里的命令在每次请求时执行、不缓存，见 [选择模型](/guide/models#compatible-endpoint)。

## 云服务商 {#cloud}

以下服务商需要额外的设置，或者可以使用云平台提供的凭据。

保存的 API key 凭据可以带一个 `env` 对象，其中的值对该服务商优先于进程环境变量：

```json
{
  "cloudflare-workers-ai": {
    "type": "api_key",
    "key": "...",
    "env": {
      "CLOUDFLARE_ACCOUNT_ID": "account-id"
    }
  }
}
```

### Azure OpenAI

设置 API key，以及 base URL 或资源名之一：

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://your-resource.ai.azure.com
# 或者：
export AZURE_OPENAI_RESOURCE_NAME=your-resource
```

`ai.azure.com`、`cognitiveservices.azure.com`、`openai.azure.com` 下的资源根地址会被规范化为 OpenAI API 路径。其他可选变量：`AZURE_OPENAI_API_VERSION`（默认 `v1`）、`AZURE_OPENAI_DEPLOYMENT_NAME_MAP`（逗号分隔的 `模型=部署名` 映射）。

### Amazon Bedrock

可以使用 bearer token 或 AWS 的默认凭据来源：

```bash
# 命名的 profile
export AWS_PROFILE=your-profile

# IAM key
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
# 临时凭据还需要
export AWS_SESSION_TOKEN=...

# Bedrock bearer token
export AWS_BEARER_TOKEN_BEDROCK=...

# 区域（profile 或 AWS SDK 配置未提供时）
export AWS_REGION=us-west-2
# 也支持 AWS_DEFAULT_REGION
```

也支持通过标准的 `AWS_CONTAINER_CREDENTIALS_*` 和 `AWS_WEB_IDENTITY_TOKEN_FILE` 变量使用 ECS 任务凭据和 IRSA。

### Cloudflare AI Gateway

需要 token、账户 ID 和网关 ID：

```bash
export CLOUDFLARE_API_KEY=...
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_GATEWAY_ID=...
```

账户 ID 和网关 ID 可以来自进程环境，也可以放在 `auth.json` 凭据的 `env` 对象里。`CLOUDFLARE_API_KEY` 用于向网关认证；上游访问可以使用 Cloudflare 统一计费、网关中保存的凭据，或在 `models.json` 中为该服务商配置的 `Authorization` 请求头。

### Cloudflare Workers AI

需要 token 和账户 ID：

```bash
export CLOUDFLARE_API_KEY=...
export CLOUDFLARE_ACCOUNT_ID=...
```

账户 ID 也可以放在凭据的 `env` 对象中。

### Google Vertex AI

使用 Google Cloud API key：

```bash
export GOOGLE_CLOUD_API_KEY=...
```

或使用 Application Default Credentials，配置项目和区域：

```bash
export GOOGLE_CLOUD_PROJECT=your-project
# 也支持 GCLOUD_PROJECT
export GOOGLE_CLOUD_LOCATION=us-central1
```

然后认证：

```bash
gcloud auth application-default login
```

使用服务账号 key 文件时，设置 `GOOGLE_APPLICATION_CREDENTIALS` 以及项目和区域。

## 检查凭据

```bash
nek auth check --provider anthropic          # ready / not_ready / invalid
nek auth check --provider openai --json
```

见 [命令行](/reference/cli#auth)。
