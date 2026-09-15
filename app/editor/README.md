# `ash-editor`

> 本 README 是代码编辑器与差异编辑器 presentation 的 crate-level canonical contract。
> 跨 crate 的依赖与产品宿主边界见
> [`docs/ash-rs-architecture.md`](../../docs/ash-rs-architecture.md)；`ash-diff` 算法契约见
> [`ash-diff`](../../ash-rs/diff/README.md)；异步结构分析与 revision binding 见
> [`docs/syntax-analysis.md`](../../docs/syntax-analysis.md)；文件保存基线与冲突状态由
> [`ash-text-file`](../../ash-rs/text-file/README.md) 独立拥有。共享 Rust document core 与跨运行时迁移边界见
> [`docs/editor-core.md`](../../docs/editor-core.md)。

`ash-editor` 拥有 Native UI 使用的多行代码编辑模型、caret/selection、键盘命令、有界
undo/redo、IME composition、语法 token、结构折叠、viewport soft wrap、代码行与视口绘制，以及由两个代码视口组成的并排差异
展示、适合窄 surface 的单列 unified 差异展示，以及纵向组合多个文件差异的
`MultiDiffEditor`。它不读取文件、不执行 Git、不计算 diff，也不拥有 changed-file collection、
活动 EditorHost 或平台事件。

## 所有权与接口

