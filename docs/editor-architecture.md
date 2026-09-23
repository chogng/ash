# Stanza：单一文本内核、可装配能力与产品边界

> 本文是跨 editor、document、language、browser view、Workbench 和过渡 adapter 的 canonical 架构文档。扁平模块的实现和修改契约见 [`ash-ts/src/ash/editor/README.md`](../ash-ts/src/ash/editor/README.md)；行式文本与结构化文档 engine 的详细契约分别见 [`text-engine.md`](../ash-ts/src/ash/editor/text-engine.md) 和 [`document-engine.md`](../ash-ts/src/ash/editor/document-engine.md)。

## 快速理解

Stanza 是 Ash 唯一的可组装编辑器内核。所有文档都由 `TextModel` 作为唯一同步权威，并原生遵循 `TextModel → LineSequence → ModelLine`；Code 使用只有行与 metadata 的受限 profile，Academic 通过 mark、atom、facet、region 与 relation 附着富语义。字符和逻辑行由 TextModel-owned `TextBuffer` 唯一保存，PieceTree 只是当前私有实现。

| 使用场景 | 模式加载入口 | 编辑能力 |
| --- | --- | --- |
| Code | `editor.code.all.ts` + `workbench/contrib/codeEditor` | 独立的文件级行式功能实现 + code/diff pane/input 与文件服务接线；共享 Workbench 另行加载 multi-diff |
| Academic | `editor.academic.all.ts` + `workbench/contrib/academic` | 独立的富文档功能实现；在同一 TextModel 上使用 line-first 语义与 Academic projection |
| Code 行式能力全集 | `editor.all.ts` | Code 使用的完整行式 contribution 集合；Academic 不加载它 |
| DOM-free 调用 | `editor.api.ts` | `editor`、`languages`、TextModel、LineDocumentSnapshot、五类语义 store、schema、transaction、serialization 和坐标 API；不注册 pane |

Stanza 是整个内核的品牌，不是某一个 mode 的别名。Code 与 Academic 拥有不同的 feature implementation、projection 和 bundle，但共享唯一 `TextModel`。结构化能力是 TextModel 的显式可选状态，不是第二个万能接口或平行模型；复用底层文本能力不代表复用 Code pane 或 Code contribution 集合。

Stanza 是当前唯一的 Ash editor runtime。不保留旧 editor ID、DOM class、目录或兼容 pane；架构与测试不得再以兼容为理由重新引入第二套编辑状态。

## 所有权

| 层 | 当前状态 | 责任 |
| --- | --- | --- |
| `editor/common` | 单一同步内核与纯投影状态已具备 | `TextModel`、`TextBuffer`、LineId、mark/atom/facet/region/relation、坐标、selection、transaction、history、schema、serialization、cursor、纯 viewport，以及相互独立的语言身份、语言配置和 provider registry；不得引用 Workbench、Electron 或 generated DTO |
| `editor/browser` | Code 与 Academic 的 widget 和 DOM projection 已具备 | code/document/diff/multi-diff widget、DOM input、viewport、editor contribution registry 与 frontend-contract adapter；不得引用 Workbench 或选择 Workbench 模式 |
| `editor/contrib` | 行式与结构化 feature 已按能力组织 | 命令、controller、可移除投影、schema、citation 和 collaboration；不得注册 pane、拥有第二套 model 或读取产品 ID |
| `editor.*.all.ts` | editor 能力按模式装配已具备 | Code、Academic 与完整 editor contribution 清单；不得注册 Workbench pane/input |
| `workbench/contrib/{codeEditor,multiDiffEditor,documentEditor,academic}` | 模式宿主适配已具备 | pane/input、文件与 working-copy 接线、Academic profile 和模式注册；不得实现编辑事务或视图内部行为 |
| `workbench/services/textMate` | 已具备 | grammar revision registry、真实 TextMate/Oniguruma runtime、增量行状态缓存、Stanza provider/module adapter、版本化 catalog/theme wire、独立 browser Worker、声明式扩展资源、活动主题 token color、embedded language 与 bracket metadata 均已接通 |
| Document service | 已具备 | `IFileService` 将 App Server `fs/changed` 映射为工作区失效事件，`ITextFileService` 转发；Stanza 模型服务提供 dirty、快照保存、显式 revert、CRLF/LF 保留、干净模型重载、脏模型外改状态与 expected-revision/CAS；Workbench 提供 workspace-scoped IndexedDB working-copy 恢复 |
| Selection/decorations | 基础具备 | selection、实例控制器、tracked range、decoration collection |
| Language model | 已具备 Code 主路径 | 基础 token 与预览着色由前端 TextMate Worker 计算；诊断、符号、折叠与结构选择通过异步 parser provider 获取，语义 token、补全、跨文件查询和重构由 LSP provider 接入；结果均检查模型版本 |
| Browser view | 部分具备 | common viewport、虚拟行 DOM、字体行宽、gutter、selection/caret、基础 decoration、hit-test、active-position reveal、字符/块 canvas minimap（公共布局、semantic-token 颜色、click/drag scroll）、diagnostic severity marker、可见行缩进参考线已完成；富交互与主题细化尚未完成 |
| EditorView / ViewController | 部分具备 | `EditorView` 选择并拥有 EditContext 生命周期，`ViewController` 将 beforeinput/textupdate/keydown 路由到 common command，覆盖 IME 协作、pointer selection、Alt+Shift 列选择、键盘导航、textarea 编辑、plain/syntax-marked safe HTML 选区与空选区整行 copy/cut/paste、单个显式文本文件 clipboard paste/drop 与 `text/uri-list`；Android/macOS 特化仍未完成 |
| SuggestController | 部分具备 | 独立 contribution 拥有 completion service/session 的 browser 接线、键盘/鼠标接受、Ctrl+Space invoke、trigger character 与 incomplete refresh、completion/listbox ARIA；完整 screen-reader navigation 与平台辅助输入仍待真实平台验证 |
| Accessibility | 部分具备 | editor label、聚焦 textarea 的文本/主选区镜像、multi-selection `aria-description`、completion/listbox ARIA、dialog state 与 cursor/selection/save live-region announcements、forced-colors focus/selection/caret/diagnostic 语义已具备；完整 screen-reader navigation 与平台辅助输入仍待真实平台验证 |
| Large-file policy | 已具备 | 模型创建时固定判断 20 MiB/30 万行 tokenization、50 MiB synchronization、256M text-unit heap 阈值；保留编辑/滚动/查找/保存，关闭或限制全量后台 token、diagnostic、folding、CodeLens、Inlay Hint、symbol、occurrence 与 bracket colorization |
| Workbench Editor Part | 已有独立实现 | tabs、pane 生命周期、可见性和模式 contribution |

`src/ash/base` 继续保持领域无关。编辑器位置、文档版本、selection 和
decoration 等身份只能由 `editor` 领域定义，不得为了复用而下沉到
`base`。

基础语法高亮不注册 App Server token provider。内置 JavaScript/JSX、TypeScript/TSX、JSON/JSONC、Rust 与 Shell grammar 由扩展资源服务装载，前端 TextMate Worker 持有行状态栈并计算 token。后台分析延迟不阻塞输入、撤销或词法着色；Semantic Tokens 在独立通道异步合成。Shell 在前端统一使用 `shellscript`，后台 `shell` 标识仅在 Workbench 领域适配处转换。

语言关联、注释、括号和缩进规则与 grammar 一样来自扩展贡献，随扩展装载和撤销。核心只注册纯文本；standalone 宿主显式注册其他语言能力。资源识别查询同一个 LanguageService，产品不维护第二份 MIME 或后缀表。

## 环境分层与 base 联动

依赖方向是 `contrib/browser → browser/common → common → base/common`，同时
`browser → base/browser`。`base` 反向引用 editor 严格禁止；
这不表示 editor 要回避 base，恰恰相反，通用机制必须优先复用 base。

| Editor 层 | 应复用的 base 能力 | 仍由 editor 定义 |
| --- | --- | --- |
| `common` | event、lifecycle、IME realm coordination、cancellation、通用 geometry | TextModel position/range、LineId、五类持久语义 store、model version、history、schema-backed selection/transaction、language request/lane/result identity、snapshot version gate 和纯 view-model 语义 |
| `browser` | DOM lifecycle、通用控件基础、platform/keybinding 状态、通用 layout primitive | code/document viewport、行与节点投影、textarea/input adapter、字体测量、editor ARIA |
| Workbench host | platform service、context key、commands、configuration、theme | editor pane 接线、document/workspace 绑定和外部区域布局 |
| Transition adapter | 对应第三方 renderer API | 仅适配，不得反向定义 Ash common/browser contract |

目录结构遵循运行环境，而不是功能名称倒置嵌套：

```text
editor/
  common/{core,model,commands,services,...}
  browser/{view,widget,services,...}
  contrib/<feature>/{common,browser}
  test/{common,browser}
  editor.code.all.ts
  editor.academic.all.ts
  editor.all.ts
  editor.api.ts
  editor.main.ts
```

当前 `editor/common` 已直接复用 `base/common/event`、
`base/common/lifecycle`、`base/common/ime` 和 `base/common/layout.ISize`。
其中 composition 开始必须
遵守共享 `IME.enabled` 状态，避免编辑器与 keybinding/inputbox 各自维护
互相冲突的输入法开关。`ISize` 只表达通用几何；scroll clamp、visible line
和 overscan 仍由 Stanza 定义，未反向污染 base。

## 当前数据流

当前产品普通文本走以下路径：

```text
EditorInput → ITextFileService.resolve
        ↓
Workbench BrowserTextResourceStore → Workbench BrowserTextModelService → Stanza TextModel
        ↓
Stanza language session → Analysis/completion workers
        ↓
Stanza viewport / input
        ↓ Ctrl/Cmd+S
ITextFileService.save → IFileService.writeFile → App Server
```

`preferredEditorId` 只是 Workbench 在 code、document、diff、PDF 等现有 pane 间做显式选择的通用机制，不再承载旧 editor 兼容入口。

语言能力采用与 VS Code 相同的两条入口、一个内部注册表：`editor.api.ts` 的 `languages` 对象供 standalone 调用者注册语言、编辑规则和 provider；Workbench 不经过公开对象转发，而是直接把 App Server、TextMate 和扩展贡献注册到同一组 Editor service contract。语言身份由 `LanguageService` 管理，编辑规则由 `LanguageConfigurationService` 管理，provider 由 `LanguageFeaturesService` 管理；Hover、补全、折叠等 contribution 自己构造面向当前 `TextModel` 的执行服务。

## 目标数据流

```text
Document service
        ↓ load/save/conflict
Stanza TextModel
        ↓ transaction snapshots
Selection + Decoration model
        ↓
Language snapshots ─────→ Language workers
        ↓
Viewport + Layout model
        ↓
EditorView ←────────────→ Native DOM renderer
```

## 长期不变量

- 一个文档在一个 renderer realm 中只有一个权威 `TextModel`。
- 所有文本变化都经过原子 transaction，版本、事件和 history 同步提交。
- 文件保存、外部变更与冲突由 Document service 决定，不能由 view 决定。
- worker 只消费带版本的不可变 snapshot；过期结果不能重新写入新版本。
- view 可以丢弃并重建，不能因此丢失文本、selection 或 undo history。
- IME composition 在提交前不是普通编辑事务，取消 composition 不得污染
  history。
- accessibility 是 view/input contract 的组成部分，不是渲染完成后的补丁。
- 旧 editor identity、DOM vocabulary 和 runtime 类型不得重新进入 editor、document 或 Workbench 公共接口。

## 分阶段实施

### Current：文本事务、TextBuffer 与 Piece Tree 实现

已实现 LF 规范化、UTF-16 坐标、原子非重叠编辑、版本、同步事件和事务级
undo/redo。`TextModel` 只依赖 `TextBuffer` contract；当前 TypeScript `PieceTreeTextBuffer` 由
`PieceTreeTextBufferBuilder` 构建，piece 引用不可变 original/add buffer，红黑树在子树维护字符数、换行数和 piece 数。随机
差分测试将 1,000 次 replace、range read、坐标和行内容与普通 string oracle
对比。

### Current 1：基础存储硬化

相邻且引用同一段连续 source 的 piece 现在会在编辑边界合并。版本化
snapshot 捕获不可变 source segment，不需要在创建时拼接全文，并且在后续
编辑或模型销毁后仍可读取。undo/redo 同时受事务数量和保存文本单元预算
约束，超限时从最旧的连续可达历史开始裁剪。

事务提交后会按 retained/live 比例、绝对可回收文本量或 piece 数触发同步
compaction。当前文本被重建为新的 immutable original buffer，add buffer
清空；版本、事件和 history 均不变化。旧 snapshot 继续引用捕获时的 source，
因此 compaction 不会破坏 worker 读取的一致性。

仓库提供非 gating 的 2 MiB benchmark runner，覆盖构建、分散编辑、坐标
往返、snapshot range read 和 churn compaction。下一步仍需建立跨平台性能
预算，并评估超大文档是否需要增量或空闲调度压实。只要 snapshot 仍被外部
持有，它捕获的旧 source 就按契约继续占用内存，不能把当前 buffer 的统计值
误认为进程总内存。

### Current 2：Selection 值与模型锚点（部分完成）

`TextSelection` 保存 anchor/active 方向，`TextSelectionSet` 保存稳定的多光标
顺序和 primary selection。它们是不可变值，不是 `TextModel` 上的全局“当前
光标”：同一文档可以同时被多个 editor instance 展示，每个实例必须拥有自己
的 selection state。

`TextModel.trackRange` 提供文档级通用锚点，并要求调用者显式选择四种边界
stickiness 之一。每次事务完成文本变更后、发送 change event 前，所有锚点会
按完整事务统一映射；undo/redo 走同一路径。

每个 undo step 会分配稳定的 `transactionId`，同组提交、撤销与重做沿用该
身份，而每次提交仍产生新 version。`EditorSelectionController` 以此保存一个
editor instance 的命令前后选区；另一个实例共享同一 `TextModel` 时仍拥有
独立 selection。命令执行期间若同步 listener 再次修改模型，控制器不会把
已经过期的 post-selection 写进新版本，而是保留 tracked mapping 的安全结果。

