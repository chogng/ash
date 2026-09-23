# 编辑器语法能力

> 状态：Rust `CodeEditor` 已内部接入 Rust、JSON、JSONC 与 Shell 的增量 tree-sitter
> 分析；Rust `DiffEditor` 已通过 retained `DiffEditorDocument` 内部维护两侧语法状态；Desktop
> Stanza Text Engine 通过 TextMate 与有界 App Server syntax facts 提供语法能力。本文拥有跨编辑器的语法能力边界；底层解析契约见
> [`ash-syntax` README](../ash-rs/syntax/README.md)，符号索引、Language Server、代码检索与未来代码图
> 的跨系统演进见 [`code-intelligence.md`](code-intelligence.md)，Native 编辑器 API 见
> [`ash-editor` README](../app/editor/README.md)。

## 快速理解

语法高亮、折叠、outline 和 parse diagnostic 都是编辑器能力。产品层对外组合
`CodeEditor` 或 `DiffEditor`，只提供文档、语言、主题和平台输入；它不获得独立 syntax service，
也不通过 App Server 同步编辑器内部 revision。

| 能力 | 当前 owner | 状态 |
| --- | --- | --- |
| Rust/JSON/JSONC/Shell grammar、query 与增量 tree | `ash-syntax`，由 Rust `CodeEditor` 私有组合 | ✅ |
| 文本、selection、undo/redo、语言切换和 syntax token 生命周期 | `ash-editor::CodeEditorDocument` | ✅ |
| Native 普通代码结构折叠、visible-row mapping 与 gutter control | `ash-editor::CodeEditorDocument` / `CodeEditor` | ✅；宿主只转交点击 |
| Native Composer 的 Shell 高亮 | `CodeEditorDocument::from_text_with_language` / `set_language` | ✅ |
| Native 文件 document lifecycle | `ash-text-file` + `FileEditorHost` / `FileEditorPane` | ✅；独立 crate 拥有 baseline/version/dirty/conflict，Native 已接通 Tab、Explorer load、save、关闭确认、外部重载/显式乐观覆盖、中心 Editor Surface 以及 keyboard/IME/pointer/clipboard/viewport 输入 |
| Native `DiffEditor` 两侧 syntax token 投影 | `ash-editor::DiffEditorDocument` / `DiffEditor` | ✅；宿主只提交 diff 与 language |
| Stanza bundled-language token | TextMate worker + lexical fallback | ✅ |
| Stanza parser facts | `ash-rs/syntax` via bounded `platform/syntax` adapter | ✅ JavaScript/JSX、TypeScript/TSX、JSON/JSONC、Rust、Shell diagnostic/symbol/folding/selection |
| App Server syntax RPC | 按连接和模型保留解析文档 | ✅；相邻版本增量更新语法树，仅服务异步 facts |
| Stanza Smart Select | Stanza selection/history + `ash-syntax` on-demand scopes | ✅ expand/shrink；revision-bound、可取消、stale-safe，parser 失败时 lexical fallback |
| completion、type、definition/reference、rename | `ash-lsp` + language server，经编辑器 language feature 接入 | ✅ Code 主路径；语言覆盖由 provider collection 决定 |
| workspace code chunk index | `ash-codebase` 消费 `ash-syntax` declaration facts | ✅ 本地 lexical retrieval；不是统一 semantic symbol graph |
| workspace symbol/reference capability | `ash-lsp` + App Server language runtime | ✅ workspace symbols 与按需 references 已接通；持久化全局 semantic graph 仍属于可选 index 演进，不属于单个 editor document |

## 一次 CodeEditor 编辑

```text
Native host
  └─ CodeEditorDocument::apply / apply_composition / replace_text
       ├─ 修改 authoritative editor text 与 history
       ├─ CodeEditorAnalysis::synchronize
       │  └─ ash-syntax::SyntaxDocument::apply_edit
       └─ 同 revision snapshot
          ├─ token → line-relative CodeEditorSyntaxToken
          └─ folding range → editor-owned visible-row projection
             └─ CodeEditor::paint / fold_control_at
```

1. 宿主创建 `CodeEditorDocument` 时选择 `CodeEditorLanguage`，或在 mode 改变时调用
   `set_language`。
2. `CodeEditorDocument` 执行 Unicode-safe 编辑、IME commit、undo/redo 或全文替换。
3. 私有 `CodeEditorAnalysis` 计算单个 UTF-8 replacement，推进内部 revision，并让
   `SyntaxDocument` 复用旧 tree；解析失败时丢弃旧 analyzer，并从当前 authoritative text 重建。
4. 同 revision snapshot 被投影为逐行 token 与 source-row folding range；每个
   `CodeEditorDocument` 独立保存 collapsed state，并把 source row 映射为 visual row。