| Symbol | 可见性 | 精确职责 |
| --- | --- | --- |
| `CodeEditor` | public | 绘制可见代码行、caret/selection、preedit、syntax token、gutter 与 fold control；拥有 fold-control geometry 和 hit test，`within_viewport` 限制嵌入式宿主实际投影的行 |
| `CodeEditorPresentation` | public | 选择带 document chrome 的普通编辑器或隐藏 gutter 的 compact 嵌入式编辑器 |
| `CodeEditorLineWrapping` / `CodeEditorNavigation` | public | 选择不换行或 viewport soft wrap，并把 presentation 解析出的显示列宽和可见行容量交给 document 的上下键与翻页导航 |
| `CodeEditorDocument` | public | 拥有 Native 的语言、行 range、composition、syntax snapshot、fold/visible-row projection；committed text、selection、revision 与 undo/redo 委托 persistent `ash-editor-core`，同步 text projection 仅供 Native 计算/绘制 |
| `CodeEditorRevision` | public | `ash-editor-core::EditorCoreRevision` 的 Native 名称；为宿主提供与文本 mutation 绑定的单调 revision，navigation 不推进，insert/replace/undo/redo 推进 |
| `CodeEditorFoldingRange` / `CodeEditorFoldState` | public | 表达零基 source-row 结构范围及每个 document 实例独立的展开状态；start row 保留可见 |
| `CodeEditorFoldControl` | public | 发布当前帧可见 gutter control 的 editor-owned range、state 与命中 bounds |
| `CodeEditorCommand` | public | 表达插入、自动缩进换行、indent/outdent、语言声明的行注释、行复制/移动/删除空行/合并/插入/行尾空白清理/排序/反转/去重、Unicode navigation、选择、删除与 undo/redo |
| `CodeEditorIndentation` | public | 以显式 tabs/spaces 与 tab width policy 驱动换行、Tab 与 Shift+Tab、leading-whitespace close delimiter auto-outdent；Enter 保留 document line ending，不把缩进策略放进 Native |
| `CodeEditorSearchQuery` / `CodeEditorSearchMatch` | public | 表达大小写策略、byte range 与 editor position；前后循环查找、单次/全部替换由 document 执行 |
| `CodeEditorDiagnostic` / `CodeEditorDiagnosticSeverity` | public | 表达 UTF-8 document byte range、severity、message/source/code；不暴露 LSP 类型 |
| `CodeEditorDiagnosticPalette` | public | 由宿主把 error/warning/information/hint theme token 映射为编辑器语义颜色 |
| `CodeEditorLanguage` | public | 让宿主选择 PlainText、Shell、JSON、JSONC 或 Rust；parser、tree、revision 与 token projection 保持私有 |
| `CodeEditorPalette` / `CodeEditorSyntaxPalette` | public | 由宿主把 resolved theme token 映射为组件命名输入；换主题只重建 style，不重新分析文本 |
| `CodeEditorRowSource` | public trait | 惰性提供稳定 visual row；普通文档和 diff projection 共用 |
| `CodeEditorRow` | public | 表达真实代码行、对齐 placeholder 或无行号 annotation，以及本帧 decoration |
| `CodeEditorViewport` | public | 保存首个可见行和横向显示列，并执行有界滚动或 reveal-row |
| `CodeEditorStyle` | public | 拥有代码 surface、header、gutter、文本与 syntax role 的 resolved presentation style；`light()` 只是安全 fallback |
| `DiffEditor` | public | 按 presentation 组合双列或单列 `CodeEditor`，同步纵向 viewport 并绘制 diff decoration |
| `DiffEditorDocument` | public | 接收已计算 `DiffDocument` 与 language，内部持有 original/modified 两个 language-aware `CodeEditorDocument`；不向宿主暴露 parser/revision/token |
| `DiffEditorPresentation` | public | 显式选择 `SideBySide` 或适合窄嵌入 surface 的 `Unified` geometry |
| `DiffEditorState` | public | 保存共享首行、两侧独立横向显示列和 Unified 未修改区间的展开状态 |
| `DiffEditorFoldControl` | public | 向产品宿主发布可见未修改区间的行数、状态与命中 bounds |
| `MultiDiffEditor` | public | 把多个文件标题和 `DiffEditor` section 组合为一个纵向裁剪 surface |
| `MultiDiffEditorItem` | public | 为一帧借用文件名、`DiffEditorDocument`、两侧标签和该文件的 `DiffEditorState`；产品 host 应通过 `with_identity` 提供稳定 changed-file identity |
| `MultiDiffEditorItemIdentity` | public | 从 host-owned stable slot 派生 section/header/diff/fold `ElementId`，并提供折叠 section 的 `AnimationProperty::Height` key |
| `MultiDiffEditorLayout` | public | 用 `ash-ui-components::VirtualListLayout` 缓存精确 item/state/presentation snapshot 的可变 section heights、平衡分块高度索引与总内容高度，并允许宿主更新一个 section measurement 或 splice changed-file 区间 |
| `ash-ui-components::ScrollState` | delegated | 保存 MultiDiffEditor 整体 logical-pixel offset；clamp 与 transition 由通用滚动基座执行 |
| `MultiDiffEditorStyle` | public | 拥有文件 header、section 间距与嵌套 DiffEditor 样式 |
| `DiffEditorPalette` / `MultiDiffEditorPalette` | public | 让产品宿主通过命名字段注入 diff marker/background、scrollbar 与文件 header 视觉 |
| `DiffSideRows` | private | 把 `DiffEditorDocument` 的一侧惰性转换为带 editor-owned syntax token 的 `CodeEditorRow` |
| `UnifiedDiffRows` | private | 用 hunk source-range、修改行索引和 fold segment 紧凑表达单列 diff；按可见 visual index 随机映射代码行，不按文件总行数分配 row 数组 |
| `UnifiedDiffMetrics` | private | 随 `DiffEditorDocument` 缓存折叠基线行数和各未修改区间展开增量，让离屏文件高度计算不构造完整 row projection |
| `MultiDiffSection` / `MultiDiffFileHeader` | private | 在共享 `ComponentContext` 中拥有每个 changed file 的 card/header geometry，并把同一 section 的 `DiffEditor` 放入 inspection ancestry |
| `MultiDiffFoldControl` / `MultiDiffScrollbar` | private | 将 editor-owned fold geometry 和 ScrollView scrollbar geometry 投影为真实组件及 interaction semantics；产品 host 不再手工注册这些节点 |
| `code_editor::layout::build_layout` | private | 从组件 bounds 计算 header/body/gutter/content |
| `code_editor::text_metrics::display_columns_until` | private | 把 UTF-8 byte offset 映射到 Tab/Unicode 等宽显示列 |
| `code_editor::wrapping::CodeEditorVisualProjection` | private | 未换行时保存 O(1) 恒等行映射；软换行时才按 grapheme/Tab display column 建立 visual line 索引，并执行 caret/pointer 映射 |
| `code_editor::editing` | private module | 执行 grapheme-safe mutation、跨行导航、selection 与有界 history |
| `code_editor::folding` | private module | 规范化 syntax fold、保留 collapsed identity，并执行 source-row / visual-row 双向投影 |
| `code_editor::decorations` | private module | 绘制 selection、syntax、composition、caret 并计算 IME caret bounds |
| `code_editor::diagnostics` | private module | 把 document byte range 投影到 source row 与 soft-wrapped visual line，绘制波浪线并执行文本命中 |
| `diff_editor::layout::build_layout` | private | 计算两个 pane 与中央 divider |

