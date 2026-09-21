# Stanza Rich Document Engine

> 本文是富文档功能实现的 canonical 设计规范，拥有 line-first 内容模型、schema compatibility、transaction、selection、history、browser projection、profile、collaboration、当前状态和修改契约。Editor 总体目录与模式装配见 [`README.md`](./README.md)，跨 Workbench、持久化与服务端的系统边界见 [`docs/editor-architecture.md`](../../../../docs/editor-architecture.md)，浏览器实现细节见 [`browser/README.md`](./browser/README.md)。
>
> 状态：Current + Proposed。状态表明确区分已实现内核、兼容路径与后续迁移。

## 快速理解

Stanza 以有序逻辑行为唯一内容主轴。Code 与 Academic 共用 `TextModel`、`LineId`、UTF-16 offset、version 和 history；富文档把文字样式、原子对象、行语义、连续区域与对象关系附着到行上，不再为代码文件或论文制造 BlockTree。

| 场景 | 当前模型 | 明确边界 |
| --- | --- | --- |
| 独立代码文件 | 行、文档 metadata、selection、transaction、history、decoration | 不创建 source Group 或全文 code Block；语法颜色属于临时 decoration |
| 学术论文 | 同一行主轴上的 mark、atom、facet、region、relation | schema 命令当前仍通过兼容 `DocumentNode` transaction 输入，再原子生成 line snapshot |
| 论文代码区域 | 连续行 region，保存 `languageId` 等属性 | 不创建嵌套 `TextModel`，也不启动 Code pane |
| 图片、引用与 hard break | 文本中的 `U+FFFC` 与一个 atom 一一对应 | 光标只位于原子前后；block atom 必须独占逻辑行 |
| 表格 | schema-backed table/row/cell 结构投影到同一行主轴 | 行列命令、单元格导航和浏览器编辑共用同一 `TextModel`；不表示分页布局 |
| 标题、caption 与交叉关系 | line facet 与 stable-ID relation | 编号和显示文本由 renderer 派生，不写回正文 |

## 设计不变量

- `TextModel` 是文本、有序逻辑行、稳定 `LineId`、version、history 和当前 `LineDocumentSnapshot` 的唯一同步 owner。
- 逻辑行与视觉行严格分离。窗口换行只改变 projection，不创建模型行。
- 文本位置使用 `LinePoint { lineId, offset }`；offset 是 UTF-16、零基、尾端排除坐标。
- 持久字体与排版属性属于 mark；syntax token、diagnostic、搜索、diff 和主题颜色属于 decoration。
- inline object 与 block-display object 都是 atom。一个 atom 必须指向恰好一个 `U+FFFC`，每个 `U+FFFC` 也必须有一个 atom。
- `TextModel` 的一次提交只产生一个 version 与一个 undo entry。同步 mutation 不等待 Worker、Rust、App Server、文件系统或语言服务。
- Code 与 Academic 可以使用不同 widget、输入 profile 和 codec，但不能创建不同的内容 authority。

## Line-first snapshot

`TextModel.lineDocument` 返回一个不可变单版本快照：

```ts
interface LineDocumentSnapshot {
	readonly lines: LineSequence;
	readonly marks: RangeStore;
	readonly atoms: PointStore;
	readonly facets: LineFacetStore;
	readonly regions: RegionStore;
	readonly relations: RelationStore;
	readonly metadata: LineSemanticAttributes;
}
```

内容拓扑只有一个方向：

```text
TextModel
  └─ LineSequence
       ├─ ModelLine { id, text }
       ├─ RangeStore<PersistentMark>
       ├─ PointStore<InlineAtom>
       ├─ LineFacetStore
       ├─ RegionStore
       └─ RelationStore
```

`TextBuffer` 保存字符和 LF 分行，`LineSequence` 保存与当前行一一对应的稳定 identity。PieceTree 只是 `TextBuffer` 的私有实现，不属于公开模型拓扑。

### 行 identity 与文本编辑

普通文本 edit 保留 edit 起始行的 identity，删除被 join 的后续行 identity，并为 split 产生的新行分配 identity。Undo/redo history 同时保存 inverse text edit 与目标 `LineId` 序列，因此撤销 split、重做 split 和再次 join 不会制造不同的行 identity。

纯文本 codec 可以不持久化 `LineId`，打开文件时由模型分配本次生命周期 identity；富文档 codec 必须恢复持久 identity。`TextModelOptions.lineIds` 只用于受限文本 profile，schema-backed 文档的 identity 来自文档 codec/projection。

## 五类正交语义

### Range mark

`PersistentMark` 保存一个有序、非空 `LinePoint` range。多个 mark 可以重叠组合；同一文字可以同时拥有字体、字号、粗体、斜体、链接、上下标和行内代码样式。Mark 不得覆盖 atom 占位符。

