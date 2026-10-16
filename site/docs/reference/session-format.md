# 会话文件格式

一个会话是由**条目（entry）**组成的树。每个条目是一个带 `type` 字段的 JSON 对象，通过 `id` / `parentId` 连成树，所以可以在同一个会话里原地分支，不需要新建文件。

会话由 durable 引擎存储在 SQLite 数据库中（它还记录进行中一轮的每一步，以便崩溃后续跑，见 [Durable 会话](/reference/durable-sessions)）。`SessionManager` 把它们读回为下面描述的条目。旧的会话是 JSONL 文件（每行一个条目），打开时会被导入；`/export` 写出的也是同样的 JSONL 格式。

## 文件位置

```text
~/.nek/agent/sessions/--<路径>--/<时间戳>_<会话ID>.sqlite
~/.nek/agent/sessions/--<路径>--/<时间戳>_<会话ID>.meta.json
```

- `<会话ID>` 默认是 UUID，也可以通过 SDK 或 `--session-id` 指定；
- `<路径>` 是工作目录去掉开头的路径分隔符后，把 `/`、`\`、`:` 替换为 `-`；
- `.meta.json` 缓存 `/resume` 列表，缺失或过期时从数据库重建；进程打开会话期间有一个 `.lock` 文件；
- 打开 `<名字>.jsonl` 会导入为 `<名字>.sqlite`，JSONL 文件不变；
- 子代理的会话存放在父会话目录下的 `subagents/` 中。

## 删除会话

删除 `~/.nek/agent/sessions/` 下对应的 `.sqlite` 和 `.meta.json` 文件（以及可能存在的旧 `.jsonl`）。也可以在 `/resume` 里选中后按 `Ctrl+D` 并确认；有 `trash` 命令时 nek 会把文件移到回收站。

## 版本

会话头里有版本号：

- **v1**：线性条目序列（旧版，加载时自动迁移）；
- **v2**：用 `id` / `parentId` 组成树；
- **v3**：把 `hookMessage` 角色改名为 `custom`。

加载时自动迁移到当前版本（v3）。

## 条目基础字段 {#entry-base}

除会话头外，所有条目都有：

```typescript
interface SessionEntryBase {
  type: string;
  id: string;               // 通常是 8 位十六进制，也可能是完整 UUID
  parentId: string | null;  // 父条目 ID，根条目为 null
  timestamp: string;        // ISO 8601 时间
}
```

条目的时间戳是 ISO 8601 字符串；其中嵌套的消息时间戳是毫秒级 Unix 时间戳。

## 条目类型 {#entry-types}

### 会话头（session）

文件的第一行，只是元数据，不在树里（没有 `id` / `parentId`）：

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project"}
```

有父会话时（通过 `/fork`、`/clone` 或 `newSession({ parentSession })` 创建）带 `parentSession`：

```json
{"type":"session","version":3,"id":"uuid","timestamp":"2024-12-03T14:00:00.000Z","cwd":"/path/to/project","parentSession":"/path/to/original/session.jsonl"}
```

### 消息（message）

`message` 字段是一个 [`AgentMessage`](/reference/message-types)。

系统消息承载提示词和工具集：会话的第一次请求保存一条包含全部提示词分节和工具声明的系统消息；之后的变化保存为按名字修改 `sections`（`null` 表示删除）、列出 `toolsAdded` / `toolsRemoved` 的系统消息。按顺序重放就得到当前的提示词和工具。

```json
{"type":"message","id":"a0b1c2d3","parentId":null,"timestamp":"2024-12-03T14:00:00.000Z","message":{"role":"system","content":"","sections":{"preamble":"...","tools":"<tools>...</tools>"},"toolsAdded":[{"name":"read","description":"...","parameters":{}}],"timestamp":1733234400000}}
{"type":"message","id":"a1b2c3d4","parentId":"a0b1c2d3","timestamp":"2024-12-03T14:00:01.000Z","message":{"role":"user","content":"Hello","timestamp":1733234401000}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}],"api":"anthropic-messages","provider":"anthropic","model":"claude-sonnet-4-5","usage":{},"stopReason":"stop","timestamp":1733234402000}}
{"type":"message","id":"c3d4e5f6","parentId":"b2c3d4e5","timestamp":"2024-12-03T14:00:03.000Z","message":{"role":"toolResult","toolCallId":"call_123","toolName":"bash","content":[{"type":"text","text":"output"}],"isError":false,"timestamp":1733234403000}}
```

### 模型变更（model_change）

```json
{"type":"model_change","id":"d4e5f6g7","parentId":"c3d4e5f6","timestamp":"2024-12-03T14:05:00.000Z","provider":"openai","modelId":"gpt-4o"}
```

### 思考等级变更（thinking_level_change）

```json
{"type":"thinking_level_change","id":"e5f6g7h8","parentId":"d4e5f6g7","timestamp":"2024-12-03T14:06:00.000Z","thinkingLevel":"high"}
```

### 用量（usage）

记录不属于助手消息、也不进入模型上下文的用量，例如缓存预热（`kind: "cache_warm"`）。计入会话的 token 和费用统计，在会话树中隐藏。遇到未知的 `kind` 应当作普通用量处理。

```json
{"type":"usage","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:08:00.000Z","kind":"cache_warm","provider":"anthropic","model":"claude-sonnet-4-5","usage":{"input":0,"output":0,"cacheRead":50000,"cacheWrite":0,"totalTokens":50000,"cost":{"input":0,"output":0,"cacheRead":0.015,"cacheWrite":0,"total":0.015}}}
```

