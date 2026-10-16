# 主题

主题控制 nek 在交互模式和 HTML 导出中使用的颜色。nek 内置 `dark` 和 `light` 两个主题。你可以固定使用一个主题、跟随终端的明暗外观自动切换，或者自己做一套配色。

## 选择主题 {#select}

打开 `/settings`，选择 **Theme**。可以所有情况都用一个主题，也可以为明亮和暗色终端分别选择。

选择保存为 `theme` 设置：

```json
{
  "theme": "dark"
}
```

自动模式把明亮主题写在前、暗色主题写在后：

```json
{
  "theme": "light/dark"
}
```

自动模式下，终端报告外观变化时 nek 会切换主题。因为 `/` 被用作分隔符，主题名不能包含 `/`。

只对一次运行指定主题，不改变保存的设置：

```bash
nek --use-theme light
nek --use-theme light/dark
```

## 创建自定义主题

复制一个 [内置主题](https://github.com/deepdarkpaw/nekcode/tree/nek/packages/coding-agent/src/modes/interactive/theme)，或按 [主题 schema](https://github.com/deepdarkpaw/nekcode/blob/nek/packages/coding-agent/src/modes/interactive/theme/theme-schema.json) 新建一个 JSON 文件：

1. 保存为 `~/.nek/agent/themes/my-theme.json`；
2. 把 `name` 设为 `my-theme`；
3. 修改 `vars` 和 `colors` 中的值；
4. 在 `/settings` 中选择 `my-theme`。

文件名请与主题名一致。nek 只对 `~/.nek/agent/themes/<名字>.json` 中**当前使用的**主题做热更新；其他来源的主题修改后需要 `/reload`。

## 主题文件结构

| 属性 | 必填 | 作用 |
|---|---|---|
| `$schema` | 否 | 让编辑器按 nek 的 schema 校验和补全 |
| `name` | 是 | 在选择器和设置中标识主题，必须唯一，不能含 `/` |
| `appearance` | 否 | `"dark"` 或 `"light"`，主题为哪种背景设计。省略时根据颜色推断 |
| `vars` | 否 | 可复用的颜色变量，变量可以引用其他变量 |
| `colors` | 是 | 各个界面角色的颜色，schema 标明了哪些必填 |
| `export` | 否 | 覆盖 HTML 导出中的页面和面板背景 |

结构示意（`colors` 需要包含 schema 要求的全部颜色，最省事的做法是从内置主题复制完整的 `colors` 再修改）：

```json
{
  "$schema": "https://raw.githubusercontent.com/deepdarkpaw/nekcode/nek/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "appearance": "dark",
  "vars": {
    "primary": "#a993ec",
    "base": "oklch(22% 0.02 280)"
  },
  "colors": {
    "accent": "primary",
    "...": "其余必填颜色从内置主题复制"
  }
}
```

### 颜色的写法

| 写法 | 示例 | 含义 |
|---|---|---|
| 十六进制 RGB | `"#0af"`、`"#00aaff"` | 三位或六位 sRGB 颜色 |
| OKLCH | `"oklch(62% 0.1 200)"` | 感知均匀的亮度、彩度、色相 |
| 256 色索引 | `39` | ANSI 调色板索引 0~255 |
| 变量引用 | `"primary"` | `vars` 中某个条目的值 |
| 终端默认色 | `""` | 终端自己的前景色或背景色 |

- 终端默认色按终端自己的颜色显示。需要具体颜色值的地方（HTML 导出、扩展做颜色计算），nek 使用终端报告的默认颜色，没有报告时根据主题的 `appearance` 猜测黑或白。
- 变量引用可以链式解析，缺失变量或循环引用会让主题无效。
- 终端支持时使用真彩色，OKLCH 会被映射到 sRGB 色域；256 色终端上会做近似。颜色与源值不同时，检查终端的真彩色检测，见 [终端设置](/platform/terminal-setup#override)。

无效的主题文件会在启动和 `/reload` 时报告。

## 找到要改的颜色

颜色按界面**角色**命名，而不是按组件。用下表找到 schema 中相关的部分：

| 区域 | 颜色名 |
|---|---|
| 通用界面 | `accent`、`border*`、`text`、`muted`、`dim`、`success`、`error`、`warning` |
| 选择与全屏 | `selectedBg`、`searchMatch*`、`scrollbar*` |
| 消息 | `userMessage*`、`customMessage*`、`thinkingText` |
| 工具执行 | `toolPendingBg`、`toolSuccessBg`、`toolErrorBg`、`toolTitle`、`toolOutput` |
| Markdown | `md*` |
| 工具 diff | `toolDiff*` |
| 语法高亮 | `syntax*` |
| 输入框模式 | `thinking*`、`bashMode` |
| HTML 导出 | `export.pageBg`、`export.cardBg`、`export.infoBg` |

以下五个颜色可选，省略时继承另一个颜色：

| 可选颜色 | 默认继承 |
|---|---|
| `scrollbarTrack` | `muted` |
| `scrollbarThumb` | `text` |
| `searchMatchBg` | `selectedBg` |
| `searchMatchText` | `text` |
| `thinkingMax` | `thinkingXhigh` |

省略 `export` 时，HTML 页面和面板背景从 `userMessageBg` 推导。

## 从项目或其他位置加载

- 项目主题放在 `.nek/themes/`，信任项目后加载；
- 设置 `themes` 可以加载额外的主题文件或目录；
- `--theme <路径>` 只对本次运行加载（可重复）；`--no-themes` 关闭自动发现和配置加载。

每个加载的主题名字必须唯一，重名会被报告为资源冲突。
