# 提示词模板

提示词模板把 Markdown 文件变成可复用的 `/` 命令。当你经常发送相同或相似的提示词，又不需要可执行逻辑或大量配套说明时，用它最合适。

## 创建模板

创建 `~/.nek/agent/prompts/review.md`：

```markdown
---
description: Review staged git changes
argument-hint: "[focus]"
---
Review the staged changes (`git diff --cached`). Focus on ${1:-correctness, security, and error handling}.
```

- **文件名就是命令名**，这个模板的命令是 `/review`。
- `description` 显示在命令补全里；省略时使用第一行非空内容。
- `argument-hint` 可选，提示参数格式：`<尖括号>` 表示必填，`[方括号]` 表示可选。

在会话中新增或修改模板后运行 `/reload`。

## 使用模板

在输入框里输入命令：

```text
/review
/review concurrency
/review "API compatibility"
```

nek 在把文本交给模型**之前**展开模板。扩展会先通过 `input` 事件拿到原始输入；如果有同名的扩展命令，则由扩展命令处理。

## 参数替换

| 写法 | 结果 |
|---|---|
| `$1`、`$2`… | 第 N 个参数 |
| `$@` 或 `$ARGUMENTS` | 全部参数，以空格连接 |
| `${1:-默认值}` | 第一个参数，没有时用默认值 |
| `${@:-默认值}` | 全部参数，没有时用默认值 |
| `${@:N}` | 从第 N 个开始的所有参数 |
| `${@:N:L}` | 从第 N 个开始的 L 个参数 |

参数按类似 shell 的规则拆分，`/review "API compatibility"` 传入的是一个包含空格的参数。

## 示例

**修复失败的测试**（`~/.nek/agent/prompts/fix-tests.md`）：

```markdown
---
description: Run the tests and fix failures
argument-hint: "[test path]"
---
Run the tests in ${1:-the whole project}. For each failure, find the root cause, fix it, and rerun until the tests pass. Do not change test expectations unless they are wrong; explain any such change.
```

**写提交信息**（`~/.nek/agent/prompts/commit-msg.md`）：

```markdown
---
description: Draft a commit message for staged changes
---
Read `git diff --cached` and draft a concise commit message in the format `type(scope): summary`, followed by a short body explaining why. Do not run git commit.
```

## 放在哪里

| 位置 | 作用范围 |
|---|---|
| `~/.nek/agent/prompts/` | 用户级，所有项目 |
| `.nek/prompts/` | 项目级，信任项目后才加载 |
| 设置 `prompts` | 额外的文件或目录 |
| `--prompt-template <路径>` | 只对本次运行生效（可重复） |

约定目录只加载直接位于其中的 `.md` 文件（不递归）。通过设置 `prompts` 可以选中嵌套目录中的 Markdown 文件，并支持 `!pattern` 排除、`+path` 精确包含、`-path` 精确排除，见 [settings.json](/reference/settings#resources)。

`--no-prompt-templates`（`-np`）关闭模板的自动发现和配置加载，显式的 `--prompt-template` 仍然生效。

项目模板在信任项目后会成为命令，信任陌生项目前请检查其内容。

## 模板、Skill 还是扩展？

| 需求 | 用 |
|---|---|
| 一段固定或带参数的提示词 | 提示词模板 |
| 一套专项说明，可能附带脚本和参考资料，由模型按需加载 | [Skill](/customize/skills) |
| 需要执行代码、注册工具或修改行为 | [扩展](/develop/extensions) |
