# nekcode

**中文** | [English](README.en.md)

nekcode（命令名 `nek`）是一个运行在终端里的编程助手，基于 [pi](https://github.com/earendil-works/pi) 二次开发。它可以读代码、跑命令、改文件，并在此基础上增加了：

- **Plan 模式**：先调研、写计划，确认后再动手。
- **Todo 列表**：任务进度固定显示在输入框上方。
- **子代理（subagent）**：把边界清晰的任务派给独立的子会话，可前台或后台运行。
- **结构化搜索 `ast_grep`**、Cursor 风格的分块读文件、Claude Code 风格的精确替换编辑。
- **MCP 服务器**和按需加载工具的 `tool_search`。
- **`web_search`** 联网搜索，无需 API key。

## 一键安装

安装前只需要准备 [Git](https://git-scm.com/) 和 [Node.js](https://nodejs.org/) 22.19 或更高版本。

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/scripts/install.sh | bash
```

**Windows（PowerShell）**

```powershell
irm https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/scripts/install.ps1 | iex
```

安装脚本会依次：

1. 检查 Git、Node.js、npm 的版本；
2. 下载源码（Linux/macOS 放在 `~/.local/share/nekcode`，Windows 放在 `%LOCALAPPDATA%\nekcode`）；
3. 安装依赖，生成内置的模型列表；
4. 创建 `nek` 命令（Linux/macOS 放在 `~/.local/bin`；Windows 放在 `%LOCALAPPDATA%\nekcode\bin`，并自动加入 PATH）；
5. 准备好搜索工具 fd、rg、ast-grep（见[搜索工具](#搜索工具)）。

装好后打开一个新终端，验证：

```bash
nek --version
```

> nek 直接从源码运行，不需要构建。如果脚本提示安装目录不在 PATH 里，按提示把那一行加入 `~/.bashrc` 或 `~/.zshrc`。

## 更新

再运行一次安装命令即可。脚本会拉取最新代码，只有依赖变化时才重新安装依赖。已打开的 nek 会话需要退出后重新运行才会用上新版本。

如果你改过安装目录里的源码，脚本会停下并提示，不会覆盖你的改动。

## 开始使用

进入项目目录，运行 `nek`：

```bash
cd /path/to/project
nek
```

第一次使用需要选模型。在 nek 里输入 `/login`，选择服务商，按提示登录或填入 API key；之后用 `/model` 切换模型。自定义接口（如 OpenAI 兼容的中转地址）写在 `~/.nek/agent/models.json`，见 [模型与服务商](packages/coding-agent/docs/models.md)。

常用操作：

| 操作 | 说明 |
|---|---|
| `/plan <需求>` | 进入 Plan 模式，先出计划再实现 |
| `alt+m` | 在 Agent 和 Plan 模式之间切换 |
| `/model` | 切换模型 |
| `/todos` | 查看 todo 列表 |
| `/subagents` | 查看和管理子代理 |
| `/mcp` | 查看 MCP 服务器状态 |
| `nek -c` | 继续当前目录最近的会话 |
| `nek -p "问题"` | 非交互模式，直接输出结果 |

## 搜索工具

nek 的部分功能依赖三个外部命令行工具：

| 工具 | 用于 |
|---|---|
| [fd](https://github.com/sharkdp/fd) | `find` 查找文件 |
| [ripgrep](https://github.com/BurntSushi/ripgrep)（`rg`） | `grep` 搜索文本 |
| [ast-grep](https://ast-grep.github.io/) | `ast_grep` 结构化搜索、`read` 读大文件时的代码大纲 |

nek 按以下顺序查找它们：

1. `~/.nek/agent/bin/`（Windows 为 `%USERPROFILE%\.nek\agent\bin\`）；
2. 系统 PATH（Debian/Ubuntu 上的 `fdfind` 也能识别）；
3. 都找不到时，自动从 GitHub 下载到第 1 个目录。

安装脚本会提前执行这一步，并逐个运行 `--version` 确认能用，所以第一次使用时不用再等下载。之后想重新检查，可以在安装目录运行：

```bash
node --import ./packages/coding-agent/src/experimental/source-resolver.ts scripts/setup-tools.ts
```

**Linux 上的 ast-grep**：自动下载的版本需要系统有 `unzip`（用来解压），并且 glibc 不低于 2.34（Ubuntu 22.04+、Debian 12+、RHEL 9+）。在更老的系统或 Alpine 上请自己安装，例如 `npm install -g @ast-grep/cli`；只要 `ast-grep` 在 PATH 里，nek 就会直接使用。

**离线环境**：设置 `NEK_OFFLINE=1` 后 nek 不会尝试下载，请提前用系统包管理器装好这三个工具。

## 安装选项

运行安装脚本前设置这些环境变量，可以改变默认行为：

| 变量 | 作用 | 默认值 |
|---|---|---|
| `NEK_INSTALL_DIR` | 源码目录 | `~/.local/share/nekcode` / `%LOCALAPPDATA%\nekcode` |
| `NEK_BIN_DIR` | `nek` 命令所在目录 | `~/.local/bin` / `%LOCALAPPDATA%\nekcode\bin` |
| `NEK_BRANCH` | 跟踪的分支 | `nek` |
| `NEK_REPO_URL` | 仓库地址（例如换成镜像） | `https://github.com/deepdarkpaw/nekcode.git` |
| `NEK_SKIP_TOOLS=1` | 跳过 fd / rg / ast-grep 的准备 | 不跳过 |

例如：

```bash
curl -fsSL https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/scripts/install.sh | NEK_INSTALL_DIR=~/src/nekcode bash
```

```powershell
$env:NEK_INSTALL_DIR = 'D:\tools\nekcode'; irm https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/scripts/install.ps1 | iex
```

## 卸载

删除源码目录和 `nek` 命令即可：

- Linux/macOS：`rm -rf ~/.local/share/nekcode ~/.local/bin/nek`
- Windows：删除 `%LOCALAPPDATA%\nekcode`，并从用户环境变量 PATH 中移除 `%LOCALAPPDATA%\nekcode\bin`

`~/.nek/` 里保存着设置、登录凭据和历史会话，需要彻底清除时再手动删除。

## 配置文件

| 位置 | 内容 |
|---|---|
| `~/.nek/agent/settings.json` | 全局设置 |
| `~/.nek/agent/models.json` | 自定义服务商和模型 |
| `~/.nek/agent/auth.json` | 登录凭据（不要外传） |
| `~/.nek/agent/mcp.json` | MCP 服务器，见 [MCP](packages/coding-agent/docs/mcp.md) |
| `~/.nek/agent/agents/*.md` | 自定义子代理类型 |
| `~/.nek/agent/AGENTS.md` | 对所有项目生效的指令 |
| 项目里的 `.nek/` | 项目级设置、计划（`.nek/plans/`）、子代理 |
| 项目里的 `AGENTS.md` | 项目级指令 |

更多文档：

- [nekcode 特有功能](packages/coding-agent/docs/nek.md)：Plan 模式、子代理、工具列表
- [完整文档目录](packages/coding-agent/docs/index.md)：设置、会话、快捷键、扩展 API
- [安全说明](packages/coding-agent/docs/security.md)

## 安全

nek 以启动它的用户的权限运行，可以读写文件、执行命令，执行工具前不会逐个确认。"项目信任"只决定是否加载项目里的配置，它不是沙箱。处理不可信的代码或无人值守运行时，请放在容器或其他沙箱里。

## 参与开发

```bash
git clone https://github.com/deepdarkpaw/nekcode.git
cd nekcode
npm ci --ignore-scripts
npm run hydrate:model-data   # 生成内置模型列表
npm run check                # 类型检查和代码格式
./test.sh                    # 运行不需要联网的测试
./nek-test.sh                # 用当前源码运行 nek
```

代码规范见 [AGENTS.md](AGENTS.md) 和 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

MIT