键盘导航已按 Current 15 直接生成 `TextSelectionSet`；文本输入与删除已按
Current 16、clipboard 已按 Current 17 生成统一的 selection-after contract。
IME composition 的单 selection 内核路径见 Current 5，browser 映射见
Current 18。

### Current 3：Decoration collection

`TextDecorationCollection<TMetadata>` 让 diagnostics、search、diff 等 owner
在同一个 `TextModel` 上维护彼此独立的装饰集合。集合提供 realm 内唯一且
稳定的 ID、原子 `replaceAll`、增量 add/update/delete，以及区分集合内容变化
和锚点范围变化的事件。范围移动继续由 `TrackedRangeStickiness` 决定。

common 不解释泛型 metadata，也不定义 CSS class、颜色、z-index 或 DOM 结构。
这些视觉规则必须由对应 renderer component 或语义 token owner 按
`docs/ui-styling-ownership.md` 投影。browser renderer 已按 Current 10 消费
collection；token/diagnostic 的 snapshot version 存储见 Current 22，向
decoration 与文本行的 projection 仍未完成。

### Current 4：结构安全的输入 Undo 合并

命令可显式选择 `CoalesceTyping`、`CoalesceBackspace` 或 `CoalesceDelete`。
控制器为同模式的连续命令复用 nominal `TextEditHistoryGroup`；只有每个光标
都继续执行同方向、相邻且非空的操作时，`TextModel` 才复用同一
`transactionId` 并合并 inverse edits。多光标前序编辑导致的后续 offset
shift 会在合并时累计修正。

Typing group 可以从替换单个或多个 selection 开始，随后继续普通插入或
向前覆盖替换；合并后的 inverse edits 同时删除整段新输入并恢复最初被替换
的文本。每次合并都会重新计算 history text-unit 占用，不能绕过内存预算。

同一事务删除相邻区间时，模型会先合并汇聚到同一 offset 的 inverse
insertions，保证 undo script 没有共享起点歧义。若跨事务多光标删除会使
不同光标的 inverse insertions 汇聚，模型拒绝合并并保留新的 undo step。

实现不会保存全文 snapshot，也不会把无法证明等价的 edit script 强行折叠。
显式 selection 变化、undo/redo、外部编辑、非相邻操作和模式变化都会形成
新的 undo step。输入层也可调用 `pushUndoStop()` 切断当前组；该操作本身
不会产生空历史项。

### Current 5：IME composition 内核事务

`EditorSelectionController.beginComposition()` 为当前单 selection 建立受保护的
history revision。每次 `update` 都完整替换上一版 provisional text，产生可观察
的 model version，但沿用同一 `transactionId` 和最初的 inverse edit。
`commit` 最终只保留一个 selection-aware undo step；`cancel` 恢复原文本和
原 selection，并消费该历史项，不生成 redo。

受保护 revision 在关闭前不会被 history budget 驱逐，因此即使预算为零也能
无损取消；commit 后立即重新执行预算裁剪。最终 composition text 与原文本
相同时不会保留空 undo step。普通 command、selection 变化、undo/redo 在
composition 活跃期间被拒绝，直接发生的外部 model edit 会使 session 失效。

DOM 无关的内核生命周期只支持单 selection。browser 已按 Current 18 接入
基础 `compositionstart`、`compositionupdate`、`compositionend` 和候选窗
anchor；Android diff、macOS 长按及其他平台差异仍未完成。

### Current 6：固定基线行高与 View Zone 布局内核

`ViewLayout`、`LinesLayout` 与 `LineHeightsManager` 已在 `editor/common/viewLayout` 中建立 DOM 无关的 view-model 边界。browser 层负责测量并输入 viewport size、content width 和 line height；common 层负责内容尺寸、横纵滚动约束、可见行范围、overscan render range，以及 visual line 之间由 feature 声明的 View Zone 空间。输出 layout 是不可变快照并携带 `TextModel.version`，因此即使一次编辑没有改变行数，renderer 仍能按版本丢弃旧投影。resize 与 line-height 更新尽量保持原 fractional top-line anchor，模型收缩则把 scroll position 约束回新的内容边界。

common 契约使用固定文本行高，但允许 View Zone 在行间增加独立高度；它只保存锚点和几何，不持有 feature DOM。软换行、折叠、字体测量和 DOM 仍由既有 owner 负责。`editor/browser` 消费这个 contract，挂载调用方拥有的 zone root，并让文本行、overlay、命中测试和滚动共享同一组纵向坐标。

### Current 7：只读虚拟行 browser projection

`EditorViewport` 已把 common viewport 接到原生 DOM。它创建并拥有
`.stanza-editor` scroll host、content extent 和 overscanned line layer；
滚动窗口重叠的行按 line index 复用 DOM identity，模型版本变化同步更新当前
render range，文档收缩则把 common 与 DOM 的滚动坐标一并约束回有效范围。
模型文本通过 `textContent` 投影，不作为 HTML 解析。

该组件复用 `base/browser/dom`、`base/browser/geometry` 和
`base/common/lifecycle`，内部 DOM 与 focus 样式由组件自己的 CSS 拥有。
Workbench host 只能负责根节点外部尺寸，不能穿透覆盖行节点。当时它只是固定
行高只读 renderer；后续 Current 18、20、26 与 33 已分别补齐输入、clipboard、
soft wrap 与基础 accessibility projection。

### Current 8：字体度量与增量横向宽度

`StanzaDomTextMeasurer` 从 line layer computed style 解析 font、letter spacing、
tab size 和左右 padding。普通文本段由 Canvas 按当前字体 shaping 和 fallback
测量，tab 按实测 space glyph 推进到下一个 stop。Canvas 不可用时使用
font-size 派生的 fallback advance；测试和未来专用字体引擎通过小型
`TextMeasurer` contract 注入。

`StanzaLineWidthIndex` 首先同步测量一个有界行片段，之后通过可取消的 idle
切片完成其余非换行行；未测量期间最大值只作为下界，完成后恢复精确值。稳定
后它按 `TextModelChange` 的旧行范围合并同一行多处编辑，只重测事务影响的新
行组。宽度计数集合维护当前最大值，最长行缩短时无需全文重测即可收缩 content
width 并夹紧横向滚动。字体加载完成或显式 `refreshFontMetrics()` 会以同一策略
重建，因为此时每个缓存值都可能失效。随机差分测试覆盖 400 次多区间事务、
换行变化和 undo/redo，并与逐次全文扫描结果比较。

### Current 9：Gutter 与 selection/caret projection

`ViewLine` 只拥有单行文字、字符映射和文字几何。`LineNumbersPart`、
`MarginDecorationsPart`、`IndentGuidesPart`、`DecorationsPart`、
`SelectionsPart`、`ViewCursorsPart` 与 `CompositionPart` 分别拥有自己的可见行 DOM，
共同复用 `ViewPartRows` 的窗口协调，不再把节点塞进文字行。gutter 宽度按当前总行数的
数字位数测量，并计入横向 content width；各层滚动时按同一个 visual line index 更新。
组件通过稳定的 `.active`
类投影 primary selection 的活动行，状态样式由 Stanza 自己的 CSS 拥有，
Workbench 不通过深层 selector 覆盖。

`EditorViewport` 可观察一个调用方持有的
`EditorSelectionController`。`createStanzaSelectionGeometry` 保留
anchor/active 方向、多 selection 顺序和 primary 身份，只为当前 overscan
范围生成矩形。水平坐标复用当前 `TextMeasurer` 测量行前缀；被选中的
换行符占一个实测 space cell，因此终点位于下一行 column 0 时仍有明确视觉
范围。overlay 在主 caret 上投影 `.primary` 身份，为后续 presentation 保留
稳定状态；CSS 不使用 ARIA attribute 作为视觉 selector。

这一步本身只消费已有 selection 状态，不产生输入；pointer policy 见
Current 12–15，普通文本输入见 Current 16，clipboard 见 Current 17，
composition 见 Current 18。caret blink 与完整 screen-reader contract 仍未
实现；销毁 view 只释放自己的 controller listener，不销毁共享 controller
或 `TextModel`。

### Current 10：Decoration presentation

`createStanzaDecorationSource<TMetadata>` 把一个调用方持有的
`TextDecorationCollection` 适配为 browser presentation。resolver 显式选择
`SearchMatch`、四种 diagnostic underline 或不投影；因此 common
metadata 继续 opaque，browser 也不接受任意 caller CSS class。对应 CSS 由
Stanza component 自己拥有，并消费已有 search、error、warning 语义 token。

Viewport 可同时观察多个 source，只为当前 overscan 范围创建 decoration
rectangle。selection 与 decoration 共用 `createStanzaRangeRectangles`，统一
end-exclusive 多行范围、换行符可见宽度、字体前缀测量和 clipping 规则。
collection 的 content/range event 会同步重建可见 decoration；文本事务移动
tracked range 后，DOM 继续使用同一 decoration ID。

每个 source 的 resolved snapshot 会缓存到下一次 collection event，因此滚动
不会重复调用 caller metadata resolver。`StanzaDecorationLineIndex` 将这些 snapshot
建为按 logical-line interval 查询的不可变树；layout 仅取与当前 rendered logical
span 相交的 decoration 后再做 visual clipping。索引不拥有 collection、metadata
resolver 或 geometry，仅消除滚动期间对完整诊断/search 集合的重复扫描。

Viewport 只拥有 source event registration，销毁时不销毁 source、collection
或共享 `TextModel`。`StanzaDiagnosticHoverController` 只消费 marker 当前的
诊断文本并在 scroll 时关闭；`EditorViewport` 的 overview ruler 与 document
minimap 都聚合每行最高 severity，且不在滚动时重扫 diagnostics。当前 presentation 还不包含
诊断版本拒绝；这些不能从已有矩形投影推断为完成。

### Current 11：Pointer hit testing

`EditorViewport.getTargetAtClientPoint` 接受与 PointerEvent 结构兼容的
`clientX/clientY`，结合 root bounds、固定行高、sticky gutter 和当前横纵
scroll，返回 `Gutter`、`Text`、`EmptyContent` 或 `AfterLines`。每个结果都
携带合法 `TextPosition`，但查询本身不 focus、不 capture pointer，也不修改
`EditorSelectionController`；输入策略仍由后续 controller 拥有。

文本横向命中使用相邻 caret midpoint。前缀宽度复用 `TextMeasurer`，
因此 tab stop 与当前 selection/decoration/line-width 投影一致。
`Intl.Segmenter` 可用时只返回 grapheme boundary，不会把 emoji 或组合字符
命中到任意 UTF-16 内部；fallback 至少保持 Unicode code-point boundary。
空行、行前 padding、行尾外侧和最后一行下方拥有显式 target kind，不要求
调用方从 column 猜测语义。

固定行高、无 layout 的测试环境和普通 LTR 文本继续使用 `TextMeasurer`。
当 viewport 为 `auto`/`rtl` 且浏览器提供布局时，`ViewLine` 先通过 `CharacterMapping` 定位跨
semantic-token span 的 UTF-16 offset，再由 `RangeUtil` 和 `DomReadingContext` 读取 DOM `Range`：selection/caret、
decoration、composition anchor、pointer hit-test 与 wrapped vertical navigation
均改用浏览器视觉坐标。缺少 Range layout 时确定性回退到度量路径。inline advance
decoration 与原生 browser-driven wrapping 尚未完成；pointer selection policy 见
Current 12。

### Current 12：Pointer selection controller

`StanzaPointerSelectionController` 把 hit target 转成一个
`EditorSelectionController` 的显式 selection policy。主键点击放置单 caret，
Shift-click 保留原 primary anchor；字符拖动持续更新 active。gutter 点击和
拖动按整行选择，存在下一行时把 LF 包含在 end-exclusive range 中，向上拖动
保留 backward direction；gutter Shift-click 把原 anchor 扩展到目标行边界。

browser 提供的双击计数按 `common/getWordSelectionRange` 的完整 segment
选择；拖动继续按词扩展并保持正反方向。三击内容按整行选择并沿用 gutter 的
行拖动规则。Shift-double/triple click 保留原 primary anchor，再分别扩展到
目标词或目标行边界。默认词边界优先使用 `Intl.Segmenter`，word-like 文本、
连续空白与标点都形成可选择 segment；fallback 至少保持 Unicode code-point
边界，行尾命中选择前一个 segment，且所有范围保持单行、UTF-16 end-exclusive。

活动拖动拥有一个 collapsed position 或完整 word 的 `TrackedRange` anchor，
因此拖动期间发生同步模型事务时不会继续使用 stale `TextPosition`。adapter 同时拥有 window 级
pointermove/up/cancel/blur listener 和 native pointer capture；完成、cancel、
blur、dispose 或初始化失败都会释放这些临时资源。Viewport、pointer adapter
和 selection controller 会比较只读 `textModel` 身份，跨文档接线直接拒绝。

该 adapter 不拥有 Viewport、selection controller 或 `TextModel`，也不执行
文本事务。拖出 viewport 的滚动策略见 Current 13，多光标策略见 Current 14。
右键 context menu 发生在现有 selection 内时保留 selection，否则先将 primary
selection 折叠到命中位置再交给宿主菜单。touch 特化仍未实现，因此尚不是完整
pointer input stack。

### Current 13：Pointer drag autoscroll

`MouseHandler` 只在已经捕获的选择手势中识别越界坐标。上下越界先按当前
scrollTop 和距离解析目标视图行，左右越界按 content、minimap 与 scrollbar
边界解析目标列，然后统一生成 `IMouseTargetOutsideEditor`；普通查询与未开始的
手势不会启动滚动。

