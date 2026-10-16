# 子代理

子代理（subagent）是一个独立的子会话，用来完成一个边界清晰的任务，再把结果交回给父会话。它有自己的上下文窗口，所以大量的搜索输出、调研过程不会塞满主会话；多个子代理还可以在后台并行。

## 什么时候会用子代理

子代理由模型通过 `subagent` 工具派出。为了避免滥用，nek 的提示词约定：

- 默认由模型自己用工具完成工作；任务“大”、“多步”、“需要探索”本身不是派子代理的理由；
- 标记为 **`[autonomous]`** 的类型（内置的 `explore`，以及 frontmatter 写了 `autonomous: true` 的自定义类型），模型可以在任务明显需要大范围代码探索时自主使用；
- 其他类型需要**你明确要求**：例如“用子代理”、“并行处理”、“派给 xxx”，或直接点名某个类型。“深入一点”、“仔细调研”不算授权；
- 一两次工具调用就能完成的事不派子代理，也不会把整个请求原样转交再转述结果。

所以，想让 nek 并行工作时，直接说出来：

```text
用两个子代理并行：一个排查 src/api 下的超时问题，一个检查 src/db 的连接池配置。
```

## 内置类型 {#builtin-types}

| 类型 | 工具 | 说明 |
|---|---|---|
| `generalPurpose`（默认） | `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`、`ast_grep`、`todo_write`、`web_search` | 通用的可写子代理 |
| `explore` `[autonomous]` | `read`、`grep`、`find`、`ls`、`ast_grep`、`web_search`（只读） | 代码探索。派出时应说明范围和深度：quick、medium、very thorough |
| `shell` | `bash`、`read` | 执行命令、Git 操作等终端工作，只在这类工作本身构成独立流程时使用 |
| `gpt-6.1-sol-worker` | 全部内置工具（含 `powershell`） | 固定模型 `CPA/gpt-6.1-sol`，思考等级 `xhigh` |
| `kimi-3-ui-worker` | 全部内置工具（含 `powershell`） | 固定模型 `CPA/kimi-k3`，思考等级 `max`，用于终端 UI 工作 |

