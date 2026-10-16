# 配置总览

nek 的配置分为**用户级**和**项目级**两层：

- 用户级数据在 `~/.nek/agent/`（可用环境变量 `NEK_CODING_AGENT_DIR` 改变，下文称“agent 目录”），对所有项目生效；
- 项目级配置在工作目录下的 `.nek/`，在[信任项目](/guide/security#project-trust)之后才加载。例外是 `sessionDir`，它在决定信任之前就会被读取，以便定位会话。

交互模式下用 `/settings` 修改常用设置。手动修改设置、快捷键、指令文件或资源之后，运行 `/reload` 让当前会话生效。

公共版本只提供应用默认值和通用示例，不附带个人 `AGENTS.md`、settings、凭据或自定义子代理文件。没有 `settings.json`（或内容为 `{}`）时使用内置默认值；内置子代理只有继承父会话模型的 `explorer`。个人配置保留在本机，发布项目时不要把它们提交到 GitHub。

## agent 目录（用户级） {#agent-dir}

| 路径 | 作用 |
|---|---|
| `settings.json` | 用户级 [设置](/reference/settings) |
| `nek.yaml` | nek 独有功能的配置：Plan、Todo、子代理，见 [nek.yaml](/reference/nek-yaml) |
| `keybindings.json` | 自定义 [快捷键](/reference/keybindings) |
| `models.json` | [兼容接口、自定义模型和模型元数据覆盖](/guide/models#compatible-endpoint) |
| `auth.json` | 保存的 API key 和 OAuth 凭据（**勿外传**） |
| `mcp.json` | [MCP 服务器](/guide/mcp) |
| `mcp-auth.json` | MCP 服务器的 OAuth 凭据 |
| `trust.json` | 保存的 [项目信任](/guide/security#project-trust) 决定 |
| `AGENTS.md`（或 `AGENTS.override.md`、`CLAUDE.md` 等） | 对所有项目生效的 [指令](/customize/context-files) |
| `SYSTEM.md` | 替换默认系统提示词（nek 的一句身份说明仍保留在最前面） |
| `APPEND_SYSTEM.md` | 追加到系统提示词末尾 |
| `agents/*.md` | 自定义 [子代理类型](/guide/subagents#custom-types) |
| `extensions/` | 自动加载的 [扩展](/customize/loading-extensions) |
| `skills/` | 用户级 [Skills](/customize/skills) |
| `prompts/` | 用户级 [提示词模板](/customize/prompt-templates) |
| `themes/` | 用户级 [主题](/customize/themes) |
| `sessions/` | 会话存储（可用 `sessionDir` 等改变，见 [会话与上下文](/guide/sessions#storage)） |
| `bin/` | 自动下载的 fd、rg、ast-grep |
| `mcp.log` | MCP 服务器日志 |
| `nek-debug.log` | `/debug` 写出的诊断信息 |

## 项目 `.nek` 目录 {#project-dir}

| 路径 | 作用 |
|---|---|
| `.nek/settings.json` | 项目级设置，覆盖用户级同名设置 |
| `.nek/nek.yaml` | 项目级 nek 配置 |
| `.nek/mcp.json` | 项目级 MCP 服务器 |
| `.nek/agents/*.md` | 项目级子代理类型 |
| `.nek/SYSTEM.md` | 替换本项目的系统提示词 |
| `.nek/APPEND_SYSTEM.md` | 追加本项目的系统提示词 |
| `.nek/extensions/` | 项目扩展 |
| `.nek/skills/` | 项目 Skills |
| `.nek/prompts/` | 项目提示词模板 |
| `.nek/themes/` | 项目主题 |
| `.nek/plans/` | Plan 模式写出的计划文件 |

以上除 `plans/` 外都要在信任项目后才加载。项目里的 `AGENTS.md` 不在 `.nek/` 里，而是放在项目目录本身，见 [项目指令](/customize/context-files)。

## 合并规则

- **settings.json**：项目设置覆盖用户设置；对象类型的设置（如 `compaction`）递归合并；资源列表（`skills`、`prompts` 等）合并。
- **nek.yaml**：先读用户级，再读项目级覆盖。
- **mcp.json**：项目里的同名服务器替换用户级的条目（只写开关字段时只覆盖开关）。
- **agents/**：同名时项目 > 用户 > 内置。
- 有几项只能在用户级设置：`defaultProjectTrust`、`httpProxy`、`cacheWarming`。

## 系统提示词文件

- `SYSTEM.md` 整体替换默认的系统提示词。nek 会在它前面保留一句身份说明（“You are working inside nekcode, a terminal coding agent.”）。
- `APPEND_SYSTEM.md` 在系统提示词末尾追加内容。
- 项目级的同名文件作用于该项目。
- 命令行也能临时指定：`--system-prompt <文本或文件>`、`--append-system-prompt <文本或文件>`（可重复）。

一般情况下优先用 `AGENTS.md` 写项目指令，它不会改动 nek 的基础提示词和工具说明。

## 数据目录与 pi 的关系

nek 使用独立的数据目录，不读取也不迁移 `~/.pi/` 里的数据。从 pi 迁移时，可以手动复制需要的文件（例如 `models.json`、`AGENTS.md`、`skills/`、`prompts/`、`themes/`），把项目里的 `.pi/` 改成 `.nek/`。凭据建议用 `/login` 重新登录。

## 相关页面

- [settings.json 参考](/reference/settings)
- [nek.yaml 参考](/reference/nek-yaml)
- [环境变量](/reference/environment-variables)
- [项目指令（AGENTS.md）](/customize/context-files)
