# settings.json

这一页列出所有用户可配置的设置、类型、默认值和作用。

- 用户级：`~/.nek/agent/settings.json`
- 项目级：`.nek/settings.json`（信任项目后加载）

项目设置覆盖用户设置；对象类型的设置递归合并；资源列表合并。大多数常用设置也可以在 `/settings` 里修改。手动编辑文件后运行 `/reload`。

nek 独有功能（Plan、Todo、子代理）的配置不在这里，而在 [nek.yaml](/reference/nek-yaml)。

## 默认配置

默认不需要创建这个文件；文件不存在或内容为以下空对象时，使用本页列出的内置默认值：

```json
{}
```

公共版本不附带个人 settings、固定服务商、代理地址或独立的压缩模型设置。登录后用 `/model` 选择自己的模型；只需把想覆盖的设置写入本机文件，例如：

```json
{
  "tuiMode": "regular"
}
```

上面的普通终端模式只是可选示例，实际默认值仍是 `"fullscreen"`。

## 模型与思考 {#model}

| 设置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `defaultProvider` | string | 自动 | 启动时的服务商 |
| `defaultModel` | string | 自动 | 启动时的模型 ID |
| `defaultThinkingLevel` | `"off"` \| `"minimal"` \| `"low"` \| `"medium"` \| `"high"` \| `"xhigh"` \| `"max"` | `"medium"` | 启动时的思考等级 |
| `modelThinkingLevels` | object | 无 | 按模型设置启动思考等级，键为精确的 `服务商/模型ID` |
| `thinkingBudgets` | object | 内置值 | `minimal`、`low`、`medium`、`high` 各等级的 token 预算 |
| `enabledModels` | `string[]` | 全部可用模型 | 启动选择和 `Ctrl+P` 循环使用的模型模式，格式同 `--models` |
| `hideThinkingBlock` | boolean | `false` | 在对话中隐藏思考内容 |
| `showCacheMissNotices` | boolean | `false` | 显示明显的缓存未命中、缓存预热成功、压缩用量、服务商恢复等提示 |
| `cacheWarming` | `"off"` \| `"streaming"` \| `"idle"` | `"streaming"` | 在运行期间（`streaming`）或运行之间（`idle`）保持服务商的提示词缓存不过期。**只能在用户级设置** |

