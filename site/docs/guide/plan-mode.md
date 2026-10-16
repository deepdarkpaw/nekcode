# Plan 模式

Plan 模式让 nek 先调研、澄清需求、写出计划，经你审阅批准后再切回 Agent 模式实施。适合改动范围大、方案有取舍、或者你想先看思路再动手的任务。

```text
你：/plan 给登录接口加限流
        │
        ▼
  Plan 模式：读代码、搜索、必要时提问（ask_question）
        │
        ▼
  create_plan：计划写入 .nek/plans/xxx.plan.md，完整计划显示在对话记录里
        │
        ▼
  审阅面板：Implement / Fresh context / Keep planning / Exit Plan mode
        │
        ▼ 选择 Implement
  切到 Agent 模式，计划的 todos 写入 Todo 列表，开始实施
```

## 两种模式

| | Agent 模式（默认） | Plan 模式 |
|---|---|---|
| 目的 | 完成任务 | 调研并写计划 |
| `edit` / `write` | 任意文件 | **只能改 Markdown 文件**（`.md`、`.markdown`） |
| 子代理 | 按类型的工具集 | 只读 |
| `create_plan` / `update_plan` | 调用会报错 | 可用 |
| 输入框 | 普通边框 | 专用边框颜色，常驻 `PLAN` 标记 |

::: warning Plan 模式不是沙箱
Plan 模式只在工具层面限制了 `edit` 和 `write` 的目标文件类型，`bash` 等其他工具仍然可用，模型被指示只做调研。不要把 Plan 模式当作安全边界，见 [安全使用](/guide/security)。
:::

## 进入和退出 {#enter}

| 操作 | 效果 |
|---|---|
| `/plan` | 安静地进入 Plan 模式（已在 Plan 模式时什么也不做） |
| `/plan <需求>` | 进入 Plan 模式并提交一个规划请求（或对现有计划的修改请求） |
| `Alt+M` | 在 Agent 和 Plan 之间切换（可在 `nek.yaml` 中修改，见下文） |
| `nek --plan` | 以 Plan 模式启动 |
| `/agent` | 退出 Plan 模式回到 Agent，**不**开始实施 |

`/plan` 是幂等的“进入”，不会把你切回 Agent；退出请用 `/agent` 或 `Alt+M`。

### 模型提议切换模式 {#switch-mode}

模型可以调用 `switch_mode` 提议切换，例如在 Agent 模式下发现任务需要先规划，或在 Plan 模式下你明确说“现在就开始写代码”。每次提议都会弹出确认，**必须由你同意**才会切换。你拒绝后，模型不会为同一个任务反复提议。

nek 的提示词要求模型只在模式明显不合适时才提议：任务大本身不是切换到 Plan 的理由；用户要求出计划、或者存在只有你能做的、会显著改变实现的决定时才会提议。

## 写计划 {#create}

在 Plan 模式下，模型会：

1. 用 `read`、`grep`、`ast_grep`、只读子代理等调研代码；
2. 只在存在会改变计划的决定时，用 `ask_question` 向你提问；
3. 调用 `create_plan`，参数包括计划名称、一两句话的概要（overview）、计划正文和一组 todos。

计划保存为 `.nek/plans/<名称>_<随机id>.plan.md`，格式如下：

```markdown
---
name: Login rate limit
overview: 用中间件按 IP 限制登录接口每分钟 20 次，超限返回 429。
todos:
  - id: middleware
    content: 新增 rateLimit 中间件
  - id: wire
    content: 在 /login 路由上启用
  - id: tests
    content: 补充超限与重置窗口的测试
---

# Login rate limit

## 方案
...
```

- 计划 ID 就是文件名去掉 `.plan.md` 的部分，例如 `login-rate-limit_3fa2c1`。
- 一个会话可以有多份计划。`create_plan` 不带 `plan_id` 时总是新建；带 `plan_id` 时原位整份重写那份计划。
- 计划目录可以在 `nek.yaml` 里改（`plan.dir`，默认 `.nek/plans`）。

