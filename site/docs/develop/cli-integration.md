# 脚本与程序集成

默认情况下，运行 `nek` 会打开交互式终端界面。输入或输出被管道或重定向时，nek 改用 print 模式。你也可以为脚本和程序显式选择 print、JSON 或 RPC 模式。

四种模式使用同样的代理、会话、资源和工具，区别只在于输入怎么进入 nek、输出怎么呈现、进程是否持续接收命令。

SDK 不是 CLI 模式，它把代理直接嵌入 Node.js 或 Bun 进程，见 [TypeScript SDK](/develop/sdk)。

## 选择模式

| 模式 | 接口 | 生命周期 | 适合 |
|---|---|---|---|
| 交互 | 终端界面 | 直到用户退出 | 人直接使用 |
| print | 最终文本写到 stdout | 一次调用 | 脚本只需要最终回复 |
| JSON | JSONL 事件写到 stdout | 一次调用 | 程序需要结构化的进度 |
| RPC | JSONL 命令、响应和事件 | 长期运行 | 程序需要双向控制 |

工作目录、模型、工具、资源和会话持久化等启动参数与模式无关，见 [命令行](/reference/cli)。

## print 模式

执行提示词，把最终的助手文本写到 stdout，然后退出：

```bash
nek -p "总结这个仓库最近的改动"
git diff | nek -p "审查这个改动"
nek -p @README.md "把这份文档翻译成英文" > README.en.md
```

- 管道输入的内容会加在第一条提示词前面；
- 错误写到 stderr；
- 最终回复的停止原因是 `error` 或 `aborted` 时，退出码非零；
- 中间过程不输出。

没有显式选择模式、而 stdin 或 stdout 不是终端时，也会使用 print 模式。

常见用法：

```bash
# 只读审查，不允许改文件
nek --tools read,grep,find,ls,ast_grep -p "审查 src/ 的错误处理"

# 不保存会话
nek --no-session -p "解释这个报错" < error.log

# 指定模型和思考等级
nek --model sonnet:high -p "设计这个模块的接口"

# 自动化时明确项目信任
nek --approve -p "运行测试并修复失败"
```

## JSON 模式

把会话头和代理、会话事件以 JSONL 写到 stdout：

```bash
nek --mode json "审查这个仓库" > events.jsonl
```

- 这是结构化的**事件输出**，不是让模型输出 JSON；
- 所有提示词在启动时提供，运行结束后进程退出，不接收后续命令；
- 失败或中止的回复只出现在事件流里，本身不会导致非零退出码；调用本身抛出错误时才非零退出；
- `message_update` 是增量（delta），不是不断增长的完整快照。用增量事件实时显示，收到 `message_end` 后用其中的权威消息替换；
- `agent_end` 之后还可能有自动恢复或排队的工作，`agent_settled` 才表示本次运行的自动工作全部结束；
- stdout 只输出 JSONL，诊断信息和日志写到 stderr。

只看完成的消息：

```bash
nek --mode json "列出文件" 2>/dev/null | jq -c 'select(.type == "message_end")'
```

事件格式见 [JSON 事件流](/reference/json)。

## RPC 模式 {#rpc}

nek 持续运行，另一个进程发送命令、接收响应和事件：

```bash
nek --mode rpc --no-session
```

- 命令是写到 stdin 的 JSON 对象，响应和事件是写到 stdout 的 JSON 对象，每条记录占一行；
- 需要对应关系的命令带上 `id`，响应会原样带回；事件一般没有命令 ID；
- `prompt` 成功只表示提示词被接受、排队或处理了，不表示运行完成。需要知道何时结束时，持续读取事件直到 `agent_settled`；
- RPC 命令可以切换模型、查看状态、管理会话、执行 shell 命令、回应扩展的界面请求；
- 扩展对话框是一个请求-响应的子协议；其他扩展界面更新是通知，客户端可以显示或忽略。

一个最小的 Python 客户端见 [RPC 协议](/reference/rpc#minimal-client)。全部命令见 [RPC 命令](/reference/rpc-commands)。

### TypeScript 客户端

Node.js/TypeScript 集成推荐使用 `@earendil-works/pi-coding-agent` 导出的 `RpcClient`：它启动 RPC 子进程、对应请求和响应、提供带类型的命令方法，并把会话事件分发给监听器。

- `RpcClient.promptAndWait()` 在发送提示词之前安装监听器，避免错过很快完成的运行；
- 分开调用时，先订阅事件再调用 `prompt()`，只在运行进行中调用 `waitForIdle()`；
- 客户端需要一个可运行的 nek CLI 路径。源码中的示例（`examples/rpc-client.ts`）指向构建后的 `dist/cli.js`。

## 换个名字发布 nek

源码分支可以通过 `package.json` 改变命令名和配置目录：

```json
{
  "nekConfig": {
    "name": "my-agent",
    "configDir": ".my-agent"
  }
}
```

同时修改顶层的 `bin` 字段来设置可执行文件名。这些设置影响 CLI 横幅、配置路径和派生出的环境变量名。

## 参考

- [命令行](/reference/cli)：启动参数与模式选择
- [JSON 事件流](/reference/json)：事件格式
- [RPC 协议](/reference/rpc)：生命周期、分帧、错误和退出
- [RPC 命令](/reference/rpc-commands)：命令与响应
- [RPC 扩展 UI](/reference/rpc-extension-ui)：扩展交互子协议
- [TypeScript SDK](/develop/sdk)：进程内集成
