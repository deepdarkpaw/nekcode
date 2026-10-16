# nek.yaml

`nek.yaml` 配置 nek 独有的功能：Plan 模式、Todo 列表和子代理。它与 `settings.json` 分开。

| 位置 | 作用范围 |
|---|---|
| `~/.nek/agent/nek.yaml` | 用户级 |
| `.nek/nek.yaml` | 项目级，信任项目后加载，覆盖用户级 |

两个文件都不存在时使用默认值。修改后重启 nek（或开新会话）生效。

## 默认值

```yaml
plan:
  dir: .nek/plans      # 计划文件目录，相对于工作目录
  shortcut: alt+m      # 切换 Plan 模式的快捷键

todo:
  settleReminder: true # 运行结束时仍有未完成的 todo，就提醒模型继续一次
  widgetMaxLines: 8    # 输入框上方 Todo 小部件的最大行数

subagent:
  maxConcurrent: 6           # 同时运行的子代理上限
  maxRetained: 32            # 保留的子代理记录上限
  awaitDefaultMs: 30000      # await 默认等待时间（毫秒）
  awaitMaxMs: 7140000        # await 最长等待时间（毫秒，119 分钟）
  finalTextMaxBytes: 32768   # 子代理返回给父会话的最终文本上限（字节）
```

只需写出想改的键，其余沿用默认值。例如：

```yaml
subagent:
  maxConcurrent: 3
todo:
  settleReminder: false
```

## 字段说明

### plan

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `dir` | string | `.nek/plans` | Plan 模式写出计划文件的目录 |
| `shortcut` | string | `alt+m` | 在 Agent 和 Plan 模式之间切换的快捷键，写法同 [快捷键](/reference/keybindings#syntax) |

### todo

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `settleReminder` | boolean | `true` | 一次运行结束时仍有 pending 或 in_progress 的 todo，提醒模型继续一次（每次运行最多一次） |
| `widgetMaxLines` | number | `8` | 输入框上方 Todo 小部件显示的最大行数 |

### subagent

| 键 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `maxConcurrent` | number | `6` | 同时运行的子代理上限。超出时 `subagent` 调用报错 |
| `maxRetained` | number | `32` | 保留的子代理记录上限，超出时移除最早完成且已查看过的记录 |
| `awaitDefaultMs` | number | `30000` | `await` 未指定等待时间时的默认值 |
| `awaitMaxMs` | number | `7140000` | `await` 允许的最长等待时间 |
| `finalTextMaxBytes` | number | `32768` | 子代理返回的最终文本上限 |

## 校验规则

nek 严格校验这个文件，出错时直接报告文件路径和原因：

- YAML 无法解析；
- 顶层不是映射；
- 出现未知的分区（只有 `plan`、`todo`、`subagent`）或未知的键；
- 值的类型与默认值不同（例如把数字写成字符串）；
- 数字为负数或非有限值。