## 审阅计划 {#review}

计划写好后：

- **完整计划**作为一条消息追加到对话记录里，可以像普通消息一样翻页（`PageUp`/`PageDown`、鼠标滚轮），普通模式下也在终端回滚记录里。这条预览只用于显示，不会发给模型。
- 输入框位置换成一个紧凑的**审阅面板**，标题为 “Implement this plan?”：

| 选项 | 效果 |
|---|---|
| **Implement** | 切到 Agent 模式，把计划的 todos 写入 Todo 列表（第一项为进行中），并发送“Implement the plan.”开始实施 |
| **Fresh context** | 开一个新会话来实施：新会话的第一条消息是计划全文。面板会显示当前上下文已用的百分比，上下文快满时选它 |
| **Keep planning** | 留在 Plan 模式，继续和模型讨论、修改计划 |
| **Exit Plan mode** | 切回 Agent 模式，但不开始实施 |

按 `Escape` 关闭面板，什么也不改变。

批准只对你审阅的那个**修订版本**有效。计划在审阅后被修改（包括你在编辑器里手动改了文件），需要重新提交审阅。

### 用命令审阅或实施

| 命令 | 作用 |
|---|---|
| `/plans` | 选择一份已保存的计划并预览 |
| `/nek-build [plan_id]` | 批准并实施一份已审阅的计划修订版本（不带参数时选择） |
| `/nek-build [plan_id] --fresh` | 同上，但在新会话里实施 |

## 修改计划 {#revise}

在 Plan 模式下继续和模型对话（或用 `/plan <修改意见>`），模型会修订计划：

- **增量修订**（常见情况）：模型先 `read` 计划文件，用 `edit` 只改需要改的段落（包括 frontmatter 里的 `overview` 和 `todos`），再调用 `update_plan` 提交审阅。nek 以磁盘上的文件为准：正文确实变了才把修订号加 1，并且只把 diff 返回给模型。
- **整份重写**：换了任务，或者你明确要求重写时，模型用 `create_plan` 加 `plan_id`。

你也可以自己用编辑器修改 `.plan.md` 文件。nek 不监听文件变化，改完后让模型调用 `update_plan`（例如告诉它“我改了计划文件，请重新提交审阅”），变化才会同步进会话并重新审阅。

### 再次进入 Plan 模式

再次进入 Plan 模式时，之前的计划只作为参考：模型会比较最新的需求和现有计划。

- 是**不同的任务**：写一份新计划；
- 是**同一个任务**：修订现有计划并删除过时的内容；
- 只有存在真正未决定的问题时才重新提问，修订后重新提交审阅。

## 实施之后

批准后没有单独的“执行阶段”：nek 就是在 Agent 模式下照常工作，计划的 todos 变成普通的 Todo 列表。按 `Escape` 像中止任何运行一样中止实施，Todo 列表保持原样，计划文件和已完成的进度都保留。

中断会撤销尚未生效的批准。旧的 todos、旧的批准、后台子代理的完成通知都不会自动恢复旧计划或覆盖你的新需求。

## 配置

`~/.nek/agent/nek.yaml`（或受信任项目的 `.nek/nek.yaml`）：

```yaml
plan:
  dir: .nek/plans     # 计划文件目录，相对于工作目录
  shortcut: alt+m     # 切换 Plan 模式的快捷键
```

见 [nek.yaml](/reference/nek-yaml)。

## 小贴士

- 计划文件是普通 Markdown，可以提交到仓库，作为设计记录。不想提交的话把 `.nek/plans/` 加进 `.gitignore`。
- 上下文已经很满时，选 **Fresh context** 在干净的会话里实施，效果通常更好。
- 计划里的 todos 应该是具体、可执行的步骤，这样实施时的 Todo 列表才有参考价值。
