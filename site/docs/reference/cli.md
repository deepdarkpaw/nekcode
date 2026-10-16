# 命令行

这一页列出 nek 的命令和启动参数。运行 `nek --help`（或在子命令后加 `--help`）可以看到你所安装版本的准确接口，顶层帮助还包括已加载扩展注册的参数。

```sh
nek [选项] [--] [@文件...] [消息...]
nek auth <check|print-api-key|print-bearer-token> [选项]
nek mcp <add|remove|list|login|logout> [选项]
nek update [--channel stable|dev] [--check]
```

## 调用方式与输出 {#modes}

```sh
nek                                              # 交互模式
nek "列出 src/ 下所有的 .ts 文件"                   # 交互模式，带初始消息
nek "读一下 package.json" "我们有哪些依赖？"         # 多条初始消息
nek @prompt.md @image.png "图里的天空是什么颜色？"     # 引用文件
nek -p "总结这个仓库"                               # print 模式
git diff | nek -p "审查这个改动"                    # 管道输入
nek --mode json "检查这个仓库" > events.jsonl        # JSON 事件流
nek -p -- "- 总结这几点"                            # 以 - 开头的提示词
```

stdin 和 stdout 都是终端时打开交互界面，除非用 `--print`、`--mode json` 或 `--mode rpc` 选择了别的模式。任一方被重定向、且没有选择 JSON 或 RPC 模式时，使用 print 模式。

| 输入 | 行为 |
|---|---|
| `消息` | 初始提示词 |
| `@路径` | 把文本文件或图片加入第一条提示词（相对当前目录解析） |
| 管道输入的 stdin | 内容加在第一条提示词之前 |
| `--` | 停止解析选项，后面的提示词可以以 `-` 开头 |

| 选项 | 行为 |
|---|---|
| `-p`、`--print` | 执行提示词，把最终的助手文本写到 stdout，然后退出 |
| `--mode text` | 文本输出；stdin 和 stdout 都是终端时仍然打开交互界面 |
| `--mode json` | 执行提示词，把 JSONL 事件写到 stdout，然后退出 |
| `--mode rpc` | 从 stdin 读取 JSONL 命令，把响应和事件写到 stdout，直到退出 |
| `--export <输入> [输出]` | 把会话文件导出为 HTML 并退出；省略输出路径时自动生成 |

RPC 模式不接受 `@文件` 参数。JSON 和 RPC 模式的 stdout 只用于协议记录。见 [脚本与程序集成](/develop/cli-integration)。

## 界面 {#ui}

| 选项 | 行为 |
|---|---|
| `--tui-mode <regular\|fullscreen>` | 界面模式，默认取设置 `tuiMode`（默认 `fullscreen`） |
| `--ui <tui\|opentui>` | 交互前端。`opentui` 为实验性界面，需要 Bun，见 [OpenTUI 界面](/guide/opentui) |
| `--plan` | 以 Plan 模式启动（由 nek 扩展注册） |
| `--verbose` | 显示详细的启动信息，覆盖 `quietStartup` |

## 模型 {#models}

```sh
nek --model sonnet:high
```

| 选项 | 行为 |
|---|---|
| `--provider <名字>` | 限定 `--model` 在某个服务商内查找 |
| `--model <模式>` | 按精确 ID 或模糊的 ID/名称匹配。支持 `服务商/ID` 和可选的 `:<思考等级>` 后缀 |
| `--api-key <key>` | 本次运行使用的 API key，不保存。需要配合 `--model` 或 `--models` |
| `--thinking <等级>` | `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`。优先于 `--model` 的后缀，并按模型能力截断 |
| `--models <模式列表>` | 逗号分隔，设定启动选择和 `Ctrl+P` 循环的范围。支持精确 ID、模糊匹配、不区分大小写的 glob（如 `anthropic/*`、`*sonnet*`）和 `:<思考等级>` 后缀 |
| `--list-models [搜索词]` | 列出可用模型（可模糊过滤）并退出 |

见 [选择模型](/guide/models) 和 [服务商认证](/reference/providers)。

## 会话 {#sessions}