```text
CodeEditorDocument ─┐
                    ├─ CodeEditorRowSource::row
DiffSideRows ───────┘
                           ↓
CodeEditor::paint
├─ zui Element(CodeEditor bounds) → automatic inspection
├─ code_editor::layout::build_layout
├─ CodeEditor::visible_row_range
├─ wrapping::CodeEditorVisualProjection → source row / wrapped visual line mapping
├─ CodeEditor::painted_row_range → host viewport row culling
├─ gutter / marker / line background
├─ text_metrics::display_columns_until
└─ UiScene

CodeEditorDocument::apply
├─ CodeEditorCommand
├─ grapheme / CRLF boundary navigation
├─ selection replacement
├─ checkpoint → core selection synchronization
├─ committed mutation → core bounded undo / redo + revision
└─ reindex_lines → CodeEditorAnalysis::synchronize
   └─ SyntaxDocument incremental edit
      ├─ token → line-relative CodeEditorSyntaxToken
      └─ folding range → CodeEditorFoldingProjection
         └─ visible row mapping / gutter fold control

CodeEditorDocument::apply_composition
├─ Preedit → separate composition state
├─ Commit → one undoable replacement
└─ Cancel → committed text unchanged

CodeEditorDocument::find_next / find_previous / replace_current / replace_all
├─ CodeEditorSearchQuery → committed-text byte ranges
├─ match → CodeEditorPosition + selection/reveal
└─ replacement → one checkpoint per command

DiffEditor::paint
├─ SideBySide
│  ├─ DiffEditorDocument.original syntax → DiffSideRows → CodeEditor
│  ├─ DiffEditorDocument.modified syntax → DiffSideRows → CodeEditor
│  └─ divider
└─ Unified
   └─ UnifiedDiffRows → one CodeEditor
      ├─ context → one row
      └─ modified → removed row + added row
      └─ long unchanged range → fold control + optional source rows

MultiDiffEditor::compose
├─ ScrollView::draw_components
│  ├─ viewport clip / content origin
│  └─ hover/active/fading scrollbar chrome
├─ VirtualListLayout::visible_range → balanced cumulative-height lookup
├─ visible MultiDiffSection only
│  ├─ MultiDiffFileHeader
│  ├─ DiffEditor::compose
│  │  └─ CodeEditor component(s)
│  └─ MultiDiffFoldControl component(s)
└─ MultiDiffScrollbar → shared scrollbar semantics

MultiDiffEditor::paint remains a scene-only compatibility path for callers that have not adopted
`ComponentContext`; it must not become the product interaction path. `EditorPane::compose` uses the
shared path above so one frame owns the complete inspection and interaction hierarchy.
```

`CodeEditorRowSource` 实现必须在一个 presentation frame 内保持 row ordering 和 line-number
identity 稳定，并只为请求的可见 index 构造行。普通文档返回真实编号行；差异投影可以返回没有
line number 的 placeholder 或 fold annotation，但不能把它们写入 authoritative document。行内高亮使用
UTF-8 byte range；越界或不落在字符边界上的 range 会被忽略，不得造成绘制 panic。
Code row 的底层 text run 仍使用 `TextBlockWrap::None`；启用 `CodeEditorLineWrapping::Soft` 时，
`CodeEditorVisualProjection` 按可用 display column 建立视觉行并分别 clip/paint，而不会向 document
插入换行。宽字符 grapheme 与 whitespace 按 8px display cell
边界分别投影；ASCII run 对齐一个 cell，CJK fallback 对齐两个 cell，使 text、space、
selection 与 caret 共用同一坐标系。语法 token 保存语义 role，不保存 RGB；paint 从当前
`CodeEditorStyle` 解析颜色，所以 theme snapshot 变化不使 syntax snapshot 失效。
普通文档折叠保留 start row，隐藏到 syntax range end row（含）之间的 source row；caret、selection
和 pointer position 始终使用 source row，viewport 与 paint 使用折叠加 soft-wrap 后的 visual row。
折叠与换行投影负责双向映射，
所以宿主不维护 hidden-line offset。父范围展开后，仍然有效的嵌套 collapsed state 会恢复生效。

Unified projection 以 `DiffDocument::hunks` 的间隙作为可折叠区间，只保存 source segment、segment end index 和 `Modified` source-row index。展开超大未修改区间不会物化等量 `CodeEditorRow`；可见行先以二分定位 segment，再映射回 source row。`DiffEditorDocument` 缓存统一视图的折叠基线与区间增量，所以离屏文件的高度计算不构造 row projection；未启用软换行的 `CodeEditorVisualProjection` 也只保存恒等映射，真正进入可见区时才请求具体行。