`TopBottomDragScrolling` 与 `LeftRightDragScrolling` 分别持有一个可替换的
`DragScrollingOperation`。operation 保存最新 target 和 mouse event，按越界
距离计算速度，把 frame duration 限制在 4–50ms，通过 `ViewLayout` 改动对应
滚动轴并同步 render。纵向滚动后使用 `MouseTargetFactory` 重新命中视口边缘，
横向滚动按 LTR/RTL 选择行首或行尾，再以 `NavigationCommandRevealType.None`
进入同一个 `ViewController.dispatchMouse` 选择策略，避免 reveal 反向抵消滚动。

pointer 返回编辑器、pointerup、cancel、blur、布局变化、新手势或 owner 释放
都会停止两个轴的 operation；可替换资源同时取消待执行动画帧。该策略不修改
文本模型，也不把 wheel、touch 惯性滚动或其他 reveal 策略算作已完成。

### Current 14：Pointer multi-cursor policy

`StanzaPointerSelectionControllerOptions.multiCursorModifier` 显式选择
`Alt`（默认）或 `ControlOrMeta`。只有配置的精确 chord 且未按 Shift 时才新增
selection；因此 Alt 模式不会吞掉 Ctrl/Meta，ControlOrMeta 模式也不会吞掉
Alt，带 Shift 的 chord 继续使用 Current 12 的普通扩选语义。

修饰键单击、双击、三击和拖动分别复用已有字符、词和整行 selection policy，
新 selection 追加为 primary。点击 gesture 起点处已有的 range 会切换移除，
但最后一个 selection 不会被删除；拖动离开该起点则用新 range 替换它。
命中另一个相同 range 时只切换 primary，新增 range 与旧 range 重叠时移除旧
range，避免后续文本命令生成重叠 edit。

活动 gesture 为原 selection 集合单独创建 temporary tracked ranges，而不是
保存裸值。因此同步模型事务、autoscroll 和重复 pointermove 后仍保持原顺序、
方向与 primary 身份。pointerup、cancel、blur、dispose 或新 gesture 会连同
active anchor 一起释放这些临时所有权。Alt+Shift primary drag 已生成 common
multi-selection 的列选择，不依赖浏览器 DOM selection；box selection 的虚拟空白与
touch 多点手势仍未实现。

### Current 15：Keyboard cursor navigation

`common/textSegmentation` 统一拥有 grapheme boundary；词移动与选择由标准
`WordCharacterClassifier` 和 `WordOperations` 持有。pointer hit-test 使用 grapheme，
double-click/drag word selection、键盘词移动、词段移动与按词删除共享 classifier；
配置的 `wordSeparators` 与 `wordSegmenterLocales` 在 common 层只解析一次，不在
browser 侧维护第二套 word range。

`MoveOperations` 公开标准的水平、垂直、空行、行边界和文档边界状态 API，
输入统一使用 `CursorConfiguration`、`ICursorSimpleModel` 与 `SingleCursorState`。
垂直移动通过 `leftoverVisibleColumns` 保留可视列，在短行后可以恢复；原子缩进、
选区折叠与扩展也由同一状态转换处理。词移动由 `WordOperations` 的词段能力决定，
不再通过 `MoveOperations.navigate` 混入一个额外总入口。

`KeyboardNavigationController` 只负责浏览器按键路由，并把字符、行、页、行边界和文档边界命令通过 `CursorMoveCommands` 分派到模型或折行视图状态；词跳转继续使用 `WordOperations`。Windows/Linux 使用 Ctrl+Arrow 词跳转和 Ctrl+Home/End 文档跳转；macOS 使用 Option+Arrow 词跳转、Command+Left/Right 行边界和 Command+Up/Down 文档边界。Shift 统一选择 `Extend`。未知按键组合、AltGraph、组合输入按键和已被上层处理的事件不会被消费。

Page 命令的行数来自当前固定行高 viewport。成功导航后
`EditorViewport.revealPosition` 同步调整横纵 scroll，使 primary active
position 可见；垂直 reveal 使用完整行，水平 reveal 使用同一
`TextMeasurer` 的前缀与 space-cell 宽度。外部 selection 变化会清除
preferred columns。该 controller 不处理字符输入、Backspace/Delete、Enter、
Tab、clipboard、composition DOM event 或平台辅助功能命令。

### Current 16：Textarea editing surface

`common/editCommands` 从调用方的当前 `TextSelectionSet` 构造统一的
`EditorEditCommand`。普通输入替换每个 selection；Backspace/Delete 优先删除
已有范围，否则分别删除前一个或后一个 grapheme，行边界则删除 LF 并合并
两行。输入先规范化为 LF，再计算 transaction 后的 UTF-16 caret offset。
多 selection 的所有 range 都基于事务前文档，重叠或共享插入起点会在修改
前拒绝；相邻删除使 caret 汇聚时，完全相同的结果会合并并重映射 primary。
undo 仍恢复命令前的原多 selection，redo 恢复合并后的结果。

`EditorView` 选择并拥有一个 `EditContext` 实现；Viewport root 获得焦点时转移到该输入表面，focus 状态通过稳定的 `.input-focused` 类投影，视觉规则由 Stanza component CSS 持有。`ViewController` 将非 composition `beforeinput` 的 `insertText`、replacement text、Enter、Backspace、Delete 以及普通 Tab keydown 映射到 common 命令；history undo/redo 直接进入同一个 `TextModel`，不经过 selection controller 的并行入口。成功编辑后清空输入表面并 reveal primary active position；它与 viewport、selection controller 必须引用同一个 `TextModel`，销毁 view 只移除自己的 DOM 和 listener。

普通 `beforeinput` router 明确忽略 composition input，由组合持有的
composition controller 按 Current 18 处理；clipboard 路径见 Current 17。
dead key、平台 IME 特化和 screen-reader mirror 仍不属于这个普通输入
router。

### Current 17：Selection clipboard adapter

`getSelectionTexts` 按 `TextSelectionSet` 拥有的稳定顺序读取范围文本。
`createPasteTextCommand` 把同一文本应用到所有 selection，
`createDistributedPasteTextCommand` 要求文本数量精确匹配 selection 数量，
`createCutCommand` 只删除非空范围。三者都生成统一的 selection-after
offset，并使用 `Isolated` history，确保 paste/cut 不会与前后的连续 typing
合成一个 undo step。

`ClipboardController` 由 editor view 组合持有并监听浏览器
copy/cut/paste。copy 写入可移植的 `text/plain`、转义后的预格式化 `text/html`；
Editor 的多 selection 复制额外写入版本化 `application/x-stanza-editor`
元数据。粘贴时，合法且数量匹配的元数据逐 selection 分发；外部纯文本或无效
元数据则把同一文本应用到每个 selection。没有 `text/plain` 的外部 HTML 会在
inert template 中转换为确定性文本，脚本、样式和 noscript 内容不进入 model。
所有输入最终仍经过 common command 和权威
`TextModel`，成功 cut/paste 后清空 textarea 并 reveal primary。

clipboard 输出的换行约定由显式 `ClipboardLineEnding` 控制，默认按宿主
Windows 选择 CRLF，其余平台选择 LF；进入 model 时仍统一规范化为 LF。浏览器
拒绝自定义 MIME 时保留 plain text，不影响跨应用复制。空 selection 的显式
策略和整行 round-trip 见 Current 20。

`ClipboardController` 独立持有 copy/cut/paste 语义，包括整行策略、metadata、HTML 输出、文本文件 paste 与 `text/uri-list` paste；URI 注释行会被忽略，异步结果必须仍匹配原 model version 与 selection 才能提交。浏览器 event 没有文本或 metadata 时，它通过 platform `IClipboardService` 读写 plain text；平台层不持有编辑器 metadata 或 HTML。`TextDropController` 只处理文本与文本文件 drop。所有删除仍由 common command 执行，但剪切范围已由 clipboard owner 决定。

### Current 18：EditContext composition adapter

`CompositionController` 统一消费 textarea 与浏览器 EditContext 的
`compositionstart/update/end` 事件。开始前要求共享 `IME.enabled`、可写模型和
单 selection；随后只调用标准 `ViewController.compositionStart`、
`compositionType` 与 `compositionEnd`，由 `ViewModel` 和 `CursorsController`
持有受保护的 history revision。输入 adapter 只负责把 provisional string 和
相对 selection offset 规范化，不建立第二套文本事务。

编辑器实例的 selection 状态固定由
`ViewModelImpl → CursorsController → CursorCollection → Cursor` 持有。
`CursorCollection` 负责 primary-first 顺序、secondary cursor 生命周期、重叠
归一化和 tracked marker；`Cursor` 只持有一个 model/view 双坐标状态。模型内容
变化从 ViewModel collector 进入 controller，reset 时重建整组 marker，再发布
一次 cursor 状态变化，不由浏览器输入层保存平行 selection。

`CodeEditorWidget` 把 collector 中同一条 cursor 状态变化投影为标准
`onDidChangeCursorPosition` 与 `onDidChangeCursorSelection`，事件保留 primary、
secondary、旧 selection、模型版本、source 和 reason。`CursorUndoRedoController`
只消费这个公开事件并持有每个 editor 的有界 cursor-only 历史；文档变化会清空该
历史，文档 undo/redo 仍只属于 `TextModel`。Linked Editing 等标准 contribution
通过 `ICodeEditor` 读取 selection，不订阅内部 `CursorsController` 事件。

每次 update 用本次完整 provisional string 替换上一版本，并按 active offset
更新 caret。composition end 完成同一 revision；Escape、blur、adapter disposal
或运行期间 `IME.disable()` 会结束 revision，并对已经写入的 provisional edit
执行 undo。重复 start 不会打开第二个 revision。`onDidChange` 对上层发布
composition active 状态，cut 与 paste 在此期间被拒绝，copy 仍可用。

开始时 View reveal composition 起点，并通过
`getPositionContentCoordinates` 把输入表面移到对应的测量 caret；layout 变化会
重算位置，为候选窗提供 content-coordinate anchor。DOM 通过稳定的
`.composing` 和 `.ime-input` 状态类投影，样式继续由 Ash component 持有。

当前实现覆盖桌面式完整 provisional string；Android/iOS replacement 推导、
dead key、IME clause segmentation、多 selection IME、候选窗越界回退和更复杂
的 composition clipboard UX 仍需独立适配与真实平台验证。

### Current 19：Composition range projection

`CompositionController` 用一个 `TextDecorationCollection` 持有 active
composition range。每次 update 通过标准 model decoration 替换范围，使用
`NeverGrowsWhenTypingAtEdges` 和 `edit-context-composition-primary`；end、cancel
与 disposal 清空 collection。

该范围进入普通 `TextModel → RenderingContext → DecorationsOverlay` 链，复用
现有 decoration 的 tab prefix measurement、end-exclusive 多行语义和 overscan
clipping。`View` 与 `ViewCursors` 不再公开 composition-range setter，也不持有
平行 `TrackedRange`、逐行 composition layer 或额外 DOM owner。当前尚未区分
IME clause 的 primary、secondary 与 none segment。

### Current 20：Empty-selection whole-line clipboard

`EditorEmptySelectionClipboardPolicy` 显式选择 `Line` 或 `Ignore`，browser
默认 `Line`。`getEditorClipboardEntries` 按稳定 selection 顺序生成文本、
source range 和 `Selection`/`Line` paste mode。collapsed selection 的整行
文本总以 LF 结束；存在下一行时 source range 包含后继 LF，最后一行则包含
前驱 LF，唯一一行只删除自身内容。`Ignore` 保持浏览器原行为，不用含糊
boolean 表达策略。

`createClipboardCutCommand` 合并相交或相邻 source ranges，所以同一行多个
caret、整行范围与普通 selection 重叠时只生成一个无歧义 deletion script。
每个原 selection 的目标 offset 再统一映射过合并后的删除；完全汇聚的 caret
按已有规则去重，undo 仍恢复原始多 selection。

Editor clipboard metadata 升级为 version 2，除每个 selection 的文本外还携带
paste mode。全部 payload 为 `Line` 且目标 selection 都 collapsed 时，
`createLinePasteCommand` 在各目标行首插入并把 caret 保留在原内容列。同一
目标行的多个 caret 会按稳定 selection 顺序合并 payload 为一次 insertion，
不会产生共享起点 edit。混合 line/selection metadata 或非空目标会降级为
普通逐 selection paste，避免 line mode 隐式绕过目标范围。

plain-text 输出会连续拼接 line entries，避免每个自带 LF 的行之间出现额外
空行；跨平台输出仍由 `ClipboardLineEnding` 转换。copy-with-syntax 数据、文本文件 paste
与 `text/uri-list` 都由 `ClipboardController` 处理；`editContext/clipboardUtils.ts` 只适配
浏览器 event transfer，并把外部 HTML 安全还原成文本。浏览器 paste event 没有可用文本
或 metadata 时，platform clipboard service 只读取 plain text；异步结果仍必须通过 captured
model revision 与完整 selection set 的闸门。copy/cut event 没有 `clipboardData` 时，同一
service 输出 plain text，cut 等待成功。

### Current 21：Versioned language request boundary

`editor/common/LanguageRequestCoordinator` 为每个请求捕获不可变
`TextSnapshot`、单调 request ID、具名 lane 和调用方 payload。同一 lane 是
latest-wins；不同 lane 可以共享一个惰性创建的 worker 并发运行。该 adapter
直接复用标准 `AbortSignal`，模型事务、同 lane 新请求、调用方取消、worker
重启和 coordinator disposal 都有显式取消原因。

worker value 不直接返回给任意状态写入路径。协调器在同步调用 result applier
之前同时检查 active request identity 与当前 `TextModel.version`；任何晚到
结果只返回 `Cancelled` outcome。模型先销毁时同样拒绝应用，而已捕获 snapshot
仍保持可读。协调器拥有 worker 和 model listener，但不拥有 `TextModel`。

当前 active request 的 worker rejection 会使该实例失效并被释放，同时以
`WorkerRestarted` 取消其他 lane；下一次请求再惰性创建 worker。失败请求保留
原始 error，result applier 自身失败不会误伤健康 worker。`LanguageWorkerRequest`
是 adapter contract 而非可直接 structured-clone 的 wire schema；具体
browser/process worker 必须自己传输文本并保留 request/model version。

