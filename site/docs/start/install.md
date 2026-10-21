# 安装、更新与卸载

nek 直接从源码运行，不需要构建。安装脚本会把源码下载到本机、安装依赖、创建 `nek` 命令，并准备好它依赖的搜索工具。

## 准备工作

| 依赖 | 版本 | 用途 |
|---|---|---|
| [Git](https://git-scm.com/) | 任意较新版本 | 下载和更新源码 |
| [Node.js](https://nodejs.org/) | 22.19 或更高 | 运行 nek（自带 npm；未安装时安装脚本会自动下载） |
| [Bun](https://bun.sh)（可选） | 1.3 或更高 | 只有实验性的 [OpenTUI 界面](/guide/opentui) 需要 |

Windows 上还需要 Bash 来执行模型的 `bash` 工具调用，通常装好 [Git for Windows](https://git-scm.com/download/win) 就够了，见 [在 Windows 上运行](/platform/windows)。

::: tip 自动安装 Node.js
如果本机未安装 Node.js 或已安装的版本低于 22.19，安装脚本会自动下载官方预编译包安装至 `~/.nek/node`（Windows 为 `%USERPROFILE%\.nek\node`），并自动配置环境与启动器，无需手动预装 Node.js。
:::

::: info nek 没有发布到 npm
npm 上的 `@earendil-works/pi-coding-agent` 是上游 pi，装出来的是 `pi` 命令，不是 `nek`。请使用下面的安装脚本。
:::

## 一键安装 {#one-line-install}

**Linux / macOS**

```bash
curl -fsSL https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/scripts/install.sh | bash
```

**Windows（PowerShell）**

```powershell
irm https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/scripts/install.ps1 | iex
```

安装脚本依次完成：

1. 检查 Git 与 Node.js 环境：若缺少 Node.js 或低于 22.19，自动下载并准备好官方 Node.js 运行时；
2. 下载源码：Linux/macOS 放在 `~/.local/share/nekcode`，Windows 放在 `%LOCALAPPDATA%\nekcode`。默认取最新的正式版本（`nek-v*` 标签）；
3. 用 `npm ci --ignore-scripts` 安装依赖，生成内置的模型列表；
4. 创建 `nek` 命令：Linux/macOS 放在 `~/.local/bin`；Windows 放在 `%LOCALAPPDATA%\nekcode\bin`，并自动加入用户 PATH（包含自动安装的 Node.js）；
5. 准备搜索工具 fd、ripgrep、ast-grep，并逐个运行 `--version` 确认可用（见 [搜索工具](#search-tools)）。

装好后**打开一个新终端**，验证：

```bash
nek --version
# nek 0.3.0 (pi 1.0.2)
```

::: tip 找不到 nek 命令？
Linux/macOS 上如果脚本提示 `~/.local/bin` 不在 PATH 里，把它打印的那一行加入 `~/.bashrc` 或 `~/.zshrc`，然后重开终端。Windows 上新开一个 PowerShell 窗口即可，旧窗口不会读取新的 PATH。
:::

## 安装选项 {#install-options}

运行安装脚本前设置这些环境变量，可以改变默认行为：

| 变量 | 作用 | 默认值 |
|---|---|---|
| `NEK_INSTALL_DIR` | 源码目录 | `~/.local/share/nekcode` / `%LOCALAPPDATA%\nekcode` |
| `NEK_BIN_DIR` | `nek` 命令所在目录 | `~/.local/bin` / `%LOCALAPPDATA%\nekcode\bin` |
| `NEK_CHANNEL` | 更新通道：`stable` 或 `dev` | `stable` |
| `NEK_BRANCH` | `dev` 通道跟踪的分支 | `nek` |
| `NEK_REPO_URL` | 仓库地址（例如换成镜像） | `https://github.com/deepdarkpaw/nekcode.git` |
| `NEK_SKIP_TOOLS=1` | 跳过 fd / rg / ast-grep 的准备 | 不跳过 |
| `NEK_INSTALL_BUN=1` | 没有 Bun 时通过官方脚本自动安装（OpenTUI 界面需要） | 不安装 |
| `NEK_NODE_DIR` | Node.js 自动安装目录 | `~/.nek/node` / `%USERPROFILE%\.nek\node` |
| `NEK_NODE_MIRROR` | Node.js 下载镜像源（例如 `https://npmmirror.com/mirrors/node`） | `https://nodejs.org/dist` |
| `NEK_NODE_VERSION` | Node.js 自动安装版本 | `22.19.0` |

例如把源码装到自定义目录：

```bash
curl -fsSL https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/scripts/install.sh | NEK_INSTALL_DIR=~/src/nekcode bash
```

```powershell
$env:NEK_INSTALL_DIR = 'D:\tools\nekcode'; irm https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/scripts/install.ps1 | iex
```

安装开发版（跟踪 `nek` 分支的最新提交）：

```bash
curl -fsSL https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/scripts/install.sh | NEK_CHANNEL=dev bash
```

```powershell
$env:NEK_CHANNEL = 'dev'; irm https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/scripts/install.ps1 | iex
```

安装选项保存在源码目录的 `.nek-install-state.json` 中（`binDir`、`channel`、`branch`、`skipTools`、`installBun`），之后 `nek update` 会沿用。重新安装时显式设置的环境变量优先于保存的值。

## 更新 {#update}

```bash
nek --version          # 当前版本
nek update --check     # 只检查，不改任何文件
nek update             # 更新到所选通道的最新版本
```

### 两个更新通道

| 通道 | 跟踪 | 适合 |
|---|---|---|
| `stable`（默认） | 版本号最高的 `nek-v*` 发布标签 | 日常使用 |
| `dev` | `nek` 分支（或 `NEK_BRANCH`）的最新提交 | 想尽快用上新功能 |

切换通道：

```bash
nek update --channel dev      # 切到 dev 并更新
nek update --channel stable   # 切回 stable 并更新
```

选择会保存到全局设置 `updateChannel`。加上 `--check` 时只检查，不保存通道。

### 更新的细节

- `nek update` 操作的是**正在运行的 nek 所在的源码目录**，与你当前所在的项目目录无关。
- `--check` 只通过 `git ls-remote` 访问源码仓库的 `origin`，不下载文件，也不调用 GitHub API。它打印当前版本（标签或提交）、目标版本和是否有更新。
- `--check` 的退出码：`0` 没有更新，`2` 有更新，`1` 无法检查。stable 通道还没有任何发布标签时，也算检查成功（退出码 `0`），并给出明确提示。
- 不带 `--check` 时，nek 会以原来的安装选项重新运行安装脚本（Linux/macOS 用 Bash 脚本，Windows 用 PowerShell 脚本），输出直接显示在终端里。只有依赖变化时才重新安装依赖。
- nek 启动时**不会**自动检查更新。
- 再运行一次一键安装命令也能更新。
- 已打开的 nek 会话要退出后重新运行才会用上新版本。

::: warning 本地改动不会被覆盖
如果你改过安装目录里的源码，或在里面有自己的提交，安装脚本会停下并提示，不会覆盖你的改动。普通检出只做 fast-forward；stable 通道停在发布标签上（detached HEAD），只会从一个发布标签移到另一个发布标签。
:::

## 搜索工具 {#search-tools}

nek 的部分功能依赖三个外部命令行工具：

| 工具 | 用于 |
|---|---|
| [fd](https://github.com/sharkdp/fd) | `find` 工具查找文件，`@` 文件补全 |
| [ripgrep](https://github.com/BurntSushi/ripgrep)（`rg`） | `grep` 工具搜索文本 |
| [ast-grep](https://ast-grep.github.io/) | `ast_grep` 结构化搜索；`read` 读大文件时生成代码大纲 |

nek 按以下顺序查找它们：

1. `~/.nek/agent/bin/`（Windows 为 `%USERPROFILE%\.nek\agent\bin\`）；
2. 系统 PATH（Debian/Ubuntu 上的 `fdfind` 也能识别）；
3. 都找不到时，自动从 GitHub 下载到第 1 个目录。

安装脚本会提前执行这一步，所以第一次使用时不用再等下载。之后想重新检查，在安装目录运行：

```bash
node --import ./packages/coding-agent/src/experimental/source-resolver.ts scripts/setup-tools.ts
```

**Linux 上的 ast-grep**：自动下载的版本需要系统有 `unzip`，并且 glibc 不低于 2.34（Ubuntu 22.04+、Debian 12+、RHEL 9+）。更老的系统或 Alpine 请自己安装，例如 `npm install -g @ast-grep/cli`；只要 `ast-grep` 在 PATH 里，nek 就会直接使用。

**离线环境**：设置 `NEK_OFFLINE=1`（或使用 `--offline`）后 nek 不会尝试下载，请提前用系统包管理器装好这三个工具。

## 卸载 {#uninstall}

删除源码目录和 `nek` 命令即可：

- **Linux/macOS**：

  ```bash
  rm -rf ~/.local/share/nekcode ~/.local/bin/nek
  ```

- **Windows**：删除 `%LOCALAPPDATA%\nekcode`（命令目录 `bin` 在它里面），然后从用户环境变量 PATH 中移除 `%LOCALAPPDATA%\nekcode\bin`。

如果安装时改过 `NEK_INSTALL_DIR` 或 `NEK_BIN_DIR`，删除对应的目录。

::: info 用户数据不会被自动删除
`~/.nek/` 里保存着设置、登录凭据、历史会话、提示词模板、Skills 和主题。需要彻底清除时再手动删除这个目录。
:::

## 从源码开发

想参与开发或直接跑仓库里的代码：

```bash
git clone https://github.com/deepdarkpaw/nekcode.git
cd nekcode
npm ci --ignore-scripts
npm run hydrate:model-data   # 生成内置模型列表
npm run check                # 类型检查和代码格式
./test.sh                    # 运行不需要联网的测试
./nek-test.sh                # 用当前源码运行 nek
```

代码规范见仓库里的 `AGENTS.md` 和 `CONTRIBUTING.md`。