5. 绘制只读取 document 已确认的 token/fold projection，并从当前 `CodeEditorStyle` 解析颜色；
   主题变化不触发重解析。宿主把 `fold_control_at` 的结果原样交给 `toggle_fold_control`，不计算
   fold 或 hidden row。

调用方看不到 parser、tree、revision、edit batch 或 syntax transport。这些细节随编辑器文档一起
创建、编辑和释放，避免 model ID、连接所有权、重连恢复和 stale-result gate 泄漏到 Workbench。

## 所有权边界

| 能力 | `ash-syntax` | `CodeEditor` / Stanza | 产品宿主 | App Server | `ash-lsp` |
| --- | --- | --- | --- | --- | --- |
| grammar、query、tree-sitter tree | ✅ | 组合/消费 | ❌ | ❌ | ❌ |
| editor text、selection、language 与本地 revision | ❌ | ✅ | 选择初始资源与语言 | ❌ | 消费同步 |
| syntax token、parse facts 与 selection scopes | 计算 | ✅ 生命周期、selection history 与展示 | ❌ | 按连接保留可释放的解析状态，投影有界结果 | ❌ |
| theme color、DOM/native geometry、fold UI state | ❌ | ✅ | 注入主题/布局 | ❌ | ❌ |
| 文件 dirty/save/conflict | ❌ | ❌ | 组合 `ash-text-file` | 可提供独立文件 I/O capability | ❌ |
| type、completion、definition/reference、rename | ❌ | 交互入口 | 协调 | 可承载独立 LSP runtime | ✅ |
| workspace 扫描、watch 与 symbol index | ❌ | ❌ | 协调 | ✅ 承载 LSP workspace symbols/references；持久化 graph 可独立演进 | 消费/提供事实 |

`ash-syntax` 仍保持独立 crate，因为 grammar、query、资源上限和增量 tree 算法需要可测试的领域
边界；但它不是产品对外服务。`ash-editor` 是当前唯一产品 consumer，Native 不直接依赖它。
tree-sitter 的输出是 concrete syntax facts，不是统一 AST，也不是 compiler/LSP semantic facts。

## Desktop Stanza

Stanza 只对外暴露编辑器与 versioned language-provider contract。声明式 grammar 在专用 TextMate
Worker 中运行；Workbench 的 `AppServerSyntaxProviders` 把 App Server 的有界解析结果注册为 diagnostic、symbol、folding 与 selection-range provider。前端提交带模型 ID 和版本的完整快照；App Server 按连接保留解析文档，计算相邻快照的最小改动并增量更新语法树。同一版本的功能请求复用解析结果，模型释放时发送 `syntax/close`，连接关闭时清理该连接的全部解析文档。前端 TextModel 仍是文本和版本的唯一依据；解析请求不参与键盘、IME、selection 或同步 transaction，结果须通过 model-version gate 才能应用。

Smart Select 是一条按需路径：快捷键捕获当前 snapshot 与所有 selection，调用
`syntax/selectionRanges`，每个 selection 只沿 parser named ancestors 返回默认最多 64 层；普通
`syntax/analyze` 不序列化全树 selection nodes。结果只有在 request 未取消、model revision 与 selection
set 都仍一致时才应用。首次 caret expansion 仍选择 word，后续优先最小 parser scope，再回退到
pair、line 和 document；shrink 只使用 Editor-owned history。该离散 command 可以承受 App Server
round trip；任何进入连续 typing hot path 的未来 structural operation 必须迁到 editor worker/in-process
parser。

## DiffEditor 与后续演进

`DiffEditorDocument` 接收已经计算完成的 `DiffDocument` 和一个 `CodeEditorLanguage`，内部重建
original/modified 精确文本，并各自持有 `CodeEditorDocument`。双栏和 unified projection 根据
source line number 读取同一份 editor-owned token；Changes Pane 不知道 parser、revision 或 token。
语言切换只调用 `DiffEditorDocument::set_language`，不会产生 App Server 请求。

近期工作按以下顺序推进：

1. 按真实产品需要扩展 parser-grade 语言覆盖，不复制已有 editor language contract。
2. 当前 `ash-codebase` 已作为独立 workspace capability 消费 declaration ranges；后续 semantic
   symbol/reference graph 继续由 LSP/index owner 演进，不能回填到 editor-local parser lifecycle。
3. 先增加 select declaration/argument/expression/statement 等只读 operation；delete/move/wrap 等 mutation
   必须返回 revision-bound plan，由 Editor 在一个 undo transaction 中应用和复核。

长期不变量是：产品层暴露编辑器，不暴露 parser RPC；编辑器拥有文档内语言能力，
`ash-syntax` 拥有底层 syntax 算法，LSP/compiler 拥有跨文件语义事实。
