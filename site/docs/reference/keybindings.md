# 快捷键

nek 的快捷键绑定在一个个命名的**动作**上（例如 `app.session.new`）。你可以修改默认绑定，或给没有默认按键的动作绑定按键。

在 nek 里运行 `/hotkeys` 查看输入框和应用当前生效的快捷键。

## 修改快捷键 {#assign}

创建 `~/.nek/agent/keybindings.json`，把动作 ID 映射到一个按键或按键列表：

```json
{
  "app.session.new": "ctrl+shift+n",
  "app.session.tree": ["ctrl+shift+t", "alt+shift+t"]
}
```

配置的值**替换**该动作的默认绑定。用空列表禁用一个动作的所有按键：

```json
{
  "tui.altScreen.pageUp": []
}
```

修改后运行 `/reload` 应用到当前会话。

切换 Plan 模式的快捷键（默认 `alt+m`）不在这里，而在 [nek.yaml](/reference/nek-yaml) 的 `plan.shortcut`。

## 按键写法 {#syntax}

格式为 `修饰键+键`。修饰键有 `ctrl`、`shift`、`alt`、`super`，可以组合使用。可用的键：

- **字母**：`a`-`z`
- **数字**：`0`-`9`
- **特殊键**：`escape`、`esc`、`enter`、`return`、`tab`、`space`、`backspace`、`delete`、`insert`、`clear`、`home`、`end`、`pageUp`、`pageDown`、`up`、`down`、`left`、`right`
- **功能键**：`f1`-`f12`
- **符号**：`` ` ``、`-`、`=`、`[`、`]`、`\`、`;`、`'`、`,`、`.`、`/`、`!`、`@`、`#`、`$`、`%`、`^`、`&`、`*`、`(`、`)`、`_`、`+`、`|`、`~`、`{`、`}`、`:`、`<`、`>`、`?`

例如：`ctrl+shift+x`、`alt+ctrl+x`、`ctrl+shift+alt+x`、`super+k`、`ctrl+super+k`、`ctrl+1`。

`super` 组合需要终端单独上报这个修饰键（通常通过 Kitty 键盘协议），不支持的终端里可能无效。

## 输入框

### 光标移动

| 动作 ID | 默认按键 | 说明 |
|---|---|---|
| `tui.editor.cursorUp` | `up` | 光标上移；在首行时浏览更早的历史 |
| `tui.editor.cursorDown` | `down` | 光标下移；在末行时浏览更新的历史 |
| `tui.editor.historyPrevious` | 无 | 上一条历史提示词（不论光标位置） |
| `tui.editor.historyNext` | 无 | 下一条历史提示词 |
| `tui.editor.cursorLeft` | `left`、`ctrl+b` | 左移 |
| `tui.editor.cursorRight` | `right`、`ctrl+f` | 右移 |
| `tui.editor.cursorWordLeft` | `alt+left`、`ctrl+left`、`alt+b` | 左移一个词 |
| `tui.editor.cursorWordRight` | `alt+right`、`ctrl+right`、`alt+f` | 右移一个词 |
| `tui.editor.cursorLineStart` | `home`、`ctrl+home`、`ctrl+a` | 到行首 |
| `tui.editor.cursorLineEnd` | `end`、`ctrl+end`、`ctrl+e` | 到行尾 |
| `tui.editor.jumpForward` | `ctrl+]` | 向前跳到指定字符 |
| `tui.editor.jumpBackward` | `ctrl+alt+]` | 向后跳到指定字符 |
| `tui.editor.pageUp` | `pageUp`、`ctrl+pageUp` | 向上翻页 |
| `tui.editor.pageDown` | `pageDown`、`ctrl+pageDown` | 向下翻页 |

专用的历史动作优先于使用相同按键的应用动作。

### 文本编辑