### Point atom

`InlineAtom` 保存稳定 id、kind、point、inline/block display 与 JSON-safe attrs。引用保存 reference identity，公式保存源码，图片保存 asset identity，cross-reference 保存 stable target；格式化后的引用编号、公式字形与交叉引用文字由 renderer 生成。

Block atom 所在逻辑行只能包含该 atom。视觉高度、公式编号、图片尺寸与 bibliography 展开行数属于 layout/projection，不改变模型行数量。

### Line facet

`LineFacet` 把标题层级、列表、对齐、quote、caption 候选或 profile 自定义语义附着到一行。当前 schema compatibility projection 会把 group/block/line ancestor 变成同一行上的可组合 facet；heading 的 `level` 等 attrs 保持在 facet 上。

### Contiguous region

`LineRegion` 使用 start/end `LineId` 表达连续区域。当前 code block 投影为 `kind: 'code'` 的 region，并在 attrs 中保存 `languageId`。Region 交叉无效；嵌套必须显式声明 `parentRegionId`，不能从区间偶然重叠推断层级。

### Stable relation

`LineRelation` 连接 line、atom、region 或 external target。Caption 使用 caption line → image atom；缺失 target 必须显式标为 `unresolved`，否则 snapshot validation 拒绝提交。

## Transaction、mapping 与 history

`TextModel.applyEdits()` 处理受限文本 profile，并在同一 mutation boundary 更新 TextBuffer、LineId、tracked ranges、history、version 和事件。`TextModel.dispatch()` 当前处理 schema-backed Academic transaction，在提交前完成 schema、selection、plugin 与 projection validation，再一次性替换 document compatibility value 与 line snapshot。

当前 `DocumentTransaction` 是 Academic browser commands、clipboard、collaboration 和 serialization 的兼容输入，不是第二个 browser model。`projectDocumentToLines()` 在每次成功 transaction 中把 schema value 转成单版本 line snapshot；如果 atom、mark、region 或 relation 违反 line-first 约束，commit 在发布 version 前失败。

Schema transaction compatibility 尚未迁移成直接的 `LineDocumentTransaction` step vocabulary。完成迁移前，新增富语义必须同时提供 schema 表达与 line projection，不能只写入松散 sidecar。

## Browser projection 与输入 profile

`CodeEditorWidget` 投影普通代码文件的逻辑行、visual wrapping、selection、caret、token 和 decoration。`RichTextEditorWidget` 当前投影 schema compatibility value，并通过同一个 `TextModel` 提交 Academic commands；它不得拥有第二套文本、版本或 history。 `DocumentEditorPane` 获取并持有工作副本，负责保存、另存为、回退和释放模型；控件通过 `setModel` 接收模型，使用模型自身的 schema，并仅释放自己的监听和视图。

输入语义由 profile/widget 决定：

| 输入 | Code | Academic prose | Academic code region |
| --- | --- | --- | --- |
| Enter | split source line | 创建下一段 | split source line |
| Shift+Enter | profile command | 插入 hard-break atom | profile command |
| Tab | indentation/completion | profile navigation/formatting | code indentation |
| Backspace/Delete | text command | atom 边界整对象删除 | text command |

当前 Academic widget 的 `DocumentPoint` selection 仍属于 compatibility path。目标 `LinePoint` selection 和 atom-aware command mapping 是 Proposed，迁移时必须保持 clipboard、IME、stored marks 与 collaboration history 行为。

## Code region

Academic `codeBlock` 当前投影为父 `TextModel` 中的连续 code region。所有 source line、language attrs、version 和 undo history 都属于父模型。

- 不创建第二个 `TextModel` 或 embedded-editor factory；
- 输入转换成 owning TextModel 的 transaction；
- Academic code-region rendering 不 import `CodeEditorPane`、`CodeEditorWidget` 或 `workbench/contrib/codeEditor`；
- 高亮、gutter 与 line layout 如果复用 Code 实现，只能作为父模型 region projection。

## Profile、codec 与持久化

Workbench `EditorProfile` 组合 resource matcher、schema/semantic vocabulary、empty document factory、node/atom views、toolbar actions、plugins 与 collaboration schema identity。Profile 在 pane 生命周期内固定。

协作边界与 VS Code 的 Editor/Workbench 分层一致：Editor 定义文档事务、快照、远端选区和同步连接契约；Workbench 定义房间输入、邀请、成员角色与凭证管理。DocumentEditorPane 创建房间工具栏并选择连接方式，将已打开的连接交给 Widget；切换文档时取消房间请求并释放连接。

Code codec 只读写 LF/CRLF 文本，并把 `languageId` 等信息放在文档 metadata 或宿主资源状态中。Academic codec 必须保存 lines、marks、atoms、facets、regions、relations、assets、references 与 document metadata；当前 production codec 仍使用 versioned schema serialization envelope，迁移到直接 line serialization 时必须提供兼容 migration。