::: info 关于两个 worker 预设
`gpt-6.1-sol-worker` 和 `kimi-3-ui-worker` 指向名为 `CPA` 的服务商。你的 `models.json` 里没有这个服务商和模型时，调用它们会直接报错（不会退回父会话的模型）。可以在 `~/.nek/agent/agents/` 里用同名文件覆盖它们，见 [自定义类型](#custom-types)。
:::

`/agents` 列出当前可用的全部类型（内置、用户、项目）及其工具、模型和思考等级。

## 子代理能做什么、不能做什么

- 在**同一个进程**里运行，共用父会话的模型凭据；
- 有自己的工具集（由类型决定）、自己的“已读文件”记录；
- 设置是**只读的**：子代理从结构上无法改写全局设置；
- **不能**再派出子代理；
- **不加载 MCP**，所以没有 MCP 工具；
- 父会话处于 **Plan 模式**时，派出的子代理一律只读；
- 子会话保存在父会话目录下的 `subagents/` 里。

## 模型和思考等级

| 情况 | 模型 | 思考等级 |
|---|---|---|
| 类型有预设模型（frontmatter 的 `model`） | 固定使用预设。调用时传入不同的 `model`（包括 `inherit`）会被拒绝；预设不可用时直接报错 | 预设的 `thinking`，没有时沿用父会话 |
| 类型没有预设模型 | 省略或 `inherit` 时沿用父会话的模型；显式指定时使用指定的模型 | 预设的 `thinking`，没有时沿用父会话 |

修改预设文件后，重新打开（reattach）的子代理会立即使用新的预设。

## 前台与后台

`subagent` 工具的参数：

| 参数 | 说明 |
|---|---|
| `description` | 简短标题，显示在卡片上 |
| `prompt` | 完整的任务说明。子代理看不到父会话的对话，所以需要写清目标、相关文件和发现、能否修改文件、要返回什么 |
| `subagent_type` | 类型，默认 `generalPurpose` |
| `model` | 只有没有预设模型的类型才接受 |
| `run_in_background` | `true` 时立即返回，子代理在后台运行；默认取类型的 `is_background` |
| `resume` | 子代理 ID。在保留上下文的前提下给已有子代理发送后续任务 |
| `interrupt` | 配合 `resume`：打断正在运行的子代理并立即发送新提示（只在你要求改变方向时使用） |

- **前台**：父会话等待子代理完成，拿到最终结果后继续。
- **后台**：父会话立即继续。子代理完成时会给父会话发一条完成通知，除非父会话已经用 `await` 取走了结果。

同时运行的子代理最多 6 个（`nek.yaml` 的 `subagent.maxConcurrent`）。超过时调用会报错，需要等一个完成或用 `/subagents` 取消一个。

### 等待：await {#await}

`await` 等待后台子代理完成：

- 指定 `subagent_id` 等待某一个；省略时等待任意一个先完成的；
- `block_until_ms` 是最长等待时间，默认 30 秒，最长 7,140,000 毫秒（119 分钟）；设为 0 只查询状态；
- 超时只表示“还没完成”，不代表子代理失败。

### 你插话时会发生什么

`await` 或前台子代理等待期间，你发送一条普通的插话消息，会**结束这次等待**：

- 子代理本身不会被停止；
- 前台子代理转为后台继续运行，完成后发来通知；
- 父会话立即处理你的消息。

父会话被中断（`Escape`）之后，完成通知会等到你下一次明确发出请求时才送达，不会自己重新启动旧的子代理。取消后台子代理请用 `/subagents`。

## 在界面上查看 {#display}

子代理在对话记录里以卡片形式显示：

```text
✓ Map the cache layer  claude-sonnet-4 · explore · ↑12k ↓3.4k · 1m 5s
```

- 状态图标、标题；
- 模型 · 类型 · 输入 token（含缓存写入，不含缓存读取）· 输出 token · 总耗时；
- 运行中时第二行显示当前活动和距上次变化的时间，例如 `bash npm test · 5s ago`；
- 按 `Ctrl+O` 展开为完整的 Markdown 结果。

运行中的后台子代理还会列在输入框上方。工具卡片、`await` 结果、完成通知使用同样的格式，并实时更新。

### /subagents

`/subagents` 列出本会话的子代理，可以：

- 查看某个子代理的结果；
- 取消一个正在运行的子代理。

保留的子代理记录最多 32 条（`subagent.maxRetained`），超出时最早完成且已查看过的记录被移除。子代理返回给父会话的最终文本最多 32KB（`subagent.finalTextMaxBytes`）。

## 自定义类型 {#custom-types}

用 Markdown 文件定义自己的子代理类型：

- 用户级：`~/.nek/agent/agents/*.md`
- 项目级（仅受信任的项目）：`.nek/agents/*.md`

同名时项目级覆盖用户级，用户级覆盖内置类型。

```markdown
---
name: reviewer
description: Reviews a diff for correctness and style issues.
model: anthropic/claude-sonnet-4-5
readonly: true
is_background: false
autonomous: false
tools: [read, grep, ast_grep, web_search]
thinking: low
context_window: 500000
disallowed_tools: bash
---
Review the changes and report concrete issues with file and line references.
```

frontmatter 之后的正文就是子代理的指令。

| 字段 | 必填 | 说明 |
|---|---|---|
| `name` | 是 | 类型名，调用时的 `subagent_type`，区分大小写 |
| `description` | 是 | 一句话说明它做什么。会出现在给模型的类型列表里，决定模型何时选用它 |
| `model` | 否 | 固定模型（`服务商/模型ID`）。设置后不能在调用时更换 |
| `readonly` | 否 | `true` 时总是使用只读工具集（`read`、`grep`、`find`、`ls`、`ast_grep`、`web_search`），忽略 `tools` |
| `tools` | 否 | 工具列表，`[a, b]` 或 `a, b` 均可。省略时使用 `generalPurpose` 的工具集 |
| `disallowed_tools` | 否 | 从工具列表中移除的工具 |
| `thinking` | 否 | 思考等级：`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max` |
| `context_window` | 否 | 正整数，限制子会话自动压缩所用的上下文窗口 |
| `is_background` | 否 | `true` 时默认在后台运行 |
| `autonomous` | 否 | `true` 时模型可以不经你明确要求就使用它，列表里标记为 `[autonomous]` |

文件读取失败、YAML 无效、缺少 `name` 或 `description` 时，该文件被跳过并报告错误，不影响其他类型。

### 示例：只读的调研员

`~/.nek/agent/agents/explorer.md`：

```markdown
---
name: explorer
description: Read-only codebase explorer for broad searches across a large repository.
model: my-proxy/deepseek-v4-flash
readonly: true
thinking: high
autonomous: true
---
Search broadly, then report file paths, symbols, and line numbers that answer the question. Do not propose code changes.
```

### 示例：覆盖内置的 worker

不使用 `CPA` 服务商时，用同名文件把 worker 指向你自己的模型：

`~/.nek/agent/agents/gpt-6.1-sol-worker.md`：

```markdown
---
name: gpt-6.1-sol-worker
description: handles coding tasks with a strong coding model.
model: my-proxy/my-coding-model
thinking: high
tools: [read, bash, edit, write, grep, find, ls, ast_grep, web_search, todo_write]
---
```

## 崩溃与续接

- nek 在前台子代理运行时被杀掉：重开父会话后，会接回**原来的**子会话，让它把中断的那一轮跑完，结果照常返回给父会话。
- 后台子代理在父会话重开后不会自动接回，在你（或模型）`resume` 或 `await` 它时才处理。

见 [Durable 会话与崩溃续跑](/reference/durable-sessions)。

## 已知限制

- 以只读方式创建的子代理（Plan 模式下或只读类型），之后在 Agent 模式下 `resume` 也无法恢复写工具。
- 子代理里也有 `todo_write`，它的列表属于子会话，不显示在父会话的输入框上方。

## 配置

`~/.nek/agent/nek.yaml`：

```yaml
subagent:
  maxConcurrent: 6          # 同时运行的子代理上限
  maxRetained: 32           # 保留的子代理记录上限
  awaitDefaultMs: 30000     # await 默认等待时间
  awaitMaxMs: 7140000       # await 最长等待时间
  finalTextMaxBytes: 32768  # 子代理返回的最终文本上限
```

见 [nek.yaml](/reference/nek-yaml)。
