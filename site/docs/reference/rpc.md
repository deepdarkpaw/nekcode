# RPC 协议

RPC 模式让 nek 作为一个长期运行的子进程，通过 stdin/stdout 上的 JSON 记录被控制。适合跨语言集成、进程隔离、IDE 插件和自定义界面。

Node.js 或 Bun 中的进程内集成优先用 [SDK](/develop/sdk)；基于子进程的 TypeScript 集成优先用导出的 `RpcClient`，它负责启动 nek、对应响应、提供带类型的命令方法并把事件分发给监听器。

| 接口 | 进程边界 | 控制方式 | 适合 |
|---|---|---|---|
| SDK | 进程内 | 直接的 TypeScript 方法和事件 | 想要完整 API 的 Node.js/Bun 宿主 |
| RPC | 子进程 | JSONL 命令、响应和事件 | 其他语言、隔离进程、IDE、自定义客户端 |

## 启动

```bash
nek --mode rpc --no-session
```

普通的 CLI 参数仍然用来选择工作目录、模型、工具、资源和会话行为，常用的有 `--provider`、`--model`、`--name`、`--no-session`、`--session-dir`。见 [命令行](/reference/cli)。

RPC 模式不接受 `@文件` 参数，请通过 [`prompt`](/reference/rpc-commands#prompt) 命令发送提示词。

## 记录类型

| 方向 | 记录 | 用途 |
|---|---|---|
| stdin | 命令 | 让 nek 发送提示词、查看状态、修改配置或管理会话 |
| stdout | `response` | 报告一条命令是否成功，并返回数据 |
| stdout | 会话事件 | 流式报告运行、消息、工具、队列、压缩和重试 |
| 双向 | 扩展 UI 记录 | 在 nek 和客户端之间转发扩展的交互 |

规范定义见 [RPC 命令](/reference/rpc-commands)、[JSON 事件流](/reference/json)、[RPC 扩展 UI](/reference/rpc-extension-ui)。

### 对应命令和响应

每条命令都可以带一个字符串 `id`，对应的响应会原样带回：

```json
{"id":"req-1","type":"get_state"}
{"id":"req-1","type":"response","command":"get_state","success":true,"data":{"...":"..."}}
```

可能同时有多条未完成的命令时，使用唯一的 ID。命令是异步处理的，请按 ID 而不是按响应顺序对应。

会话事件一般没有命令 ID。例外是 `bash_execution_update`：发起的 [`bash`](/reference/rpc-commands#bash) 命令带 ID 时，它的输出事件会带上同一个 ID。

`extension_ui_response` 使用对应 `extension_ui_request` 的 ID，不会产生普通的命令响应。

## 分帧

严格的 JSONL：每条记录是一个完整的 JSON 对象，以 LF（`\n`）结尾。以字节流或 UTF-8 流读取 stdout，只按 LF 切分，去掉可选的前置 CR 以兼容 CRLF。

不要使用会把 Unicode 行/段落分隔符当作记录边界的通用行读取器。尤其是 Node.js 的 `readline` 会在 `U+2028` 和 `U+2029` 处切分，而它们在 JSON 字符串里是合法的。

持续读取 stdout。nek 遵守 stdout 的背压，但停止读取的客户端会让进程卡住。写命令时也要遵守 stdin 的背压。stdout 只用于协议记录，诊断信息和日志写到 stderr。

## 运行的生命周期

`prompt` 成功只表示提示词被接受、排队或处理，不表示模型工作已完成：

```json
{"id":"req-2","type":"prompt","message":"Review this repository"}
{"id":"req-2","type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}
```

`data.disposition` 说明提示词的去向。为 `"handled"` 时没有为它启动运行，不要等待 `agent_settled`。所有取值见 [RPC 命令](/reference/rpc-commands#prompt)。

响应之后继续读取 [事件](/reference/json)。`agent_end` 只是一次底层运行结束，之后还可能有重试、溢出恢复、压缩、插话或追加。需要知道 nek 不会再自动继续时，等待 `agent_settled`。

在发送提示词之前订阅事件，避免错过很快完成的运行。`RpcClient.promptAndWait()` 内部就是这样做的。

## 错误

失败的命令返回一条 `success: false` 的响应：

```json
{"id":"req-3","type":"response","command":"set_model","success":false,"error":"Model not found: invalid/model"}
```

格式错误的 JSON 产生一条没有请求 ID 的 parse 响应：

```json
{"type":"response","command":"parse","success":false,"error":"Failed to parse command: Unexpected token..."}
```

成功的响应只代表命令处理本身。提示词被接受之后的服务商失败和中止，出现在消息和事件流里。

客户端还需要处理子进程启动失败、意外退出、stderr 诊断、取消和自己的超时。不要把 stderr 当作协议数据解析。

## 退出

关闭子进程的 stdin 请求有序退出，nek 会先释放当前运行时再退出。客户端仍应处理进程信号和意外退出。扩展也可以通过扩展上下文请求退出，nek 会在当前命令完成后，或在当前运行发出 `agent_settled` 后退出。

## 最小客户端 {#minimal-client}

这个 Python 示例使用二进制管道读取，按 LF 切分，不会把 Unicode 分隔符当作协议边界：

```python
import json
import subprocess

process = subprocess.Popen(
    ["nek", "--mode", "rpc", "--no-session"],
    stdin=subprocess.PIPE,
    stdout=subprocess.PIPE,
)

assert process.stdin is not None
assert process.stdout is not None

command = {"id": "prompt-1", "type": "prompt", "message": "Hello"}
process.stdin.write(json.dumps(command).encode("utf-8") + b"\n")
process.stdin.flush()

while line := process.stdout.readline():
    record = json.loads(line)
    if record.get("type") == "message_update":
        update = record["assistantMessageEvent"]
        if update["type"] == "text_delta":
            print(update["delta"], end="", flush=True)
    elif record.get("type") == "agent_settled":
        print()
        break

process.stdin.close()
process.wait()
```

::: tip Windows
在 Windows 上 `nek` 是一个 `.cmd` 启动器，用 `subprocess` 启动时可能需要写成 `["nek.cmd", ...]` 或传 `shell=True`。
:::

TypeScript 客户端见源码中的 `examples/rpc-client.ts`（需要构建后的 CLI，示例指向 `dist/cli.js`）。

## 参考

- [RPC 命令](/reference/rpc-commands)：所有 stdin 命令和响应
- [JSON 事件流](/reference/json)：stdout 上的会话事件和流式重建
- [RPC 扩展 UI](/reference/rpc-extension-ui)：对话框、通知、响应和限制
- [消息类型](/reference/message-types)
- [会话文件格式](/reference/session-format)
