# `ash-editor-core`

> 本 README 拥有纯 Rust 编辑器核心的实现契约。跨运行时的分层、前端服务边界与迁移阶段由
> [`docs/editor-core.md`](../../docs/editor-core.md) 规范；App 编辑器的当前能力见
> [`ash-editor`](../editor/README.md)。

1. 在 App 进程内持有文本、选区、revision 和有界 undo/redo。
2. 原子应用绑定 revision 的文本事务，并校验 UTF-16 offset 边界。
3. 由 `ash-editor` 直接调用，不依赖绘制、文件、语法解析器或 IPC；TypeScript 端拥有自己的 `TextModel`。

## 当前 API 与调用路径

| Public API | 职责 | 不负责 |
| --- | --- | --- |
| `EditorCoreDocument` | 保存文本、selection、revision 与 bounded history | DOM、绘制、文件保存、语法结果 |
| `EditorCoreTransaction` | 将同一旧 revision 上的 edit 和 post-selection 原子提交 | command/keybinding 解释 |
| `EditorCoreUtf16Offset` | 固定 Browser-compatible UTF-16 code-unit 语义 | UTF-8 byte offset 暴露 |
| `EditorCoreDocumentSnapshot` | 在显式同步点复制文本、revision 与 selections | viewport / line rendering |
| `EditorCoreRevision` | 跨 adapter 共用的单调 revision value | 将 selection-only 变化误报为文本 mutation |
| `EditorCoreEditError` | 报告 stale revision、无效 surrogate boundary、重叠 edit | transport error mapping |

```text
adapter input
  → EditorCoreTransaction(base_revision, edits, selections)
  → EditorCoreDocument::apply_transaction
     → apply_edits (validate all UTF-16 ranges before mutation)
     → validate_selections (against resulting text)
     → checkpoint / revision advance
  → EditorCoreDocumentSnapshot
```

`apply_edits` 接受同一旧文本上的无重叠 edit，排序后从后向前应用；调用者的输入顺序不影响结果。
offset 落入代理对（surrogate pair）中间、edit 重叠、同起点 edit 或 stale revision 会拒绝整个事务，
不改变文本、selection、history 或 revision。无文本变化的 transaction 可以更新 selection，但不推进
revision，也不建立 history 项。

即使 DTO 经 JSON transport 反序列化而绕过 Rust 构造函数，`apply_transaction` 仍验证 ordered range
和 non-empty/valid-primary selection set；不可信 payload 只会返回 `EditorCoreEditError`，不会让 document
进入无效状态或触发 `replace_range` panic。

`undo` 与 `redo` 恢复 text 和 selection，并各自推进 revision，使异步 adapter 能丢弃旧结果。
`apply_transaction_with_history` 额外接受显式 `EditorCoreHistoryMerge`：Native command adapter 可以把已经判定为同一
typing 或 composition group 的连续 transaction 合并为一个 undo step；core 保留最早 pre-transaction snapshot。当前 history
仅按 transaction 数量上限裁剪，默认保留 1,000 项；文本单位预算、tracked ranges、syntax 和 command semantics
都是后续阶段，不应由 adapter 私自补出第二套文本 history。

Current Native `CodeEditorDocument` 以 persistent `EditorCoreDocument` 持有 committed text、selection、
revision 与 history，并有 exact-edit/undo/redo conformance test。Native 保留同步 text projection，供现有
line index、syntax、folding 与绘制读取；它不是第二个 history/revision owner。它还可通过
`apply_core_transaction` 消费一个 single-selection `EditorCoreTransaction`：core 验证 UTF-16 transaction，
Native 只投影 byte offset 并刷新 syntax/folding。multi-selection transaction 必须显式拒绝，直到 Native
presentation 真正支持多 caret。

## 修改影响与验证

```bash
just check ash-editor-core --locked
just test ash-editor-core --locked
just rust-warnings ash-editor-core --locked
```

修改 UTF-16 mapping、transaction validation 或 history 时必须同步检查 `document_tests.rs`。如果该 crate
开始依赖 `zui`、DOM、文件 service、App Server transport，或让 adapter 把未校验 byte offset 传入 core，
说明所有权已经漂移。

## 当前限制与演进

Current：Native `CodeEditorDocument` 是唯一产品消费者，并以同步 Rust 调用组合本 crate。Desktop Stanza 的 TypeScript
`TextModel`、history、selection 与 tracked ranges 是另一个运行时边界，不通过 WASM、App Server 或 shadow document
调用本 crate。Proposed：只有第二个真实 Rust consumer 出现后，才按其同步 Rust 调用面提取额外 adapter；不得为
Browser hot path 预建 transport。