定向测试已覆盖同 lane 覆盖、跨 lane 并发、模型变更、调用方取消、worker
故障重建、两种销毁顺序、晚到结果拒绝和 application failure isolation。
token/diagnostic result store 见 Current 22，completion result/session 见
Current 25，completion full-snapshot wire 见 Current 27；增量同步、
token/diagnostic transport 与自动 retry 在该阶段仍未定义。completion 增量
同步见 Current 28。

### Current 22：Versioned token and diagnostic result state

`VersionedLanguageResultStore<TResult>` 是 Current 21 同步 application gate
之后的持久状态 owner。`VersionedLanguageResult` 同时携带 realm-local
`TextModel` identity 与 version，跨模型接线在 normalization 前直接拒绝，
不能把两个 version 1 文档混为一体。一个 store 对应一个单调 request-ID
domain；低于 high-water mark 的结果返回
`SupersededRequest`，相同 ID 返回 `DuplicateRequest`。显式 `clear()` 只清内容，
不重置 high-water，因而旧的同版本 worker 结果不能重新写回。

store 发出不可变的 `Result`、`ModelChanged` 和 `Cleared` 事件。任何文本事务
都会整体移除当前 language result，而不是用 tracked range 把旧 token 或
diagnostic 映射到新文本。这样 `TextDecorationCollection` 继续保持领域无关，
language owner 也不能把 stale analysis 伪装成仍然有效的装饰。

`createLanguageTokenStore` 要求 token 是非空、单行、按位置排序且不重叠的
`TextRange`，token type 是非空 ID，modifier 必须唯一。结果和所有 entry/
modifier 数组都会复制并冻结。`createLanguageDiagnosticStore` 允许 diagnostic
重叠与 collapsed point range，但验证 model range、severity、非空 message、
finite/string code 和 source。任一 entry 失败时不会替换既有 result。

normalizer 完成后 store 会再次检查 model version 和 request high-water，
所以 validation 期间的同步模型编辑或重入写入不能发布捕获版本。模型先销毁
时返回 `ModelUnavailable`；store disposal 不拥有模型。diagnostic projection
见 Current 23；semantic-token 行索引和 browser projection 见 Current 24；
completion result/session 见 Current 25，completion wire schema 见 Current 27；
token/diagnostic worker wire schema 仍未完成。

### Current 23：Versioned diagnostic decoration projection

`LanguageDiagnosticDecorationBridge` 观察一个 typed diagnostic store，并拥有
`TextDecorationCollection<LanguageDiagnostic>`。当前 result 会在构造时投影，
后续 result replacement、显式 clear 和 model invalidation 都走 collection
的原子 `replaceAll`。bridge 不拥有 store 或 `TextModel`，dispose 只释放自己
的 listener、tracked ranges 和 collection。

该 collection 在 store 之后注册 model listener。文本事务先触发 store 的
`ModelChanged` clear，再由 bridge 清空 collection；轮到 collection 自己观察
同一事务时已经没有旧 range，因此不会先发一次虚假的 `Range` movement 再
清空。测试明确证明 model version 2 只出现一个空 `Content` event。

browser 的 `createStanzaLanguageDiagnosticSource` 为 Error、Warning、Information
和 Hint 映射命名 underline，并继续消费 Stanza component 的 severity theme token 和
CSS。Viewport 还会在每个可见 logical line 的首个 visual row 放置该行最高严重级别的
gutter marker；`StanzaDiagnosticHoverController` 会把该 marker 的当前文本呈现为
component-owned rich hover，并在 scroll 时关闭。Viewport 的非交互 overview ruler
聚合每行最高 severity，且不改变 content hit-test。它不是可操作 glyph margin。
Viewport 只拥有 source event registration，不拥有 bridge、collection、store 或 model。
F8/Shift+F8 的 diagnostic navigation 会在选择目标后通过同一 viewport live region
宣读 severity、source/code（若有）和 message，不依赖视觉 hover。

当前 whole-result replacement 会重新分配 decoration ID；若后续 hover/action
需要跨同版本 refresh 保持身份，必须增加明确的 diagnostic identity/reconcile
契约，不能从 message 或数组位置静默猜测。大规模 diagnostics 也仍需行范围
索引，当前 viewport clipping 会扫描 source 的全部 resolved decorations。

### Current 24：Versioned semantic-token line projection

`LanguageTokenLineIndex` 观察一个
`VersionedLanguageResultStore<LanguageTokenResult>`，按实际含 token 的行
建立稀疏索引。每条可见虚拟行可做 O(1) 查询；同 model version 的新 request
原子替换全部 line buckets，模型事务则沿 store 的 `ModelChanged` 顺序先清空
索引。index 不拥有 store 或 `TextModel`，也不把旧 token 通过 tracked range
映射到新文本。

browser 的 `createStanzaSemanticTokenSource` 把 common token type 显式解析为
Stanza 的 `Comment`、`Keyword`、`String`、`Number`、`Regexp`、`Type`、
`Function`、`Variable` 或 `Operator` presentation。未知 type 默认省略；
语言 owner 可以提供 resolver，但返回值仍必须属于该命名 enum，worker
字符串永远不能直接成为 CSS class。source 的全量 `lines` 查询仍可生成并整体验证
稀疏 snapshot；Viewport 使用 Current 35 的逐行查询，不再解析屏幕外 token。

`projectStanzaSemanticTokenLine` 只使用 text node 和 component-owned `span`，
不使用 HTML 拼接。每次分段都验证非空、排序、不重叠和行内边界，并要求
fragment 的完整 `textContent` 与模型行逐 UTF-16 code unit 相同。Viewport
先解析完整目标虚拟窗口，再修改其中的 row；同版本 token refresh
只重投影当前虚拟窗口，重叠行继续保留 row DOM identity。模型编辑先移除
stale span，再由既有 model-version reconciliation 投影新文本。Viewport
只拥有 event registration，不拥有 source、index、store 或 model。

颜色由 `platform/theme/common/colors/editorColors.ts` 以
`editor.semanticToken.*Foreground` 注册并编译为 design-token 产物；
Stanza CSS 只消费这些语义变量。当前 modifiers 交给 resolver 解释，尚未定义
字体粗细/斜体 contract；持久 relative-range token storage、multi-splice delta、
嵌入语言优先级和超大 token snapshot 的调度仍未完成。

### Current 25：Versioned completion result、session 与 widget

`createLanguageCompletionStore` 继续复用
`VersionedLanguageResultStore<LanguageCompletionResult>`。result 显式携带
触发 `TextPosition`、`isIncomplete` 和 immutable items；每个 item 必须提供
item ID、命名 kind、label、明确的 `TextRange` 与 `insertText`。替换范围必须
停留在触发行且包含触发位置。detail/documentation/filter/sort/preselect 都在
接受前验证并复制冻结，多个 preselect、重复 provider/item identity、跨行或不包含触发点的范围
会 failure-atomically 拒绝整个 result。插入文本在 store 边界归一化为 LF。

`LanguageCompletionSessionController` 是 per-editor 状态，不进入共享
`TextModel`。它只在 selection 是位于 result 触发点的单一 collapsed caret
时打开；同版本新 request 通过 provider/item identity 保留 focus，默认使用唯一 preselect
或第一项。next/previous 循环移动，显式 cancel 和 selection change 只关闭
本地 session，不清除 caller-owned store。store、selection controller 或
model 都不由 session 拥有。

接受 item 时，`createLanguageCompletionAcceptCommand` 只使用 item 的明确
range/insertText，生成一个 isolated `EditorEditCommand`，并把 caret 放在
归一化插入文本末尾。它不从 label、detail 或 DOM 推断编辑。模型事件造成的
store invalidation 在 accept 期间由 session 协调，最终只发布一次
`Accepted` close；undo 通过既有 selection history 同时恢复文本与触发 caret。

browser 的 `CompletionWidget` 由 `SuggestController` 创建并托管。widget 使用 viewport 的 content coordinates 锚定在触发 caret 下方，以 `.visible`、`.focused` 状态类同步 listbox/option ARIA；`SuggestController` 在 view 的 pre-command 事件上处理上下键循环、Enter/Tab 接受、Escape 本地取消和 commit character，活跃 session 才截获这些键，其余事件继续走既有 navigation controllers。鼠标在 mousedown 同一事务中 focus 并接受，避免重绘后的 detached option 丢失 click。label/detail/kind 全部用 `textContent`，kind 只映射命名 enum，CSS 由 widget 自己拥有并仅消费现有 theme tokens。

当前结果协议和接受链路已具备：deferred resolve/documentation、commit character、
non-overlapping additional edits，以及 `$n`/`${n}`/`${n:default}`/`${n|a,b|}` snippet
tabstop 会话，都通过同一 item contract、Worker transport 与 isolated undo 交付。
choice 的镜像 occurrence 通过 `Alt+↑/↓` 原子循环替换；session 为 `${TM_FILENAME}`、
`${TM_FILENAME_BASE}`、`${TM_DIRECTORY}` 与 `${TM_FILEPATH}` 注入 editor input
变量，未知变量必须有显式 default。transform 仍不在 Stanza 当前受支持 grammar，
不能被静默降级。provider 生产和触发链见 Current 26；completion Worker wire
transport 见 Current 27。

### Current 26：Completion provider registry、host 与触发链

`LanguageCompletionProviderRegistry` 在 common 层保存确定性的注册顺序，
并以 provider ID、显式 language ID 或 `*` selector、Unicode code-point trigger
characters 形成最小注册契约。注册返回的 disposable 只撤销该项；registry
不拥有 provider。`Invoke`、`TriggerCharacter` 与 `IncompleteRefresh` 是封闭的
discriminated context，避免用 boolean 或可歧义的 optional 参数表达触发原因。

`LanguageCompletionProviderWorker` 实现既有 `LanguageWorker` 边界，是当前
进程内 provider host。一次请求先捕获唯一 snapshot 行索引，再并发调用全部
匹配 provider；每个 provider 的结果都在该 snapshot 上验证。普通 provider
异常和无效结果按 provider 隔离并上报，取消则直接向 coordinator 传播。合并
结果保持 registry/item 顺序，以 `providerId + item.id` 作为 identity，只保留
第一个 preselect，并对 `isIncomplete` 做 OR。`LanguageCompletionService`
拥有 coordinator、host 和 result store，但不拥有 registry 或 model。

browser 的 Suggest contribution 在 editor configuration 阶段创建 service/session，并在 `EditorView` 建立后安装 `SuggestController`；它显式接入 service 和 language ID。Ctrl+Space 发送 `Invoke`；已注册的 trigger character 在文本事务完成后，以新的 model version 和 caret 发送请求；当前结果为 incomplete 时，普通输入发送 `IncompleteRefresh`。请求只发生在单一 collapsed selection 上，失败不会回滚已经成功的文本事务。session 必须精确观察该 service 的 result store，避免同模型、不同 request-ID domain 被误接。

当前 incomplete refresh 会重新查询所有匹配 provider，不复用旧版本 complete
items，因为旧 range 不能越过 model-version gate。host 隔离在
`LanguageWorker` 后；具体浏览器 Worker transport 见 Current 27。

### Current 27：Completion Worker wire 与 lexical provider

`LanguageWorkerWireClient` / `LanguageWorkerWireServer` 在 common 层只依赖
结构化 `LanguageWorkerWirePort`，不依赖 DOM `Worker`、`MessagePort` 或 browser
event 类型。协议使用版本化的 request/cancel/result/failure envelope。每次
request 传输 request ID、lane、完整 LF snapshot DTO 和 domain payload；
server 会核对 snapshot version、UTF-16 length、line count 与文本，再创建
只读 `TextSnapshot`。取消在 client 立即结束本地 promise，同时发送 cancel
使 server 的 `AbortSignal` 中止。remote failure 只传 name/message，不传递
可执行对象或不可靠的跨 realm prototype。

`languageCompletionWireCodec` 是 completion domain 对 wire 的唯一 codec。
renderer 发出的 `TextPosition`/context 被编码为 plain DTO；Worker 返回的
position/range/item 也全部是 plain DTO。client 在自己的 realm 重建
`TextPosition` / `TextRange`，然后再次按原始 captured snapshot 做完整结果
normalization。无效 range、kind、identity 或 malformed protocol 不能进入
result store。transport terminal failure 会使 pending request 失败；既有
coordinator 随即销毁 client，下一次请求创建新的 Worker。

browser 的 `createStanzaCompletionWorkerFactory` 创建 Vite module Worker、
DOM Worker port adapter 与 typed wire client。Worker entry 创建自己的 provider
registry、`LanguageCompletionProviderWorker` 和 wire server，并注册
`stanza.word` lexical provider。该 provider 在 snapshot 内收集确定性排序的
同前缀 word，使用完整 active word 作为 replacement range，默认最多返回
100 项并准确标记 incomplete。

`LanguageCompletionService.workerFactory` 允许调用方显式选择该 transport；
service 仍拥有每个 factory result，而 registry/model 仍由调用方拥有。当前
默认值继续使用进程内 provider host，因此现有调用方不会隐式创建线程。
Stanza 产品 composition root 尚未接入该 factory；接入时 renderer registry
与 Worker registry 的触发元数据同步由 Current 29 负责。

Current 27 的第一版 wire 每次请求复制完整 snapshot，是正确但
O(document length) 的同步基线；Current 28 已用增量文档镜像替代正常路径。
Current 29 已补齐 Worker provider catalog/metadata 与 Worker 预热。token 与
diagnostic codec、resolve request 仍未完成。

### Current 28：增量 Worker 文档镜像

`LanguageWorkerModelSynchronizer` 是独立于 `LanguageWorker.run` 的可选能力。
`LanguageRequestCoordinator` 收到 `TextModelChange` 时先以 `ModelChanged`
取消所有旧版本 request，再把同一个 immutable change 交给当前支持同步的
worker。同步失败只丢弃该 worker；下一请求惰性创建新实例并从 full snapshot
恢复。普通进程内 worker 不需要实现该接口。

