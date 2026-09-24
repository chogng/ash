# 编辑器核心：Native Rust 与 Stanza TypeScript 边界

> 状态：Current。`ash-editor-core` 是 App Native editor 的纯 Rust document core；Stanza 是 Ash
> Renderer 内独立的 TypeScript editor，不通过 WASM 或 App Server RPC 复用该同步 core。Rust 实现契约见
> [`ash-editor-core`](../app-rs/editor-core/README.md)，App 编辑器实现见
> [`ash-editor`](../app-rs/editor/README.md)，Stanza 实现见
> [`app-ts/src/ash/editor/text-engine.md`](../app-ts/src/ash/editor/text-engine.md)。

## 当前所有权

| 能力 | Stanza（Ash TS Renderer） | App（Native Rust） |
| --- | --- | --- |
| 文本存储、transaction、version | `TextModel` / `TextBuffer` | `EditorCoreDocument` / `CodeEditorDocument` |
| undo/redo 与 typing grouping | `TextModelHistory` | `EditorCoreDocument` + Native command policy |
| selection、tracked range、IME | Stanza common/browser | `ash-editor` |
| layout 与 presentation | DOM、CSS、virtual viewport | `ash-ui-components`、`zui`、GPU scene |
| 文件、LSP、workspace search | 异步调用 Rust App Server service | Native product adapter 按需组合 Rust crate |

两套 editor 共享产品语义和 conformance 目标，但不共享同步运行时状态。Stanza 的输入必须在 Renderer 当前事件
循环内完成；逐键 IPC、WASM 双写或远端 undo authority 都会破坏 IME、selection 和渲染一致性。App 则直接链接
Rust crate，不需要 Browser transport。

## Stanza 与 Rust 后端的数据流

```text
Browser input
  → Stanza TextModel 同步提交
  → versioned TextModelChange
     ├─ 同步更新 selection / tracked ranges / viewport
     ├─ 异步同步前端 language Worker
     └─ 异步发送 Rust file / LSP / search service

Rust result(resource + document version + request identity)
  → Stanza freshness gate
     ├─ current: result store / decoration / widget
     └─ stale: discard
```

Rust 后端适合拥有文件读写与磁盘版本检查、language-server 生命周期和 document sync、workspace search、Git 与后台业务 Diff、
formatting、rename、code action 和异步语言分析。Stanza 持有 dirty buffer、保存冲突状态和交互，并通过自己的
`TextModel.applyEdits` 应用后端返回的 edits。

基础语法高亮与编辑器实时 Diff 的最终归属是前端。TS 当前仍有 App Server Diff 和 parser token 调用，
后续切分与验证见[前端 crate 迁移计划](../app-rs/docs/crate-migration-plan.md)；本次 Rust crate 目录迁移不表示这些调用已移除。

## `ash-editor-core` 的 Native 契约

`ash-editor-core` 接受 UTF-16 code-unit range、revision-bound atomic edit 和显式 post-selection，拒绝 stale
revision、代理对中间 offset、重叠 edit 和无效 selection。Native `CodeEditorDocument` 用 persistent core 持有
committed text、selection、revision 与 history；Native text projection 只服务 line index、syntax、folding 和绘制。

该 crate 不依赖 `zui`、`ash-ui-components`、Native host、DOM、文件或 transport。若未来出现第二个真实 Rust consumer，应该
直接依赖其纯 Rust API；不得为 Stanza 的同步输入路径预先增加 WASM 或 App Server adapter。

## 长期不变量

- Stanza 的同步 text/history/selection authority 在 TypeScript Renderer。
- Rust App Server 结果必须携带并比较 Stanza document version；后端不可阻塞输入。
- App Native 直接消费 Rust editor/core/UI crate，不绕经 Electron 或 Browser API。
- `ash-editor-core` 不依赖 presentation 或 transport；Stanza 不依赖 `ash-editor-core`。
- 只有基准与真实消费者证明必要时才提取共享 wire contract，不能以潜在复用代替当前所有权。
