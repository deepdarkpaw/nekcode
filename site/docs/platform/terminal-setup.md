# 终端设置

大多数现代终端不需要额外设置就能运行 nek。当修饰键、滚动、链接、图片、颜色或输入法候选框的位置不正常时，参考这一页。

nek 使用扩展按键协议，让终端能区分 `Shift+Enter`、`Alt+Enter` 和普通的 `Enter`。终端代理、终端复用器（tmux）和 IDE 内置终端可能会改写或丢弃这些信息。

## 按症状查找

| 现象 | 先看 |
|---|---|
| `Shift+Enter` 直接发送了消息，而不是换行 | 下面对应终端的小节；tmux 见 [在 tmux 中运行](/platform/tmux) |
| `Alt+Enter` 不能排队追加消息 | [WezTerm](#wezterm)、[Alacritty](#alacritty)、[Windows Terminal](#windows-terminal) |
| 全屏模式下滚动特别慢 | [iTerm2](#iterm2) |
| 链接能点但没有悬停预览 | [Ghostty](#ghostty) |
| 内嵌图片或颜色检测不对 | [覆盖自动检测](#override) |
| 输入法候选框位置不对 | [WezTerm](#wezterm)、[IntelliJ IDEA](#intellij) |
| 修饰键只在 tmux 里失效 | [在 tmux 中运行](/platform/tmux) |

`/hotkeys` 查看 nek 当前生效的快捷键，修改方法见 [快捷键](/reference/keybindings)。

::: tip 换行的万能替代键
任何终端里都可以用 `Ctrl+J` 换行，它不依赖扩展按键协议。
:::

## Kitty

无需额外配置，原生支持所需的键盘协议。

## iTerm2 {#iterm2}

普通模式无需配置。

**全屏模式滚动慢**：全屏模式下 nek 接管视口，iTerm2 发送的是鼠标滚轮事件，而不是滚动终端历史。快速的触控板手势可能每次只移动一行。修改方法：

1. 打开 **iTerm2 > Settings > Advanced**；
2. 搜索 **Trackpad scrolls fast?**；
3. 设为 **No**。

这是 iTerm2 的全局设置，也可能影响原生的触控板滚动。

## Apple Terminal

nek 会在可用时启用增强按键上报。如果 Terminal.app 仍然把 `Shift+Enter` 当作普通回车发送，nek 会读取本机的 macOS 修饰键状态作为补救，把它识别为 `Shift+Enter`。

这个补救只在 nek 与 Terminal.app 运行在同一台 Mac 上时有效，通过 SSH 在另一台机器上运行时无效。

## Ghostty {#ghostty}

如果 `Alt+Backspace` 不能删除单词，在 Ghostty 配置里加上：

```text
keybind = alt+backspace=text:\x1b\x7f
```

配置文件在 macOS 上是 `~/Library/Application Support/com.mitchellh.ghostty/config`，Linux 上是 `~/.config/ghostty/config`。

旧版 Claude Code 的配置里可能有：

```text
keybind = shift+enter=text:\n
```

它发送的是原始换行符，nek 无法把它和 `Ctrl+J` 区分开，也会让 nek 和 tmux 收不到真正的 `Shift+Enter`。如果只是为了旧版 Claude Code 加的，删掉它。

**全屏模式下打开链接**：链接可以点击，但 nek 捕获鼠标时 Ghostty 不显示悬停下划线和 URL 预览。按住 `Shift+Command`（macOS）或 `Shift+Ctrl`（Linux）使用 Ghostty 自带的链接处理。

## WezTerm {#wezterm}

WezTerm 通常通过 xterm 扩展按键上报 `Shift+Enter`。要显式启用 Kitty 键盘协议，创建 `~/.wezterm.lua`：

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.enable_kitty_keyboard = true
return config
```

**macOS 上转发 Alt+Enter**：WezTerm 在 macOS 上默认把 `Option+Enter` 绑定为全屏。要把它用作 nek 的追加消息键，在 `config.keys` 里加：

```lua
local wezterm = require 'wezterm'
local config = wezterm.config_builder()
config.keys = {
  {
    key = 'Enter',
    mods = 'ALT',
    action = wezterm.action.SendString('\x1b[13;3u'),
  },
}
return config
```

**WSL 中输入法候选框位置不对**：显示硬件光标：

```bash
export NEK_HARDWARE_CURSOR=1
nek
```

或在设置里把 `showHardwareCursor` 设为 `true`。

## Alacritty {#alacritty}

Alacritty 通常能上报 `Shift+Enter`。在 macOS 上 `Option+Enter` 可能变成普通回车，在 `~/.config/alacritty/alacritty.toml` 中加上：

```toml
[[keyboard.bindings]]
key = "Enter"
mods = "Alt"
chars = "\u001b[13;3u"
```

修改后重启 Alacritty。

## VS Code 内置终端

VS Code 1.109.5 及更新版本默认在内置终端启用 Kitty 键盘协议。

更旧的版本，在 `keybindings.json` 里添加 `Shift+Enter` 绑定：

```json
{
  "key": "shift+enter",
  "command": "workbench.action.terminal.sendSequence",
  "args": { "text": "\u001b[13;2u" },
  "when": "terminalFocus"
}
```

用户的 `keybindings.json` 通常位于：

- macOS：`~/Library/Application Support/Code/User/keybindings.json`
- Linux：`~/.config/Code/User/keybindings.json`
- Windows：`%APPDATA%\Code\User\keybindings.json`

## Zed 内置终端

在 Zed 的 `keymap.json` 中添加：

```json
{
  "context": "Terminal",
  "bindings": {
    "shift-enter": ["terminal::SendText", "\u001b[13;2u"],
    "ctrl--": ["terminal::SendText", "\u001b[45;5u"],
    "ctrl-alt-]": ["terminal::SendText", "\u001b[93;7u"]
  }
}
```

## Windows Terminal {#windows-terminal}

在 Windows Terminal 中，nek 使用 Windows/WSL 的默认快捷键，完整列表见 [快捷键](/reference/keybindings)。

**转发 Shift+Enter**：用 `Ctrl+Shift+,` 或 **设置 > 打开 JSON 文件** 打开 `settings.json`，在 `actions` 数组中添加：

```json
{
  "command": { "action": "sendInput", "input": "\u001b[13;2u" },
  "keys": "shift+enter"
}
```

完全关闭并重新打开 Windows Terminal，然后确认 `Shift+Enter` 在 nek 中能换行。

**用 Alt+Enter 追加消息**：Windows Terminal 默认把 `Alt+Enter` 绑定为全屏，所以 nek 在 Windows 和 WSL 上用 `Ctrl+Q` 追加消息。想用 `Alt+Enter`，先让 Windows Terminal 转发这个键，再在 nek 的 `keybindings.json` 里把 `app.message.followUp` 绑定到 `alt+enter`，见 [快捷键](/reference/keybindings#assign)。

## xfce4-terminal 和 Terminator

这两个终端无法可靠地区分带修饰键的回车和普通回车，`Ctrl+Enter`、`Shift+Enter` 等自定义绑定可能无效。需要这些按键时，请换用支持现代扩展按键的终端，例如 Kitty、Ghostty、WezTerm、iTerm2、Windows Terminal 或兼容的 Alacritty。

## IntelliJ IDEA 内置终端 {#intellij}

IntelliJ IDEA 的内置终端无法可靠区分 `Shift+Enter` 和普通回车。用 `Ctrl+J` 换行，或在支持扩展按键的终端里运行 nek。

如果输入法候选框不跟随文字光标，显示硬件光标：

```bash
export NEK_HARDWARE_CURSOR=1
nek
```

## 覆盖自动检测 {#override}

nek 自动检测 OSC 8 超链接、内嵌图片协议和真彩色支持。终端代理或复用器可能让检测结果不准确，这时可以手动覆盖：

| 能力 | 环境变量 | 设置 |
|---|---|---|
| 超链接 | `PI_HYPERLINKS=1\|0\|auto` | `terminal.hyperlinks: true\|false\|"auto"` |
| 内嵌图片 | `PI_IMAGE_PROTOCOL=kitty\|iterm2\|none\|auto` | `terminal.images: "kitty"\|"iterm2"\|false\|"auto"` |
| 真彩色 | `PI_TRUE_COLOR=1\|0\|auto` | `terminal.trueColor: true\|false\|"auto"` |

设置优先于环境变量。不设置或设为 `auto` 时保持自动检测。

只在整条终端链路都支持时才强制开启某个能力，不支持的转义序列会破坏显示。

其他相关设置：

| 设置 | 作用 |
|---|---|
| `terminal.showImages` | 是否显示内嵌图片，默认 `true` |
| `terminal.imageWidthCells` | 内嵌图片的宽度（字符格），默认 60 |
| `terminal.clearOnShrink` | 内容缩短时清除空行（也可用 `NEK_CLEAR_ON_SHRINK=1`） |
| `terminal.showTerminalProgress` | 在终端标签上显示 OSC 9;4 进度 |
| `showHardwareCursor` | 显示终端光标，帮助输入法定位（也可用 `NEK_HARDWARE_CURSOR=1`） |