wire protocol v2 把 request snapshot 分为 `full` 与 `reference`。client 第一次
请求或失去连续版本时发送 full；成功把消息交给有序 channel 后记录 mirror
version。后续每个 model commit 发送 `sync(previousVersion, modelVersion,
changes)`，其中 changes 只包含 pre-transaction UTF-16 range offset/length
和 LF text。连续同步后的请求只发送 version/length/lineCount reference，
不再传全文。若 client 观察到版本跳跃，它不猜测缺失事务，而是清空本地 mirror
状态，使下一请求重新发送 full。

Worker server 用 `LanguageWorkerDocumentMirror` 独占一个由 PieceTree 实现的 TextBuffer，而不是
用字符串拼接应用 delta。所有 change 会先验证版本连续、顺序、非重叠、范围
和 LF，再按 offset 逆序写入，因此验证失败是原子的。每个 request 从 Piece
Tree 捕获独立 immutable snapshot；同步新版本不会改变正在取消中的旧 request
snapshot。undo、redo 和多 edit transaction 使用同一 `TextModelChange`
contract，无需 transport 特判。

同一 Worker port 是可靠有序 channel，因此 cancel、sync、reference request
按发送顺序处理，不增加每次 sync acknowledgement。server 拒绝 sync 时会清空
镜像并发送 terminal `syncFailure`；client poison 后，coordinator 在下一请求
替换整个 Worker。协议仍保留 full 作为初始化、版本跳跃和 Worker 重建的恢复
路径。一个 coordinator/worker 只镜像一个 model，当前不引入多文档 identity。

### Current 29：Worker provider catalog 与首次 trigger handshake

`LanguageCompletionProviderMetadata` 从可执行 `provideCompletions` 函数中拆出
provider ID、language selectors 和 trigger characters。
`LanguageCompletionProviderRegistry.providerCatalog` 是带单调 revision 的
immutable snapshot；注册和撤销都会在 registry 顺序下发布新 catalog。
catalog normalization 会复制冻结所有数组，并拒绝重复 provider ID、language
ID 或 trigger character，因此 renderer 不会直接信任 Worker plain objects。

catalog 使用独立的 `stanza.completion-provider-catalog` side-channel，
不把 completion 特有 metadata 塞进通用 language-worker envelope。
`LanguageCompletionCatalogWirePublisher` 观察 Worker 内真正执行 provider 的
registry，启动时发送当前 snapshot，之后发送每个 revision。
`LanguageCompletionCatalogWorkerClient` 同时委托 typed request client 和观察
catalog；首次 catalog 有明确 readiness promise，后续 revision 必须严格递增。
malformed/stale catalog 会 invalidate 底层 wire client。

自定义 `LanguageCompletionService.workerFactory` 现在会被 service 预热。
factory result 若实现 `LanguageCompletionProviderCatalogSource`，service 会切换
到该远端 source；普通自定义 worker 和默认进程内 host 继续使用 caller-owned
registry catalog。`requestTriggerCharacter` 捕获当前 model version，启动或
重建 Worker，等待首次 catalog，再只对真实匹配 provider 发请求。等待期间模型
变化会丢弃该 trigger，而不是用旧位置请求新版本。

`SuggestController` 使用该异步 trigger API。若 catalog 证明字符不受支持，且先前 result 是 incomplete，它只在 model version、单一 collapsed selection 和 caret 都未变化时回退到 `IncompleteRefresh`。Worker terminal failure 或 disposal 会先发布 empty catalog；下一次 trigger 让 coordinator 创建新 Worker，并重新完成 catalog handshake，旧 metadata 不会继续路由输入。

当前 catalog 描述 Worker 已加载的 provider，但还不能要求 Worker 动态加载
任意 renderer 函数。后续需要命名 provider module/feature manifest 与受控加载
协议；函数本身始终不能通过 structured clone 传输。

### Current 30：命名 Worker provider module 与首次请求 barrier

`LanguageCompletionProviderModuleRegistry` 在 Worker realm 内保存调用方拥有的
命名 module definition，只向 renderer 发布 ID 与单调 revision。
`LanguageCompletionProviderModuleHost` 按 module ID 串行化 Active/Inactive
操作。一次 load 返回的 provider batch 先全部校验，再通过
`LanguageCompletionProviderRegistry.registerMany` 原子注册；重复 ID、无效
provider 或 load failure 都不会泄漏部分 registry 状态。deactivate、module
撤销和 host disposal 会释放整批 provider，并只发布一次 provider catalog
revision。

独立的 `stanza.completion-provider-modules` 协议只传 module ID、期望状态、
catalog 和结果，不传函数或 renderer 对象。
`LanguageCompletionProviderModuleWireServer` 在 Worker 内委托 module host；
`LanguageCompletionProviderModuleWireClient` 验证 catalog revision 与 request
response identity。stale/malformed catalog 或协议不匹配会 invalidate 共享
typed Worker client，因此 catalog、activation 和 request 不会形成彼此独立的
半失效状态。

`LanguageCompletionCatalogWorkerClient` 将 required-module activation 合成首次
request readiness barrier。browser factory 声明需要 `stanza.word`；Worker entry
只注册同名 module definition，不再无条件注册 lexical provider。客户端先等
module catalog，再请求激活；Worker 原子注册 provider 并发布 provider catalog，
最后返回 activation result。共享 port 的有序性保证 catalog revision 先于
barrier 释放，立即发出的首次 Invoke 也不会跑到空 registry。Worker 重建会
重新执行同一 handshake。

### Current 31：版本绑定的 completion resolve

列表 item 新增显式 `hasDeferredDetails`，但 provider 的 `resolveData` 不进入
renderer item 或通用 completion DTO。`LanguageCompletionProviderWorker` 在一次
成功列表请求结束时保存 provider realm 内的解析记录，key 同时包含 completion
request ID、model version、provider ID 和 item ID。新结果替换 cache；provider
撤销或同 ID replacement 也会使旧记录失效。

provider resolver 只能返回 `LanguageCompletionItemDetails`。runtime normalizer
只接受 `detail` 与 `documentation`，拒绝 `insertText`、range、label 等字段，
因此延迟解析不能改变已验证的 edit identity。`resolveData` 在缓存前通过
structured clone 与 provider 后续 mutation 隔离；resolve failure 走 provider
error policy，但不会 poison 一个协议仍健康的 Worker。

独立的 `stanza.completion-resolve` side-channel 提供 resolve/result/failure/
cancel。它复用同一 Worker port，却不扩张通用 language request envelope。
客户端核对 response target；错配或 malformed response 会 invalidate 共享
Worker。普通 provider failure 只拒绝对应 resolve。浏览器取消会发送 cancel，
Worker 使用独立 `AbortController` 终止 provider work。

`LanguageCompletionService` 在调用 Worker 前后都核对当前 result identity。
`LanguageCompletionSessionController` 只为 focused item 自动解析，focus、
result、selection、accept、cancel 或 disposal 都会 abort 旧请求。session 用
Complete/Loading/Failed/Unavailable 命名状态投影详情；失败不会关闭候选列表，
已解析文本也不能参与 acceptance。browser widget 只用 text node 展示选中项
detail/documentation，并以 `.resolving` 和 `aria-busy` 投影加载状态。

### Current 32：共享 token/diagnostic Worker transport

通用 `LanguageWorkerWireCodec` 从单一 `lane` 演进为显式 `lanes` 集合，codec 的
payload/result encode/decode 都接收当前 lane。request envelope 与协议版本无需
变化；client 使用 pending request 的 lane 解码 result，server 在 decode 前拒绝
未声明 lane。completion 继续声明单 lane，而 analysis codec 同时声明 `tokens`
与 `diagnostics`。

`LanguageAnalysisProviderRegistry` 保存 caller-owned provider。token lane 按注册
顺序选择第一个匹配 provider，避免多个语义 token batch 产生未定义覆盖规则；
diagnostic lane 并发执行全部匹配 provider，并按注册顺序合并，允许诊断 overlap。
provider failure 通过 Worker realm 的 error policy 报告并与健康 batch 隔离。
所有 range、token 排序/非重叠、modifier、severity、message、code 与 source
都先针对 captured snapshot 归一化。

`LanguageAnalysisService` 用一个 `LanguageRequestCoordinator` 和一个 Worker
同时拥有两条 latest-wins lane，并将结果分别应用到 token/diagnostic versioned
store。两 lane 可并发；任一 lane 的新请求只 supersede 自己，model transaction
则先取消两者，再向共享 `LanguageWorkerModelSynchronizer` 发送一次增量 change。
因此首个请求发送 full snapshot，同一轮的另一个 lane 使用 reference，后续
请求在有序 sync 后继续 reference。无效 DTO 在 renderer realm 被拒绝，terminal
Worker failure 由 coordinator 在下一请求重建。

browser 的 `createStanzaAnalysisWorkerFactory` 创建独立 Vite module Worker。
completion 与 analysis 共用抽取后的 browser/dedicated Worker port adapter，
但 provider host、协议 client 和 failure domain 独立。Worker entry 注册
`stanza.lexical` baseline provider，为 TypeScript/JavaScript/JSON 以及 Rust 提供确定性的
comment/string/number/identifier/keyword/operator token；Rust profile 还识别 ordinary/raw string
和 character literal，以及未终止 string/template/comment/raw string 和 bracket balance
diagnostic。它不是 parser 或语言
服务器；在 Current 32 边界内每条 lane 仍完整扫描 captured snapshot，只有文档
transport 已经增量化。产品 composition root 尚未选择该 factory。

### Current 33：版本化增量词法分析

通用 Worker server 在成功应用一笔有序同步事务后，向实现
`LanguageWorkerDocumentSynchronizationObserver` 的 Worker host 投递
`previousVersion`、`modelVersion`、规范化 change 和更新后的不可变 snapshot。
`LanguageAnalysisProviderWorker` 再把该事件投递给注册表中声明
`synchronizeDocument` 的 provider。单个 provider 的同步失败只进入该 provider
的错误策略，不会清空 Worker mirror，也不会阻断健康 token/diagnostic lane。

`stanza.lexical` 现在由一个 token 与 diagnostic lane 共享的版本缓存计算结果。
逐行扫描只保存相对列范围、括号/诊断事件和显式
`normal`、`blockComment`、`multilineString` 与带 delimiter hash 数的 Rust `rawString` 输入输出状态。事务更新先复用文本相同的
前缀，再从首个变化行向后传播状态；进入相同文本后缀且输入状态与旧缓存一致时，
剩余行整体复用。行号发生移动时，相对结果在聚合阶段重新绑定当前 snapshot，
因此不会保留旧版本绝对坐标。

同一版本的另一条 lane 直接读取已聚合缓存，不再重复扫描。缓存 observer 记录
完整/增量更新、实际扫描行数和复用行数，测试据此锁定 1,000 行文档的单行编辑
预算；跨行状态测试证明传播在闭合点后收敛，120 轮确定性随机编辑逐版本与全量
新缓存 oracle 比对 token 和 diagnostic。该能力仍是确定性词法基线，不代表
TypeScript AST、语义类型检查或语言服务器级增量图已经完成。

### Current 34：可确认基准的 analysis result delta

Worker wire protocol v3 为每条 lane 增加可选的 `resultBaseRequestId`。client 只
发送最后一次通过 renderer application gate 的 request ID；server 仅在自己最后保存的同 lane result
具有完全相同 ID 时把它交给 codec。若响应在取消竞态中丢失、请求乱序、Worker
重建或任一侧没有基准，server 发送 full result。这个握手避免把“server 已发送”
误当成“client 已接收”，也不需要额外 acknowledgement 消息。codec 必须显式
选择 `stateless` 或 `confirmedBase` result protocol；completion 不持有无用基准。

analysis codec 的 delta 保存绝对相同的 item 前缀，对文档总行数变化后的 item
后缀执行统一行位移，并只传输中间 splice。DTO 绑定 base request ID、行位移、
起始 item、删除数量和插入 item。renderer realm 在重建前校验基准、lane、
snapshot 行数差、splice 边界以及全部 token/diagnostic contract；delta 不能减少
传输 item 数时直接使用 full。completion codec 继续发送 full result，不承担
analysis 特有规则。

100 轮随机编辑证明两条 analysis lane 的 delta 重建与 full oracle 相同。
1,000 行且超过 3,000 token 的文档在首行普通编辑后最多传输 4 个 token item；
测试还主动制造 client 漏收 server result 的状态，证明下一请求回退 full。

当前限制必须保持显式：v3 只有一个连续 item splice，距离很远的多个变化区域
可能回退 full；renderer 的 `VersionedLanguageResultStore` 仍接受完整数组，
`LanguageTokenLineIndex` 仍在发布后重建。行原生 renderer store 与 multi-splice
协议尚未完成，不能把 Worker 传输增量描述成端到端零复制。

### Current 35：application-confirmed token line state

`LanguageWorkerWireClient` 不再在 decode 时立即晋升 analysis 基准。它先暂存
结果；`LanguageRequestCoordinator` 只有在 request identity、model version、
store normalization 和同步 application callback 全部通过后，才以
`LanguageWorkerResultDisposition.Applied` 确认。取消、stale result 和 application
failure 都发送 `Discarded`，因此下一请求不会引用 renderer 从未接受的基准。

token delta 的 splice 元数据不进入可克隆 DTO，也不开放给 provider。codec 在
renderer realm 完成 DTO 与 snapshot 校验后，通过 realm-local `WeakMap` 绑定；
provider snapshot normalizer 会剥离该提示，token store normalizer 只保留已绑定
元数据。

模型事务发生时，`LanguageTokenLineIndex` 立即清空可见 bucket，同时可将上一份
immutable state 保留为隐藏 confirmed base。匹配 delta 到达后，index 只重建
splice 边界覆盖的稀疏 token 行；行号未变化的 prefix/suffix line object 直接
复用。base 不匹配或 full result 到达时仍执行完整 rebuild。change event 显式
报告 `rebuiltLineCount` 与 `reusedLineCount`。

