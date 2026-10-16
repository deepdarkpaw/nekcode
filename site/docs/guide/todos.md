# Todo 列表

处理多步任务时，模型会用 `todo_write` 工具维护一个 Todo 列表。列表固定显示在输入框上方，让你随时知道它做到哪一步、接下来要做什么。

```text
 ✓ 读取现有的配置加载逻辑
 ▸ 新增 rateLimit 中间件
 ○ 在 /login 路由上启用
 ○ 补充测试
> 
```

## 什么时候会出现

模型被指示在这些情况下使用 Todo 列表：

- 任务有三个左右或更多的独立步骤；
- 你一次给了一串任务；
- 你明确要求列出 todo。

单步任务、简单修复、纯提问不会使用 Todo 列表。

Plan 模式的计划被批准后，计划里的 todos 会作为普通 todos 写入列表，第一项标为进行中，见 [Plan 模式](/guide/plan-mode#review)。

## 每一项的状态

| 状态 | 含义 |
|---|---|
| `pending` | 未开始 |
| `in_progress` | 进行中（模型被要求同一时间最多一项） |
| `completed` | 已完成 |
| `cancelled` | 不再需要 |

模型完成一项后会立刻标为 completed，不再需要的项标为 cancelled。

## 模型如何更新列表

`todo_write` 有两种写法：

- `merge: false`：用新列表**整体替换**旧列表；
- `merge: true`：按 `id` 更新已有项（只需传要改的字段），保持原有顺序，新的 `id` 追加到末尾。

工具结果只返回一行摘要给模型，例如 `Todos updated: 2/5 completed. In progress: add-schema`。

## 查看列表

- 输入框上方的小部件默认最多显示 8 行（`nek.yaml` 的 `todo.widgetMaxLines`）。
- `/todos` 显示当前分支的完整列表。

Todo 列表保存在会话里，跟随**当前分支**：用 `/tree` 切换分支或 `/fork` 后，看到的是那条分支上的列表。

## 收尾提醒

一次运行结束时如果还有未完成（pending 或 in_progress）的 todos，nek 会提醒模型一次，让它继续把工作做完或更新列表状态。每次运行最多提醒一次，不会无限循环。

不需要这个行为时，在 `nek.yaml` 中关闭：

```yaml
todo:
  settleReminder: false
  widgetMaxLines: 8
```

见 [nek.yaml](/reference/nek-yaml)。

## 子代理里的 Todo

`generalPurpose` 等可写的子代理也有 `todo_write`，它们的 Todo 列表属于子会话自己，不会显示在父会话的输入框上方。