`MultiDiffEditor` 通过 `VirtualListLayout` 缓存每文件 section height 与平衡分块高度索引；paint 和 fold-control 查询先定位可见 section，不从首个文件线性累加 offset。宿主保留 `measure_layout` 结果供滚动、fold-control geometry 和 paint 复用；单文件状态变化调用 `update_section_extent`，changed-file 集合变化调用 `splice_section_extents`，SCM 按稳定 identity 保留区间外布局并通过 `ListScrollAnchor` 保持视口。首次快照、style 或 presentation 变化才重建全部 measurement。

## 执行、失败与宿主义务

`CodeEditor`、`DiffEditor` 和 `MultiDiffEditor` 构造与绘制没有 I/O 或独立 error channel。编辑命令以 Unicode
grapheme boundary 修改 committed text；CRLF 在删除时作为一个换行边界处理。`ash-editor-core` 为 Native
保留最多 100 个完整 snapshot，新编辑会清空 redo；当前不合并连续输入。IME preedit 与 committed text
分离，只有 Commit 建立一个可撤销 checkpoint，Cancel 不修改文档。`CodeEditor::caret_bounds`
向平台宿主提供候选框锚点，`text_position_at` 与 `CodeEditorDocument::move_to` /
`set_selection` 支持指针选择。`CodeEditorPresentation::Compact` 只改变共享组件拥有的
header/gutter geometry，不改变 document、editing 或 row-source contract。
直接键入语言允许的单个开括号或引号会创建匹配的 close delimiter；已有选区时会包裹并保留选区。
只有仍被 document 追踪为自动创建的 close delimiter 才允许 overtype 或双侧 Backspace，手写源码中的
相同字符保持普通插入/删除语义；IME Commit 和多字符输入保持原样，避免把 composition 或 paste 误判为键入。
Rust/JSONC 使用 `//`、Shell 使用 `#` 的行注释命令由语言声明决定；JSON 明确不接受该命令。
启用 soft wrap 的宿主应把 `CodeEditor::navigation()` 交给
`CodeEditorDocument::apply_in_view`，并使用 `visual_row_count` / `caret_visual_row` 驱动 viewport；
宿主不得重新计算换行边界。
`CodeEditor::fold_control_at` 负责 gutter 命中，宿主把返回值原样交给
`CodeEditorDocument::toggle_fold_control`；范围计算、stale-control 校验、状态迁移、隐藏行、光标修正
和 fold glyph 都不属于宿主。

三个公开 editor Component 都通过 `Component::element` 声明各自 zui leaf，resolved bounds 与源码
位置由 `UiScene::draw_component` 自动写入 inspection frame；宿主必须使用
`UiFrame::draw_component`/`ComponentContext::draw_component`，使
`MultiDiffEditor → ScrollView → MultiDiffSection → DiffEditor → CodeEditor` 的可见组合链进入同一帧的
layout inspection hierarchy。`MultiDiffFoldControl` 与 `MultiDiffScrollbar` 也必须沿这条链生成，
不能回到手工注册 `UiNode`。该 metadata 不改变 document、viewport 或输入 ownership；需要把自定义
paint 与子组件放在一个宿主根下时，使用 `ComponentContext::with_component` 保持 inspector 与 interaction
父链一致。

`DiffDocument` 的输入验证、资源限制和取消在进入本 crate 前由 `ash-diff` 完成。宿主随后用
语言构造 retained `DiffEditorDocument`；组件只根据该不可变 editor snapshot 生成 `UiScene`。

产品宿主必须：

- 为每个文件保存独立的 document identity 与 editor viewport，并在创建 document 时选择
  `CodeEditorLanguage`；
- 为 `MultiDiffEditorItem` 提供已排序的 changed-file snapshot，并保留整体
  `ash-ui-components::ScrollState`；产品 host 必须为 changed file 分配稳定的
  `MultiDiffEditorItemIdentity`，不能用当前列表 index 作为 retained 或 animation key；
- 保存每文件 `DiffEditorState`，并用 `fold_controls` 发布的 identity 与 bounds 路由未修改区间
  的展开/收起输入；
- 对普通文档，用 `CodeEditor::fold_control_at` 转交 gutter 点击并调用
  `CodeEditorDocument::toggle_fold_control`，不得自行计算结构范围或隐藏行；
- 把滚轮、平台按键和 IME 事件转换为 `CodeEditorCommand` / `TextInputCompositionEvent`；
- 用 `caret_bounds` 同步平台 IME candidate area，并由 host 控制 caret blink；
- 在接入异步 diff 或 LSP 结果时丢弃不再匹配当前 document revision 的结果；CodeEditor 的
  tree-sitter revision 不暴露给宿主。