browser 不再在 source event 上解析全部 sparse lines。
`StanzaSemanticTokenSource.getLineTokens` 只解析指定行，Viewport 先解析整个目标
虚拟窗口，再原子更新该窗口。1,000 个 token 行的单行编辑测试证明 1 行重建、
999 行复用；100 轮随机 wire delta 与 full token oracle 一致；1,000 行文档的一行
viewport 只调用一次 presentation resolver。

当前 store 仍保留完整 token 数组，换行编辑也仍需为绝对 range 重建 shifted
suffix。下一步需要 relative-range persistent line storage，才能把 line delta
从投影层继续下沉到 canonical result ownership。

### Current 36：multi-splice 与相对 token 行基座

language Worker protocol v4 将 analysis delta 从单个连续 splice 扩展为按 base item
坐标排序的 splice 列表。`createLanguageAnalysisItemSplices` 先以完全相同的 snapshot
行建立有序稳定锚点，再要求对应 token/diagnostic item 在各自累计行位移下完全相同；
锚点之间才作为变化区传输。每个 splice 记录其后续未变化区间的累计行位移，因此两个
相距很远的编辑不再把中间数千个 item 合并进一个巨大变化区。无法证明排序、稳定锚点
或传输收益时仍回退单 splice 或 full result，正确性不依赖差分质量。

renderer 解码器依次验证 base ID、splice 顺序、非重叠边界、最终行数位移和完整结果
contract。通过验证后，它把 base/result item 坐标、插入数量及 splice 前后行位移作为
realm-local `WeakMap` 元数据交给 token store；provider 无法伪造该提示。协议版本提升
到 v4，避免旧 Worker 把新的 result payload 当成 v3 解析。

`LanguageTokenLineIndex` 的持久状态不再以绝对 `TextRange` 作为行内容基座。每个稀疏
行保存不可变的相对列 payload；multi-splice 元数据把完整 base item 空隙映射到 result
item 空隙。行号不变时复用同一个公开 line object，行号移动时只创建新的轻量绑定并
复用 payload，绝对 range 在 `getLineTokens` 或 `line.tokens` 首次查询时才生成。base
缺失、元数据不连续或当前 token 与 payload 不一致时仍完整重建。

验证覆盖两个相距 800 行的编辑只产生两个 splice，40 轮双区域事务与 full oracle
一致，1,000 行中的两个变化行只重建 2 行并复用 998 行，以及插入一行后只重建新行、
复用原有 1,000 个相对 payload。`VersionedLanguageResultStore` 目前仍发布完整绝对
token 数组；若要进一步消除 renderer 端整数组分配，需要后续引入持久 result tree，
不能把当前状态描述为端到端零复制。

本阶段同时固定服务抽取边界：

| 能力 | 所有者 | 当前状态 |
| --- | --- | --- |
| event、lifecycle、URI、resource collection | `base` | ✅ 复用现有领域无关基座；禁止 editor 反向依赖 |
| 原始资源 I/O 与粗粒度失效 | `platform/files` | ✅ App Server-backed UTF-8 read/write 与 `fs/changed` projection |
| load/save 传输、共享文档引用与 Stanza dirty/revert/conflict policy | `workbench/services/textfile/common` / `workbench/services/textmodelResolver/browser/BrowserTextModelService` | ✅ CAS 与 workspace-scoped working-copy 备份恢复均已接通 |
| 文本事务、selection、decoration、language result | `editor/common` | ✅ editor 领域所有权 |
| TextMate grammar/runtime 与 token provider | 独立 `workbench/services/textMate` adapter | ✅ runtime/provider/browser WASM、内置资源、声明式 extension discovery、活动主题、embedded language 与 bracket metadata 已接通 |

因此 Current 36 不为 token delta 新造 service，也不提前创建没有保存、冲突或 grammar
consumer 的空壳 service。Current 43 在 Analysis provider 成为真实 consumer 后才抽取
TextMate adapter。未来若文件 I/O、dirty 状态或 TextMate runtime import 出现在
`TextModel`、token index 或 Stanza browser component 中，应视为所有权漂移并
立即沿上述边界抽取。

### Current 37：共享 provider module 基座与 Analysis 激活屏障

Completion 原先拥有的 module registry、host、catalog、activation 状态机和
wire request/response 校验已经抽为 `editor/common` 内的通用语言域设施。
Completion 与 Analysis 仅保留 provider 类型和协议描述符的薄封装。该抽取不会进入
`base`：module ID、provider batch 与 Worker catalog 都是编辑器语言域语义，反向下沉
会违反 base 的领域无关边界。

两个真实调用方都需要“等待异步准备，同时响应调用方 `AbortSignal`”，因此仅将这一
无领域语义的机制抽为 `base/common/cancellation.raceCancellation`。它不拥有也不取消
底层任务，只结束当前调用方的等待，并统一产生可识别的 `CancellationError`。

Analysis Worker entry 不再直接把 lexical provider 无条件注册进 provider registry。
它发布 `stanza.lexical` module definition，由
`LanguageAnalysisModuleWorkerClient` 在首个 token/diagnostic 请求前完成 catalog
握手与激活。激活以一个 provider batch 原子提交；碰撞、加载失败或加载期间撤销都不
泄漏部分 provider。required module 失败会使预热 Worker 失效，下一次请求由
`LanguageAnalysisService` 创建全新 Worker 并重新握手。

该组合客户端仍转发 Current 35 的 `Applied`/`Discarded` result settlement，所以
只有 Renderer 真正接受的 Analysis 结果才成为下一次 delta 基线。测试覆盖激活先于
首请求、批量注册回滚、确认基线转发、失败后的 Worker 重建，并继续回归 Completion
module 协议。

这条 module seam 是 `workbench/services/textMate` adapter 的接入点。Current 37 落地时
TextMate grammar、scope 解析和 runtime 依赖后来由 Current 43–46 在 Stanza/`base`
之外建立，并已接通产品 grammar 资源与 extension discovery。同样，
`workbench/services/textfile/common` 已由 Text Engine、Document Engine 与 Explorer 的
共享 loading/save 边界证明需要。它只转发 I/O 与粗粒度 invalidation；Stanza 保持 dirty、
revert、共享模型引用和外改 policy，不能反向塞入 `TextModel` 或 `base`。

### Current 38：语言配置基座与 lexical cache 身份

对照 VS Code 源码后，Stanza 保留了“language configuration 与 tokenization runtime
分离”的架构结论，但没有移植其完整 service、配置覆盖层或 support class。
Current 38 的首个真实消费者只需要 comments 与 brackets，因此当时
`LanguageConfigurationRegistry` 先定义这两个可组合字段。贡献按 priority 和注册顺序
逐字段合并，`null` 可以显式清空继承值，撤销贡献会恢复剩余配置并发布新的不可变
revision。`languageId.ts` 统一 concrete language ID 与 `*` provider selector 的校验，
这些都是 editor 领域身份，不能下沉到 `base`。

Analysis Worker realm 在加载 `stanza.lexical` module 前建立并拥有该 registry，注册
ECMAScript、JSON、JSONC 与 Rust 的内置配置，再把配置 source 注入 lexical provider。
scanner 被编译为 `LanguageLexicalLineScanner`，comments、任意长度 bracket token、
keyword、ordinary string、ECMAScript regular-expression、hash-delimited raw string 与 character-literal profile 均由明确的
语言配置/lexical profile 提供，不再依赖文件级
全局常量。

此前 `LanguageLexicalAnalysisCache` 只以 model version 判断命中；同一快照先按
TypeScript、再按 JSON 请求时可能错误复用第一份结果。现在 provider 按
`languageId + resolved configuration identity` 拥有独立 cache，每个 cache 内仍由
token/diagnostic 两条 lane 共享扫描结果。配置 revision 改变时，即使 model version
不变，也会创建新 scanner/cache。JSON 不再继承 JavaScript 的注释与 template literal
规则，JSONC 则显式保留注释配置。

测试覆盖 priority/order 合并、逐字段保留、显式清空、验证原子性、贡献撤销、
registry 独立生命周期、同版本跨语言隔离、JSON/JSONC 差异、配置变更后的 cache
替换，以及既有 1,000 行增量扫描与随机编辑 oracle。

该 registry 是原生输入的 bracket/comment command、wordPattern 与 `workbench/services/textMate` adapter
可共同消费的 Stanza common 基座。Current 38 落地时尚未加入 indentation、on-enter
或 word-pattern 字段；Current 41 在 Enter command 成为真实消费者后加入前两者。
word-pattern 继续服务明确需要语言正则的 occurrence 等语言能力；browser pointer、
键盘导航与按词删除使用 editor 配置的 `wordSeparators` 和标准 `WordOperations`，
不把语言正则变成第二套 cursor 边界。TextMate grammar runtime 与 scope
tokenization 由 Current 43 在独立 adapter 中补齐。

### Current 39：语言配对输入事务

`LanguageConfiguration` 新增 `autoClosingPairs`、`surroundingPairs` 与
`autoCloseBefore`。未显式贡献 auto-closing 时回退到最终 brackets；未显式贡献
surrounding 时再回退到最终 auto-closing。相同 open/close 的 quote pair 合法，
bracket 与 block-comment pair 仍要求角色不同。字段继续遵循 Current 38 的
priority/order、`null` 清空、revision 与撤销语义。

ECMAScript、JSON 与 JSONC 的内置配置已从 lexical profile 文件迁移到
`languageBuiltinConfigurations.ts`。这是所有权修正：comments、brackets 与编辑
pair 是 language configuration，lexical 文件只拥有 keyword/string scanner profile。
Analysis Worker 仍显式拥有自己的 registry；原生输入 composition root 也可以注册
同一组配置，但两边不共享可变实例或生命周期。

`createSelectionEditCommand` 把原有 edit command 内部的多 selection 偏移映射提升为
editor-common 事务构造器。`createLanguagePairTypeCommand` 在这一边界上实现：

- 非空 selection 输入 surrounding opener 时保留方向并包围原文本；
- collapsed caret 输入 opener 时仅在行尾或 `autoCloseBefore` 允许的后继字符前插入
  完整 pair，并把 caret 留在中间；
- 输入已位于 caret 后的 closer 时只移动 selection，不产生 model version；
- `createLanguagePairBackspaceCommand` 删除空 pair 两侧，同时让同一多光标事务中的
  其他 selection 保持普通 Backspace 语义。

`LanguageEditingAdapter` 由 bracket-matching contribution 创建，并显式接收 concrete language ID 与 caller-owned `LanguageConfigurationSource`；它在每次相关 `beforeinput` 中读取当前 resolved revision，因此配置贡献变化无需重建 View。`ViewController` 只负责 DOM 事件到 command 的适配，`SuggestController` 独立消费 view 的 pre-command/post-edit 事件；pair 决策、事务、selection 映射与 undo 仍由 common/controller/model 拥有。

测试覆盖单字符和多字符 pair、后继字符策略、quote overtype、正反向 selection
surround、多光标偏移、空 pair Backspace、undo、配置 revision 热更新和浏览器
`beforeinput` 路由。Current 39 落地时尚无自动闭合来源追踪；该缺口由 Current 40
补齐。自动缩进与 on-enter 由 Current 41 补齐基础事务；token-context `notIn` 条件
由 Current 42 补齐 string/comment 基线。

### Current 40：每编辑器实例的自动闭合来源

字符相等不足以证明 closer 来自自动闭合。`createLanguagePairTypeCommand` 现在为实际
auto-close edit 生成 post-transaction `LanguageAutoClosingAction`；调用者只有在返回的
model version 仍是当前已提交版本时，才能把 action 交给
`LanguageAutoClosingTracker`。同步 listener 引发重入编辑时，过期 action 会被丢弃。

`LanguageAutoClosingTracker` 位于 `editor/common`，但由每个输入 controller 实例拥有。
它复用 `TextModel.trackRange`，分别追踪 enclosing range 与 closer range，并借用同一
model 的 `EditorSelectionController`：

| 关注点 | 所有者 | 结论 |
| --- | --- | --- |
| tracked-range 映射算法 | `TextModel` / Stanza text core | ✅ 复用，不建立第二套 decoration |
| “由自动闭合产生”的身份 | `LanguageAutoClosingTracker` | editor-instance 状态，不进入共享 model |
| DOM `beforeinput` 路由 | `ViewController` | browser 只适配事件并把 language adapter 的提交回执交回 common |
| auto-closing tracker 生命周期 | `LanguageEditingAdapter` | 每个 editor 实例独立拥有 tracker，不进入 shared model |
| language pair 配置 | `LanguageConfigurationRegistry` | 继续由 caller-owned registry 提供 |
| URI、文件保存、TextMate runtime | 各自 platform/adapter service | ❌ 不与自动闭合来源耦合 |
| 通用 `base` | domain-neutral primitives | ❌ 不新增 editor identity 或反向依赖 |

只有 tracker 对当前位置和 closer 给出正向信任时，pair command 才允许无事务
overtype；只有 trusted pair 仍为空时，Backspace 才删除两侧。用户源码中原本存在的
`()`、字符串或 bracket 即使字符完全匹配，也保持普通插入/删除语义。

外部编辑会通过 tracked range 移动仍有效的 pair；closer/open 改写、跨行、所有
selection 离开 enclosing range 都会永久释放对应记录。多光标记录独立失效。
undo 令 pair 消失时来源随之失效；redo 只恢复 model/selection 历史，不伪造已经释放
的短生命周期来源。测试覆盖以上路径、过期 version、销毁后借用依赖仍存活，以及
`ViewController` 与 `LanguageEditingAdapter` 的自动记录链路。

### Current 41：语言感知 Enter 与实例缩进

`LanguageConfiguration` 现在拥有 `indentationRules` 与 `onEnterRules` 两个真实消费字段。
它们继续遵守 field-wise priority/order、`null` 清空、registration disposal 和 revision
语义。RegExp 在注册时克隆，resolved rule/action/pattern 全部冻结；Analysis Worker
使用的 isolated built-in source 也返回自己的冻结副本，不共享 caller 可变
`lastIndex`。

`createLanguageEnterCommand` 的决策顺序是：

