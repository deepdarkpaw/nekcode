# 上下文压缩

这一页说明自动压缩、分支摘要、它们保存的条目，以及扩展可用的钩子。日常用法见 [会话与上下文](/guide/sessions#compaction)。

nek 有两种总结机制：

| 机制 | 触发 | 目的 |
|---|---|---|
| 压缩（compaction） | 上下文超过阈值，或 `/compact` | 总结较早的消息，腾出上下文空间 |
| 分支摘要（branch summary） | 用 `/tree` 切换分支 | 切换分支时保留被放弃分支的要点 |

两者使用相近的结构化格式，并累积记录文件操作。总结请求不写入提示词缓存，因为这种一次性的提示词不太可能被复用。

## 压缩

### 何时触发

满足以下条件时自动压缩：

```text
上下文 token > 模型上下文窗口 - reserveTokens
```

`reserveTokens` 默认 16384，为模型回复留出空间。

- 多轮运行中，每批工具执行完、结果追加之后、开始下一次助手回复之前检查一次；超过阈值就在下一轮开始前压缩；
- 发送新的用户消息前检查一次；
- 服务商返回上下文溢出错误，或回复过早因长度截断（`stopReason: "length"`）时，会进行一次“压缩并重试”的恢复。

也可以用 `/compact [说明]` 手动压缩，说明会引导摘要的重点。

### 工作过程

1. **找切点**：从最新的消息往回累加 token 估算，直到达到 `keepRecentTokens`（默认 20000）；
2. **取出消息**：收集从上一次保留边界（或会话开头）到切点之间的消息；
3. **生成摘要**：调用模型生成结构化摘要；有上一次的摘要时作为迭代上下文一起提供；
4. **追加条目**：保存一个 `CompactionEntry`，记录摘要和 `firstKeptEntryId`；
5. **重建上下文**：之后的请求使用“摘要 + 从 `firstKeptEntryId` 开始的消息”。

```text
压缩前：

  条目:   0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┘
                └────────┬───────┘ └──────────────┬──────────────┘
                     要总结的消息                   保留的消息
                                   ↑
                          firstKeptEntryId（条目 4）

压缩后（追加新条目）：

  条目:   0     1     2     3      4     5     6      7      8     9     10
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬─────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool│ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴─────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                   不再发给模型                           发给模型

模型看到的：

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
```

再次压缩时，总结的范围从上一次压缩的保留边界开始，所以上一次幸存下来的消息会在这次被一起总结。原始条目仍然保存在会话里。

### 一条用户消息就超过预算

正常情况下切点落在用户消息处。如果从某条用户消息开始的这一段本身就超过了 `keepRecentTokens`，切点会落在这一段中间的某条助手消息上。这时 nek 生成两份摘要并合并：之前历史的摘要，以及这一段前半部分的摘要。

### 可以作为切点的位置

用户消息、助手消息、`!` 命令的执行记录、自定义消息（custom_message、branch_summary）。工具结果**不能**作为切点，它必须和对应的工具调用在一起。

### 溢出恢复的顺序

```text
保存最终的助手回复
→ turn_end
→ agent_end
→ 为这次尝试追加 context_edit（从上下文中省略）
→ 溢出/长度截断：运行 session_before_compact，成功则追加压缩条目
→ 以全新的运行重试
```

恢复压缩失败或被取消时，保留省略编辑，不追加压缩，也不安排重试。

## 摘要格式

压缩摘要的格式：

```markdown
## Goal
[用户要完成什么]

## Constraints & Preferences
- [用户提出的要求]

## Progress
### Done
- [x] [已完成的任务]

### In Progress
- [ ] [进行中的工作]

### Blocked
- [阻塞的问题]

## Key Decisions
- **[决定]**: [理由]

## Next Steps
1. [接下来要做的]

## Critical Context
- [继续工作需要的数据]

<read-files>
path/to/file1.ts
</read-files>

<modified-files>
path/to/changed.ts
</modified-files>
```

摘要被要求作为一个“续接检查点”：优先最新的用户要求，区分尝试和结果，保留精确的路径、符号、错误信息和测试证据，删除已经过时的状态。分支摘要格式相同，但到 Next Steps 为止。

### 摘要的输入 {#content}

总结请求使用一份单独的、有长度上限的旧对话表示，**不改写**原始记录：

- **思考内容**视为未经验证的推理。较长的思考只保留一小段开头，并优先保留结尾的段落（结论和下一步通常在那里）；整个会话有总预算，避免大量旧思考塞满总结请求；
- **工具调用**保留工具名和调用 ID，过长的参数被折叠（大段的 `write`/`edit` 内容不会原样复制进去）；
- **工具结果**保留工具名、调用 ID、状态和有限的摘录。`read` 的结果可以带上原始记录中的分块标签；shell 输出保留选定的诊断行；图片只标注存在，不包含内容。

```text
[User]: What they said
[Assistant thinking (unverified reasoning)]: final reasoning excerpt
[Assistant]: Response text
[Assistant tool calls]: read(path="foo.ts") [id=call-1]
[Tool result read id=call-1 OK]: bounded output excerpt
```

### 清理保留区里的旧工具结果

内置压缩成功后，保留区中较旧的、成功的文本工具结果可能被替换为更短的版本。原始的工具结果条目仍保存在数据库里，压缩条目记录经过校验的目标 ID、工具调用 ID 和替换文本；续接、`/tree`、导入 JSONL 和 durable 会话时都会重放这个替换。最近的结果、最新一批工具调用、错误、图片、未知工具和扩展自己的压缩不受影响。摘要失败时不做清理。

默认值：

```json
{
  "compaction": {
    "content": {
      "thinkingMaxChars": 3000,
      "thinkingTotalMaxChars": 24000,
      "toolResultMaxChars": 2000,
      "toolErrorMaxChars": 6000,
      "toolArgumentMaxChars": 2000,
      "pruneToolResults": true,
      "protectedRecentTokens": 8000,
      "protectedToolResults": 6
    }
  }
}
```

| 键 | 说明 |
|---|---|
| `thinkingMaxChars` | 单个思考块在摘要输入中的字符上限 |
| `thinkingTotalMaxChars` | 所有思考内容的总字符上限 |
| `toolResultMaxChars` | 单个成功工具结果的字符上限 |
| `toolErrorMaxChars` | 单个错误工具结果的字符上限 |
| `toolArgumentMaxChars` | 单个工具调用参数的字符上限 |
| `pruneToolResults` | 是否清理保留区里的旧工具结果；`false` 保持不变 |
| `protectedRecentTokens` | 最近这么多 token 内的结果不清理 |
| `protectedToolResults` | 最近这么多个工具结果不清理 |

分支摘要使用同样的折叠表示，但不写清理编辑。

## 设置

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

| 设置 | 默认值 | 说明 |
|---|---|---|
| `enabled` | `true` | 启用自动压缩（关闭后仍可 `/compact`） |
| `reserveTokens` | `16384` | 为回复预留的 token；也影响摘要输出上限 |
| `keepRecentTokens` | `20000` | 原样保留的近期 token |
| `modelOverrides` | 无 | 按模型覆盖上面两项 |
| `model` | 无 | 写摘要的模型 |
| `thinkingLevel` | 会话的等级 | 写摘要时的思考等级 |
| `content` | 内置策略 | 见 [摘要的输入](#content) |

### 按模型覆盖

```json
{
  "compaction": {
    "reserveTokens": 16384,
    "keepRecentTokens": 20000,
    "modelOverrides": {
      "some-provider/big-model": {
        "reserveTokens": 400000
      }
    }
  }
}
```

对于上下文窗口 1M 的模型，这个覆盖让压缩在超过 600K token 时触发，并保留普通的 20000 近期 token。其他模型仍用 16384 的预留。

键是精确的、区分大小写的 `服务商/模型ID`。每个值独立地按“模型覆盖 → 普通设置 → 内置默认”解析，必须是非负的安全整数，无效值在读取时报错。`enabled` 是全局的，不能按模型设置。全局和项目设置先递归合并再查找，所以全局的模型级值会胜过项目的普通值；项目需要覆盖同一个模型条目才能改变它。

### 压缩用的模型 {#compaction-model}

默认用主模型写压缩摘要。可以指定另一个模型，例如更便宜或上下文更长的：

```json
{
  "compaction": {
    "model": "some-provider/cheap-model",
    "thinkingLevel": "high"
  }
}
```

- 配置的模型负责所有内置压缩：`/compact`、阈值压缩、溢出恢复，以及崩溃后续跑的手动压缩。对话本身仍然用主模型；
- 触发阈值、`reserveTokens`、`keepRecentTokens` 仍然按**主模型**计算（包括主模型的 `modelOverrides`）。摘要输出上限由主模型的 `reserveTokens` 决定，并受压缩模型的最大输出限制；
- nek **不会**退回主模型。以下情况压缩直接报错（错误信息会点名 `compaction.model`）：
  - 值不是精确的 `服务商/模型ID`，或没有匹配的已注册模型；
  - 该模型的服务商没有可用的凭据；
  - 某个总结请求放不进压缩模型的上下文窗口（按约 4 字符/token 估算请求，加上输出上限，在发送前检查；上下文窗口未知的模型不检查）；
- 模型和凭据在 `session_before_compact` 之前解析，所以即使扩展会提供自己的摘要，无效的 `compaction.model` 也会导致压缩失败。

`compaction.thinkingLevel`（`off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`）必须是摘要模型（`compaction.model`，未设置时为主模型）支持的等级，否则压缩报错，不会自动降级。分支摘要始终使用主模型，不受这两个设置影响。

## 分支摘要

用 `/tree` 切换到另一个分支时，nek 会询问是否总结你离开的那条分支：

1. 找到新旧位置的最近公共祖先；
2. 收集从旧叶节点到公共祖先之间的条目；
3. 在 token 预算内（从最新的开始）准备消息；
4. 调用模型生成结构化摘要；
5. 在切换到的位置追加一个 `BranchSummaryEntry`。

```text
切换前：

         ┌─ B ─ C ─ D（旧叶节点，将被放弃）
    A ───┤
         └─ E ─ F（目标）

公共祖先：A，要总结的条目：B、C、D

切换并生成摘要后：

         ┌─ B ─ C ─ D
    A ───┤
         └─ E ─ F ─ [B、C、D 的摘要]（新叶节点）
```

### 文件记录的累积

默认的压缩和分支摘要都会从被总结消息的工具调用中提取文件操作，并累积记录：压缩会带上前一次内置压缩的文件列表；分支摘要会带上它所总结的条目中内置分支摘要的文件列表。扩展生成的摘要（`fromHook: true`）不会自动带入文件列表，扩展自行管理 `details`。

## 扩展钩子

### session_before_compact

自动压缩或 `/compact` 之前触发，可以取消压缩或提供自定义摘要：

```typescript
pi.on("session_before_compact", async (event, ctx) => {
  const { preparation, branchEntries, customInstructions, reason, willRetry, signal } = event;
  // preparation.messagesToSummarize   要总结的消息
  // preparation.turnPrefixMessages    被切开的那一段的前半部分
  // preparation.previousSummary       上一次的摘要
  // preparation.fileOps               提取出的文件操作
  // preparation.tokensBefore          压缩前的上下文 token
  // preparation.firstKeptEntryId      保留消息的起点
  // preparation.settings              应用模型覆盖后的有效设置
  // reason: "manual" | "threshold" | "overflow"

  // 取消：
  // return { cancel: true };

  // 自定义摘要：
  return {
    compaction: {
      summary: "Your summary...",
      firstKeptEntryId: preparation.firstKeptEntryId,
      tokensBefore: preparation.tokensBefore,
      details: {},
    },
  };
});
```

用 `serializeConversation(convertToLlm(preparation.messagesToSummarize))` 把消息转成文本，再交给你自己的模型总结。源码中的 `examples/extensions/custom-compaction.ts` 是一个完整示例。

### session_compact_failed

手动或自动压缩失败或被中止时触发，字段有 `reason`、`errorMessage`、`aborted`、`willRetry`、`fromExtension`，适合遥测类扩展把尝试和结果配对。

### session_before_tree

`/tree` 导航之前触发（无论用户是否选择生成摘要），可以取消导航，或在 `preparation.userWantsSummary` 为真时提供自定义摘要：

```typescript
pi.on("session_before_tree", async (event, ctx) => {
  const { preparation } = event;
  // preparation.targetId / oldLeafId / commonAncestorId / entriesToSummarize / userWantsSummary
  if (preparation.userWantsSummary) {
    return { summary: { summary: "Your summary...", details: {} } };
  }
});
```

## 条目结构

```typescript
interface CompactionEntry<T = unknown> {
  type: "compaction";
  id: string;
  parentId: string | null;
  timestamp: string;
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  usage?: Usage;       // 生成摘要的用量
  fromHook?: boolean;  // 由扩展提供时为 true
  details?: T;         // 默认为 { readFiles: string[]; modifiedFiles: string[] }
}

interface BranchSummaryEntry<T = unknown> {
  type: "branch_summary";
  id: string;
  parentId: string | null;
  timestamp: string;
  summary: string;
  fromId: string;      // 离开时所在的条目
  usage?: Usage;
  fromHook?: boolean;
  details?: T;
}
```

更多见 [会话文件格式](/reference/session-format)。
