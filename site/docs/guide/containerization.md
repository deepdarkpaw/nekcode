# 在隔离环境中运行

隔离环境用来限制模型生成的命令能访问或影响的文件、凭据、进程和网络服务。可以把整个 nek 进程放进隔离环境，也可以让 nek 留在宿主机、只把内置工具路由到隔离环境里执行。

## 选择隔离方式

| 方式 | nek 运行在 | 被隔离的部分 | 凭据 | 适合 |
|---|---|---|---|---|
| Docker | 容器内 | nek、内置工具、`!` 命令、扩展 | 传进容器的凭据在容器内可见 | 简单直接的本地容器边界 |
| Gondolin 扩展 | 宿主机 | 内置工具和 `!` 命令 | 存储的凭据留在宿主机，但命令会继承宿主机的环境变量 | 用本地微型虚拟机执行工具，同时保留宿主机上的界面 |

隔离方式决定了扩展在哪里运行：整个 nek 在隔离环境里时，扩展也在里面；用 Gondolin 只路由内置工具时，其他扩展的工具仍在宿主机上运行，除非它们也把工作委托给隔离环境。

::: info Docker Sandboxes 和 OpenShell
[Docker Sandboxes](https://docs.docker.com/ai/sandboxes/) 和 [NVIDIA OpenShell](https://docs.nvidia.com/openshell/about/overview) 目前公开的镜像（`pi-kit`、`pi`）安装的是上游 pi，不是 nek，还没有 nek 的 kit。要隔离 nek 本身，请使用下面的 Docker 方案，或在这些平台的通用沙箱里按 Docker 方案中的步骤安装 nek。
:::

## 先想清楚 nek 能访问什么

隔离环境里的进程仍然能影响你暴露给它的资源：

- 以读写方式挂载的宿主机目录，nek 可以修改；
- 挂载 `~/.nek/agent` 会暴露你的 nek 凭据、设置、扩展和会话；
- 传进容器的环境变量，容器内的所有进程都能读到；
- 有网络访问时，代码或工具输出可能被发送出去；
- 只隔离工具的方案，限制不了宿主机上的 nek 进程和不走隔离后端的扩展工具。

只暴露任务需要的工作目录、凭据和网络目的地。不希望写入影响宿主机时，用只读挂载，或者把文件复制进去、做完再复制出来。

## 在 Docker 中运行 nek {#docker}

### 构建镜像

创建 `Dockerfile.nek`：

```dockerfile
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git unzip ripgrep fd-find \
  && ln -s /usr/bin/fdfind /usr/local/bin/fd \
  && rm -rf /var/lib/apt/lists/*

# 安装 nek：源码放在 /opt/nekcode，nek 命令放在 /usr/local/bin
RUN curl -fsSL https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/scripts/install.sh \
  | NEK_INSTALL_DIR=/opt/nekcode NEK_BIN_DIR=/usr/local/bin bash

WORKDIR /workspace
ENTRYPOINT ["nek"]
```

在 `Dockerfile.nek` 所在目录构建：

```bash
docker build -t nek-sandbox -f Dockerfile.nek .
```

### 启动

在你希望 nek 访问的工作目录里运行：

```bash
docker run --rm -it \
  -e ANTHROPIC_API_KEY \
  -v "$PWD:/workspace" \
  -v nek-agent-home:/root/.nek/agent \
  nek-sandbox
```

- 把 `ANTHROPIC_API_KEY` 换成你的服务商需要的变量；
- 名为 `nek-agent-home` 的卷保存容器内的设置、凭据和会话，下次运行还在；
- 除非你希望容器访问宿主机的 nek 配置和凭据，否则**不要**挂载宿主机的 `~/.nek/agent`。

非交互地运行一次任务：

```bash
docker run --rm -e ANTHROPIC_API_KEY -v "$PWD:/workspace" nek-sandbox -p "列出失败的测试并分析原因"
```

### 验证工作目录

在 nek 里运行：

```text
!pwd
```

应该输出 `/workspace`。`/workspace` 下的改动会直接写到宿主机挂载的目录。不能接受时去掉挂载或改用只读挂载（`-v "$PWD:/workspace:ro"`）。

## 用 Gondolin 隔离工具 {#gondolin}

[Gondolin](https://github.com/earendil-works/gondolin) 是一个本地 Linux 微型虚拟机。仓库里的示例扩展让 nek 进程和基于文件的服务商凭据留在宿主机，把内置工具和你输入的 `!` 命令路由到虚拟机里执行。

::: warning 环境变量会进入虚拟机
虚拟机里的命令继承宿主机进程的环境变量，所以通过环境变量提供的服务商 key 在虚拟机里可见。除非你移除敏感变量或修改扩展的环境处理方式，否则不要把这种方案当作凭据边界。
:::

Gondolin 需要 Node.js 23.6 或更高版本，以及通过系统包管理器安装的 QEMU。

### 安装扩展

在 nek 的源码目录里（安装脚本默认放在 `~/.local/share/nekcode`）：

```bash
cd ~/.local/share/nekcode
mkdir -p ~/.nek/agent/extensions
cp -R packages/coding-agent/examples/extensions/gondolin ~/.nek/agent/extensions/gondolin
cd ~/.nek/agent/extensions/gondolin
npm install --ignore-scripts
```

放在 `~/.nek/agent/extensions/` 下的扩展会被自动加载。

### 启动

在要挂载的工作目录里启动 nek：

```bash
cd /path/to/working-folder
nek
```

扩展把宿主机的工作目录挂载到虚拟机的 `/workspace`，并替换 `read`、`write`、`edit`、`bash`、`grep`、`find`、`ls`。`/workspace` 下的改动直接写到宿主机。

其他扩展的工具仍在宿主机上运行，除非它们显式委托执行。添加可能绕过虚拟机边界的工具前，先阅读示例扩展的源码。

不想每次都加载它时，把扩展放在别处，用 `nek -e <路径>` 按需加载，见 [加载扩展](/customize/loading-extensions)。
