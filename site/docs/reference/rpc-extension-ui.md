# RPC 扩展 UI

扩展通过 `ctx.ui` 请求用户交互。在 RPC 模式下，支持的调用变成一个请求/响应子协议，与普通的 [RPC 命令](/reference/rpc-commands) 和 [会话事件](/reference/json) 并行。

扩展界面方法分两类：

- **对话框方法**（`select`、`confirm`、`input`、`editor`，以及仅限 RPC 的 `structured`）：在 stdout 发出 `extension_ui_request`，然后阻塞，直到客户端在 stdin 发回 `id` 相同的 `extension_ui_response`；
- **即发即弃方法**（`notify`、`setStatus`、`setWidget`、`setTitle`、`set_editor_text`）：在 stdout 发出 `extension_ui_request`，不需要响应。客户端可以显示，也可以忽略。

对话框请求带有 `timeout` 字段时，超时后 nek 一侧会自动以默认值结束，客户端不需要自己跟踪超时。

## 限制

需要直接访问终端界面的方法在 RPC 模式下不支持或降级：

- `custom()` 返回 `undefined`；
- `onTerminalInput()` 返回一个空操作的取消订阅函数；
- `setWorkingMessage()`、`setWorkingVisible()`、`setWorkingIndicator()`、`setHiddenThinkingLabel()`、`setFooter()`、`setHeader()`、`addAutocompleteProvider()`、`setEditorComponent()`、`setToolsExpanded()` 为空操作；
- `getEditorText()` 返回 `""`，`getEditorComponent()` 返回 `undefined`；
- `getToolsExpanded()` 返回 `false`；
- `pasteToEditor()` 委托给 `setEditorText()`，没有终端粘贴处理；
- `getAllThemes()` 返回 `[]`，`getTheme()` 返回 `undefined`；
- `setTheme()` 返回 `{ success: false, error: "Theme switching not supported in RPC mode" }`。

RPC 模式下 `ctx.mode` 为 `"rpc"`、`ctx.hasUI` 为 `true`（对话框和即发即弃方法通过子协议可用）。用 `ctx.mode === "tui"` 保护 `custom()` 等需要真实终端的功能。

## nek 发出的请求

所有请求都有 `type: "extension_ui_request"`、唯一的 `id` 和 `method` 字段。

### select

让用户从列表中选择：

```json
{"type": "extension_ui_request", "id": "uuid-1", "method": "select", "title": "Allow dangerous command?", "options": ["Allow", "Block"], "timeout": 10000}
```

期望的响应：带 `value`（选中的选项字符串）或 `cancelled: true`。

### confirm

是/否确认：

```json
{"type": "extension_ui_request", "id": "uuid-2", "method": "confirm", "title": "Clear session?", "message": "All messages will be lost.", "timeout": 5000}
```

期望的响应：`confirmed: true/false` 或 `cancelled: true`。

### input

自由文本输入：

```json
{"type": "extension_ui_request", "id": "uuid-3", "method": "input", "title": "Enter a value", "placeholder": "type something..."}
```

期望的响应：带 `value` 或 `cancelled: true`。

### editor

打开多行文本编辑器，可带预填内容：

```json
{"type": "extension_ui_request", "id": "uuid-4", "method": "editor", "title": "Edit some text", "prefill": "Line 1\nLine 2\nLine 3"}
```

期望的响应：带 `value` 或 `cancelled: true`。`ctx.ui.editor(title, prefill, { signal, timeout })` 设置超时后，请求中也会包含 `timeout`。

### structured {#structured}

向客户端发起结构化交互并接收结构化结果。只有 RPC 模式提供 `ctx.ui.structured`，因此扩展以可选调用方式使用：`await ctx.ui.structured?.("my.kind", payload, { signal, timeout })`。

```json
{
  "type": "extension_ui_request",
  "id": "uuid-10",
  "method": "structured",
  "kind": "auth.prompt",
  "payload": {"provider": "anthropic", "prompt": {"type": "secret", "message": "Enter Anthropic API key"}}
}
```

`kind` 和 `payload` 的结构由调用方决定。客户端通过 `result` 发回结果：

```json
{"type": "extension_ui_response", "id": "uuid-10", "result": {"value": "sk-example"}}
```

