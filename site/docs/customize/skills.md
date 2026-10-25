# Skills

Skill 为某一类工作提供专项说明和配套文件。nek 只把每个 Skill 的名字和描述告诉模型，任务需要时模型才读取完整的说明。这样详细的指导不会一直占用上下文。

当一个工作流程需要比提示词模板更多的上下文、但又不需要新的可执行能力时，用 Skill。Skill 可以附带脚本、参考资料和其他资源。

nek 实现了 [Agent Skills 规范](https://agentskills.io/specification)。大多数无效字段只产生警告，不会阻止启动。

## 创建 Skill

一个 Skill 是一个包含 `SKILL.md` 的目录：

```text
pdf-tools/
├── SKILL.md
├── scripts/
│   └── extract.sh
├── references/
│   └── formats.md
└── assets/
    └── template.json
```

`SKILL.md` 以 frontmatter 开头，后面是直接的说明：

```markdown
---
name: pdf-tools
description: Extract text and tables from PDF files. Use when reading, converting, or inspecting PDFs.
---

# PDF tools

Read `references/formats.md` before converting a document. Run scripts relative to this skill directory.
```

**描述决定模型何时考虑加载这个 Skill。** 同时写清楚“它做什么”和“什么时候用”。像“帮助处理 PDF”这样的描述提供的信息不够。

引用附带的文件时使用相对于 Skill 目录的路径，nek 会告诉模型 Skill 所在的位置，让它能解析这些路径。

## Skill 如何加载

1. 启动时，nek 扫描配置的 Skill 位置，把每个 Skill 的名字、描述和路径加入系统提示词（不含完整说明）；
2. 任务匹配时，模型读取 `SKILL.md` 并按说明工作。

模型有可能没有加载一个相关的 Skill。需要强制使用时，用 `/skill:名字`：

```text
/skill:pdf-tools extract report.pdf
```

命令后面的参数会作为用户请求附加在加载的说明之后。

也可以在消息任意位置写 `@skill:名字`（输入 `@` 会补全）。对话里只显示你输入的原文，完整说明作为隐藏消息紧跟在后面发给模型，一条消息可以引用多个 Skill，见 [点名子代理和 Skill](/guide/usage#mentions)。

- frontmatter 中设置 `disable-model-invocation: true`：Skill 不出现在模型的自动选择里，只能通过命令或 `@skill:名字` 使用。
- 设置 `enableSkillCommands`（默认 `true`）控制 Skill 命令是否出现在命令补全里；手动输入的 `/skill:名字` 始终有效，`@` 补全里的 Skill 不受这个设置影响。

## 放在哪里 {#locations}

| 位置 | 作用范围 |
|---|---|
| `~/.nek/agent/skills/` | 用户级 |
| `~/.agents/skills/` | 用户级（Agent Skills 通用位置） |
| `.nek/skills/` | 项目级，信任项目后加载 |
| `.agents/skills/` | 项目级，从工作目录向上查找各级目录（有仓库时到仓库根为止），信任项目后加载 |
| 设置 `skills` | 额外的文件或目录 |
| `--skill <路径>` | 只对本次运行生效（可重复） |

包含 `SKILL.md` 的目录会被递归发现。nek 也接受部分独立的 Markdown Skill 文件，但包含 `SKILL.md` 的目录是可移植的形式，推荐使用。

`--no-skills`（`-ns`）关闭 Skill 的自动发现和配置加载，显式的 `--skill` 仍然生效。

::: warning 审查项目 Skill
项目 Skill 可以指示模型运行脚本或修改文件。信任陌生项目前，请检查它的 Skill 及配套文件。
:::

## frontmatter 字段

| 字段 | 作用 |
|---|---|
| `name` | 命令名和显示名 |
| `description` | 给模型看的路由描述 |
| `license` | 许可证名称或附带的许可证文件 |
| `compatibility` | 环境要求 |
| `metadata` | 额外的键值元数据 |
| `allowed-tools` | 实验性的预批准工具列表 |
| `disable-model-invocation` | 不参与模型的自动选择 |

规则：

- 名字只能用小写字母、数字和连字符，不能以连字符开头或结尾，也不能有连续的连字符，最多 64 个字符；描述最多 1024 个字符。
- nek 不要求名字与所在目录同名，也不会因此警告；但其他 Agent Skills 实现可能要求，保持一致更具可移植性。
- 格式错误的 `SKILL.md`、没有描述的 Skill 不会加载。
- 名字冲突时保留第一个发现的 Skill 并给出警告。

## 验证和分享

在能发现该 Skill 的位置启动 nek，检查启动诊断信息（`Ctrl+O` 展开启动信息）和 `/skill:名字` 命令。会话中编辑 Skill 后运行 `/reload`。

分享时直接分发整个 Skill 目录即可（例如放进一个 git 仓库，让别人克隆到 `~/.nek/agent/skills/`）。把环境准备写在 Skill 的说明里，并声明它需要的运行时依赖。

可以参考的 Skill 集合：[Anthropic skills](https://github.com/anthropics/skills)、[pi-skills](https://github.com/badlogic/pi-skills)。