| 选项 | 行为 |
|---|---|
| `-c`、`--continue` | 继续当前项目最近的会话 |
| `-r`、`--resume` | 打开会话选择器 |
| `--session <路径\|ID>` | 按文件路径、完整 ID 或 ID 前缀打开。先在当前项目中查找，匹配到其他项目的会话时提示复制一份 |
| `--session-id <ID>` | 打开当前项目中指定 ID 的会话，不存在则创建。ID 只能含字母、数字、`.`、`_`、`-` |
| `--fork <路径\|ID>` | 把已有会话复制成当前项目的新会话 |
| `--session-dir <目录>` | 会话存储和查找目录，优先于 `NEK_CODING_AGENT_SESSION_DIR` 和 `sessionDir` 设置 |
| `--no-session` | 使用不落盘的内存会话 |
| `-n`、`--name <名字>` | 设置会话显示名 |

约束：

- 会话 ID 必须以字母或数字开头和结尾；
- `--fork` 不能与 `--session`、`--continue`、`--resume`、`--no-session` 同时使用；
- `--session-id` 不能与 `--session`、`--continue`、`--resume` 同时使用；与 `--fork` 一起用可以指定新会话的 ID。

见 [会话与上下文](/guide/sessions)。

## 工具 {#tools}

```sh
nek --tools read,grep,find,ls -p "审查这个项目"
nek --exclude-tools ask_question
```

| 选项 | 行为 |
|---|---|
| `-t`、`--tools <列表>` | 逗号分隔的白名单，替换默认选择。作用于内置、扩展和自定义工具 |
| `-xt`、`--exclude-tools <列表>` | 在其他选择之后禁用列出的工具 |
| `-nbt`、`--no-builtin-tools` | 禁用默认的内置工具，保留扩展和自定义工具 |
| `-nt`、`--no-tools` | 所有工具都不启用 |

默认启用的工具见 [内置工具](/guide/tools)。

## 资源 {#resources}

| 选项 | 行为 |
|---|---|
| `-e`、`--extension <路径>` | 加载扩展文件或目录，可重复 |
| `-ne`、`--no-extensions` | 不加载自动发现和配置的扩展，`-e` 指定的仍加载 |
| `--skill <路径>` | 加载 Skill 文件或目录，可重复 |
| `-ns`、`--no-skills` | 不加载自动发现和配置的 Skills，`--skill` 指定的仍加载 |
| `--prompt-template <路径>` | 加载提示词模板文件或目录，可重复 |
| `-np`、`--no-prompt-templates` | 不加载自动发现和配置的模板，显式指定的仍加载 |
| `--theme <路径>` | 加载主题文件或目录，可重复 |
| `--use-theme <名字[/名字]>` | 本次运行使用的初始主题 |
| `--no-themes` | 不加载自动发现和配置的主题，显式指定的仍加载 |
| `-nc`、`--no-context-files` | 不加载 `AGENTS.md` / `CLAUDE.md` |

资源路径只对当前进程有效，相对路径从当前目录解析。

## 提示词与进程 {#process}

| 选项 | 行为 |
|---|---|
| `--system-prompt <文本\|路径>` | 用文本或文件内容替换默认系统提示词，nek 的身份句保留在最前面 |
| `--append-system-prompt <文本\|路径>` | 把文本或文件追加到系统提示词，可重复 |
| `-a`、`--approve` | 本次运行信任项目本地的配置和资源 |
| `-na`、`--no-approve` | 本次运行忽略需要信任的项目配置和资源 |
| `--offline` | 关闭自动的网络活动（包括模型目录刷新），等同 `NEK_OFFLINE=1` |
| `-h`、`--help` | 显示帮助（包括扩展注册的参数）并退出 |
| `-v`、`--version` | 显示版本并退出 |

扩展可以注册额外的长参数。未知的短参数会被拒绝。

## nek update {#update}

```sh
nek --version                       # nek 0.3.0 (pi 1.0.2)
nek update --check                  # 只检查
nek update --channel dev --check    # 检查 dev 通道
nek update                          # 更新
nek update --channel stable         # 切回 stable 并更新
```

| 选项 | 行为 |
|---|---|
| `--channel stable\|dev` | 选择通道并保存到设置 `updateChannel`（与 `--check` 一起用时不保存） |
| `--check` | 只检查，不改动文件和设置 |