缓存预热只在模型声明了缓存有效期（见 [提示词缓存有效期](/guide/models#prompt-cache)），且 nek 估计能避免至少 0.05 美元的缓存未命中费用时才进行。预热产生的用量计入会话总量，但不进入模型上下文。`/session` 会显示下一次的预热决定。

## 交互 {#interaction}

| 设置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `steeringMode` | `"all"` \| `"one-at-a-time"` | `"one-at-a-time"` | 排队的插话消息如何送达 |
| `followUpMode` | `"all"` \| `"one-at-a-time"` | `"one-at-a-time"` | 排队的追加消息如何送达 |
| `externalEditor` | string | `$VISUAL`、`$EDITOR`，再到平台默认 | `Ctrl+G` 打开的外部编辑器命令 |
| `doubleEscapeAction` | `"tree"` \| `"fork"` \| `"none"` | `"tree"` | 输入框为空时双击 `Escape` 的动作 |
| `treeFilterMode` | `"default"` \| `"no-tools"` \| `"user-only"` \| `"labeled-only"` \| `"all"` | `"default"` | 打开 `/tree` 时的初始过滤器 |
| `defaultProjectTrust` | `"ask"` \| `"always"` \| `"never"` | `"ask"` | 没有其他决定时的项目信任行为。**只能在用户级设置** |

## 工具 {#tools}

| 设置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `defaultTools` | `string[]` | `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`、`ast_grep`、`web_search` | 启动时启用的内置工具。空数组表示不启用任何内置工具（扩展和 SDK 工具不受影响） |

可用的内置工具：`read`、`bash`、`powershell`、`edit`、`write`、`grep`、`find`、`ls`、`ast_grep`、`web_search`。nek 扩展的工具（`todo_write`、`subagent` 等）不受 `defaultTools` 控制。

`/reload` 会启用新加入 `defaultTools` 的工具，保留被移除的工具，不会重新启用本会话中手动禁用且未改变的工具。命令行的工具参数（`--tools` 等）优先于这个设置，包括 reload 时。

## 会话与上下文 {#sessions}

| 设置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `sessionDir` | string | agent 目录下的 `sessions/` | 会话存储目录，相对路径从工作目录解析。环境变量 `NEK_CODING_AGENT_SESSION_DIR` 和 `--session-dir` 优先 |

### 压缩 {#compaction}

| 设置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `compaction.enabled` | boolean | `true` | 启用自动压缩 |
| `compaction.reserveTokens` | number | `16384` | 为模型回复预留的 token |
| `compaction.keepRecentTokens` | number | `20000` | 原样保留、不做总结的近期 token |
| `compaction.modelOverrides` | object | 无 | 按模型设置上面两项，键为精确的 `服务商/模型ID` |
| `compaction.model` | string | 无（用主模型） | 写压缩摘要的模型（精确的 `服务商/模型ID`）。token 相关设置仍按主模型计算 |
| `compaction.thinkingLevel` | string | 无（用会话的等级） | 写压缩摘要时的思考等级，必须是摘要模型支持的等级 |
| `compaction.content` | object | 内置策略 | 摘要输入的折叠预算和旧工具结果的清理，见 [上下文压缩](/reference/compaction#content) |

token 值必须是非负的安全整数。每一项独立地按“模型覆盖 → 普通设置 → 内置默认值”解析。项目和用户的对象先合并，再按模型查找。

### 分支摘要

| 设置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `branchSummary.reserveTokens` | number | `16384` | 总结分支历史时预留的 token |
| `branchSummary.skipPrompt` | boolean | `false` | 不再询问是否生成分支摘要，默认不生成 |

## 终端与显示 {#display}

| 设置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `theme` | string | 自动检测 | 内置或自定义主题名；`"light/dark"` 形式表示跟随终端明暗 |
| `quietStartup` | boolean | `false` | 隐藏启动信息 |
| `tuiMode` | `"regular"` \| `"fullscreen"` | `"fullscreen"` | 交互界面模式。`"regular"` 使用终端自己的回滚 |
| `fullscreenExitOutput` | `"transcript"` \| `"resume-hint"` | `"transcript"` | 退出全屏模式时输出完整对话还是只输出续接提示 |
| `fullscreenScrollbar` | `"auto"` \| `"always"` \| `"hidden"` | `"auto"` | 全屏模式的滚动条 |
| `fullscreenCopyOnSelect` | boolean | `true` | 全屏模式下选中文字即复制 |
| `editorPaddingX` | number | `0` | 输入框水平内边距，0~3 格 |
| `outputPad` | `0` \| `1` | `1` | 对话记录的水平内边距 |
| `autocompleteMaxVisible` | number | `5` | 补全列表可见条数，3~20 |
| `showHardwareCursor` | boolean | `false` | 显示终端光标（帮助输入法定位） |
| `terminal.showImages` | boolean | `true` | 支持时显示内嵌图片 |
| `terminal.imageWidthCells` | number | `60` | 内嵌图片宽度（字符格） |
| `terminal.clearOnShrink` | boolean | `false` | 内容缩短时清除空行 |
| `terminal.showTerminalProgress` | boolean | `false` | 在终端标签上显示 OSC 9;4 进度 |
| `terminal.hyperlinks` | boolean \| `"auto"` | `"auto"` | 覆盖 OSC 8 超链接检测 |
| `terminal.images` | `"kitty"` \| `"iterm2"` \| `"auto"` \| `false` | `"auto"` | 覆盖内嵌图片协议检测 |
| `terminal.trueColor` | boolean \| `"auto"` | `"auto"` | 覆盖真彩色检测 |
| `images.autoResize` | boolean | `true` | 发送给模型前把图片缩放到不超过 2000×2000 |
| `images.blockImages` | boolean | `false` | 禁止把图片发送给模型 |
| `markdown.codeBlockIndent` | string | `"  "` | 渲染代码块时的缩进前缀 |
| `markdown.mermaid` | `"off"` \| `"final"` \| `"streaming"` | `"streaming"` | Mermaid 图的渲染方式 |

## 网络与重试 {#network}

| 设置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `transport` | `"auto"` \| `"sse"` \| `"websocket"` \| `"websocket-cached"` | `"auto"` | 支持多种传输方式的服务商优先使用的传输 |
| `httpProxy` | string | 无 | 代理地址，作为 `HTTP_PROXY` 和 `HTTPS_PROXY` 用于 nek 管理的 HTTP 客户端。**只能在用户级设置** |
| `httpIdleTimeoutMs` | number | `300000` | HTTP 响应头和响应体的空闲超时（毫秒），`0` 关闭 |
| `websocketConnectTimeoutMs` | number | `15000` | WebSocket 连接超时（毫秒），`0` 关闭 |
| `retry.enabled` | boolean | `true` | 对临时错误自动重试 |
| `retry.maxRetries` | number | `3` | 最大重试次数 |
| `retry.baseDelayMs` | number | `2000` | 指数退避的初始延迟（毫秒） |
| `retry.maxAgentDelayMs` | number | `60000` | 单次重试的最大延迟（毫秒） |
| `retry.provider.timeoutMs` | number | 同 `httpIdleTimeoutMs` | 服务商请求超时（毫秒） |
| `retry.provider.maxRetries` | number | `0` | 服务商 SDK 层面的重试次数 |
| `retry.provider.maxRetryDelayMs` | number | `60000` | 服务端要求的最大等待时间（毫秒），`0` 不限制 |

`retry.provider.maxRetries` 除非确有需要请保持 `0`：服务商层面的重试会推迟 nek 自己处理额度和用量限制错误。

可重试的临时错误包括：过载、限流、5xx、连接中断（包括流在完成前断开）、`model is at capacity` 等。`Retry-After` 无法解析时使用指数退避。上游卡住但没有断开连接时，nek 要等到 `httpIdleTimeoutMs` 才会报错并重试。

## Shell {#shell}

| 设置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `shellPath` | string | 平台默认 | 自定义 shell 可执行文件，支持开头的 `~` |
| `shellCommandPrefix` | string | 无 | 加在每条 shell 命令前面的内容（`bash` 工具和 `!` 命令） |
| `npmCommand` | `string[]` | `["npm"]` | 查找和安装 npm 包时使用的命令及参数 |

见 [Shell 命令配置](/platform/shell)。

## 资源 {#resources}

用户设置中的资源路径从 agent 目录解析，项目设置中的从项目 `.nek` 目录解析。支持绝对路径和 `~`。

| 设置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `extensions` | `string[]` | `[]` | 扩展文件或目录 |
| `skills` | `string[]` | `[]` | Skill 文件或目录 |
| `prompts` | `string[]` | `[]` | 提示词模板文件或目录 |
| `themes` | `string[]` | `[]` | 主题文件或目录 |
| `enableSkillCommands` | boolean | `true` | 把 Skills 注册为 `/skill:名字` 命令 |

资源数组支持：

- `!pattern`：用 glob 排除；
- `+path`：精确包含；
- `-path`：精确排除。

这些规则也作用于自动发现的资源。例如在项目里禁用某个用户级扩展：

```json
{
  "extensions": ["-~/.nek/agent/extensions/noisy.ts"]
}
```

## 更新、遥测与警告 {#updates}

| 设置 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `updateChannel` | `"stable"` \| `"dev"` | `"stable"` | `nek update` 使用的通道，由 `nek update --channel` 保存（`--check` 不保存）。stable 取最高的 `nek-v*` 标签，dev 跟踪安装时的分支（默认 `nek`）。启动时不会自动检查更新 |
| `collapseChangelog` | boolean | `false` | 更新后显示精简的更新日志 |
| `enableInstallTelemetry` | boolean | `true` | 启用部分服务商的来源标识请求头。nek 不发送安装/更新上报 |
| `enableAnalytics` | boolean | `false` | 选择加入分析数据共享，目前只用于实验性的首次运行设置 |
| `warnings.anthropicExtraUsage` | boolean | `true` | Anthropic 订阅认证可能产生付费的额外用量时发出警告 |