### 压缩（compaction）

```json
{"type":"compaction","id":"f6g7h8i9","parentId":"e5f6g7h8","timestamp":"2024-12-03T14:10:00.000Z","summary":"User discussed X, Y, Z...","firstKeptEntryId":"c3d4e5f6","tokensBefore":50000,"systemMessage":{"role":"system","content":"...","toolsAdded":[],"timestamp":1733235000000}}
```

- `firstKeptEntryId`（必填）：压缩前保留下来的第一个条目。重建上下文时，用摘要代替之前的条目，从这个条目开始保留。不保留任何条目时存的是压缩条目自己的 ID；
- `systemMessage`：压缩边界处完整的提示词和工具检查点，成为压缩后上下文的开头系统消息；
- `usage`：生成摘要的用量；
- `details`：实现相关的数据（默认是 `{ readFiles, modifiedFiles }`）；
- `fromHook`：由扩展生成时为 `true`。

### 上下文编辑（context_edit）

对之前某个产生上下文的条目做追加式的编辑，只改变之后的模型上下文；原条目在原始历史、界面、导出和统计中保持不变。

```json
{"type":"context_edit","id":"g6h7i8j9","parentId":"f6g7h8i9","timestamp":"2024-12-03T14:11:00.000Z","targetId":"c3d4e5f6","replacement":null}
```

目标可以是用户、助手、工具结果或自定义消息条目。`replacement: null` 把目标从上下文中省略；非 null 时只替换目标消息的内容。同一目标有多个编辑时，活动分支上最新的生效。编辑是分支相关的：导航到编辑之前的位置会重新看到原内容。

### 分支摘要（branch_summary）

```json
{"type":"branch_summary","id":"g7h8i9j0","parentId":"a1b2c3d4","timestamp":"2024-12-03T14:15:00.000Z","fromId":"f6g7h8i9","summary":"Branch explored approach A..."}
```

`parentId` 是新分支继续的位置，`fromId` 是被总结的那条路径的旧叶节点。可选 `usage`、`details`、`fromHook`。

### 自定义条目（custom）

扩展保存状态用，**不**进入模型上下文：

```json
{"type":"custom","id":"h8i9j0k1","parentId":"g7h8i9j0","timestamp":"2024-12-03T14:20:00.000Z","customType":"my-extension","data":{"count":42}}
```

用 `customType` 在重新加载时识别自己的条目。交互模式可以用 `pi.registerEntryRenderer(customType, renderer)` 渲染它们。

### 自定义消息（custom_message）

扩展注入的消息，**会**进入模型上下文：

```json
{"type":"custom_message","id":"i9j0k1l2","parentId":"h8i9j0k1","timestamp":"2024-12-03T14:25:00.000Z","customType":"my-extension","content":"Injected context...","display":true}
```

`content` 是字符串或 `(TextContent | ImageContent)[]`；`display` 为 `true` 时在界面中以特殊样式显示；`details` 不发给模型。

### 标签（label）

用户在某个条目上做的书签：

```json
{"type":"label","id":"j0k1l2m3","parentId":"i9j0k1l2","timestamp":"2024-12-03T14:30:00.000Z","targetId":"a1b2c3d4","label":"checkpoint-1"}
```

`label` 为 `undefined` 表示清除。

### 会话信息（session_info）

会话元数据，例如通过 `/name`、`--name` 或 `pi.setSessionName()` 设置的显示名，`/resume` 列表中用它代替第一条消息：

```json
{"type":"session_info","id":"k1l2m3n4","parentId":"j0k1l2m3","timestamp":"2024-12-03T14:35:00.000Z","name":"Refactor auth module"}
```

## 树结构

- 根条目的 `parentId` 为 `null`；
- 非根条目通过 `parentId` 指向父条目；
- 分支是从较早的条目长出新的子条目；
- “叶节点”是树中的当前位置；
- 导航 API 可能产生多个根。

```text
[user] ─── [assistant] ─── [user] ─── [assistant] ─┬─ [user] ← 当前叶节点
                                                    │
                                                    └─ [branch_summary] ─── [user] ← 另一个分支
```

## 构建上下文

1. 从当前叶节点走到根，收集路径上的条目；
2. 路径上有压缩条目时使用最新的一个：先放压缩条目，再放从 `firstKeptEntryId` 到压缩条目之前的非系统条目，再放压缩之后的条目；
3. 对每个目标应用最新的 `context_edit`；
4. 转换为模型消息：`message` → 保存的消息；`compaction` → 完整的系统检查点加摘要消息；`branch_summary` → 分支摘要消息；`custom_message` → 自定义消息；`context_edit`、`usage`、`custom` 不产生消息。

## 读取示例

`SessionManager` 同时支持 `.sqlite` 和 `.jsonl`：

```typescript
import { SessionManager } from "@earendil-works/pi-coding-agent";

const session = SessionManager.open("session.sqlite");
const header = session.getHeader();
if (header) console.log(`Session v${header.version ?? 1}: ${header.id}`);

for (const entry of session.getEntries()) {
  switch (entry.type) {
    case "message":
      console.log(`[${entry.id}] ${entry.message.role}`);
      break;
    case "compaction":
      console.log(`[${entry.id}] Compaction: ${entry.tokensBefore} tokens summarized`);
      break;
    case "model_change":
      console.log(`[${entry.id}] Model: ${entry.provider}/${entry.modelId}`);
      break;
  }
}
```
