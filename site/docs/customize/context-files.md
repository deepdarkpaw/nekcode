# 项目指令（AGENTS.md）

项目指令（context file）是写给模型的长期说明：项目怎么构建、代码风格、哪些目录不要动、提交信息的格式等等。nek 会在每次请求时把它们交给模型。

这是最简单、最推荐的定制方式：不需要写代码，对 nek 的基础行为也没有副作用。

## 文件名与查找规则

nek 在每个目录里按以下优先级查找**一个**指令文件，找到第一个就停止：

1. `AGENTS.override.md`
2. `AGENTS.md`
3. `AGENTS.MD`
4. `CLAUDE.md`
5. `CLAUDE.MD`

查找的目录：

1. **agent 目录**（`~/.nek/agent/`）：对所有项目生效；
2. **工作目录及其所有上级目录**，一直到文件系统根目录。

加载顺序是：agent 目录的文件在最前，然后从最外层的上级目录一直到工作目录。所以越靠近工作目录的指令越靠后，也就越“具体”。

例如在 `~/work/shop/api` 里启动 nek：

```text
~/.nek/agent/AGENTS.md      ← 1. 个人通用习惯
~/work/AGENTS.md            ← 2. 工作区约定
~/work/shop/AGENTS.md       ← 3. 仓库约定
~/work/shop/api/AGENTS.md   ← 4. api 子项目的约定
```

四个文件都会加载。

### AGENTS.override.md

`AGENTS.override.md` 只在**同一个目录里**替代 `AGENTS.md` / `CLAUDE.md`，不影响 agent 目录或其他目录的指令文件。适合在不改动团队共享的 `AGENTS.md` 的前提下，放一份个人版本（记得把它加进 `.gitignore`）。

nekcode 仓库的 `AGENTS.md` 只包含通用开发说明；本仓库已忽略 `AGENTS.override.md` 和 `.nek/`。全局个人指令放在 `~/.nek/agent/AGENTS.md`，不要把个人指令复制到公开仓库的默认文件里。

### git worktree

在嵌套于主仓库内的 git worktree 中工作时，worktree 自己的指令文件会屏蔽主仓库根目录的同名文件，避免同一份仓库指令被加载两次。

## 指令如何发给模型

指令文件**不**放在系统提示词里。每次请求时，nek 在开头的系统消息之后插入一条单独的消息，内容大致是：

```text
<project_instructions>
（各指令文件的内容，按上面的顺序，每个文件标注路径）
</project_instructions>
```

这条消息不写入对话记录。这样在一个会话里，系统提示词和工具声明保持不变，服务商的提示词缓存不会因为你修改了指令而整段失效。

后面的指令优先于前面的指令；你在对话中的最新要求优先于所有指令文件。

## 信任与安全

指令文件的加载**不需要**项目信任。也就是说，在一个不受信任的仓库里启动 nek，那个仓库的 `AGENTS.md` 仍然会被加载。请把陌生仓库里的指令当作不可信输入，见 [安全使用](/guide/security)。

不想加载任何指令文件时：

```bash
nek --no-context-files     # 或 -nc
```

## 修改后生效

会话进行中修改了指令文件，运行 `/reload`。启动信息（按 `Ctrl+O` 展开）会列出当前加载了哪些指令文件。

## 写好指令的建议

- 写**具体、可验证**的规则：“提交前运行 `npm run check`”比“保证代码质量”有用。
- 写清楚项目的命令：怎么安装依赖、构建、跑测试、跑单个测试。
- 写下不能做的事：不能改的目录、不能提交的文件、禁止的命令。
- 保持简短。指令每次请求都会发送，冗长的指令会占用上下文。
- 大段的专项知识（某个子系统的设计、某类任务的步骤）更适合做成 [Skill](/customize/skills)，按需加载。

示例：

```markdown
# 项目约定

## 命令
- 安装依赖：`pnpm install`
- 检查：`pnpm check`（改完代码后必须运行，修复所有错误）
- 单个测试：`pnpm vitest run path/to/file.test.ts`

## 代码
- TypeScript 严格模式，不要使用 `any`
- 新的 API 路由放在 `src/routes/`，每个路由一个文件

## 禁止
- 不要修改 `src/generated/`，它由 `pnpm codegen` 生成
- 未经要求不要提交（git commit）
```

## 其他改变系统提示词的方式

| 方式 | 作用 |
|---|---|
| `~/.nek/agent/APPEND_SYSTEM.md`、`.nek/APPEND_SYSTEM.md` | 在系统提示词末尾追加 |
| `~/.nek/agent/SYSTEM.md`、`.nek/SYSTEM.md` | 替换整个默认系统提示词（身份句保留） |
| `--append-system-prompt <文本或文件>` | 本次运行追加 |
| `--system-prompt <文本或文件>` | 本次运行替换 |

替换系统提示词会丢掉 nek 默认的工具使用说明和工作方式约定，一般不建议。
