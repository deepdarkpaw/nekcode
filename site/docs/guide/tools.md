# 内置工具

工具是模型与外部世界交互的方式：读文件、搜索、执行命令、修改文件、向你提问、派出子代理。这一页逐个说明 nek 的内置工具，让你知道模型每一步在做什么，以及如何启用或限制它们。

## 默认启用哪些工具

新会话默认启用：

- 文件与搜索：`read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`、`ast_grep`、`web_search`；
- nek 扩展提供的：`todo_write`、`switch_mode`、`create_plan`、`update_plan`、`ask_question`、`subagent`、`await`、`stop_subagent`；
- 按需出现的：`tool_search`（存在延迟加载的工具时，例如 MCP 工具）、MCP 资源工具。

`powershell` 默认不启用，需要在 Windows 上手动开启，见 [在 Windows 上运行](/platform/windows#powershell)。

### 调整工具集

| 方式 | 作用 |
|---|---|
| 设置 `defaultTools` | 替换启动时启用的内置工具列表。空数组表示不启用任何内置工具（扩展工具不受影响） |
| `--tools a,b,c`（`-t`） | 只启用列出的工具（内置、扩展、自定义工具都受限）。nek 的工具也必须列出才会出现 |
| `--exclude-tools a,b`（`-xt`） | 在其他选择之后再禁用列出的工具 |
| `--no-builtin-tools`（`-nbt`） | 禁用默认内置工具，保留扩展和自定义工具 |
| `--no-tools`（`-nt`） | 所有工具都不启用 |

例子：只读审查代码

```bash
nek --tools read,grep,find,ls,ast_grep -p "审查 src/ 下的代码，列出潜在的 bug"
```

不想让模型向你提问：

```bash
nek --exclude-tools ask_question
```

## 文件工具

### read {#read}

读取文件，支持文本和图片（jpeg、png、gif、webp）。

- 每行输出都带一个行号前缀，格式为六位右对齐的行号加一个竖线，例如 `    12|`。前缀不是文件内容的一部分。
- 不指定范围时，约 10,000 字符以内的文件完整返回。更大的**源代码文件**也会完整返回，但沿语法树折叠：10 行以上的函数、方法、类只显示首行、`...` 和末行，并保留真实行号。模型再用 `offset` 和 `limit` 读取折叠的部分。
- 没有代码大纲的语言（ast-grep 不支持的语言）按 50 行一块分段。
- `offset` 从 1 开始；负数表示从末尾倒数，`-1` 是最后一行。`limit` 限制行数。
- 输出超过 2000 行或 50KB 时截断，并提示从哪个 `offset` 继续。

折叠用的代码大纲由 ast-grep 生成，所以 ast-grep 不可用时大文件只能分块读取。

### edit {#edit}

在文件里把一段精确的文本替换成新文本（参数 `file_path`、`old_string`、`new_string`、`replace_all`）。

- `old_string` 必须与文件当前内容**完全一致**（包括缩进），并且在文件里**只出现一次**；需要替换所有出现时设置 `replace_all`。
- 行尾符会归一化后再匹配，所以 LF 写法也能匹配 CRLF 文件；写回时保留文件原来的编码、BOM 和行尾符。
- 写入是原子的（先写临时文件再替换）。
- 编辑前**不要求**先读文件：`old_string` 必须精确匹配这一约束本身就防止了基于过期内容的修改。
- 对同一个文件的多次 `edit` 按顺序执行，每次都基于上一次的结果。
- `old_string` 为空且文件不存在时，创建新文件。

### write {#write}

创建文件或整体覆盖已有文件，会自动创建父目录。

**覆盖已有文件前必须先读过它**。以下都算“读过”：在当前分支上成功的 `read`、`edit`、`write`，以及识别得出的 shell 读取（`cat`、`head`、`tail`、`sed -n`，以及 PowerShell 的 `Get-Content`/`gc`/`cat`/`type` 读单个文件）。这个“已读”记录从会话分支重建，所以重启、`/resume`、`/fork` 之后仍然有效；用 `/tree` 切到没读过该文件的分支后需要重新读。

## 搜索工具

### grep {#grep}

用 ripgrep 搜索文件内容。

- `pattern` 是 Rust 正则；设置 `literal` 可以按字面文本搜索（适合包含 `(`、`[`、`.` 等字符的文本）。
- `path` 限定目录或文件，`glob` 过滤文件（例如 `*.ts`，或 `!**/*.test.ts` 排除）。
- `context` 显示匹配行前后的行，`ignoreCase` 忽略大小写。
- 遵守 `.gitignore`，包含点文件。
- 默认最多 100 条匹配或 50KB，单行超过 500 字符会截断。
- 路径相对于搜索目录。同一文件有多条结果且分组更短时，路径只显示一次：

```text
src/config.ts:
  32: const config = {};
  45: export { config };
src/main.ts:1: start();
```

缩进的行属于上方的文件标题；只有一条结果或分组不节省空间时，仍显示 `路径:行号: 内容`。这也适用于返回给模型的文本，不只是界面折叠。

启用 `context` 时，重叠或相邻的上下文窗口会合并，每行只显示一次。命中行用 `32: 内容`，上下文用 `31- 内容`，不连续的窗口之间用 `--` 分隔。匹配上限仍按实际命中计算，不把标题和上下文行计为额外命中。

### find {#find}

按 glob 模式查找文件（基于 fd）。不含 `/` 的模式匹配任意层级的文件名（`*.ts`），含 `/` 的模式匹配相对路径（`src/**/*.test.ts`）。遵守 `.gitignore`，包含点文件，默认最多 1000 条结果。

同一父目录有多个结果且这样更短时，会合并公共目录：

```text
src/core/tools/
  grep.ts
  find.ts
README.md
```

将目录标题和缩进的文件名拼接即可得到相对于搜索目录的路径，例如 `src/core/tools/grep.ts`。单独的路径保持原样，目录结果仍保留结尾的 `/`。

### ls {#ls}

列出一个目录的内容，按字母排序，目录以 `/` 结尾，包含点文件，默认最多 500 条。

### ast_grep {#ast-grep}

用 [ast-grep](https://ast-grep.github.io/) 按语法树结构搜索代码。适合找函数定义、某个 API 的所有调用、某种 import 写法等，比文本搜索更准确。

- `pattern` 写成代码的样子，`$X` 匹配一个节点，`$$$X` 匹配零个或多个节点。例如 `console.log($$$ARGS)`、`function $NAME($$$) { $$$ }`。
- `lang` 指定语言（ts、tsx、js、py、go、rust 等），省略时按文件扩展名推断。
- `path` 限定文件或目录，`globs` 包含/排除文件。
- `strictness` 控制匹配严格程度：`cst`、`smart`（默认）、`ast`、`relaxed`、`signature`。
- 结果显示命中的首行内容，多行匹配标注 `(+N lines)`。与 [grep](#grep) 一样，重复路径在更短时合并为文件标题和缩进行号；单条结果仍为 `路径:行号: 首行内容`。默认最多 100 条匹配，标题不计入匹配数。

### web_search {#web-search}

联网搜索，获取最新的公开信息。底层使用 Exa 托管的 MCP 服务，**不需要 API key**。

- `query`：用自然语言描述要找的内容；
- `objective`：可选，说明搜索目的和偏好的来源；
- `num_results`：结果数，默认 8，最多 20；
- `allowed_domains` / `blocked_domains`：限定或排除域名。

模型使用搜索结果时应在回答里列出来源链接。`web_search` 始终直接可用，不会被 `tool_search` 延迟加载。

## 命令工具

### bash {#bash}

执行 shell 命令，返回 stdout 和 stderr；退出码非零时作为错误报告并附上输出。

- 默认没有超时，模型可以为可能挂起的命令设置 `timeout`（秒）。
- 输出只保留最后 2000 行或 50KB，完整输出保存到临时文件并给出路径。
- 每条命令在一个新的非交互 Bash 进程里执行：别名默认不展开，交互式 shell 的启动文件通常不会加载。需要别名或环境准备时用 `shellCommandPrefix`，见 [Shell 命令配置](/platform/shell)。
- Windows 上默认使用 Git Bash。
- 命令能拿到当前会话的信息：`NEK_SESSION_ID`、`NEK_SESSION_FILE`、`NEK_PROVIDER`、`NEK_MODEL`、`NEK_REASONING_LEVEL`，见 [环境变量](/reference/environment-variables#shell-env)。

### powershell {#powershell}

只在原生 Windows 上可用，默认不启用。优先使用 PowerShell 7（`pwsh.exe`），没有时退回 Windows PowerShell，以 `-NoProfile -NonInteractive -ExecutionPolicy Bypass` 启动。启用方法见 [在 Windows 上运行](/platform/windows#powershell)。

## 规划与协作工具

这些工具由 nek 扩展提供。

| 工具 | 作用 | 详见 |
|---|---|---|
| `todo_write` | 创建和更新输入框上方的 Todo 列表 | [Todo 列表](/guide/todos) |
| `switch_mode` | 提议在 Agent 和 Plan 模式之间切换，需要你确认 | [Plan 模式](/guide/plan-mode#switch-mode) |
| `create_plan` | Plan 模式下保存一份新计划（或整份重写），并提交你审阅 | [Plan 模式](/guide/plan-mode) |
| `update_plan` | Plan 模式下，在模型用 `edit` 增量修改计划文件后提交审阅 | [Plan 模式](/guide/plan-mode#revise) |
| `ask_question` | 向你提出多选题 | 见下文 |
| `subagent` | 把一个边界清晰的任务派给子代理，前台或后台运行 | [子代理](/guide/subagents) |
| `await` | 等待后台子代理完成 | [子代理](/guide/subagents#await) |
| `stop_subagent` | 停止一个正在运行的子代理 | [子代理](/guide/subagents#stop) |

### ask_question {#ask-question}

模型遇到只能由你决定的问题时（例如选哪个库、哪种数据模型），会弹出多选题而不是用大段文字追问。

- 每次 1~2 个问题，每个问题至少两个选项；
- 可以允许多选；
- 始终可以选 **Other** 输入自己的答案（在原位换行编辑）；
- 推荐项排在第一个，并标注 `(Recommended)`。

这个调用会**阻塞**，直到你回答。nek 的提示词要求模型只在真正需要你决定时才提问：可逆的、范围内的操作直接做，提交、跑测试这类例行流程按项目指令自行决定。不希望被打断时可以用 `--exclude-tools ask_question` 禁用。

## 按需加载：tool_search {#tool-search}

有些工具注册了但默认不声明给模型（**deferred**，延迟加载），例如 MCP 服务器的工具。这样首次请求不会因为几十个 MCP 工具而变得臃肿。

`tool_search` 只在存在可发现的延迟工具（或仍在连接的延迟工具来源）时出现。模型用它按名字、描述、参数做 BM25 搜索，匹配到的工具会在下一次请求时激活，之后就能直接调用。加载记录保存在会话分支上，续接、`/tree`、`/fork` 后依然有效。

工具的四种暴露方式：

| 暴露方式 | 行为 |
|---|---|
| `direct`（默认） | 像内置工具一样直接声明 |
| `model-only` | 在 nek 中等同 `direct` |
| `deferred` | 注册但不激活，通过 `tool_search` 加载 |
| `hidden` | 注册但永不声明、不可发现、不可激活 |

MCP 工具的暴露方式配置见 [MCP 服务器](/guide/mcp#exposure)。

## MCP 资源工具

连接的 MCP 服务器提供资源时，会额外出现 `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`，见 [MCP 服务器](/guide/mcp#resources)。

## 工具与安全

所有工具都以 nek 进程的操作系统权限运行。工作目录只决定默认路径，不阻止命令访问其他路径。项目信任只控制加载哪些项目资源，不限制工具能做什么。见 [安全使用](/guide/security)。