1. 按配置顺序匹配 `previousLineText`、`beforeText`、`afterText` 的显式
   `onEnterRules`；
2. 匹配 caret 两侧的 language brackets，生成 Indent 或 IndentOutdent；
3. 读取 increase/decrease/indent-next/unindented patterns；
4. 无规则命中时保留当前行在 caret 前的 leading indentation。

Indent、IndentOutdent、Outdent、appendText 与 removeText 都转换为
`EditorSelectionEdit`。多个 selection 仍以同一 pre-change snapshot 计算，交给
`createSelectionEditCommand` 一次提交。`BeginCoalescedTyping` 在 Enter 前切断旧 typing
history group，但让 Enter 后紧邻输入继续加入新 group：一次 undo 删除 Enter 与随后
输入，再一次 undo 才删除 Enter 前的输入。

缩进样式没有放入 language registry。`EditorIndentationOptions` 明确选择 Tabs 或 Spaces，并提供 tabSize；visual-column 归一化负责 mixed whitespace、shift 与 unshift。`LanguageEditingAdapter` 只拥有 resolved 实例选项并在每次 Enter 读取当前 language revision。

| 候选抽象 | 当前归属 | 评估 |
| --- | --- | --- |
| event/lifecycle | `base/common` | ✅ 继续复用 |
| Tabs/Spaces/tabSize | Stanza editor instance | 值对象即可，尚不需要 service |
| indentation/on-enter language rules | `LanguageConfigurationRegistry` | ✅ 已有多个 input/Worker composition root |
| 持久化 editor setting | future Workbench settings service | 尚未完成；未来只映射为实例 options |
| TextFile resolve/save 与 invalidation；Stanza dirty/conflict | `workbench/services/textfile` / `BrowserTextModelService` | ✅，不与 Enter command 耦合；CAS 与 workspace-scoped recovery 已接通 |
| TextMate grammar/runtime | `workbench/services/textMate` adapter | ✅；不得进入 Enter 或 `base` |

Current 41 初始 matcher 使用 model 原始行文本，尚未像 VS Code 的
`IndentationContextProcessor` 一样移除 string/comment token 中的 bracket-looking
文本。该缺口由 Current 42 的同步 lexical context 补齐；common 仍不反向 import
Worker/browser，editor token 语义也没有进入 `base`。

测试覆盖规则组合/清空/验证、全局 RegExp 隔离、ECMAScript/JSON built-ins、显式规则
优先级、doc-comment continuation、bracket indent-outdent、increase/decrease/ignore、
tabs/spaces visual-column 归一化、selection replacement、多光标偏移、undo group、
动态 revision 与 browser `beforeinput`。

### Current 42：同步 lexical input context

Worker 的 `LanguageLexicalAnalysisCache` 会生成整份 token/diagnostic 结果，不能直接放到
按键热路径。`LanguageLexicalContextSource` 因此定义更小的同步查询契约：

- identity 必须绑定一个 `TextModel` 与 concrete language ID；
- `getStructuralLineContent` 返回指定原始列范围的结构文本；
- `getTokenTypeAt` 返回 caret 所处的 baseline lexical token type。

默认实现 `LanguageLexicalContextIndex` 复用 `createLanguageLexicalLineScanner`，按需从最近
已知 lexical state 扫描到目标行。model transaction 只截断 first changed line 之后的
cache；resolved configuration identity 改变时才重建 scanner。它借用 model 与
configuration source，不拥有两者。

结构文本不是把整个 string/comment 清空。与 VS Code 的
`IndentationLineProcessor` 边界一致，它只删除这些 token span 内由当前 language
配置声明的 bracket token，保留引号、comment marker、普通文字与 whitespace。这样
`/** ... */`、line-comment continuation 等显式 on-enter rule 仍能匹配，同时 `"{"`、
`// {`、`/[{]/` 和跨行 block comment 内的括号不会触发 Indent/IndentOutdent。

`LanguageAutoClosingPair` 同时新增冻结的 `notIn`。当前 closed vocabulary 是
`string | comment`，因为 baseline scanner 只对这两类上下文提供可靠结构边界。
`createLanguagePairTypeCommand` 在 auto-close 前查询同一个 source；已记录 closer 的
overtype 仍先由 `LanguageAutoClosingTracker` 决定，不会被 `notIn` 破坏。

| 生命周期/能力 | 当前所有者 | 结论 |
| --- | --- | --- |
| 行 scanner 编译与 lazy state cache | `LanguageLexicalContextIndex` | Stanza common、可共享注入 |
| 默认 input context | `LanguageEditingAdapter` | bracket-matching contribution 创建并销毁本地 lexical index |
| document-level 共享 | future composition root | 可直接注入 source，无需改 command |
| full token/diagnostic analysis | Analysis Worker | 继续异步，不阻塞按键 |
| lifecycle/event primitives | `base/common` | ✅ 复用 |
| lexical/token semantics | `base` | ❌ 禁止下沉 |

当前 ECMAScript baseline 能识别一行 regular-expression literal，并区分除法；它仍不识别
embedded language、template interpolation 中重新进入代码的区域，也没有 suffix-state
convergence 优化。这些是明确的下一阶段，而不是当前能力。测试已覆盖 partial slice、string、closed 与
unterminated string boundary、line/block comment、多行状态、外部编辑、configuration
revision、销毁、跨 model/language 拒绝、Enter、auto-closing `notIn` 与 browser
路由。

### Current 43：独立 TextMate runtime adapter

TextMate grammar 已经出现真实消费者：Stanza Analysis provider/module seam 可以接收比
baseline lexical scanner 更高保真的 token provider。因此 runtime 不进入
`editor`，而是建立单向依赖 `workbench/services/textMate → editor/common →
base/common`。`base` 不认识 grammar、scope、language ID 或 token provider；
Stanza 也不 import `vscode-textmate`、`vscode-oniguruma` 或 WASM。

`TextMateGrammarRegistry` 拥有 grammar contribution identity。一个 definition 由唯一
`scopeName`、可选 root `languageId`、injection targets 和延迟 loader 组成；注册、
撤销都会产生新的 immutable snapshot，旧 snapshot 仍能完成已经开始的请求。
loader 只返回 raw grammar 文本或对象，不接收 URI/`IFileService`。资源定位、extension
manifest 与信任验证由当前 product composition root 负责，避免 token Worker
反向拥有 platform I/O。

`TextMateTokenizationService` 针对 snapshot 建立 `vscode-textmate.Registry`，通过注入
的 `IOnigLib` 加载 grammar/injection，并按行保存 input/output `StateStack` 与相对列
token。文档变化后先复用相同行前缀，再从第一处变化扫描；进入相同文本后缀且新的
input state 与旧 state `equals` 时复用剩余 suffix。grammar revision 即使 model
version 未变化，也建立新的 runtime generation；旧 generation 只在最后一个捕获它
的请求退出后 dispose。

scope mapping 是显式可替换的 `TextMateScopeResolver`。默认 resolver 只投影稳定的
comment/string/regexp/number/operator/keyword/function/type/parameter/variable/tag/
property/constant/punctuation/invalid vocabulary。`TextMateScopeThemeModel` 现在提供
可 structured-clone 的 revisioned selector rule，覆盖 token type 和 modifier；Renderer
通过独立 theme wire 更新 Worker，Worker 清空仅样式 cache 后由下一请求重算。embedded
language identity、balanced/unbalanced bracket metadata 与 exact scope styling 已接通。`createTextMateAnalysisProvider` 把结果转为 Stanza
`LanguageTokenResult`，`createTextMateAnalysisModule` 再接入现有 module activation
协议。

Stanza token provider 新增 `tokenPriority`，默认值为 `0`，相同优先级保留注册顺序。
TextMate provider 使用 `100`，因此一个 Worker 可同时激活 lexical fallback 与
TextMate。Current 43 初始 provider 捕获当时的 root language selectors；该静态限制由
Current 44 的 wildcard/`undefined` fallback chain 与版本化 catalog transport 移除。
priority 只影响 token lane；diagnostic provider 继续按原合同合并。

browser 边界由 `createBrowserTextMateOnigLib` 独占：它通过 Vite asset URL fetch
`onig.wasm`，每个 Worker realm 只初始化一次，并只把 `IOnigLib` 交给 common。
CommonJS package 在 Node ESM 和 Vite realm 的导出形态不同，适配层统一处理
namespace/default 两种形式；该差异不泄漏给调用方。

| 能力 | 所有者 | 当前状态 |
| --- | --- | --- |
| grammar identity、revision、injection graph | `workbench/services/textMate/common` | ✅ |
| TextMate runtime 与 incremental state | `TextMateTokenizationService` | ✅ |
| Stanza provider/module integration | `workbench/services/textMate/common` | ✅ |
| Oniguruma WASM URL/fetch | `workbench/services/textMate/browser` | ✅ |
| baseline structural diagnostics | `stanza.lexical` | ✅，继续独立 |
| grammar resource/extension manifest loading | product extension/resource layer | ✅ App Server extension discovery 与声明式资源投影已接通；不执行 extension JavaScript |
| scope-theme selector、token type、modifier 与 embedded-language projection | TextMate/theme adapter | ✅ |
| URI、文件保存、dirty/conflict | platform/textfile / `BrowserTextModelService` | ✅，不得混入 TextMate；CAS/恢复已接通 |

真实 WASM 测试覆盖跨行 string/comment state、单行编辑只重扫一行、多行状态变化扫描到
suffix convergence、同 model version grammar revision 替换、scope validation、
cancellation、独立生命周期，以及经过 `LanguageAnalysisService` application gate 的
provider priority。独立 Vite entry build 证明 browser WASM adapter 可被 Worker
打包。`createBrowserEditorPart` consumes the Workbench `ITextMateService`/`BrowserTextMateService` for product Stanza panes and subscribes
to catalog/theme revisions before scheduling a replacement analysis request.
This proves extension-packaged JSON/JSONC and caller-resolved session contributions
are active in the product path; Rust owns extension manifest/resource discovery and
the Workbench composition root projects those contributions into TextMate.

### Current 44：版本化 grammar catalog 与动态 token fallback

Grammar loader 是函数，不能跨 structured clone；而 Electron Renderer 能通过 platform
service 读取 extension/resource，dedicated Worker 则不应拥有 IPC 或文件权限。因此
TextMate 新增显式的完整 catalog 边界：

1. `materializeTextMateGrammarCatalog` 把一个 immutable registry snapshot 的 raw
   grammar 文本/对象解析为有界 content catalog；
2. `TextMateGrammarCatalogModel` 在 Renderer 维护严格递增的完整 revision；
3. `TextMateGrammarCatalogWireClient` 通过 Analysis Worker 已有 port 发送 catalog；
4. `TextMateGrammarCatalogWireServer` 先完整验证并构造候选 registry，再原子替换
   `TextMateGrammarCatalogStore`；
5. `TextMateTokenizationService` 在下一请求捕获新的 registry snapshot，同 model
   version 也不会复用旧 grammar runtime。

Wire 限制 grammar 数、单 grammar UTF-16 长度和 catalog 总长度，拒绝重复 scope/root
language、空内容、乱序 revision 与未知 response。远端拒绝、malformed response 或
transport failure 会 poison catalog client 并 invalidate 整个 Analysis Worker；下一
请求由 `LanguageRequestCoordinator` 建立新 Worker，并把 catalog source 当前 revision
发送给从零开始的 store。普通 dispose 只结束 pending catalog wait，不反向拥有 source
或 port。

静态 root selector 会让动态 catalog 增加语言时必须重注册 provider。为消除这个耦合，
Stanza token lane 从“选一个 provider”演进为明确的 priority fallback chain：

- `LanguageAnalysisProviderRegistry.getTokenProviders` 按 `tokenPriority` 降序返回，
  同 priority 保留注册顺序；
- provider 返回 `undefined` 表示“本次不拥有”，继续下一个 provider；
- provider failure 被隔离并报告，然后继续 fallback；
- 第一个返回有效结果的 provider 经过原有 snapshot normalizer 和 application gate；
- 所有 provider 都缺席时才发布 empty token result。

TextMate provider 因而声明 wildcard、priority `100`；catalog 没有该 language root 时
返回 `undefined`，priority `0` 的 `stanza.lexical` 自动接管。该 fallback 语义只属于
token provider；diagnostic lane 仍然并发合并所有匹配 provider。

`TextMateAnalysisModuleWorkerClient` 同时持有 Stanza module client 与 grammar catalog
client。catalog updates 串行发送，每个 Analysis request 都等待调用时最新的 scheduled
revision。`textMateAnalysisWorkerMain.ts` 是独立 composition root，拥有：

| Worker 内能力 | 所有者 |
| --- | --- |
| Analysis request/result 与 document mirror | Stanza Worker wire |
| provider module activation | Stanza generic module wire |
| grammar catalog replacement | TextMate catalog wire/store |
| TextMate provider/runtime | `textmate.grammars` / `TextMateTokenizationService` |
| deterministic fallback/diagnostics | `stanza.lexical` |
| WASM fetch/init | `workbench/services/textMate/browser` |

这种组合保持依赖为 `textmate/browser → textmate/common → editor/common → base`；
Stanza 原有 Worker 不 import TextMate，`base` 也不增加任何 editor identity。

真实 structured-clone 测试证明 initial catalog 在首请求前落地、TextMate 优先、
无 grammar language 回落 lexical、同 Worker revision 热更新改变同版本 token，
stale revision poison client，以及 registry snapshot 到 wire catalog 的 materialization。
独立 Vite build 同时产出 TextMate Worker chunk 与 466,610-byte Oniguruma WASM。

Current 44 落地时还缺真实 grammar resource owner 和产品层消费者。Current 45 已补入
首批内置 grammar 与 catalog service，后续 extension service 也已接通声明式资源 discovery；`createBrowserEditorPart` 选择
Stanza pane 的 Worker factory 并调度 catalog 变化后的 model token request。catalog change 本身不隐式遍历或重算所有
文档，这个调度责任不得偷偷进入通用 catalog model。

### Current 45：TextMate grammar service 与首批真实资源

