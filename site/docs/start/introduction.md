# nekcode 是什么

nekcode（命令名 `nek`）是一个运行在终端里的编程助手。你在项目目录里启动它，用自然语言描述任务，它会调用工具读文件、搜索代码、执行命令、修改文件，并把每一步都显示出来。

nekcode 基于开源项目 [pi](https://github.com/earendil-works/pi) 二次开发，保留了 pi 的会话、模型、扩展等全部基础能力，并在此之上增加了一组面向“规划 + 分工”的功能。

## 和 pi 相比多了什么

| 功能 | 说明 | 详见 |
|---|---|---|
| Plan 模式 | 先调研、写计划，审阅通过后再实施；计划保存在 `.nek/plans/` | [Plan 模式](/guide/plan-mode) |
| Todo 列表 | 多步任务的进度显示在输入框上方 | [Todo 列表](/guide/todos) |
| 子代理 | 把边界清晰的任务派给独立子会话，可前台或后台运行 | [子代理](/guide/subagents) |
| 新的文件工具 | Cursor 风格的分块 `read`、Claude Code 风格的精确替换 `edit`、结构化搜索 `ast_grep` | [内置工具](/guide/tools) |
| `ask_question` | 模型需要你做决定时，弹出多选题而不是长篇追问 | [内置工具](/guide/tools#ask-question) |
| `web_search` | 联网搜索，无需 API key | [内置工具](/guide/tools#web-search) |
| MCP | 内置 MCP 客户端和按需加载工具的 `tool_search` | [MCP 服务器](/guide/mcp) |
| 崩溃后续跑 | 每一步写入 SQLite，进程被杀后 `nek -c` 接着跑 | [Durable 会话](/reference/durable-sessions) |
| 一键安装与更新 | 从源码运行，`nek update` 跟随 stable 或 dev 通道 | [安装、更新与卸载](/start/install) |
| OpenTUI 界面 | 实验性的新终端界面，`nek --ui opentui` | [OpenTUI 界面](/guide/opentui) |

## 和 pi 的区别

如果你用过 pi，需要注意这些差异：

- **命令和目录不同**：命令是 `nek`，用户配置在 `~/.nek/agent/`，项目配置在 `.nek/`。nek 不会读取或迁移 `~/.pi/` 里的数据。
- **不通过 npm 安装**：npm 上的 `@earendil-works/pi-coding-agent` 是上游 pi，装出来的是 `pi` 命令。nek 用安装脚本从源码安装，见 [安装](/start/install)。
- **没有包管理命令**：pi 的 `install`、`remove`、`list`、`config` 等包管理命令已移除。`nek update` 用来更新 nek 自己。扩展用 `-e` 加载或放进扩展目录，见 [加载扩展](/customize/loading-extensions)。
- **默认工具更多**：新会话默认启用 `read`、`bash`、`edit`、`write`、`grep`、`find`、`ls`、`ast_grep`、`web_search`，以及 nek 自带的 Plan、Todo、子代理等工具。
- **默认全屏界面**：对话记录由 nek 自己滚动。想用终端原生的滚动条，用 `--tui-mode regular`。

## 版本号

```bash
nek --version
# nek 0.3.0 (pi 1.0.2)
```

前面是 nek 自己的版本，括号里是它所基于的 pi 版本。

## 下一步

- [安装 nek](/start/install)
- [快速上手：完成第一个任务](/start/quickstart)
- [了解 nek 的工作方式](/start/how-it-works)
