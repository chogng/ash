# Native Text 输入：分层、IME 与当前实现

> 状态：Current。
> 本文拥有 Native 单行控件与多行代码编辑器输入的跨 crate ownership、用户语义和演进边界。具体源码接口与
> 修改路径分别由 [`app`](../README.md)、
> [`zui`](../zui/README.md) 和 [`ash-ui-components`](../ui-components/README.md) 说明。

## 快速理解

Native 文本输入采用单向依赖，不建立同时理解窗口事件、编辑状态和 GPU scene 的总括 widget：

```text
winit keyboard / IME event
  → private zui window/input forwarding
  → app focus and event routing
  ├─ single-line → zui TextInput → TextInputLayoutEngine → ash-ui-components InputBox
  └─ multiline   → ash-editor CodeEditorDocument / CodeEditorViewport → CodeEditor
  → zui UiScene
```

`zui` 的 backend-neutral `ui`/`runtime` modules 不依赖 `ash-ui-components`、winit 或 GPU；`zui::window` 与 `zui::input` 统一导出 ZUI-owned 事件，并在各自 owner 内组合 private native adapter。`TextInput` 不保存 `winit::Ime`、`KeyEvent` 或 GPU 类型；平台
adapter 不理解 committed text、selection 或 composition。这个边界让 Unicode 编辑语义、
shaping geometry 和真实平台接入可以分别测试。

| 用户行为 | 当前支持 | 由谁负责 |
| --- | --- | --- |
| 键盘输入和光标移动 | ✅ | `TextInput` 或 `CodeEditorDocument` |
| 中文、日文等输入法预编辑与提交 | ✅ | Native 路由 + 当前输入模型 |
| 选择、退格和字素级移动 | ✅ | `TextInput` 或 `CodeEditorDocument` |
| 文件编辑器鼠标放置光标、拖选与越界自动滚动 | ✅ | Native pointer/timer adapter + `CodeEditor` hit-test |
| 文件编辑器剪贴板、撤销和重做 | ✅ | `zui::ClipboardHandle` + `CodeEditorDocument` |
| 文件编辑器查找/替换与自动缩进 | ✅ | Native find widget + `CodeEditorDocument` search/indent contracts |
| 多行编辑与 viewport soft wrap | ✅ | `ash-editor::CodeEditorDocument` / editor-owned visual projection |

## 2. 所有权

| 能力 | 当前 owner | 状态 |
| --- | --- | --- |
| 原生 keyboard/IME event 与候选框 API | `zui::input` + private `window` native adapter | 委托 |
| Composer、文件 Editor 与搜索框 focus、event routing、IME activation | `app-rs/workbench/application` 的 `WorkbenchApplication` | ✅ |
| Composer committed text、selection、IME state 与 multiline viewport | `ash-session::SessionPaneState` + `ash-editor::CodeEditorDocument` | ✅ |
| Committed text、selection、grapheme movement | `zui::TextInput` | ✅ |
| Preedit/commit/cancel composition state | `zui::TextInput` | ✅ |
| 单行 shaping、selection/caret/preedit geometry | `zui::TextInputLayoutEngine` | ✅ |
| Caret blink phase state machine | `zui::CaretBlinkController` | ✅ |
| Input-box chrome、状态与 scene composition | `ash-ui-components::InputBox` | ✅ |
| Blink deadline scheduling 与 redraw | `app-rs/workbench/application` 的 `WorkbenchApplication` | ✅ |
| 文件 Editor mouse caret、drag selection、clipboard 与 viewport | `file_editor_input` + `ash-editor` | ✅ |
| 文件 Editor undo/redo 与 vertical navigation | `ash-editor::CodeEditorDocument` | ✅ |
| 平台 accessibility adapter | `zui` private AccessKit adapter | 委托；TextInput 现有 value/focus 随 frame 发布 |

`TextInput` 是非 component 基座：拥有编辑状态、composition 和 shaping contract，但不实现
`Component`，也不拥有边框、背景、placeholder 或 hover/focus 视觉。`InputBox` 才是
`Component`，它组合 `TextInput` 的 immutable layout 与自己的 chrome/style。
`CaretBlinkController` 同样不是 component；它只计算时间相位，不创建 timer 或请求 redraw。

