---
layout: home

hero:
  name: nekcode
  text: 运行在终端里的编程助手
  tagline: 命令名 nek。读代码、跑命令、改文件；先出计划再动手，能把任务派给子代理，进程被杀掉也能接着跑。
  image:
    src: /logo.svg
    alt: nekcode
  actions:
    - theme: brand
      text: 快速上手
      link: /start/quickstart
    - theme: alt
      text: 安装
      link: /start/install
    - theme: alt
      text: 命令行参考
      link: /reference/cli

features:
  - title: Plan 模式
    details: 先调研、提问、写计划，计划经你审阅后才切到 Agent 模式实施。计划保存在 .nek/plans/，可以多份并存、增量修订。
    link: /guide/plan-mode
  - title: 子代理
    details: 把边界清晰的任务派给独立的子会话，前台等结果或后台并行跑。可以用 Markdown 定义自己的子代理类型，固定模型和思考等级。
    link: /guide/subagents
  - title: Todo 列表
    details: 多步任务的进度固定显示在输入框上方，模型按步骤更新状态。
    link: /guide/todos
  - title: 崩溃后续跑
    details: 每一步都写入会话数据库（SQLite）。进程被杀、终端被关之后，用 nek -c 重新打开，中断的回合会接着跑完。
    link: /reference/durable-sessions
  - title: 好用的文件工具
    details: 带行号和代码大纲的 read、精确替换的 edit、结构化搜索 ast_grep，再加上 grep、find、ls 和免 key 的 web_search。
    link: /guide/tools
  - title: MCP 与扩展
    details: 内置 MCP 客户端（stdio、Streamable HTTP、OAuth），工具按需加载；也可以用 TypeScript 扩展添加工具、命令和界面。
    link: /guide/mcp
---

## 这份手册怎么读

- **第一次用**：按顺序读 [安装](/start/install) 和 [快速上手](/start/quickstart)，十分钟内能跑起第一个任务。
- **日常使用**：[终端界面与输入](/guide/usage) 讲清楚输入框、快捷键和排队消息；[会话与上下文](/guide/sessions) 讲续接、分支和压缩。
- **nek 独有功能**：[Plan 模式](/guide/plan-mode)、[Todo 列表](/guide/todos)、[子代理](/guide/subagents)、[内置工具](/guide/tools)。
- **按需定制**：[配置总览](/customize/configuration) 列出所有配置文件的位置；[参考](/reference/cli) 部分逐项列出命令行参数、设置和快捷键。
- **写程序调用 nek**：[脚本与程序集成](/develop/cli-integration) 介绍 print、JSON、RPC 三种模式和 SDK。

::: warning 安全提示
nek 以启动它的用户的权限运行，可以读写文件、执行命令，执行工具前**不会**逐个确认。处理不可信的代码或无人值守运行时，请放进容器或其他沙箱。详见 [安全使用](/guide/security)。
:::
