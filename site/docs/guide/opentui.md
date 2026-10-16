# OpenTUI 界面（实验）

`nek --ui opentui` 启动一个基于 [OpenTUI](https://opentui.com)（`@opentui/core`）的新终端界面。原来的界面仍是默认，不受影响。

新界面的目标是与原界面功能完全对齐，只在外观上增强：主题派生的分层背景、圆角对话框、弱化的次要文字。

## 准备

- **Bun 1.3 或更高版本**。OpenTUI 通过 Bun FFI 加载原生核心，不能在 Node 上运行。nek 按以下顺序查找 Bun：
  1. 环境变量 `NEK_BUN`（Bun 可执行文件的路径）；
  2. PATH 中的 `bun`；
  3. `~/.bun/bin/bun`（Windows 为 `bun.exe`）。

  没有 Bun 时从 [bun.sh](https://bun.sh) 安装，或设置 `NEK_INSTALL_BUN=1` 后重新运行安装脚本。
- **源码安装**的 nek（安装脚本装的就是）。新界面位于 `packages/opentui`。
- 支持真彩色和备用屏幕的终端。终端支持时会使用 Kitty 键盘协议。

## 启动

```bash
nek --ui opentui
nek --ui opentui -c                          # 继续上次的会话
nek --ui opentui --model sonnet "解释一下这个仓库"
```

所有交互模式的参数都可用（`-c`、`-r`、`--session`、`--model`、`@文件`、初始消息、`--verbose` 等）。`--ui opentui` 不能与 `--mode` 或 `--print` 同时使用。

它的工作方式：Node 启动器解析参数、找到 Bun，然后用 Bun 重新运行同一个 `main()`，只是把交互界面换成 OpenTUI 版本。因此会话、设置、扩展、启动提示、print/RPC 模式的行为与平时完全一致，agent 和界面在同一个 Bun 进程里运行。

## 外观

主题跟随 `--use-theme` 或 `theme` 设置（内置的 `dark`/`light` 或自定义主题）。界面从主题的页面背景派生出分层背景：对话记录（底层）、状态栏（面板）、输入框（凸起）、对话框和提示（浮层，圆角边框）。次要文字使用主题的 muted 和 dim 颜色，链接和 Web Search 行使用主题的链接蓝色（`mdLink`）。

## 按键

所有按键来自可配置的 `keybindings.json`，与原界面相同，`/hotkeys` 列出当前生效的绑定。默认值（括号内为 Windows/WSL 的替代键）：

| 按键 | 作用 |
|---|---|
| `Enter` | 发送。运行中：排队一条插话；压缩中：排队到压缩之后 |
| `Alt+Enter`（`Ctrl+Q`） | 排队一条追加消息 |
| `Shift+Enter` | 换行 |
| `Alt+↑`（`Alt+Q`） | 把排队的消息全部移回输入框 |
| `Esc` | 中止当前运行（排队消息回到输入框）、取消 bash、退出 bash 模式；输入框为空时按两次打开 `/tree` 或 `/fork` |
| `Ctrl+C` | 清空输入框；按两次退出 |
| `Ctrl+D` | 输入框为空时退出 |
| `Ctrl+Z` | 挂起（Windows 不支持） |
| `Ctrl+O` | 展开/折叠工具输出、启动帮助和已加载资源 |
| `Ctrl+T` | 显示/隐藏思考内容 |
| `Shift+Tab` | 循环切换思考等级 |
| `Ctrl+P`、`Shift+Ctrl+P`（`Alt+P`） | 下一个 / 上一个模型 |
| `Ctrl+L` | 模型选择器 |
| `Ctrl+G` | 用外部编辑器编辑提示词 |
| `Ctrl+V`（`Alt+V`） | 从剪贴板粘贴图片（剪贴板是文字时粘贴文字） |
| `/`、`!`、`!!`、`@` | 命令、bash、不进上下文的 bash、文件路径补全 |
| `PgUp` / `PgDn` | 滚动对话记录 |
| `Home` / `End` | 跳到开头 / 最新消息 |
| `Ctrl+↑` / `Ctrl+↓` | 上一条 / 下一条你的消息 |
| `Ctrl+Shift+F`（`Ctrl+F`） | 搜索对话记录 |

鼠标：滚轮滚动对话记录；拖选文字并在 `fullscreenCopyOnSelect` 开启时自动复制；右键粘贴到输入框。滚到上方后不再跟随新输出，并显示“跳到最新消息”按钮。

## 普通模式

`tuiMode: "regular"` 或 `--tui-mode regular` 时，对话保留在终端自己的回滚记录里。OpenTUI 以 split-footer 模式运行：只重绘输入框及以下的区域，对话块在内容不再变化后写到上方。流式回复、运行中的工具、运行中的 `!` 命令和最新状态行在完成前一直停留在输入框上方。

已经进入回滚记录的输出无法修改。需要改变时（终端宽度、主题、工具输出展开、思考内容显示、重建对话、关闭对话框），会清屏并清空回滚记录，然后重新写出对话。普通模式下没有鼠标、对话滚动键和对话搜索，用终端自己的滚动和搜索。

## 已知限制

- **普通模式重绘**：重放会重写整段对话；比屏幕高的流式回复在完成前只显示最新的几行。运行中从全屏切到普通模式后，退出时会清除可见屏幕。
- **自动明暗主题**暂时无法通过 OpenTUI 查询终端背景，会使用默认外观。
- **终端进度**（OSC 9;4）写在 OpenTUI 帧输出之外，不忽略未知 OSC 序列的终端可能显示杂字符。
- **输入法**：开启 `showHardwareCursor` 后终端光标跟随输入框光标，但 OpenTUI 没有输入法组合支持，预编辑文字不会内联显示。
- **tmux**：没有开启 `extended-keys`（以及 `extended-keys-format csi-u`）时，`Shift+Enter`、`Ctrl+Shift+F` 等组合键无法到达界面。
- **字符宽度**：少数 emoji 和东亚“宽度不明确”字符的宽度计算与原界面不同，可能差一格。
- OpenTUI 仍是 1.0 之前的版本（`@opentui/core` 0.5.14）。

逐项的功能对齐清单见仓库的 `packages/opentui/PARITY.md`。