## 3. 用户语义与不变量

- committed text 与 preedit 永远分离；`Preedit` 只改变临时 composition，`Commit` 才写入文本；
- selection、cursor 和 IME cursor range 都使用 UTF-8 byte index；
- 普通移动和删除以 extended grapheme cluster 为边界，不拆开组合附加符或 emoji sequence；
- composition 在视觉上临时替换 active selection，但不修改 committed text；只有 `Commit` 才原子
  替换 selection，cancel 保留原始文本和选择；
- IME 没有提供 preedit cursor 时隐藏 caret；提供 range 时使用 range end 定位 caret；
- composer、文件 Editor 或搜索框获得焦点时启用 IME；输入目标切换时清除原目标未提交的 preedit；
- 获得焦点或发生 editing/composition activity 时 caret 立即可见，之后按 deadline 切换相位；
- active selection 隐藏普通 caret；IME preedit cursor 仍遵守平台提供的 visible/hidden range；
- 候选框锚点来自 shaped caret 的 logical window coordinates，不使用字符数估算；
- 单行模型拒绝换行与控制字符。

## 4. 当前端到端路径

```text
pointer release on composer / file editor / search input
  → ShellInteraction focuses the selected text input
  → NativeWindow::enable_ime
  → rebuild ShellPresentation
  → TextInputLayoutEngine shapes content
  → NativeWindow::set_ime_cursor_area(shaped caret)

WindowEvent::KeyboardInput
  → WorkbenchApplication routes by Workspace Surface and focused element
  ├─ single-line → TextInputCommand → TextInput
  └─ file editor → CodeEditorCommand → active CodeEditorDocument
  → rebuild and redraw

WindowEvent::Ime(Preedit)
  → WorkbenchApplication maps platform event to TextInputCompositionEvent
  → active TextInput or CodeEditorDocument updates temporary composition
  → owning component paints preedit underline and caret

WindowEvent::Ime(Commit)
  → TextInput atomically inserts committed text
  → composition clears
  → rebuild, reposition candidate area, redraw

zui::App::about_to_wait
  → CaretBlinkController::advance
  → rebuild only when the visible phase changes
  → ControlFlow::WaitUntil(next blink deadline)
```

## 5. 关键取舍

| 选择 | 结论 | 原因 |
| --- | --- | --- |
| `TextInput` 直接处理 `WindowEvent` | ❌ | 造成 base → platform 反向依赖，无法纯测试 |
| `TextInput` 实现 `Component` 并拥有 chrome | ❌ | 混合编辑基座与具体 input-box presentation |
| 用字符数估算 caret | ❌ | 比例字体、fallback、emoji 和 BiDi 会产生错误候选框位置 |
| preedit 直接写入 committed text | ❌ | cancel/update 会破坏文本和 selection |
| `TextInput` base + `InputBox` component | ✅ | 编辑语义可复用，具体组件拥有自己的 chrome |
| 独立 layout engine + immutable snapshot | ✅ | shaping 几何可复用，InputBox 保持纯 scene composition |

## 6. 当前限制与演进前提

单行控件支持键盘插入、grapheme-safe 左右移动与删除、Shift selection、Home/End、Select All、
IME composition 和 caret blink；其 mouse selection、clipboard、undo/redo 与 password variant
仍未完成。文件 Editor 另外支持多行 navigation、pointer caret/drag、clipboard、undo/redo、结构
折叠、find/replace、自动缩进、soft wrap、垂直 viewport 和拖选越界自动滚动。平台 accessibility
由 `zui` 发布现有语义树；更完整的 selection/edit action 与各平台读屏 smoke coverage 仍需补充。

两类输入必须继续消费各自 owner 的同源 hit-test/layout，不能在 Native 另建字符宽度估算。
`TextInput` 基座留在 `zui`，输入框 chrome 留在 `ash-ui-components`；多行文档、命令和可见行投影留在
`ash-editor`。

## 7. 长期不变量

- platform adapter 只暴露窄 forwarding contract；
- authoritative editing state 不进入 renderer；
- render component 不执行产品命令；
- composition 与 committed text 保持可区分；
- cursor/selection geometry 与实际 shaping 使用同一文本语义；
- 产品领域状态不得下沉到 `zui` 或 `ash-ui-components`。
