# 加载扩展

扩展是给 nek 添加可执行能力的 TypeScript/JavaScript 模块：新的工具、命令、快捷键、事件处理、模型服务商、界面组件等。这一页讲怎么**加载**扩展；怎么**编写**扩展见 [编写扩展](/develop/extensions)。

::: warning 扩展以 nek 的权限运行
扩展在 nek 进程内执行，可以读取提示词、工具调用、文件、凭据和会话历史，也可以执行命令、发起网络请求。只加载你信任的来源，加载前先审查源码。
:::

## 三种加载方式

### 1. 命令行临时加载

只对本次运行生效，适合开发调试或偶尔使用：

```bash
nek -e ./my-extension.ts
nek -e ./my-extension-dir/
nek -e ./a.ts -e ./b.ts        # 可重复
```

### 2. 放进扩展目录（自动加载）

| 目录 | 作用范围 |
|---|---|
| `~/.nek/agent/extensions/` | 用户级，每次启动都加载 |
| `.nek/extensions/` | 项目级，信任项目后加载 |

目录中直接放置的 `.ts` / `.js` 文件，以及包含 `index.ts` / `index.js` 入口的子目录，都会被加载。修改后运行 `/reload`。

### 3. 设置中列出路径

在 `settings.json` 的 `extensions` 中列出额外的文件或目录（用户设置中的相对路径从 agent 目录解析，项目设置中的相对路径从 `.nek/` 解析）。这个列表也能用 `!pattern`、`+path`、`-path` 排除或包含自动发现的扩展，见 [settings.json](/reference/settings#resources)。

## 扩展目录的入口

一个扩展目录可以包含 `index.ts` 或 `index.js`，也可以在 `package.json` 的 `nek` 字段里声明入口：

```json
{
  "name": "my-nek-extension",
  "nek": {
    "extensions": ["./src/extension.ts"]
  }
}
```

nek 用 jiti 加载扩展，本地 TypeScript 扩展不需要单独编译。扩展需要 npm 依赖时，在扩展目录里放 `package.json` 并安装依赖（建议 `npm install --ignore-scripts`）。

## 关闭扩展

```bash
nek --no-extensions        # 或 -ne：不加载自动发现和配置的扩展，-e 指定的仍然加载
```

## 与 pi 的区别

nek **没有**包管理命令：pi 的 `install`、`remove`、`update`、`list`、`config` 已移除（`nek update` 只用于更新 nek 本身）。安装别人发布的扩展时，请手动下载或克隆到扩展目录，审查后再使用。

nek 内置的功能（Plan、Todo、子代理、MCP、`tool_search`、llama.cpp 服务商）以内置扩展的形式加载，不需要也不能单独安装。

## 冲突

多个扩展注册了同名的工具、命令或参数时，所有扩展都会加载，冲突会作为诊断信息报告，按加载顺序决定优先级。启动信息（`Ctrl+O` 展开）会列出加载的扩展和错误。
