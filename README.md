# 快捷文本 Quick Text

一个 Chrome / Edge 浏览器扩展(MV3):维护一份预置文字片段列表,在网页任意输入框按 **Alt+Q** 在光标旁弹出浮动面板,输入关键字过滤、↑↓+Enter 或鼠标点击,把文字插入光标处。

- 支持单行 `input`、多行 `textarea`、`contenteditable` 富文本框、以及 iframe 内的输入框
- 面板自带搜索(标题 / 内容 / 关键字,多关键字空格分隔),跟随系统明暗主题
- 管理页支持增删改查、上下排序、搜索,以及整个列表的 JSON 导入 / 导出
- 无构建步骤、无外部依赖,纯原生 JS/HTML/CSS

## 安装(开发者模式加载)

1. 打开 `chrome://extensions`(Edge 为 `edge://extensions`)
2. 右上角开启「开发者模式」
3. 点「加载已解压的扩展程序」,选择本目录(`quick-text`)
4. 首次安装会自动写入 3 条示例片段,可在管理页删除/修改

> 本目录必须保留;删除或移动目录会导致扩展失效。

## 使用

**唤出面板**(三选一):

- 在输入框内(或最近用过的输入框)按 `Alt+Q`
- 点击工具栏图标
- 在输入框/富文本上右键 → 「插入快捷文本」

**面板内操作**:

| 按键 | 作用 |
|------|------|
| 直接打字 | 按关键字过滤列表(中文输入法选词不受影响) |
| `↑` / `↓` | 循环选择条目 |
| `Enter` | 插入选中条目到光标处 |
| `Esc` | 关闭面板并归还光标 |
| 鼠标点击 | 直接插入该条目 |

页面滚动、点击面板外部会自动关闭面板。若当前页面找不到任何输入框,面板进入「复制模式」:点条目 = 复制到剪贴板。

**管理列表**:右键工具栏图标 → 「选项」,或扩展详情页 → 「扩展选项」。管理页改动立即对面板生效。

**导入 / 导出**:管理页右上角。导出为带时间戳的 JSON 备份;导入支持「合并」(追加并按内容去重)与「覆盖」(自动先下载当前数据的备份)。导入文件可以是导出的 `{version, exportedAt, snippets}` 结构,也可以直接是条目数组。

## 常见问题

- **快捷键不生效 / 被占用**:在 `chrome://extensions/shortcuts`(Edge: `edge://extensions/shortcuts`)给「快捷文本」改绑其他组合键。
- **本地 `file://` 页面无效**:扩展详情页勾选「允许访问文件网址」;或在 `test/demo.html` 所在文件夹上右键用浏览器打开后重试。
- **工具栏图标出现红色 ✕ 角标**:当前页面不允许注入(如 `chrome://` 设置页、扩展商店、PDF 查看器);橙色 `!` 表示注入成功但打开面板失败。回到普通网页再按一次即恢复。
- **插入后想撤销**:`Ctrl+Z` 通常可用(走浏览器原生 insertText);极少数被页面禁用 insertText 的场景走手动插入,该路径不支持原生撤销。

## 已知限制

- 自绘编辑器(ProseMirror / Slate / CodeMirror 等)一般可用,个别深度定制的编辑器可能插入位置异常,此时会退化为复制到剪贴板并提示。
- 面板开在 iframe 内部时会受 iframe 可视区域裁剪。
- 多行片段插入单行 `input` 时,换行会被替换为空格。

## 开发

```
quick-text/
├── manifest.json          # MV3 清单:_execute_action=Alt+Q,无 host_permissions(按需授权)
├── background.js          # Service worker:图标/快捷键/右键三入口 → 按需注入 → 打开面板
├── content/content.js     # 内容脚本:焦点跟踪、Shadow DOM 面板、caret 定位、文字插入
├── options/               # 管理页(条目 CRUD + JSON 导入/导出)
├── icons/                 # 生成的 PNG 图标
├── tools/make-icons.js    # 零依赖 PNG 图标生成器(需 Node)
└── test/demo.html         # 本地测试页(input/textarea/contenteditable/密码框/iframe/翻转)
```

重新生成图标(修改 `tools/make-icons.js` 的配色/字形后):

```
node tools/make-icons.js
```

测试流程见 `test/demo.html`:先在扩展详情勾选「允许访问文件网址」,打开该页逐项验证(光标定位、向上翻转、IME 过滤、iframe、密码框排除)。