- 操作的是正在运行的 nek 所在的源码目录，不是当前项目目录；
- stable 选择语义版本最高的 `nek-v*` 标签；dev 跟踪安装时的 `NEK_BRANCH`（默认 `nek`）。本地 dev 检出已经包含远程分支头（例如有更新的本地提交）时视为最新；
- `--check` 只对 `origin` 执行 `git ls-remote`，不 fetch、不检出文件、不调用 GitHub API。打印当前标签或提交、目标和是否有更新；
- `--check` 退出码：`0` 检查成功且无更新，`1` 出错，`2` 有可用更新。stable 没有任何标签也算成功（`0`），并明确提示；
- 不带 `--check` 时运行源码目录里的安装脚本（Linux/macOS 用 Bash，Windows 用 PowerShell），输出直接显示，返回脚本的退出码。脚本拒绝覆盖已跟踪文件的本地修改和分叉/本地提交，只做 fast-forward；stable 检出保持在标签上（detached）。

安装脚本的环境变量（`NEK_INSTALL_DIR`、`NEK_BIN_DIR`、`NEK_REPO_URL`、`NEK_BRANCH`、`NEK_CHANNEL`、`NEK_SKIP_TOOLS=1`、`NEK_INSTALL_BUN=1`）见 [安装](/start/install#install-options)。源码目录中被 git 忽略的 `.nek-install-state.json` 保存 `binDir`、`channel`、`branch`、`skipTools`、`installBun`，更新时复用；显式设置的环境变量优先。

维护者发版：`npm run nek:release -- patch|minor|<x.y.z>` 在干净的 `nek` 分支上只修改 `nekConfig.version`，提交 `Release nek v<x.y.z>` 并创建 `nek-v<x.y.z>` 标签。它不会推送，只打印推送命令供检查。

## nek mcp {#mcp}

不加载扩展，直接使用内置的 MCP 实现。

| 命令 | 行为 |
|---|---|
| `nek mcp add <服务器> [选项] -- <命令> [参数...]` | 添加或替换 stdio 服务器 |
| `nek mcp add <服务器> [选项] --url <url>` | 添加或替换 Streamable HTTP 服务器 |
| `nek mcp remove <服务器> [--local]` | 从选定的配置文件中移除服务器 |
| `nek mcp list [--json]` | 连接启用的服务器，报告状态、工具和错误；失败时退出码为 1 |
| `nek mcp login <服务器> [--timeout <秒>]` | OAuth 登录，浏览器等待默认 300 秒 |
| `nek mcp logout <服务器>` | 删除该服务器保存的 OAuth 凭据 |

`add` 和 `remove` 默认作用于用户级配置，`-l` / `--local` 选择 `.nek/mcp.json`。`add` 的选项包括可重复的 `--env KEY=VALUE` 和 `--header KEY=VALUE`、`--cwd`、`--bearer-token-env-var`、OAuth 客户端设置、`--description`、`--exposure deferred|direct|hidden`，完整列表见 `nek mcp --help`。会话内的修改用 `/mcp`。见 [MCP 服务器](/guide/mcp)。

## nek auth {#auth}

```sh
nek auth check --provider openai --json
nek auth print-api-key --provider openai
nek auth print-bearer-token --provider openai-codex
```

认证命令需要 `--provider <服务商>` 或 `--model <模型>`。

| 命令 | 说明 |
|---|---|
| `nek auth check` | 输出 `ready`、`not_ready` 或 `invalid`，退出码分别为 `0`、`1`、`2` |
| `nek auth print-api-key` | 打印解析出的 API key |
| `nek auth print-bearer-token` | 打印解析出的 OAuth bearer token（过期时刷新） |

| 选项 | 适用于 | 说明 |
|---|---|---|
| `--provider <服务商>` | 全部 | 解析某个服务商的凭据 |
| `--model <模型>` | 全部 | 从模型解析凭据，可与 `--provider` 一起用 |
| `--json` | `auth check` | 以 JSON 输出结构化结果 |
| `--credentials` | `auth check` | 就绪时一并输出解析出的凭据 |
| `--no-refresh` | `auth check` | 不刷新过期的 OAuth 凭据（默认会刷新） |
| `--min-expiry <时长>` | `print-bearer-token` | 要求 token 剩余有效期至少为此值，单位 `ms`、`s`、`m`、`h`，例如 `30m` |

::: warning
打印凭据的命令会把密钥写到 stdout。
:::

用途举例：把 nek 里登录的订阅凭据提供给其他工具使用。