VS Code/Node 兼容 Extension Host 当前仍不存在；Ash-native executable Host RPC v1 的 runtime core
已经实现，App Server/Workbench provider bridge 和 production enforcing launcher 的状态由
[`editor-extensions.md`](editor-extensions.md) 维护。Current 45 落地前还没有 grammar contribution
service；现有
`IFileService` 的合同是“工作区文件读取”，并不拥有产品内置资源。因而真实 grammar
不能硬编码进 Worker，也不能通过给 workspace file service 增加 TextMate 特例来读取。
Current 45 建立了独立的 editor-domain 服务边界：

| 能力 | 所有者 | 结论 |
| --- | --- | --- |
| URI、事件、取消与生命周期原语 | `base/common` | ✅ 复用，保持领域无关 |
| 工作区用户文件读取 | `platform/files` | ✅ 合同不变 |
| grammar contribution、异步装载和 catalog 发布 | `TextMateGrammarService` | ✅ `workbench/services/textMate/common` |
| 产品内置 grammar 资源解析与贡献 | `AppServerExtensionService` | ✅ 通过 generation-bound extension API 接入 |
| catalog 传输和 tokenization | TextMate dedicated Worker | ✅ 继续无文件权限 |
| extension manifest 与外部 grammar resource | extension service | ✅ 不可变 generation-bound 声明式 discovery；不执行 extension JavaScript |
| TextFile resolve/save/invalidation；Stanza dirty/save/revert/conflict | `textfile` / `BrowserTextModelService` | ✅，未与 grammar service 混合；CAS/working-copy 恢复已完成 |

`TextMateGrammarService` 拥有 registration 和 `TextMateGrammarCatalogModel`。每次贡献变化
都会捕获 immutable registry snapshot；较新 revision 会取消较旧 materialization，只有最新且
完整的 catalog 才能发布。loader 失败通过 `onDidFailCatalog` 报告，已经可用的 catalog 保持
不变；`whenReady()` 明确等待当前最新 revision。服务销毁先关闭调度和 listener，再释放注册，
不会在 teardown 中启动新的 catalog 工作。

首批产品资源从相邻 VS Code 源码树的 `extensions/json/syntaxes` 移入：
`JSON.tmLanguage.json` 和 `JSONC.tmLanguage.json`。两者当前位于根目录 `extensions/json/`，保留
上游 revision/provenance，由 App Server extension resource API 读取，再通过现有 catalog wire 传给 Worker。
`common` 不 import raw asset，Worker 不访问文件系统，`base` 不识别 grammar、scope 或
language identity。

`BrowserTextMateService` 把内置 grammar service 和
`createTextMateAnalysisWorkerFactory` 组合为一个可销毁的产品接入单元。Current 45
落地时 Workbench 尚无 Stanza `EditorPane`，因此当时未选择该 support，也未在 catalog
revision 变化时为打开文档请求重分析；Current 46 已补齐这两个真实消费者。

测试覆盖 contribution 装载、latest-revision-wins、失败保持 last-good catalog、撤销后重发布，
并使用真实 Oniguruma 对移入的 VS Code JSON grammar 执行 tokenization。扩展与打包测试同时
验证 manifest 引用的真实资源仍存在。

### Current 46：Workbench TextFile 边界与 Stanza 产品 Pane

Stanza 已从独立内核演进为由真实 `IEditorPane` 宿主的编辑器能力，但仍保持“Workbench 负责资源与宿主、
编辑器域负责模型和交互语义”的单向依赖。Code 与 Academic 产品通过 Workbench contribution 注册 Stanza 为
普通文本的默认 editor；document、diff 和 PDF 继续通过各自明确的 pane descriptor 参与选择。

`IEditorPart.openEditor` 是产品调用面，`EditorPaneRegistry` 是实现选择边界，`IEditorPane` 是
被选实现的生命周期 contract。产品调用方不选择 parser、analysis service 或 transport；descriptor
只绑定当前受支持的 code、document、diff、PDF 等资源视图，App Server 不知道最终选择了哪个 pane。

| 能力 | 当前所有者 | 状态 |
| --- | --- | --- |
| URI、取消、事件、生命周期原语 | `base/common` | ✅ 复用，保持领域无关 |
| 工作区原始文件读取 | `platform/files` | ✅ |
| file/bootstrap 内容决策 | `ITextFileService` | ✅ Workbench service |
| URI 到 Stanza `TextModel` 的共享引用 | Workbench `BrowserTextModelService` | ✅ Workbench-owned；Editor 只定义 `ITextModelService` contract |
| Stanza viewport、native input、基础键盘/指针与 text drop | `CodeEditorWidget` | ✅ Code mode 的底层浏览器编辑表面；Academic code region 由 `RichTextEditorWidget` 按同一 TextModel 的连续行范围投影 |
| Stanza language、folding、diagnostic、save 与文档命令组合 | `EditorBrowser` + editor contribution registry | ✅ Code browser runtime；可独立能力由模式 bundle 选择 |
| original/modified 版本 gate、diff result 与前端计算取消 | `DiffModel` / `IDiffComputationService` | ✅ common model；browser Worker 为当前实现 |
| JSON/JSONC TextMate 与 Analysis Worker | `workbench/services/textMate` (`ITextMateService`) | ✅ 产品 Stanza pane 已选择 |
| Completion Worker | `createBrowserEditorPart` | ✅ 产品 Stanza pane 已选择 |
| dirty、save/revert、CRLF/LF、粗粒度外改重载与冲突状态 | `BrowserTextModelService` | ✅；CAS 与 Workbench 备份恢复已完成，TextFile 边界严格接受 UTF-8 并把其他内容路由到只读 Binary Editor |

打开资源时，`ExplorerViewPane` 只提交 `{ resource, label }`；它不再预读文件或伪造
`initialText`。`EditorBrowser` 选定 descriptor 后把 `ITextFileService` 注入 pane。
Stanza pane 先通过 `BrowserTextModelService.acquire` 获取引用：已有资源模型保持权威，
新资源才调用 TextFile resolve。最后一个引用释放时模型销毁。TextFile service
不吸收任何编辑器的 transaction、undo 或 selection 类型。

`TextModel` 本身只接受一个领域无关的可取消 maintenance scheduler；没有注入时保持
同步压缩默认行为。浏览器 `BrowserTextModelService` 为文件模型注入 idle scheduler，
所以达到 piece-tree 回收阈值不会把 O(document length) 压缩塞进一次编辑事务；调度
任务在模型关闭时取消，快照、history 与 `TextModel.version` 不因维护而改变。

产品 Stanza session 组合 `BrowserTextMateService` 与 Completion Worker。
它等待初始 grammar catalog，再发 token/diagnostic 请求；catalog revision 变化会触发
当前文档重新分析。直接构造的 Stanza session 仍使用本地 lexical/word provider，方便
独立嵌入和确定性测试。详细 TextFile 实现契约见
[`ash-ts/src/ash/workbench/services/textfile/README.md`](../ash-ts/src/ash/workbench/services/textfile/README.md)，
Stanza 内部契约见
[`ash-ts/src/ash/editor/text-engine.md`](../ash-ts/src/ash/editor/text-engine.md)。

Grammar catalog 由共享 Workbench `ITextMateService` 拥有，声明式 extension resource contribution
会更新其 revision；每个文档的 Analysis Worker 仍由其 model coordinator 独立拥有，避免故障域和增量 mirror 互相污染。

本阶段明确没有把 TextFile、TextMate 或 document identity 下沉到 `base`。当前 host 已具备原子写入与粗粒度变更通知，Stanza 因而拥有 dirty/save/revert 和外改 policy；expected-revision write、workspace-scoped working-copy 备份恢复已经接通。TextFile resolve 先以 stat 限制文本大小，再读取 bytes、剥离 UTF-8 BOM、拒绝 NUL/控制字符密集内容和非法 UTF-8；被拒绝的内容可显式切换到只读 Binary Editor。保留原编码写回与编码选择器仍是独立的未来能力，当前实现不会静默转码。

### Current 47：Workbench Editor 宿主与 VS Code 文件边界

Ash 不以 VS Code `workbench/browser/parts/editor` 的文件数量作为完成度指标；对齐对象是宿主不变量和用户行为。VS Code 为兼容多代编辑器、配置组合与平台服务拆分了大量类，Ash 在保持 `base → platform → editor → workbench` 依赖方向的前提下合并同一所有者内的实现，并把格式专用视图放入 contribution。

| 能力或 VS Code 文件族 | Ash 所有者 | 当前结论 |
| --- | --- | --- |
| `editorPart`、`editorGroupView`、`editorParts`、`auxiliaryEditorPart` | `workbench/browser/parts/editor/{editorPart,editorGroup,editorParts}.ts` + `services/auxiliaryWindow` | 已具备二维 Grid、稳定 group/editor identity、跨窗口活动 part、移动与关闭 veto |
| `editorTabsControl`、multi/single/no tabs | Editor title/tabs controls | 已具备 multiple/single/none、preview/pinned、dirty/conflict decoration、reorder 与 edge split；multi-row tabs 未引入，因为当前产品没有对应配置与密度需求 |
| `editorQuickAccess`、`editorTypePicker`、`editorsObserver` | `editorActions.ts` + `EditorParts`/`EditorPart` 可观察状态 | 已具备 Show All Editors、Reopen With、MRU、recently closed；不复制第二套 observer model |
| `editorWithViewState`、placeholder、drop target、auto save、status | pane capability + group/part contributions | 已具备 JSON-safe view state、retry/close/binary fallback、内部/外部 DnD、自动保存和状态栏 |
| breadcrumbs model/picker | `breadcrumbsControl.ts` | 当前只投影资源路径；符号 breadcrumbs 和目录 picker 需要 outline/file navigation service，不能在 control 内私建索引 |
| `textEditor`、`textCodeEditor`、`textResourceEditor` | `workbench/contrib/codeEditor` + `src/ash/editor` | 不在 Workbench 复制；模型、selection、undo、viewport 与 language runtime 归 editor 域 |
| binary editor | `workbench/contrib/binaryEditor` | 已具备有界只读 hex/ascii 预览；binary diff 尚无产品交互需求，不用文本 diff 伪装 |
| side-by-side/text diff | `workbench/contrib/codeEditor` 的 diff pane/model 与 multi-diff contribution | 不复制 VS Code 继承树；版本 gate 和 diff 取消归 diff model/service |
| editor commands/context | action registry、Workbench context-key projection、editor services | 已按命令/菜单/快捷键和稳定事件契约拆分，不建立同名转发文件 |

Workbench editor 宿主负责资源视图的“在哪个 group/window、以哪个 pane、何时激活或关闭”；具体 pane 负责“如何解释和编辑内容”。跨窗口服务只注册同源 UI 窗口、镜像样式并提供布局/卸载事件，不获得文件或模型权限。Binary Pane 只消费 `IFileService.readFileBytes`，TextFile service 只向文本模型发布经过验证的 UTF-8，二者不会共享可写模型。

新增 VS Code 对应能力前必须先判断基座所有者：需要稳定布局与事件时扩展 EditorPart/Group state；需要窗口时扩展 auxiliary-window service 与 scoped services；需要格式解释时新增 contribution/pane；需要 transaction、selection 或 language 状态时进入 `src/ash/editor`。只有出现至少两个真实调用方时，才把领域无关 DOM、Grid、取消或生命周期原语下沉到 `base`。

### Current 48：Overview Ruler 渲染边界

`DecorationsOverviewRuler` 是标准 `ViewPart`，只拥有一个从无障碍树隐藏的 canvas。它在 `prepareRender` 阶段读取 ViewModel 的 overview decoration 分组，在 render 阶段按 layout、DPR 和 lane 写入 canvas；光标、配置、主题、滚动和 View Zone 变化都进入同一失效状态，不再由调用方拼装另一套 marker source。

`editorOverviewRuler.border` 与 `editorOverviewRuler.background` 由 Ash 主题注册表提供，普通主题保留安静的透明表面，高对比度主题保留明确边界。`hideCursorInOverviewRuler` 是完整 boolean 配置，不再只存在于枚举和默认值。该 canvas 不可聚焦、不可点击，也不承担 hover 或命令职责。

`EditorScrollbar` 尚未进入本切片：它依赖的 base scrollable element 还没有标准 overview layout、wheel delegate 和 vertical pointer delegate API。必须先补齐 base owner，再迁移 `View → EditorScrollbar`；不能在上层补同名空方法。仅本地且无生产调用的旧 debug breakpoint decoration 文件也不属于 Overview Ruler owner，未接入本链。

### Proposed 3：语言边界

在 Current 21–36 的请求、结果、基础 diagnostic、semantic-token 与
completion provider/accept/wire 之上定义 rich diagnostic identity、
actionable glyph 与语言专用增量语法/语义分析。
所有结果必须继续绑定请求时的 model version，不得绕过同步 application gate。

### Proposed 4：原生 view 与输入

在现有虚拟行、字体度量、gutter、selection/caret、基础 decoration、
hit-test、pointer selection、keyboard navigation、普通 textarea 编辑、
基础 clipboard 与桌面式 composition 之上补齐 Android/iOS IME
差异、macOS clause presentation 与跨平台辅助技术验收；富
decoration 与 versioned language result 沿 language boundary 演进。
每增加一种输入路径，都必须生成同一种 Ash transaction。

## 评估与迁移门槛

| 阶段 | 必须证明 |
| --- | --- |
| Storage | 大文件编辑、随机事务回放、snapshot 一致性和内存上限 |
| Model state | 多光标、tracked range、undo selection 和 decoration 稳定性 |
| Language | cancellation、版本拒绝、worker crash recovery |
| View | viewport 正确性、字体变化、滚动稳定性和主题切换 |
| Input | 主流 IME、clipboard、dead key、组合取消和浏览器差异 |
| Accessibility | screen reader 导航、ARIA、键盘完整操作和高对比度 |

这些证据决定现有能力能否从“部分具备”升级为“已具备”；它们不再对应任何旧 runtime 迁移状态。
