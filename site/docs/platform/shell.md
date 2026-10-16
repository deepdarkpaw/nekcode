# Shell 命令配置

nek 每执行一条 Bash 命令，都会启动一个独立的**非交互** shell 进程。非交互 Bash 默认不展开别名，通常也不加载交互终端会加载的启动文件（如 `~/.bashrc`）。所以你在终端里能用的别名和函数，nek 里不一定能用。

用 `shellPath` 选择 Bash 程序，用 `shellCommandPrefix` 在每条命令前执行准备工作。

## nek 用哪个 shell

| 命令来源 | 使用的 shell |
|---|---|
| 模型调用内置 `bash` 工具 | nek 解析到的 Bash |
| 你在输入框里输入 `!命令` 或 `!!命令` | 同一个 Bash |
| 模型调用可选的 `powershell` 工具 | PowerShell 7（`pwsh.exe`）或 Windows PowerShell |
| 扩展提供或替换的 shell 工具 | 由该扩展决定 |

nek 通常以 `bash -c` 执行命令。Unix 系统上依次尝试 `/bin/bash`、PATH 中的 `bash`，都没有时退回 `sh`。原生 Windows 依次尝试 `shellPath`、Git Bash、PATH 中的 `bash.exe`，见 [在 Windows 上运行](/platform/windows)。

## 指定 Bash 程序

在 `~/.nek/agent/settings.json` 中设置 `shellPath`（支持开头的 `~`）：

```json
{
  "shellPath": "~/.local/bin/bash"
}
```

Windows 上用正斜杠或转义反斜杠：

```json
{
  "shellPath": "C:\\cygwin64\\bin\\bash.exe"
}
```

修改后运行 `/reload`。

## 每条命令前执行准备工作

`shellCommandPrefix` 会加在内置 `bash` 工具以及你输入的 `!`、`!!` 命令之前：

```json
{
  "shellCommandPrefix": "export CI=1"
}
```

nek 用换行把前缀和命令连接起来。前缀每条命令都会执行一次，请保持它快速、不需要交互。

## 启用 Bash 别名

把 nek 需要的别名放在一个 Bash 兼容的文件里，而不是让它解析整个交互式 shell 配置。

创建 `~/.bash_aliases`：

```bash
alias ll='ls -la'
alias gs='git status --short'
```

然后让 nek 开启别名展开并加载这个文件：

```json
{
  "shellCommandPrefix": "shopt -s expand_aliases\nsource ~/.bash_aliases"
}
```

运行 `/reload`，然后验证：

```text
!ll
```

输出应与 `ls -la` 相同。

别名必须是 Bash 语法。不要把整个 `.zshrc` source 进 Bash，zsh 的选项、函数和插件在 Bash 里可能无法解析或行为异常。

## 会话信息环境变量

模型调用的 `bash` 和 `powershell` 命令能拿到当前会话的信息，例如 `NEK_SESSION_ID`、`NEK_MODEL`。你输入的 `!` 命令**不会**注入这些变量。见 [环境变量](/reference/environment-variables#shell-env)。

## 排查问题

### 前缀对 `!` 命令有效，对某个扩展的工具无效

`shellCommandPrefix` 只配置 nek 内置的 Bash 执行。替换了 `bash` 工具或自带 shell 操作的扩展自己负责准备环境，请查看该扩展的说明。

### 提示找不到 `shopt`

nek 退回到了 `sh`，或者 `shellPath` 指向了非 Bash 的 shell。安装 Bash 或把 `shellPath` 指向 Bash，再使用 `shopt` 等 Bash 专有命令。

### 命令卡住等待输入

从 `shellCommandPrefix` 中移除交互式命令。前缀在非交互进程里、每条命令之前执行。

完整的设置定义见 [settings.json](/reference/settings#shell)。
