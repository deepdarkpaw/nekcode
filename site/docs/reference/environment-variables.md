# 环境变量

nek 用环境变量配置进程、传递会话信息和提供服务商凭据。

- `NEK_*` 变量配置 nek 进程；
- nek 会设置进程标记，让子进程知道自己是被 nek 启动的；
- 模型调用的 shell 工具会收到描述当前会话的 `NEK_*` 变量；
- 共享的服务商和终端组件保留了少量 `PI_*` 兼容变量。

服务商 API key 的变量见 [服务商认证](/reference/providers#env)。

## 进程配置 {#process}

| 变量 | 说明 |
|---|---|
| `NEK_CODING_AGENT_DIR` | 用户数据目录，默认 `~/.nek/agent` |
| `NEK_CODING_AGENT_SESSION_DIR` | 会话存储目录，会被 `--session-dir` 覆盖 |
| `NEK_PACKAGE_DIR` | 覆盖包目录，适用于 Nix、Guix 等 store 路径 |
| `NEK_OFFLINE` | 关闭启动时的网络活动（模型目录刷新、工具下载等），同 `--offline` |
| `NEK_EXPERIMENTAL` | 设为 `1` 时启用实验性的 server/client 命令 |
| `NEK_TELEMETRY` | 覆盖安装遥测和服务商来源标识请求头（`1`/`true`/`yes` 或 `0`/`false`/`no`） |
| `NEK_SHARE_VIEWER_URL` | 覆盖 `/share` 使用的查看器地址 |
| `NEK_RADIUS_GATEWAY` | 覆盖 Radius 网关地址（用于分享上传等） |
| `NEK_CLEAR_ON_SHRINK` | 设为 `1` 时内容缩短后清除空行 |
| `NEK_HARDWARE_CURSOR` | 设为 `1` 时显示硬件光标（帮助输入法定位） |
| `NEK_BUN` | OpenTUI 界面使用的 Bun 可执行文件路径 |
| `NEK_STARTUP_BENCHMARK` | 交互模式下启用启动性能测量 |
| `NEK_TIMING` | 设为 `1` 时启用启动耗时统计 |

## 安装脚本 {#installer}

运行安装脚本或 `nek update` 时读取，见 [安装](/start/install#install-options)：

| 变量 | 说明 |
|---|---|
| `NEK_INSTALL_DIR` | 源码目录 |
| `NEK_BIN_DIR` | `nek` 命令所在目录 |
| `NEK_CHANNEL` | 更新通道：`stable` 或 `dev` |
| `NEK_BRANCH` | dev 通道跟踪的分支 |
| `NEK_REPO_URL` | 仓库地址 |
| `NEK_SKIP_TOOLS` | 设为 `1` 跳过 fd/rg/ast-grep 的准备 |
| `NEK_INSTALL_BUN` | 设为 `1` 在没有 Bun 时自动安装 |

## 进程标记 {#markers}

CLI 和 RPC 入口会设置：

- `AI_AGENT=nek`：标识启动者是 nek；
- `NEK_CODING_AGENT=true`：标识这是 nek 的子进程。

子进程继承这两个标记。它们与会话无关，通过 SDK 嵌入时不会自动设置。

## shell 工具中的会话信息 {#shell-env}

模型调用的 `bash` 和 `powershell` 命令会收到当前会话的状态：

| 变量 | 说明 |
|---|---|
| `NEK_SESSION_ID` | 当前会话 ID |
| `NEK_SESSION_FILE` | 当前会话文件（`.sqlite`）的绝对路径；临时会话时不设置 |
| `NEK_PROVIDER` | 当前选择的服务商 |
| `NEK_MODEL` | 当前选择的模型 ID |
| `NEK_REASONING_LEVEL` | 当前生效的思考等级 |

每条命令启动时取值，切换模型或思考等级会影响下一条命令，不需要重启 nek。

```bash
printf '%s/%s\n' "$NEK_PROVIDER" "$NEK_MODEL"
printf 'reasoning=%s session=%s\n' "$NEK_REASONING_LEVEL" "$NEK_SESSION_ID"
```

这些变量**不会**注入你输入的 `!` 和 `!!` 命令。自定义 shell 工具可以用 `exposeSessionEnvironment: false` 关闭注入。

## 兼容变量 {#compat}

以下变量由 nek 使用的共享组件读取，保留原来的名字：

| 变量 | 说明 |
|---|---|
| `PI_HYPERLINKS` | `1`/`0`/`auto`，覆盖 OSC 8 超链接检测 |
| `PI_IMAGE_PROTOCOL` | `kitty`/`iterm2`/`none`/`auto`，覆盖内嵌图片协议检测 |
| `PI_TRUE_COLOR` | `1`/`0`/`auto`，覆盖真彩色检测 |
| `PI_TUI_ESC_TIMEOUT` | 终端 Escape 序列的等待时间 |
| `PI_TUI_WRITE_LOG` | 把原始 ANSI 输出写入日志，用于诊断渲染问题 |
| `PI_CACHE_RETENTION` | 服务商提示词缓存的保留档位 |

对应的设置优先于这些变量，见 [终端设置](/platform/terminal-setup#override)。

## 其他常用变量

| 变量 | 说明 |
|---|---|
| `VISUAL`、`EDITOR` | `Ctrl+G` 使用的外部编辑器（设置 `externalEditor` 优先） |
| `HTTP_PROXY`、`HTTPS_PROXY` | 代理（也可用设置 `httpProxy`） |
| `LLAMA_BASE_URL`、`LLAMA_API_KEY` | llama.cpp 路由服务的地址和 key，见 [本地模型](/guide/local-models) |
| `HF_TOKEN` | Hugging Face token |
