# 终端界面与输入

这一页讲交互模式下的日常操作：怎么输入、怎么引用文件、怎么在 nek 工作时插话、怎么滚动和搜索对话、怎么导出结果。

还没装好或没连模型？先看 [快速上手](/start/quickstart)。

## 界面组成

| 区域 | 内容 |
|---|---|
| 启动信息 | 版本、常用按键，以及加载到的指令文件、Skills、提示词模板、扩展、主题。按 `Ctrl+O` 展开完整列表。可用设置 `quietStartup` 隐藏 |
| 对话记录 | 你的消息、模型回复、思考过程、工具调用和结果、错误 |
| 编辑器上方 | Todo 列表、运行中的后台子代理、扩展添加的小部件 |
| 输入框 | 输入提示词和命令。边框颜色表示当前思考等级；Plan 模式下换成专用颜色并显示 `PLAN` 标记 |
| 状态栏（footer） | 当前目录和会话名、本会话累计的 token 用量和费用、上下文用量、当前模型和思考等级 |

状态栏里的上下文用量显示为进度条，例如：

```text
▕████▌     ▏ 45.2% 90k/200k (auto)
```

表示当前上下文约 90k token，模型上限 200k，`(auto)` 表示自动压缩已开启。超过 70% 变成警告色，超过 90% 变成错误色。终端宽度小于 70 列时只显示文字。

## 输入提示词

| 操作 | 按键 |
|---|---|
| 发送 | `Enter` |
| 换行 | `Shift+Enter`（或 `Ctrl+J`） |
| 用外部编辑器写长提示词 | `Ctrl+G` |
| 浏览之前发过的提示词 | 输入框为空或光标在首行/末行时按 `↑` / `↓` |
| 清空输入框 | `Ctrl+C` |
| 退出 nek | 连按两次 `Ctrl+C`，或输入框为空时按 `Ctrl+D`，或 `/quit` |

外部编辑器按 `externalEditor` 设置、`$VISUAL`、`$EDITOR` 的顺序选择，都没有时 Windows 用记事本、其他系统用 `nano`。

如果 `Shift+Enter` 直接发送了消息，说明终端没有把修饰键传给 nek，见 [终端设置](/platform/terminal-setup)。

输入框支持完整的行编辑快捷键（按词移动、`Ctrl+W` 删词、`Ctrl+K` 删到行尾、`Ctrl+Y` 粘贴刚删除的内容、撤销等），见 [快捷键](/reference/keybindings)。

## 引用文件和图片 {#files}