- 把 `ash-ui-theme` 或其他主题 runtime 的 snapshot 映射成公开 palette；本 crate 不读取主题文件，
  也不依赖具体产品宿主。

`app` 是当前 GPU presentation host；`ash-tui` 不依赖本 crate，而是直接消费
`ash-diff` 并拥有自己的 Ratatui projection。

## 测试、修改影响与限制

```bash
cargo test --manifest-path Cargo.toml -p ash-editor
cargo clippy --manifest-path Cargo.toml -p ash-editor --all-targets -- -D warnings
```

测试覆盖 LF/CRLF/CR 行索引、多行 Unicode 编辑、跨行列导航、选择替换、有界撤销/重做、IME
预编辑与提交、语法前景 token、结构折叠、source/visual row 映射、viewport soft wrap、
wrapped pointer/caret/vertical navigation、fold-control hit test、折叠后
caret/selection/navigation、viewport、Tab/Unicode 列宽和
无效 UTF-8 range，DiffEditor 的双 pane 映射、Unified 单列映射、字符级高亮和长未修改区间
展开/收起，以及 MultiDiffEditor 的可变高度多文件 section、平衡分块高度索引 viewport 定位、
每文件 fold-control identity、整体纵向滚动与
超大单文件的紧凑行映射与 row-level viewport culling。

修改 `CodeEditorRowSource` 或 `CodeEditorRow` 必须同步检查普通文档和 `DiffSideRows`；修改显示列
计算必须同步检查 text、horizontal scroll 与 inline decoration；修改 CodeEditor layout 必须同步
检查 DiffEditor 两侧 geometry 和 pointer mapping。若 DiffEditor 再次直接绘制代码行、行号或
字符范围，表示共享 CodeEditor ownership 已经漂移。若 `MultiDiffEditor` 绕过 `DiffEditor`
直接生成左右代码行，或 `EditorPane` 重新手工注册 `MultiDiffSection`/fold/scrollbar interaction
nodes，表示多文件组合层的 ownership 已经漂移。

当前 history 使用完整 snapshot 且不做 typing coalescing；Native CodeEditor 的 tree-sitter 分析
与文本 mutation 同步执行，大文件尚未迁移到 editor-owned worker。多光标、
缩进和语言注释的 `#region` / `#endregion` 会生成编辑器自有的 folding candidates；多行 selection
可通过 `ToggleManualFoldSelection` 生成临时 manual fold，任何文本 mutation 都会将它移除。
minimap 尚未完成。`CodeEditorTextEdit` 允许产品 adapter 通过精确 UTF-8
range 使用同一 undo/revision/analysis mutation path。Diagnostics 已支持 revision 外部绑定、severity
波浪线、跨行/soft-wrap 投影和 hover hit-test；文件、tabs、持久化与产品级
EditorHost 明确不属于本 crate；Native `FileEditorHost` 已负责对应组合。普通 CodeEditor 的 syntax
结构折叠与 Unified DiffEditor 的未修改区间折叠是两套独立语义，分别保存在各自 document/state 中。
MultiDiffEditor section 高度随 diff row 数量增长，并用可变高度平衡分块索引剔除完全不可见的文件；部分可见的超大单文件只处理外层 viewport 内的行。折叠高度动画只绑定目标布局当前可见的 section，并通过稀疏高度覆盖影响后续可见 section，不为全部 changed file 创建 animation track 或复制完整高度索引。SCM 快照插入、删除或重排文件时计算稳定 identity 的共同前后区间，只 splice 变化的中间段，并把原可见文件重新解析到新 index 后恢复滚动锚点。
section/fold/scrollbar 的组件组合已完成；SCM host 现在为 changed file 分配稳定 identity，section、header、
diff body、fold control 和折叠高度 animation key 都从该 identity 派生。`MultiDiffEditor::fold_element_id`
仍保留旧的 index/region 编码，供未迁移的 standalone caller 兼容。SCM host 已把目标 section height 接入
retained `AnimationBinding`；高度会影响后续 section 的位置，因此使用 `FrameInvalidation::Rebuild`，并由 runtime
按 section identity 保持 transition 连续性与 track cleanup。动画对象仍不属于 editor 组件。
DiffEditor 已维护 original/modified 两侧的 language 与 syntax
snapshot；当前同步 parse 仍需以后基于大文件 profile 决定是否迁入 editor-owned worker。
