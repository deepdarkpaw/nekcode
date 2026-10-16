# 快速上手

这一页带你从零开始：安装 nek、连接一个模型、完成第一个任务，然后学会续接会话。整个过程大约十分钟。

## 1. 安装

还没装的话，先按 [安装](/start/install) 运行一键安装脚本：

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/scripts/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/scripts/install.ps1 | iex
```

打开新终端，确认 `nek --version` 能输出版本号。

## 2. 在项目目录里启动

```bash
cd /path/to/project
nek
```

启动目录很重要，nek 用它来：

- 查找项目文件、项目指令（`AGENTS.md`）和项目配置（`.nek/`）；
- 作为工具的默认工作目录；
- 给会话分组（`nek -c` 续接的是**这个目录**最近的会话）。

如果项目里有 `.nek/settings.json`、`.nek/extensions/` 这类会执行或改变行为的配置，nek 会先问你是否信任这个项目，见 [项目信任](/guide/security#project-trust)。

界面从上到下分为三部分：

```text
┌──────────────────────────────────────────────┐
│ 对话记录：你的消息、模型回复、工具调用和结果       │  ← PageUp/PageDown 或鼠标滚轮滚动
│ ...                                          │
├──────────────────────────────────────────────┤
│ [Todo 列表 / 运行中的子代理]                    │  ← 有内容时才出现
│ > 在这里输入                                   │  ← 输入框，边框颜色表示思考等级或 Plan 模式
├──────────────────────────────────────────────┤
│ 当前目录 · 用量与费用 · 上下文进度条 · 模型         │  ← 状态栏（footer）
└──────────────────────────────────────────────┘
```

## 3. 连接模型 {#connect-model}

**模型**负责生成回复，**服务商（provider）**是你访问这个模型的服务或账号。

在 nek 的输入框里输入：

```text
/login
```

选择服务商，然后按提示操作：

- 有订阅（例如 Claude Pro/Max、ChatGPT Plus/Pro、GitHub Copilot）的服务商会打开浏览器登录；
- 其他服务商让你粘贴 API key。

凭据保存在 `~/.nek/agent/auth.json`。登录后用 `/model` 搜索并选择模型，在模型上按 `Ctrl+S` 可以把它保存为新会话的默认模型。

::: tip 用中转地址或自建服务？
OpenAI 兼容、Anthropic 兼容的中转地址，以及 Ollama、vLLM、LM Studio 等本地服务，写在 `~/.nek/agent/models.json` 里，见 [选择模型](/guide/models#compatible-endpoint)。
:::

不想把 key 存到磁盘？启动前设置环境变量也行：

```bash
export ANTHROPIC_API_KEY=sk-ant-...
nek
```

各服务商的变量名见 [服务商认证](/reference/providers)。

## 4. 交给它一个任务

直接用自然语言描述你要做的事，按 `Enter` 发送。例如：

```text
解释一下这个仓库的目录结构，以及怎么运行它的测试。
```

```text
把 @src/config.ts 里的硬编码超时改成从环境变量读取，并补上单元测试。
```

```text
对比 @old.csv 和 @new.csv，总结重要的变化。
```

输入 `@` 可以模糊搜索文件并插入路径。nek 工作时，你会看到它每一次读文件、搜索、执行命令和修改文件的过程。它**不会**在每次调用工具前征求同意，所以：

- 重要的工作请先提交到 git 或做好备份；
- 完成后检查它的回复和改动（`git diff`）；
- 不可信或无人值守的任务放进容器，见 [安全使用](/guide/security)。

工作过程中你可以随时插话：直接输入并按 `Enter` 会在当前步骤结束后插入你的消息；按 `Escape` 中止。详见 [终端界面与输入](/guide/usage#steer)。

## 5. 复杂任务：先出计划

需求比较大、或者你想先看方案再动手时，用 Plan 模式：

```text
/plan 给登录接口加上限流，按 IP 每分钟 20 次
```

nek 会只读地调研代码、在必要时向你提问，然后写出一份计划。你审阅后选择 **Implement**，它切回 Agent 模式按计划实施。`Alt+M` 可以随时在两种模式间切换。详见 [Plan 模式](/guide/plan-mode)。

## 6. 下次接着做

nek 会自动保存会话。退出后（`Ctrl+C` 两次，或空输入框时按 `Ctrl+D`），在同一个目录里：

```bash
nek -c          # 继续这个目录最近的会话
nek -r          # 从列表里选一个会话
```

在 nek 里用 `/resume` 切换会话，`/new` 开新会话。即使 nek 是被强制杀掉的，`nek -c` 也会把中断的那一轮接着跑完，见 [Durable 会话](/reference/durable-sessions)。

## 下一步

| 想做的事 | 去看 |
|---|---|
| 熟悉输入框、快捷键、排队消息 | [终端界面与输入](/guide/usage) |
| 给项目写长期有效的指令 | [项目指令（AGENTS.md）](/customize/context-files) |
| 了解每个工具能做什么 | [内置工具](/guide/tools) |
| 让多个子任务并行 | [子代理](/guide/subagents) |
| 接入 MCP 服务器 | [MCP 服务器](/guide/mcp) |
| 在脚本里调用 nek | [脚本与程序集成](/develop/cli-integration) |

### 选择合适的定制方式

从能满足需求的最简单方式开始：

| 需求 | 用 |
|---|---|
| 给某个目录写长期有效的指令 | [`AGENTS.md`](/customize/context-files) |
| 把常用提示词做成 `/` 命令 | [提示词模板](/customize/prompt-templates) |
| 打包一套专项说明和配套脚本 | [Skills](/customize/skills) |
| 定义自己的子代理类型 | [自定义子代理](/guide/subagents#custom-types) |
| 添加可执行的工具、命令或事件处理 | [扩展](/develop/extensions) |
| 接入一个 nek 不支持的模型服务 | [自定义服务商](/develop/custom-provider) |