`DocumentEditorTextModelService` 解析 resource 为 caller-owned `TextModelWorkingCopyReference`。`DocumentWorkingCopy` 适配 dirty/revert/conflict、expected-revision save 和 untitled Save As；Workbench transport 不拥有 model mutation。

## Collaboration

Collaboration 使用 server-ordered transaction stream，不让 `TextModel` 自己选择分布式顺序。当前 wire contract 传输 schema transaction compatibility envelope；client rebase 后仍通过同一个 `TextModel.dispatchRemote()` 产生一个 version 与 line snapshot。

- Synchronizer 分开保存 canonical、exact in-flight 与 later optimistic buffer；
- 无法安全 rebase 的 history branch 明确 drop，不覆盖 remote content；
- Snapshot resync 会丢弃 local intent 时报告 `resyncRequired`；
- Presence 和 remote selection 是带 lease 的 ephemeral stream，不进入 durable history；
- Transport、credential、room authorization 和 retry policy 留在 Workbench adapter。

## Validation 与失败语义

`createLineDocumentSnapshot()` 在状态可见前验证：

- line id、semantic id、kind 与 JSON-safe attrs；
- line text 不包含模型换行符；
- mark point 存在、range 有序非空且不覆盖 atom；
- atom 与 `U+FFFC` 双向一一对应；
- block atom 独占逻辑行；
- facet line、region boundary、parent region 与 relation endpoint 存在；
- region 不交叉，嵌套显式声明 parent；
- unresolved relation target 显式标记。

Invalid schema、selection、step、plugin state 或 line snapshot 在 commit 前失败。Model reference、widget、pane、working copy 和 collaboration connection 分别释放自己创建的资源，不跨 owner dispose。

## 当前状态与限制

| Area | Status | Boundary |
| --- | --- | --- |
| 有序逻辑行、稳定 LineId、UTF-16 LinePoint | ✅ Current | 普通 TextModel edit、split/join、undo/redo 已接入 |
| Range/Point/Facet/Region/Relation store 与 validation | ✅ Current | immutable `LineDocumentSnapshot` |
| 普通代码受限 profile，无 source Group/全文 Block | ✅ Current | mark/atom/facet/region/relation 为空 |
| Schema document → line semantics projection | ✅ Current | mark、inline/block atom、ancestor facet、code region、caption relation |
| Table schema、行列命令、单元格导航与 browser editing | ✅ Current | 嵌套 table/row/cell 仍投影为同一 `TextModel` 的逻辑行 |
| Citation 与 bibliography UI | ✅ Current | citation/reference schema、reference-index plugin、toolbar action 和 node view 已接入 Academic profile |
| Academic browser 直接使用 LinePoint command | Proposed | 当前仍使用 DocumentPoint compatibility commands |
| 直接 `LineDocumentTransaction` 与 line-first rich codec | Proposed | 当前 schema transaction/serialization 是兼容输入 |
| Math 与 cross-reference UI | Extension point | store contract 已能表达；profile command/view 尚未提供 |
| Footnote、pagination、floating object | Potential | 专门结构或页面布局问题，不改变行主轴 |

## 关键实现入口

| Symbol/file | Responsibility | 修改时同步检查 |
| --- | --- | --- |
| `common/model/lineDocument.ts` | LineId、五类 store、snapshot freeze 与 validation | codec、projection、atom/region/relation tests |
| `common/model/lineDocumentProjection.ts` | schema compatibility value → line semantics | schema、serialization、Academic model tests |
| `common/model/textModel.ts` | TextBuffer、LineId mapping、version、history 与唯一 mutation boundary | cursor、worker mirror、language version gate、model tests |
| `common/model/textModelBlockState.ts` | schema transaction compatibility、selection、plugin 与 document history | transaction、collaboration、atomic commit tests |
| `common/model/documentTransaction.ts` | compatibility steps、mapping 与 metadata | selection、decoration、rebase、serialization |
| `browser/widget/richTextEditor/richTextEditorWidget.ts` | Academic compatibility projection 与 input | DOM selection、IME、clipboard、node views |
| `browser/widget/codeEditor/codeEditorWidget.ts` | Code profile browser surface | input、viewport、accessibility、contributions |

## 验证与修改影响

- 修改 line identity、store validation、transaction、selection、history、plugin 或 serialization：运行 `pnpm --dir ash-ts run test:editor:unit`。
- 修改 `RichTextEditorWidget`、clipboard、IME、atom view 或 pane integration：运行 unit suite 和 `pnpm --dir ash-ts run test:editor:browser`。
- 修改 dependency direction、profile composition 或 codec boundary：运行 editor architecture tests、Renderer typecheck 和 stale-reference scan。
- 所有改动运行 `git diff --check`。