回复 `cancelled: true` 时调用解析为 `undefined`。核心登录流程通过 `auth.prompt` 支持 [`auth_login`](/reference/rpc-commands#auth-login)。

#### 内置 nek 结构化交互类型

在 RPC 模式下，内置 `nek` 扩展使用以下 `kind`（TUI 模式仍使用终端组件）：

- `nek.ask_question`：payload `{title?, questions:[{id, prompt, allow_multiple?, options:[{id,label}]}]}`；result `{answers:[{questionId, selected:string[], other?}]}`。
- `nek.plan_review`：payload `{path, revision, name, overview, markdown, todos:[{id,content}]}`；result `{action}`，`action` 为 `implement`、`implement_fresh`、`keep_planning` 或 `exit`。
- `nek.switch_mode`：payload `{from, to, explanation?}`；result `{approved:boolean}`。

客户端返回 `cancelled: true` 时，问题或计划审阅被关闭、模式切换被拒绝。若当前回合被中止，nek 会发送 `extension_ui_cancel`，对应工具调用以中止（aborted）结束，而不是当作用户拒绝；客户端收到 `extension_ui_cancel` 时应关闭弹窗。RPC 模式下这些交互固定走 `structured`，不会退回普通的 `select` / `confirm`。

### notify

显示通知，不需要响应：

```json
{"type": "extension_ui_request", "id": "uuid-5", "method": "notify", "message": "Command blocked by user", "notifyType": "warning"}
```

`notifyType` 为 `"info"`（默认）、`"warning"` 或 `"error"`。

### setStatus

设置或清除状态栏中的一项：

```json
{"type": "extension_ui_request", "id": "uuid-6", "method": "setStatus", "statusKey": "my-ext", "statusText": "Turn 3 running..."}
```

省略 `statusText` 表示清除该键。

### setWidget

设置或清除显示在输入框上方或下方的小部件（文本行）：

```json
{"type": "extension_ui_request", "id": "uuid-7", "method": "setWidget", "widgetKey": "my-ext", "widgetLines": ["--- My Widget ---", "Line 1", "Line 2"], "widgetPlacement": "aboveEditor"}
```

省略 `widgetLines` 表示清除。`widgetPlacement` 为 `"aboveEditor"`（默认）或 `"belowEditor"`。RPC 模式只支持字符串数组，组件工厂会被忽略。

### setTitle

设置终端窗口/标签标题：

```json
{"type": "extension_ui_request", "id": "uuid-8", "method": "setTitle", "title": "nek - my project"}
```

### set_editor_text

设置输入框中的文本：

```json
{"type": "extension_ui_request", "id": "uuid-9", "method": "set_editor_text", "text": "prefilled text for the user"}
```

## 发给 nek 的响应

只有对话框方法（`select`、`confirm`、`input`、`editor`、`structured`）需要响应，`id` 必须与请求一致。

选择、输入、编辑器的值：

```json
{"type": "extension_ui_response", "id": "uuid-1", "value": "Allow"}
```

确认：

```json
{"type": "extension_ui_response", "id": "uuid-2", "confirmed": true}
```

取消（任何对话框）：

```json
{"type": "extension_ui_response", "id": "uuid-3", "cancelled": true}
```

取消时扩展收到 `undefined`（select/input/editor/structured）或 `false`（confirm）。

### 主动取消通知 {#cancellation}

当发起请求的扩展中止了操作（例如运行结束触发 `AbortSignal`）、请求超时或进程退出时，nek 会主动关闭对话框并发送 `extension_ui_cancel`：

```json
{"type": "extension_ui_cancel", "id": "uuid-3"}
```

客户端收到后关闭对应对话框即可，无需再发回响应。扩展侧会按取消默认值解析（`select`、`input`、`editor`、`structured` 为 `undefined`，`confirm` 为 `false`）。超时始终由 nek 侧处理，客户端无需自己计时。

## 扩展自定义 RPC 方法 {#extension-rpc}

扩展可以通过两个在所有模式下都可调用、但只在 RPC 模式下产生协议记录的接口暴露自己的 RPC 通道：

- `pi.registerRpcHandler(method, handler)`：注册可通过 [`extension_call`](/reference/rpc-commands#extension-call) 调用的方法。处理函数接收命令的 `params`，返回值会包装为 `{ "result": ... }`。重复注册同名方法会保留第一个并报告扩展错误。
- `pi.emitRpcEvent(name, payload)`：写出一条 [`extension_event`](/reference/json#extension-event) 记录；其他模式会忽略，因此扩展可以无条件调用。

## 示例

源码中的 `examples/rpc-extension-ui.ts` 是一个处理扩展对话框的终端客户端，配套的演示扩展是 `examples/extensions/rpc-demo.ts`。请求和响应的联合类型定义在 `packages/coding-agent/src/modes/rpc/rpc-types.ts`。
