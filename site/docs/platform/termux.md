# 在 Android（Termux）上运行

nek 可以通过 [Termux](https://termux.dev/) 在 Android 上运行。Termux 是一个终端模拟器加 Linux 环境。文字输入、文件工具和 shell 命令都可用；通过 Termux:API 可以复制粘贴文字，但不支持粘贴剪贴板图片。

::: info 未经充分测试
nek 的安装脚本主要在 Windows、Linux、macOS 上验证过。Termux 不是 glibc 环境，部分预编译的工具可能无法运行，下文给出了处理办法。
:::

## 准备

从 [GitHub 或 F-Droid](https://github.com/termux/termux-app#installation) 安装 Termux，不要使用 Google Play 上已弃用的版本。

[Termux:API](https://github.com/termux/termux-api#installation) 可选，只在需要 Android 剪贴板或设备 API 时安装。

## 安装 nek

1. 更新 Termux 软件包：

   ```bash
   pkg update && pkg upgrade
   ```

2. 安装依赖（Node.js、Git、curl，以及 nek 用到的搜索工具）：

   ```bash
   pkg install nodejs git curl ripgrep fd
   ```

3. 运行安装脚本。Termux 已经通过包管理器提供了 rg 和 fd，可以跳过工具的自动下载：

   ```bash
   curl -fsSL https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/scripts/install.sh | NEK_SKIP_TOOLS=1 bash
   ```

4. 确认 `~/.local/bin` 在 PATH 中（安装脚本会提示），然后验证：

   ```bash
   nek --version
   ```

5. 在工作目录里启动：

   ```bash
   cd /path/to/working-folder
   nek
   ```

接下来按 [快速上手](/start/quickstart#connect-model) 连接模型。

### ast-grep

`ast_grep` 工具和 `read` 读大文件时的代码大纲需要 ast-grep。nek 自动下载的是 glibc 版本，在 Termux 里无法运行。可以尝试用 Rust 工具链编译安装（`pkg install rust` 后 `cargo install ast-grep --locked`），只要 `ast-grep` 在 PATH 里，nek 就会使用它。没有 ast-grep 时，nek 的其他功能不受影响，`read` 会改为按 50 行分块读取大文件。

## 访问 Android 共享存储

运行一次以授予权限：

```bash
termux-setup-storage
```

共享存储位于 `/storage/emulated/0`，也可以通过 `~/storage/` 访问。只在 nek 确实需要这些文件时才授予权限。

## 使用剪贴板

安装 Termux:API 应用及其命令行软件包：

```bash
pkg install termux-api
```

验证：

```bash
printf 'nekcode clipboard test' | termux-clipboard-set
termux-clipboard-get
```

Termux 剪贴板 API 只支持文字，nek 的粘贴快捷键无法粘贴剪贴板图片。

## 添加 Termux 相关的指令

把环境信息写进 `~/.nek/agent/AGENTS.md`，让模型知道自己在什么环境里：

````markdown
# Termux environment

- nek runs in Termux on Android.
- Shared Android storage is under `/storage/emulated/0`.
- Open URLs with `termux-open-url "https://example.com"`.
- Open files with `termux-open <path>`.
- Do not access shared storage unless the task requires it.
````

在会话中修改后运行 `/reload`。

## 排查问题

### 剪贴板不工作

确认 Termux:API 应用和 `termux-api` 软件包与 Termux 来自同一个渠道。先在 nek 外测试剪贴板命令。

### 共享存储提示权限不足

运行 `termux-setup-storage`，同意 Android 的权限请求，然后重新访问 `~/storage/` 或 `/storage/emulated/0` 下的路径。

### 安装后找不到 nek

打开新的 Termux 会话，检查：

```bash
command -v nek
echo $PATH
```

确认 `~/.local/bin`（或你设置的 `NEK_BIN_DIR`）在 PATH 中，例如在 `~/.bashrc` 里加入 `export PATH="$HOME/.local/bin:$PATH"`。
