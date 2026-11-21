# 桌面应用（nekcode GUI）

nekcode GUI 是 nek 的图形界面。它和终端里的 `nek` 是**同一个 nek 的两种用法**，就像 Codex app 和 Codex CLI：两边读同一组配置文件，用同一份模型列表、同样的 Skill 和 MCP 服务器，会话也存在同一个地方。在一边改了配置，另一边下次读取时就能看到，不需要同步，也没有“GUI 专用”的第二份配置。

源码和安装包在 [deepdarkpaw/nekcode-gui](https://github.com/deepdarkpaw/nekcode-gui)。

## 与 CLI 共用什么 {#shared}

| 内容 | 位置 | GUI 里的入口 |
|---|---|---|
| 服务商与模型 | `~/.nek/agent/models.json` | 设置 → 服务商 |
| 默认模型、思考等级、循环范围 | `~/.nek/agent/settings.json`（项目里是 `.nek/settings.json`） | 设置 → 默认模型 |
| 认证信息 | `~/.nek/agent/auth.json` | 设置 → 服务商 |
| Skill | `~/.nek/agent/skills/`、项目里的 `.nek/skills/` | 设置 → 技能 / 命令；输入框里的 `/` |
| 提示词模板 | `~/.nek/agent/prompts/`、项目里的 `.nek/prompts/` | 设置 → 技能 / 命令；输入框里的 `/` |
| MCP 服务器 | `~/.nek/agent/mcp.json`、项目里的 `.nek/mcp.json` | 设置 → MCP |
| 项目信任 | `~/.nek/agent/trust.json` | 首次打开项目时的确认 |
| 会话 | nek 的会话目录（默认 `~/.nek/agent/sessions/`） | 侧栏的对话列表 |

各文件的含义见 [配置总览](/customize/configuration)。GUI 不会扫描 `~/.agents/skills` 等其他目录，Skill 的位置规则和 CLI 完全一样，见 [Skills](/customize/skills#locations)。

GUI 自己只保存界面数据（窗口布局、标签页、外观设置、日志等），放在 `~/.nek/gui/v2/`。在「设置 → 数据存储路径」里可以把这部分搬到别的磁盘，`.nek/gui/v2` 这段后缀不变；nek 的配置不受影响。

## 安装与更新 {#install}

1. 先安装 nek（GUI 需要 **0.5.1-beta.7 或更新版本**），见 [安装、更新与卸载](/start/install)。没有装也可以直接启动 GUI，首次启动的引导里能一键安装。
2. 到 [nekcode-gui Releases](https://github.com/deepdarkpaw/nekcode-gui/releases) 下载安装包：Intel/AMD 电脑选 `nekcode-<版本>-win-x64.exe`，ARM 电脑选 `win-arm64`。所有文件都可以用同页的 `SHA256SUMS` 校验。

安装包没有代码签名，Windows 弹出 SmartScreen 时点「更多信息 → 仍要运行」。macOS 安装包目前不随每个 Beta 发布。

GUI 会自动检查自己的新版本，也可以在帮助菜单（右上角的 `?`）里点「检查更新」。nek 本身用 `nek update` 更新；更新前先关掉正在运行的 nek 会话，包括 GUI 里的会话。

## 输入框 {#composer}

| 输入 | 作用 |
|---|---|
| `/` | 斜杠命令、Skill 和提示词模板。这是使用 Skill 的唯一入口 |
| `@` | 引用工作区里的文件或目录，或点名一个 [子代理](/guide/subagents) |

模型正在工作时继续输入，消息会排队等待，或作为引导插入当前一轮，与 CLI 的 [排队消息](/guide/usage) 相同。

## 模型 {#models}

「设置 → 服务商」里的模型表**就是** `models.json` 本身：在 GUI 里新增、批量导入、从服务商拉取或复制的模型，都写进这个文件，效果和在 CLI 那边手动编辑完全一样。改名或删除模型时，`enabledModels` 里明确指向它的条目会一起更新。

「设置 → 默认模型 → 循环范围」对应 CLI 的 `/scoped-models`，也就是 `settings.json` 里的 `enabledModels`：

- **不设置（默认）**：GUI 的模型菜单和 CLI 的 `/model` 都显示全部已配置的模型。
- **设置后**：两边都默认只显示这些模型，循环切换也只在其中进行；模型菜单里可以切到「显示全部模型」。

如果某个模型在 GUI 能看到、在 CLI 看不到（或反过来），先检查 `enabledModels` 是否限定了范围。详见 [选择模型](/guide/models)。

## Plan 模式 {#plan}

把对话模式切到 Plan 后，nek 只调研和写计划，规则与 [Plan 模式](/guide/plan-mode) 相同。计划写好后，对话里会出现计划卡片：

- 卡片和审批按钮保存在会话里，离开一段时间、切换对话或重启 GUI 后仍在；
- 只有当前修订版本可以执行，执行时等同于 `/nek-build <计划ID> --revision <修订号>`，计划在审阅后被改过时，nek 会拒绝执行并要求重新审阅；
- 不批准而直接发送新消息，等于放弃这次审批，旧卡片不会再重复出现。

## 帮助菜单 {#help}

右上角的 `?` 菜单提供：

| 项目 | 作用 |
|---|---|
| 产品文档 | 打开本手册 |
| 导出日志 | 把 GUI 日志打包成 zip，反馈问题时附上 |
| 资源管理器 | 查看 GUI 相关进程的资源占用，以及数据目录的磁盘占用 |
| 检查更新 | 检查 GUI 新版本 |
| 关于 nekcode | 版本信息 |

## 远程开发 {#remote}

GUI 可以通过 SSH 连接 Linux 主机，在远端运行 nek，见 [Remote SSH](/gui/remote)。
