# 在 Windows 上运行

nek 可以作为原生 Windows 进程运行，也可以在 WSL（Windows Subsystem for Linux）里运行。原生 Windows 默认用 Git Bash 执行 Bash 命令，并可以选择把 PowerShell 开放给模型；WSL 里则使用 Linux 环境和它自己的 Bash。

安装和登录按 [快速上手](/start/quickstart) 进行（PowerShell 安装命令见 [安装](/start/install#one-line-install)）。这一页讲如何选择和配置命令环境。

## 选择原生 Windows 还是 WSL

| 环境 | 命令环境 | 适合 |
|---|---|---|
| 原生 Windows + Git Bash | 内置 `bash` 工具和 `!` 命令用 Git Bash | 文件和开发工具主要在 Windows 上 |
| 原生 Windows + `powershell` 工具 | 模型的命令用 PowerShell；`!` 命令仍用 Bash | 任务依赖 PowerShell 模块或 Windows 原生命令 |
| WSL | WSL 发行版里的 Linux Bash 和工具 | 文件和工具链已经在 Linux/WSL 里 |

在 WSL 里使用时，按 Linux 的方式安装（`curl ... | bash`）。

## 原生 Windows 使用 Git Bash

对大多数原生 Windows 用户，装好 [Git for Windows](https://git-scm.com/download/win) 就够了。

nek 按以下顺序查找 Bash：

1. `~/.nek/agent/settings.json` 中的 `shellPath`；
2. `Program Files` 或 `Program Files (x86)` 下的 Git Bash；
3. PATH 中的 `bash.exe`（包括 Cygwin、MSYS2）。

启动 nek 后输入下面的命令验证：

```text
!printf 'Bash is working\n'
```

找不到 Bash 时，nek 会报告它检查过的位置。安装 Git for Windows、把其他 Bash 放进 PATH，或配置 `shellPath`。

## 让模型使用 PowerShell {#powershell}

可选的 `powershell` 工具优先通过 `pwsh.exe`（PowerShell 7）执行命令，没有时退回 Windows PowerShell，以 `-NoProfile -NonInteractive -ExecutionPolicy Bypass` 启动。它只在原生 Windows 进程中可用。

**同时提供 bash 和 powershell**：

```json
{
  "defaultTools": ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls", "ast_grep", "web_search"]
}
```

**用 powershell 代替 bash**：

```json
{
  "defaultTools": ["read", "powershell", "edit", "write", "grep", "find", "ls", "ast_grep", "web_search"]
}
```

写入 `~/.nek/agent/settings.json` 后重启 nek，让它执行一条无害的 PowerShell 命令确认。输入框里的 `!` 和 `!!` 命令仍然使用 Bash。

也可以只对一次运行生效：

```powershell
nek --tools read,powershell,edit,write,grep,find,ls,ast_grep,web_search
```

注意 `--tools` 是白名单，nek 的规划和子代理工具也需要列出才会出现，所以长期使用更推荐 `defaultTools`。

## 使用自定义 Bash

Bash 装在 nek 找不到的位置时，设置 `shellPath`：

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

命令前缀和别名见 [Shell 命令配置](/platform/shell)。

## Windows 上的快捷键差异

Windows Terminal 会占用或改写一些组合键，所以 nek 在 Windows 和 WSL 上使用不同的默认键：

| 操作 | macOS / Linux | Windows / WSL |
|---|---|---|
| 排队追加消息 | `Alt+Enter` | `Ctrl+Q` |
| 取回排队消息 | `Alt+↑` | `Alt+Q` |
| 粘贴图片 | `Ctrl+V` | `Alt+V` |
| 上一个模型 | `Shift+Ctrl+P` | `Alt+P` |
| 撤销 | `Ctrl+-` | `Ctrl+Z`（WSL 为 `Alt+Z`） |
| 搜索对话 | `Ctrl+Shift+F` | `Ctrl+F` |
| 挂起到后台 | `Ctrl+Z` | 无（原生 Windows 不支持作业控制） |

`Shift+Enter` 的转发设置见 [终端设置](/platform/terminal-setup#windows-terminal)，完整按键列表见 [快捷键](/reference/keybindings)。

## 文件位置

| 内容 | 位置 |
|---|---|
| nek 源码 | `%LOCALAPPDATA%\nekcode` |
| `nek` 命令 | `%LOCALAPPDATA%\nekcode\bin` |
| 用户配置、凭据、会话 | `%USERPROFILE%\.nek\agent\` |
| 搜索工具（fd、rg、ast-grep） | `%USERPROFILE%\.nek\agent\bin\` |