| 动作 ID | 默认按键 | 说明 |
|---|---|---|
| `tui.editor.deleteCharBackward` | `backspace` | 向后删除一个字符 |
| `tui.editor.deleteCharForward` | `delete`、`ctrl+d` | 向前删除一个字符 |
| `tui.editor.deleteWordBackward` | `ctrl+w`、`alt+backspace` | 向后删除一个词 |
| `tui.editor.deleteWordForward` | `alt+d`、`alt+delete` | 向前删除一个词 |
| `tui.editor.deleteToLineStart` | `ctrl+u` | 删除到行首 |
| `tui.editor.deleteToLineEnd` | `ctrl+k` | 删除到行尾 |
| `tui.editor.yank` | `ctrl+y` | 粘贴最近删除的文本 |
| `tui.editor.yankPop` | `alt+y` | 粘贴后循环切换更早删除的文本 |
| `tui.editor.undo` | `ctrl+-`（Windows 为 `ctrl+z`，WSL 为 `alt+z`） | 撤销 |

### 输入与选择

| 动作 ID | 默认按键 | 说明 |
|---|---|---|
| `tui.input.newLine` | `shift+enter`、`ctrl+j` | 换行 |
| `tui.input.submit` | `enter` | 发送 |
| `tui.input.tab` | `tab` | Tab 或补全 |
| `tui.input.copy` | `ctrl+c` | 复制选中内容 |
| `tui.select.up` | `up` | 列表中上移 |
| `tui.select.down` | `down` | 列表中下移 |
| `tui.select.pageUp` | `pageUp` | 列表中上翻页 |
| `tui.select.pageDown` | `pageDown` | 列表中下翻页 |
| `tui.select.confirm` | `enter` | 确认选择 |
| `tui.select.cancel` | `escape`、`ctrl+c` | 取消选择 |

## 全屏模式

全屏模式下这些动作控制对话记录，优先于使用相同按键的输入框动作。

| 动作 ID | 默认按键 | 说明 |
|---|---|---|
| `tui.altScreen.pageUp` | `pageUp` | 对话向上翻一页 |
| `tui.altScreen.pageDown` | `pageDown` | 对话向下翻一页 |
| `tui.altScreen.halfPageUp` | 无 | 向上翻半页 |
| `tui.altScreen.halfPageDown` | 无 | 向下翻半页 |
| `tui.altScreen.lineUp` | 无 | 向上一行 |
| `tui.altScreen.lineDown` | 无 | 向下一行 |
| `tui.altScreen.previousPrompt` | `ctrl+shift+up`、`ctrl+up`（`ctrl+up` 仅 Windows/WSL） | 跳到上一条标记的消息 |
| `tui.altScreen.nextPrompt` | `ctrl+shift+down`、`ctrl+down`（`ctrl+down` 仅 Windows/WSL） | 跳到下一条标记的消息 |
| `tui.altScreen.search` | `ctrl+shift+f`（Windows/WSL 为 `ctrl+f`） | 搜索对话记录 |
| `tui.altScreen.searchNext` | `enter`、`ctrl+g` | 搜索时跳到下一个匹配 |
| `tui.altScreen.searchPrevious` | `shift+enter`、`ctrl+shift+g` | 搜索时跳到上一个匹配 |
| `tui.altScreen.searchClose` | `escape` | 关闭搜索 |
| `tui.altScreen.top` | `home` | 滚动到对话开头 |
| `tui.altScreen.bottom` | `end` | 滚动到末尾并跟随新输出 |

## 应用

| 动作 ID | 默认按键 | 说明 |
|---|---|---|
| `app.interrupt` | `escape` | 取消 / 中止 |
| `app.clear` | `ctrl+c` | 第一次清空输入框，第二次退出 |
| `app.exit` | `ctrl+d` | 输入框为空时退出 |
| `app.suspend` | `ctrl+z`（Windows 无） | 挂起到后台 |
| `app.editor.external` | `ctrl+g` | 在外部编辑器中编辑（`externalEditor`、`$VISUAL`、`$EDITOR`，Windows 默认记事本，其他系统默认 `nano`） |
| `app.clipboard.pasteImage` | `ctrl+v`（Windows/WSL 为 `alt+v`） | 从剪贴板粘贴图片或文字 |

原生 Windows 上 `app.suspend` 没有默认按键，因为 Windows 终端不支持 Unix 作业控制。手动绑定后 nek 只会显示一条状态信息而不会挂起。WSL 使用正常的 `ctrl+z` 和 `fg`。

## 会话

