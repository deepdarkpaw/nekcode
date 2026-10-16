# 常见问题与排错

## 安装与更新

### 安装后提示找不到 `nek`

- **Linux/macOS**：确认 `~/.local/bin`（或 `NEK_BIN_DIR`）在 PATH 里。把安装脚本打印的那一行加入 `~/.bashrc` 或 `~/.zshrc`，然后重开终端。
- **Windows**：安装脚本会把 `%LOCALAPPDATA%\nekcode\bin` 加入用户 PATH，但已经打开的终端不会刷新，请新开一个 PowerShell 窗口。

### 安装脚本说没有 `nek-v*` 发布标签

stable 通道需要至少一个发布标签。还没有发布时，改用 dev 通道：`NEK_CHANNEL=dev` 再运行安装脚本，见 [安装](/start/install#install-options)。安装脚本不会悄悄切换通道。

### `nek update` 停下来说有本地改动

你修改过安装目录里的源码，或在里面有自己的提交。安装脚本不会覆盖它们。如果改动不需要保留，到安装目录（默认 `~/.local/share/nekcode` 或 `%LOCALAPPDATA%\nekcode`）里自行处理（例如 `git status` 查看后还原），然后重新运行 `nek update`。

### 更新后行为没有变化

已经打开的 nek 会话仍在运行旧代码，退出后重新运行 `nek`。

### Node.js 版本不够

nek 需要 Node.js 22.19 或更高版本。用 `node --version` 检查，升级后重新运行安装脚本。

### 启动时出现 `ExperimentalWarning: SQLite is an experimental feature`

这是 Node.js 对内置 `node:sqlite` 模块的提示，不影响使用。

## 模型与登录

### `/model` 里看不到想要的模型

- 确认该服务商有可用的凭据（`/login` 或环境变量）；
- `models.json` 里的模型也需要能解析到凭据才会出现；
- 用 `nek --list-models <关键词>` 在命令行检查；
- llama.cpp 只显示路由服务当前加载的模型。

见 [选择模型](/guide/models)。

### 中转接口报错或输出异常

检查 `models.json` 里的 `api` 是否与接口的真实协议一致（`openai-completions`、`openai-responses`、`anthropic-messages` 等），以及 `baseUrl` 是否包含正确的路径（例如是否需要 `/v1`）。思考等级不被接受时，用 `thinkingLevelMap` 映射或禁用不支持的等级。

### 请求经常中断或很慢才报错

- 临时错误（过载、限流、5xx、流在完成前断开）会按 `retry` 设置自动重试；
- 上游卡住但没有断开连接时，nek 要等 `httpIdleTimeoutMs`（默认 5 分钟）才报错重试。确认上游在长时间推理时也会持续发送数据后，可以考虑调小这个值；
- 需要代理时设置 `httpProxy`（只能在用户级设置）或 `HTTPS_PROXY`。

### 在远程服务器上无法完成 OAuth 登录

出现提示时，把浏览器最终跳转到的完整地址（或授权码）粘贴回 nek。也可以改用 API key。

## 界面与按键

### `Shift+Enter` 直接发送了消息

终端没有把修饰键传给 nek。临时可以用 `Ctrl+J` 换行；根本解决见 [终端设置](/platform/terminal-setup)，tmux 见 [在 tmux 中运行](/platform/tmux)。

### 在 tmux 里鼠标滚轮不能滚动对话

在 `~/.tmux.conf` 中加入 `set -g mouse on` 并重载配置。键盘的 `PageUp`/`PageDown` 始终可用。或者改用普通模式 `nek --tui-mode regular`。

### 想用终端自己的滚动条和搜索

使用普通模式：`nek --tui-mode regular`，或在 `/settings` 里把 TUI mode 改成 regular。

### 中文输入法的候选框位置不对

设置 `NEK_HARDWARE_CURSOR=1` 或在设置里打开 `showHardwareCursor`。

### Windows 上 `Alt+Enter` 不能排队消息

Windows Terminal 占用了 `Alt+Enter`，nek 在 Windows/WSL 上用 `Ctrl+Q` 排队追加消息，见 [在 Windows 上运行](/platform/windows)。

## 工具

### `ast_grep` 或大文件的代码大纲不可用

nek 找不到可用的 ast-grep。检查 `~/.nek/agent/bin/` 或 PATH 中是否有 `ast-grep`。Linux 上自动下载的版本需要 `unzip` 和 glibc 2.34+，老系统或 Alpine 请用 `npm install -g @ast-grep/cli` 自行安装。见 [搜索工具](/start/install#search-tools)。

### 模型说 `write` 失败，要求先读文件

覆盖已有文件前必须先读过它。这是有意的保护：防止基于过期内容整份覆盖。模型读一次文件后就可以写；局部修改应使用 `edit`，它不要求先读。

### Plan 模式下模型说只能改 Markdown

这是 Plan 模式的限制。审阅计划后选择 Implement，或按 `Alt+M` / 输入 `/agent` 回到 Agent 模式。

### 别名在 `!` 命令或 `bash` 工具里不能用

nek 用非交互的 Bash 执行命令，默认不展开别名。用 `shellCommandPrefix` 加载别名文件，见 [Shell 命令配置](/platform/shell)。

### 模型老是问问题，打断工作

nek 的提示词已要求模型只在真正需要你决定时才提问。如果仍然觉得打扰，可以在 `AGENTS.md` 中写明你的偏好，或用 `--exclude-tools ask_question` 禁用提问工具。

## 子代理

### 调用 `gpt-6.1-sol-worker` / `kimi-3-ui-worker` 报错

这两个内置预设固定使用名为 `CPA` 的服务商的模型。你的环境里没有时会直接报错。用同名文件在 `~/.nek/agent/agents/` 中覆盖它们，见 [自定义类型](/guide/subagents#custom-types)。

### 提示 `Subagent limit reached`

同时运行的子代理达到上限（默认 6）。等一个完成，或用 `/subagents` 取消一个；也可以在 `nek.yaml` 中调整 `subagent.maxConcurrent`。

### 子代理里没有 MCP 工具

子代理不加载 MCP，这是有意的设计。需要 MCP 的工作请在父会话中完成。

## 会话

### nek 被强制结束后，之前的工作还在吗？

在。用 `nek -c`（或 `/resume`）重新打开会话，中断的那一轮会继续。会修改外部状态的工具（`bash`、`edit`、`write` 等）不会被自动重跑，模型会看到“已中断”的结果并决定下一步。见 [Durable 会话](/reference/durable-sessions)。

### 提示会话已被其他进程打开

同一个会话不能被两个 nek 进程同时打开（有 `.lock` 文件）。关闭另一个进程，或用 `/new` 开新会话。

### 上下文很快就满了

- 状态栏的进度条显示当前用量；
- `/compact` 手动压缩，可以附加说明保留重点；
- 长任务可以在 Plan 模式审阅时选 **Fresh context** 在新会话里实施；
- 大范围的代码探索交给 `explore` 子代理，避免搜索输出塞满主会话；
- 用 `compaction.model` 指定一个上下文更长或更便宜的模型写摘要。

## 获取帮助

- 运行 `/debug` 收集诊断信息（分享前检查内容）；
- 在 [GitHub Issues](https://github.com/deepdarkpaw/nekcode/issues) 报告问题，附上 `nek --version` 的输出、操作系统和终端；
- 安全问题请按 [安全策略](https://github.com/deepdarkpaw/nekcode/blob/nek/SECURITY.md) 私下报告。
