# 终端 UI 组件

`@earendil-works/pi-tui` 是 nek 使用的终端组件系统。当内置的对话框、通知、状态文字和小部件不能满足扩展需要的交互时，用它构建自定义组件。

先从 [扩展](/develop/extensions#ui) 的 `ctx.ui` 方法开始。只有当界面需要自己的渲染、键盘或鼠标输入、焦点、布局或生命周期时，才构建自定义组件。

## 选择集成点

| 需求 | 用 |
|---|---|
| 选择、确认、输入、多行编辑 | `ctx.ui.select()`、`confirm()`、`input()`、`editor()` |
| 不打断的反馈 | `ctx.ui.notify()` 或 `setStatus()` |
| 输入框附近的常驻内容 | `ctx.ui.setWidget()` |
| 替换页头、页脚或输入框 | 对应的 `ctx.ui` 组件工厂 |
| 临时的交互界面或浮层 | `ctx.ui.custom()` |
| 自定义某个工具或会话条目的渲染 | 扩展渲染器 |

这些 API 会拿到 nek 当前的主题和快捷键。不要在扩展里另建一个终端渲染器。

## 组件模型

组件根据可用宽度渲染出一组终端行，可以选择处理键盘和鼠标输入；状态或与主题相关的内容变化时，必须让缓存的输出失效。

**每一行都必须在给定宽度之内。** 要按可见列宽计算，而不是字符串长度，因为 ANSI 转义、宽字符、emoji 和组合字符都会影响显示宽度。使用 `visibleWidth()`、`truncateToWidth()`、`sliceByColumn()`、`wrapTextWithAnsi()`，不要自己实现宽度处理。nek 在每行结束时重置样式和超链接，所以每行都要重新应用样式。

修改组件状态后，让受影响的组件失效（invalidate），并调用注入的 `tui.requestRender()`。TUI 会合并渲染请求再更新终端。

## 内置组件

- 内容：`Text`、`Markdown`、`Image`、`TruncatedText`
- 布局：`Container`、`VStack`、`HStack`、`Box`、`Spacer`
- 输入：`Input`、`Editor`
- 列表：`SelectList`、`SettingsList`（可搜索的选择和设置流程）
- 滚动：`ScrollView`
- 进度：`Loader`、`CancellableLoader`
- 指针：`MouseRegion`

优先组合这些组件，不要重新实现选择、滚动、文本编辑或宽度处理。

## 键盘输入与焦点

用 `matchesKey()` 和 `Key` 处理键盘输入，解析器已经考虑了各种终端协议和修饰键。扩展组件对可配置的应用动作应使用注入的 `KeybindingsManager`，不要硬编码按键。

显示文字光标的组件应实现 `Focusable`，并在视觉光标前放置 `CURSOR_MARKER`，TUI 用它定位硬件光标供输入法使用。包裹 `Input` 或 `Editor` 的容器必须把 `focused` 状态传给子组件，否则中文、日文、韩文等输入法的候选框可能出现在错误的位置。

替换主输入框时继承 nek 的 `CustomEditor`，它保留了应用快捷键和 agent 控制。把自己不处理的按键转交给基类，清除自定义编辑器工厂即可恢复默认。

## 鼠标输入

全屏模式会把规范化的鼠标事件交给组件。处理函数可以标记事件已处理、捕获一次拖动、请求焦点或请求渲染。未处理的滚轮事件滚动最近的 `ScrollView`，未处理的主键拖动留给对话记录的文字选择。OSC 8 链接优先于外层的点击区域。

普通模式下鼠标交给终端（终端拥有回滚记录）。每个交互都要有键盘路径。

## 自定义界面和浮层

`ctx.ui.custom()` 让一个组件临时接管交互区域，组件调用传入的完成回调时 Promise 解析。

- 传 `overlay: true` 绘制在现有内容之上。浮层选项控制大小、锚点、偏移、边距和响应式显示。浮层句柄可以改变焦点，或用 `setHidden()` 临时隐藏/显示；
- 获得焦点的浮层在普通渲染之间保持输入所有权，需要让其他组件接收输入时显式释放或转移焦点；
- 每个自定义组件实例只属于一次交互，再次开始时创建新实例；
- 用工厂提供的完成回调结束交互，它会解析 `ctx.ui.custom()` 并销毁组件。不要对 `ctx.ui.custom()` 创建的浮层调用 `OverlayHandle.hide()`。

## 正确使用主题

使用传给扩展或组件回调的主题。主题辅助函数为语义颜色（accent、muted、success、warning、error、工具输出、Markdown 等）生成带 ANSI 样式的字符串：

```typescript
return new Text(
  theme.style("Done!", {
    fg: "success",
    bg: "toolSuccessBg",
    bold: true,
  }),
  0,
  0,
);
```

- 颜色可以是语义 token，也可以是具体的 `Color`。前景 token 用于 `fg`，背景 token 用于 `bg`；要在另一个位置使用某个 token 的颜色，传它的具体颜色，例如 `{ fg: theme.colors.userMessageBg }`；
- 通过 `theme.colors` 访问具体颜色，用 `@earendil-works/pi-tui` 的 `mixColors()` 等做颜色计算；
- 用 `theme.appearance`（`"dark"` 或 `"light"`）决定加亮还是加暗；
- `theme.fg()`、`theme.bg()` 仍可用来应用单个语义颜色；
- 除非 `invalidate()` 会重建，否则不要长期保存带主题颜色的字符串。切换主题会清除渲染缓存，但清除不了嵌在应用状态里的旧 ANSI 颜色。

渲染 Markdown 时用 nek 的 `getMarkdownTheme()` 与当前主题保持一致。

## 保持渲染流畅

渲染在交互路径上执行。按宽度和内容缓存昂贵的布局和高亮结果，在 `invalidate()` 中清除。默认视图保持紧凑，细节通过展开或单独的界面呈现。自定义工具渲染要处理部分结果，能安全更新时复用上一次的组件。

诊断渲染问题时，设置 `PI_TUI_WRITE_LOG` 捕获原始 ANSI 输出流。测试窄宽度、宽字符、窗口缩放、主题切换、焦点转移，以及普通和全屏两种模式。

## 示例

源码 `packages/coding-agent/examples/extensions/` 中：

- `preset.ts`、`tools.ts`：选择列表和设置列表；
- `qna.ts`：可取消的异步界面；
- `modal-editor.ts`：替换输入框；
- `custom-footer.ts`：替换页脚；
- `widget-placement.ts`：在输入框周围放置常驻内容；
- `overlay-qa-tests.ts`：浮层的定位、堆叠、焦点、响应式显示和动画；
- `doom-overlay/`：持续渲染的浮层。

公开导出见 [`packages/tui/src/index.ts`](https://github.com/deepdarkpaw/nekcode/blob/nek/packages/tui/src/index.ts)。
