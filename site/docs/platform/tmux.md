# 在 tmux 中运行

nek 可以在 tmux 里运行，但 tmux 可能把 `Shift+Enter`、`Ctrl+Enter` 和普通 `Enter` 报告成同一个键。开启扩展按键后，nek 才能区分它们。

## 查看 tmux 版本

```bash
tmux -V
```

tmux 3.5 及更新版本用下面推荐的 CSI-u 配置；3.2 到 3.4 用 [旧版本配置](#old)。

## tmux 3.5+：开启扩展按键

在 `~/.tmux.conf` 中加入：

```sh
set -g extended-keys on
set -g extended-keys-format csi-u
```

终端本身不直接提供 Kitty 键盘协议时，nek 会请求扩展按键上报。CSI-u 是通过 tmux 转发修饰键最可靠的格式。

## 重启 tmux

配置作用于 tmux 服务器。为确保生效，关闭所有 tmux 会话后启动新的服务器。

如果用命令行停止服务器，请先保存工作，下面的命令会结束这个服务器管理的**所有**会话：

```bash
tmux kill-server
tmux
```

## 验证

在新的 tmux 会话里启动 nek，确认：

1. `Shift+Enter` 在输入框里换行；
2. `Enter` 发送；
3. `Alt+Enter` 排队追加消息（macOS 和 Linux）。Windows 和 WSL 默认用 `Ctrl+Q`。

如果这些键仍然和普通 `Enter` 一样，检查 tmux 外层的终端能否上报修饰键，见 [终端设置](/platform/terminal-setup)。

## tmux 3.2 到 3.4 {#old}

这些版本支持扩展按键，但不支持 `extended-keys-format csi-u`。只加：

```sh
set -g extended-keys on
```

nek 支持这些版本使用的 xterm `modifyOtherKeys` 格式。重启 tmux 后重复上面的验证。

更旧的版本请升级 tmux，或在 tmux 外运行 nek，不要依赖带修饰键的回车。

## 全屏模式下滚动

nek 默认以全屏模式启动，在备用屏幕上自己绘制对话，所以 tmux 的回滚（copy mode）里看不到对话内容。

- **键盘始终可用**：`PageUp`/`PageDown` 翻页，`Home` 跳到开头，`End` 回到末尾并跟随新输出。这些按键可在 [快捷键](/reference/keybindings) 中以 `tui.altScreen.*` 修改。
- **鼠标滚轮**只有在 tmux 转发鼠标事件时才能到达 nek。在 `~/.tmux.conf` 中加入下面一行，然后运行 `tmux source-file ~/.tmux.conf` 或重启 tmux：

```sh
set -g mouse on
```

没有 `set -g mouse on` 时，tmux 自己处理滚轮，nek 的对话不会滚动。

## 改回普通模式

普通模式把对话直接输出到终端，tmux 的 copy mode 和回滚照常可用。只用一次：

```bash
nek --tui-mode regular
```

设为默认：在 `/settings` 中选择，或在 `~/.nek/agent/settings.json` 中设置 `"tuiMode": "regular"`。

## 推荐的完整配置

```sh
# ~/.tmux.conf
set -g extended-keys on
set -g extended-keys-format csi-u   # tmux 3.5+
set -g mouse on
```