- 输入 `@` 后接文件名片段，会弹出模糊搜索的文件列表，选中后插入路径，模型需要时自己读取文件内容。
- 同一个列表里排在文件前面的是子代理类型和 Skill，选中后插入 `@agent:类型` 或 `@skill:名字`，见 [点名子代理和 Skill](#mentions)。
- 按 `Tab` 补全路径。
- 粘贴图片：`Ctrl+V`（Windows/WSL 为 `Alt+V`）从剪贴板粘贴图片，剪贴板里是文字时粘贴文字。
- 在支持的终端里，也可以把图片文件拖进窗口。

大段粘贴的文本在输入框里会折叠成一个标记，发送时展开为完整内容。

图片发送前默认缩放到不超过 2000×2000 像素（设置 `images.autoResize`）；不想发图片给模型可以设置 `images.blockImages: true`。

## 点名子代理和 Skill {#mentions}

输入 `@` 后，补全列表先列出子代理类型（`agent:类型`）和 Skill（`skill:名字`），再列出文件；输入 `@agent:` 或 `@skill:` 只看对应的一类。

- `@agent:类型`：要求模型把请求中合适的部分交给这个子代理类型，内置和自定义类型都可以。这算作明确点名，没有 `[autonomous]` 标记的类型也会使用，见 [子代理](/guide/subagents)。
- `@skill:名字`：把这个 Skill 的完整说明作为一条隐藏消息，紧跟在你的消息后面发给模型，效果和 `/skill:名字` 相同，但可以写在消息任意位置，一条消息里也可以引用多个 Skill。名字不存在时保留原文。
- `@` 前面要是行首、空格或标点；`user@skill:x`、`a/@agent:x` 这类写法不算点名。

```text
@agent:explorer 找出所有读取 config.yaml 的地方，再用 @skill:pdf 把结果整理成 PDF
```

对话记录里只显示你输入的原文。输入框和对话记录里的 `@agent:`、`@skill:` 都用链接色显示；终端支持 OSC 8 超链接时（见 [终端设置](/platform/terminal-setup)），对话记录里的 `@skill:名字` 可以点击打开 `SKILL.md`，指向已存在文件的 `@路径` 也可以点击打开该文件。Skill 说明不会显示在对话中，只有 `/tree` 和导出的 HTML 会把它列为隐藏消息。

## 斜杠命令

输入 `/` 会弹出命令列表，可以继续输入进行搜索。常用的有：

| 命令 | 作用 |
|---|---|
| `/model` | 切换模型 |
| `/thinking` | 设置思考等级 |
| `/login`、`/logout` | 添加或移除服务商凭据 |
| `/settings` | 打开设置 |
| `/plan`、`/agent` | 进入 Plan 模式、回到 Agent 模式 |
| `/todos`、`/subagents` | 查看 Todo 列表、管理子代理 |
| `/new`、`/resume` | 新会话、切换会话 |
| `/compact` | 手动压缩上下文 |
| `/mcp` | 管理 MCP 服务器 |
| `/hotkeys` | 查看当前生效的快捷键 |

完整列表见 [斜杠命令](/reference/slash-commands)。扩展、提示词模板和 Skills 也会添加命令，`/` 菜单就是你当前会话可用命令的准确清单。

## 观察 nek 的工作

nek 工作时，对话记录里会实时显示每个工具调用和结果：

- `Ctrl+O`：展开或折叠工具输出（以及启动信息）。折叠时只显示前几行预览。
- `Ctrl+T`：显示或隐藏思考过程。
- `Shift+Tab`：在当前模型支持的思考等级之间切换。
- 子代理以卡片形式显示，运行中的卡片会实时更新当前活动，见 [子代理](/guide/subagents#display)。

nek **不会**在每次调用工具前征求同意。请检查它执行的命令和改动的文件，不可信或无人值守的任务请使用沙箱，见 [安全使用](/guide/security)。

## 运行中插话或中止 {#steer}

nek 工作时你可以继续输入：

| 想做的事 | 操作 |
|---|---|
| 调整当前任务（插话） | 输入消息后按 `Enter`。消息在当前这一轮的工具执行完后送达，模型下一步就会看到 |
| 当前任务完成后再做另一件事（追加） | 输入消息后按 `Alt+Enter`（Windows/WSL 为 `Ctrl+Q`） |
| 把排队中的消息拿回输入框 | `Alt+↑`（Windows/WSL 为 `Alt+Q`） |
| 停止当前任务 | `Escape`。排队中的消息会退回输入框 |

排队的消息默认每轮送达一条，可以用设置 `steeringMode`、`followUpMode` 改成一次全部送达。

压缩进行中按 `Enter` 输入的消息会在压缩完成后送达。

子代理运行期间（前台等待或 `await` 等待中），你发送的插话会结束等待：前台子代理转到后台继续运行，完成后发来通知。

## 双击 Escape

输入框为空时连按两次 `Escape`，默认打开 `/tree`（会话树）。可以用设置 `doubleEscapeAction` 改为打开 `/fork`，或设为 `none` 关闭。

## 执行终端命令

在输入框里以 `!` 开头，直接执行一条 shell 命令，并把命令和输出加入对话：

```text
!git status
```

以 `!!` 开头则只执行、不把输出发给模型：

```text
!!npm run dev
```

这两种命令使用与 `bash` 工具相同的 Bash（Windows 上默认是 Git Bash），也会应用 `shellCommandPrefix` 设置，见 [Shell 命令配置](/platform/shell)。命令输出会在下一次你发送消息时一起交给模型。

## 全屏模式与滚动 {#fullscreen}

nek 默认以全屏模式运行：输入框和状态栏固定在底部，对话记录由 nek 自己滚动。

| 操作 | 按键 |
|---|---|
| 翻页 | `PageUp` / `PageDown`，或鼠标滚轮 |
| 跳到开头 / 回到最新并跟随输出 | `Home` / `End` |
| 跳到上一条 / 下一条你的消息 | `Ctrl+Shift+↑` / `Ctrl+Shift+↓`（Windows/WSL 也可用 `Ctrl+↑` / `Ctrl+↓`） |
| 搜索对话记录 | `Ctrl+Shift+F`（Windows/WSL 为 `Ctrl+F`），`Enter`/`Shift+Enter` 下一个/上一个，`Escape` 关闭 |
| 选择文字 | 鼠标拖选；默认选中即复制（设置 `fullscreenCopyOnSelect`） |

向上滚动后，nek 停止自动跟随新输出；按 `End` 回到底部并恢复跟随。

相关设置：

- `fullscreenScrollbar`：滚动条 `auto`（默认）/`always`/`hidden`；
- `fullscreenExitOutput`：退出全屏时，`transcript`（默认）把对话记录打印到终端，`resume-hint` 只打印续接提示。

### 改用普通模式

普通（regular）模式把对话直接输出到终端里，使用终端自己的滚动条、回滚记录和搜索：

```bash
nek --tui-mode regular
```

想长期使用，在 `/settings` 里把 TUI mode 改成 regular，或在 `~/.nek/agent/settings.json` 中设置：

```json
{ "tuiMode": "regular" }
```

在 tmux 里用鼠标滚轮需要先 `set -g mouse on`，见 [在 tmux 中运行](/platform/tmux)。

## 切换模型和设置

- `/model` 或 `Ctrl+L`：打开模型选择器。
- `Ctrl+P` / `Shift+Ctrl+P`（Windows/WSL 为 `Alt+P`）：在可用模型间循环切换。用 `/scoped-models` 限定循环范围。
- `/thinking` 或 `Shift+Tab`：调整思考等级。
- `/settings`：修改常用设置（主题、TUI 模式、压缩、排队方式等）。

见 [选择模型](/guide/models) 和 [settings.json](/reference/settings)。

## 继续或重新开始

nek 会自动保存会话（除非用 `--no-session` 启动）。

| 命令 | 作用 |
|---|---|
| `/new` | 开始新会话 |
| `/resume` | 打开会话列表，切换到别的会话 |
| `/name <名字>` | 给当前会话起个好认的名字 |
| `/session` | 查看会话文件、ID、消息数、token 用量和费用 |
| `/tree`、`/fork`、`/clone` | 在不丢失现有工作的前提下尝试另一条路线 |
| `/compact` | 手动压缩上下文 |

退出后在同一目录运行 `nek -c` 继续最近的会话。详见 [会话与上下文](/guide/sessions)。

## 复制、导出与分享 {#export}

| 操作 | 说明 |
|---|---|
| `Ctrl+X` 或 `/copy` | 复制最后一条助手回复 |
| `/export [路径]` | 导出当前会话。默认 HTML；路径以 `.jsonl` 结尾时导出 JSONL |
| `/share` | 上传会话并返回查看链接。登录了 Radius 时上传到 Radius；否则通过 GitHub CLI 创建一个私密 gist（需要先 `gh auth login`） |
| `nek --export <会话文件> [输出]` | 在命令行把会话文件导出为 HTML |

::: warning 分享前请检查
导出或分享的会话可能包含提示词、工具参数、命令输出、文件内容，以及对话中出现过的凭据。
:::

## 收集诊断信息

遇到终端渲染或对话状态的问题时，输入 `/debug`。nek 会把当前渲染的终端行和会话消息写到 `~/.nek/agent/nek-debug.log`。这个文件可能包含提示词、回复、工具输出和文件内容，分享前请检查。

## 终端兼容性

不同终端对鼠标、修饰键和内嵌图片的支持不同。遇到 `Shift+Enter` 不换行、`Alt+Enter` 无效、图片不显示、输入法候选框位置不对等问题，见 [终端设置](/platform/terminal-setup)。`/hotkeys` 列出当前生效的全部快捷键，修改方法见 [快捷键](/reference/keybindings)。
