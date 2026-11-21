# Remote SSH

GUI 可以通过 SSH 打开 Linux 主机上的项目。界面在本机，nek 和项目文件都在远端：文件读写、命令和模型调用都在远端执行。

## 远端需要什么 {#requirements}

| 条件 | 说明 |
|---|---|
| 系统 | Linux x64 |
| SSH | 能从本机登录，支持密钥、ssh-agent 和密码；会读取本机 `~/.ssh/config`，包括多跳 `ProxyJump` |
| nek | 0.5.1-beta.7 或更新版本。没有安装或版本太旧时，连接对话框可以直接在远端安装，并显示安装日志；也可以复制手动安装命令自己执行 |

第一次连接时，GUI 会显示主机指纹（`SHA256:...`）请你确认。主机指纹之后发生变化时，连接会被阻断。

## 远端组件 {#server}

GUI 需要在远端运行一个小的服务进程，安装在 `~/.nek/gui-server/`。首次连接或 GUI 升级后：

1. 远端直接从 [nekcode-gui Releases](https://github.com/deepdarkpaw/nekcode-gui/releases) 下载与本机 GUI 同版本的 `nekcode-gui-server-*.tar.gz` 组件；
2. 每个文件都用安装包自带的 SHA256 清单校验，校验不通过就不会使用；
3. 远端无法访问 GitHub 时，GUI 会显示失败原因，然后改为从本机上传这些组件。

组件已经是当前版本时，再次连接不会重新下载。

## 配置在哪一边 {#config}

远程项目使用**远端主机上的 nek 配置**（远端的 `~/.nek/agent/` 和项目里的 `.nek/`）。在远程项目中打开设置，服务商、模型、Skill、MCP 等页面读写的是远端的这些文件，和在远端终端里运行 `nek` 看到的一致。本机的 nek 配置不会被带到远端。

## 断线与重连 {#reconnect}

连接断开后 GUI 会按间隔自动重连，标题栏显示当前状态，也可以手动重试或取消。