| 动作 ID | 默认按键 | 说明 |
|---|---|---|
| `app.session.new` | 无 | 新会话（`/new`） |
| `app.session.tree` | 无 | 打开会话树（`/tree`） |
| `app.session.fork` | 无 | 分叉会话（`/fork`） |
| `app.session.resume` | 无 | 打开会话列表（`/resume`） |
| `app.session.togglePath` | `ctrl+p` | 会话列表中显示/隐藏路径 |
| `app.session.toggleSort` | `ctrl+s` | 会话列表中切换排序 |
| `app.session.toggleNamedFilter` | `ctrl+n` | 会话列表中只看已命名的会话 |
| `app.session.rename` | `ctrl+r` | 重命名会话 |
| `app.session.delete` | `ctrl+d` | 删除会话 |
| `app.session.deleteNoninvasive` | `ctrl+backspace` | 搜索框为空时删除会话 |

## 模型与思考

| 动作 ID | 默认按键 | 说明 |
|---|---|---|
| `app.model.select` | `ctrl+l` | 打开模型选择器 |
| `app.model.cycleForward` | `ctrl+p` | 下一个模型 |
| `app.model.cycleBackward` | `shift+ctrl+p`（Windows/WSL 为 `alt+p`） | 上一个模型 |
| `app.models.save` | `ctrl+s` | 把选中的默认模型或循环范围保存到设置 |
| `app.thinking.cycle` | `shift+tab` | 循环切换思考等级 |
| `app.thinking.save` | `ctrl+s` | 把当前思考等级保存到设置 |
| `app.thinking.toggle` | `ctrl+t` | 折叠/展开思考内容 |

## 显示与消息队列

| 动作 ID | 默认按键 | 说明 |
|---|---|---|
| `app.tools.expand` | `ctrl+o` | 折叠/展开工具输出 |
| `app.message.copy` | `ctrl+x` | `/tree` 中复制选中的消息；全屏模式下 `fullscreenCopyOnSelect` 为 `false` 时复制当前选区；其他情况复制最后一条助手消息 |
| `app.message.followUp` | `alt+enter`（Windows/WSL 为 `ctrl+q`） | 排队追加消息 |
| `app.message.dequeue` | `alt+up`（Windows/WSL 为 `alt+q`） | 把排队的消息取回输入框 |

## 会话树

| 动作 ID | 默认按键 | 说明 |
|---|---|---|
| `app.tree.foldOrUp` | `ctrl+left`、`alt+left` | 折叠当前分支段，或跳到上一段的开头 |
| `app.tree.unfoldOrDown` | `ctrl+right`、`alt+right` | 展开当前分支段，或跳到下一段开头/分支末尾 |
| `app.tree.editLabel` | `shift+l` | 编辑选中节点的标签 |
| `app.tree.toggleLabelTimestamp` | `shift+t` | 显示/隐藏标签时间 |
| `app.tree.filter.default` | `ctrl+d` | 过滤器：默认视图 |
| `app.tree.filter.noTools` | `ctrl+t` | 过滤器：隐藏工具结果 |
| `app.tree.filter.userOnly` | `ctrl+u` | 过滤器：只看用户消息 |
| `app.tree.filter.labeledOnly` | `ctrl+l` | 过滤器：只看带标签的条目 |
| `app.tree.filter.all` | `ctrl+a` | 过滤器：显示全部 |
| `app.tree.filter.cycleForward` | `ctrl+o` | 向前循环过滤器 |
| `app.tree.filter.cycleBackward` | `shift+ctrl+o` | 向后循环过滤器 |

## 循环模型选择器

在 `/scoped-models` 打开的选择器中使用。

| 动作 ID | 默认按键 | 说明 |
|---|---|---|
| `app.models.enableAll` | `ctrl+a` | 启用全部模型（或当前搜索匹配的全部） |
| `app.models.clearAll` | `ctrl+x` | 清除全部模型（或当前搜索匹配的全部） |
| `app.models.toggleProvider` | `ctrl+p` | 切换当前服务商的所有模型 |
| `app.models.reorderUp` | `alt+up` | 在循环顺序中上移 |
| `app.models.reorderDown` | `alt+down` | 在循环顺序中下移 |

## nek 扩展

| 按键 | 说明 | 配置位置 |
|---|---|---|
| `alt+m` | 在 Agent 和 Plan 模式之间切换 | `nek.yaml` 的 `plan.shortcut` |
