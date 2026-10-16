# 编辑器语法能力

## 快速理解

语法高亮、折叠、outline 和 parse diagnostic 都是编辑器能力。产品层对外组合
`CodeEditor` 或 `DiffEditor`，只提供文档、语言、主题和平台输入；它不获得独立 syntax service，
也不通过 App Server 同步编辑器内部 revision。

| 能力                                                           | 当前 owner                                                     | 状态                                                                                                                                                                                                |
| -------------------------------------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 内置语言 grammar、query 与增量 tree                            | `ash-syntax`，由 Rust `CodeEditor` 私有组合                    | ✅                                                                                                                                                                                                  |
| 文本、selection、undo/redo、语言切换和 syntax token 生命周期   | `ash-editor::CodeEditorDocument`                               | ✅                                                                                                                                                                                                  |
| Native 普通代码结构折叠、visible-row mapping 与 gutter control | `ash-editor::CodeEditorDocument` / `CodeEditor`                | ✅；宿主只转交点击                                                                                                                                                                                  |
| Native Composer 的 Shell 高亮                                  | `CodeEditorDocument::from_text_with_language` / `set_language` | ✅                                                                                                                                                                                                  |
| Native 文件 document lifecycle                                 | `ash-text-file` + `FileEditorHost` / `FileEditorPane`          | ✅；独立 crate 拥有 baseline/version/dirty/conflict，Native 已接通 Tab、Explorer load、save、关闭确认、外部重载/显式乐观覆盖、中心 Editor Surface 以及 keyboard/IME/pointer/clipboard/viewport 输入 |
| Native `DiffEditor` 两侧 syntax token 投影                     | `ash-editor::DiffEditorDocument` / `DiffEditor`                | ✅；宿主只提交 diff 与 language                                                                                                                                                                     |
| Stanza bundled-language token                                  | Desktop Rust / Web Rust 或 WASM Worker                         | ✅                                                                                                                                                                                                  |
| Stanza parser facts                                            | `crates/syntax` via bounded `platform/syntax` adapter          | ✅ 全部现有内置语言；语言包 tags/folds 查询提供大纲和结构折叠，含 HTML/Markdown 嵌入语言                                                                                                            |
| App Server syntax RPC                                          | 按连接和模型保留解析文档                                       | ✅；相邻版本增量更新，提供视口高亮、括号和异步 facts                                                                                                                                                |
| Stanza Smart Select                                            | Stanza selection/history + `ash-syntax` on-demand scopes       | ✅ expand/shrink；revision-bound、可取消、stale-safe，parser 失败时 lexical fallback                                                                                                                |
| completion、type、definition/reference、rename                 | `ash-lsp` + language server，经编辑器 language feature 接入    | ✅ Code 主路径；语言覆盖由 provider collection 决定                                                                                                                                                 |
| workspace code chunk index                                     | `ash-codebase` 消费 `ash-syntax` declaration facts             | ✅ 本地 lexical retrieval；不是统一 semantic symbol graph                                                                                                                                           |
| workspace symbol/reference capability                          | `ash-lsp` + App Server language runtime                        | ✅ workspace symbols 与按需 references 已接通；持久化全局 semantic graph 仍属于可选 index 演进，不属于单个 editor document                                                                          |

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

| 能力                                             | `ash-syntax` | `CodeEditor` / Stanza                 | 产品宿主             | App Server                                                        | `ash-lsp`     |
| ------------------------------------------------ | ------------ | ------------------------------------- | -------------------- | ----------------------------------------------------------------- | ------------- |
| grammar、query、tree-sitter tree                 | ✅           | 组合/消费                             | ❌                   | ❌                                                                | ❌            |
| editor text、selection、language 与本地 revision | ❌           | ✅                                    | 选择初始资源与语言   | ❌                                                                | 消费同步      |
| syntax token、parse facts 与 selection scopes    | 计算         | ✅ 生命周期、selection history 与展示 | ❌                   | 按连接保留可释放的解析状态，投影有界结果                          | ❌            |
| theme color、DOM/native geometry、fold UI state  | ❌           | ✅                                    | 注入主题/布局        | ❌                                                                | ❌            |
| 文件 dirty/save/conflict                         | ❌           | ❌                                    | 组合 `ash-text-file` | 可提供独立文件 I/O capability                                     | ❌            |
| type、completion、definition/reference、rename   | ❌           | 交互入口                              | 协调                 | 可承载独立 LSP runtime                                            | ✅            |
| workspace 扫描、watch 与 symbol index            | ❌           | ❌                                    | 协调                 | ✅ 承载 LSP workspace symbols/references；持久化 graph 可独立演进 | 消费/提供事实 |

`ash-syntax` 仍保持独立 crate，因为 grammar、query、资源上限和增量 tree 算法需要可测试的领域
边界；Rust 编辑器内部组合它，Desktop Stanza 通过 App Server 的语法边界复用它。grammar/query 的资源归各语言扩展包所有。
tree-sitter 的输出是 concrete syntax facts，不是统一 AST，也不是 compiler/LSP semantic facts。

## Desktop Stanza

Stanza 对外暴露编辑器与 versioned language-provider contract。内置语言默认通过下文的共用后台语法树运行；旧 TextMate grammar 声明保留为兼容元数据，不再加载或启动分词器。`AppServerSyntaxProviders` 仅为未使用共享树的模型注册独立分析路径，避免为同一模型保留两份解析状态。TextModel 是文本、selection、undo/redo 和版本的唯一依据；后台结果通过 model-version gate 后应用。解析不参与同步编辑 transaction。

Smart Select 是一条按需路径：快捷键捕获当前 snapshot 与所有 selection，调用
`syntax/selectionRanges`，每个 selection 只沿 parser named ancestors 返回默认最多 64 层；普通
`syntax/analyze` 不序列化全树 selection nodes。结果只有在 request 未取消、model revision 与 selection
set 都仍一致时才应用。首次 caret expansion 仍选择 word，后续优先最小 parser scope，再回退到
pair、line 和 document；shrink 只使用 Editor-owned history。该离散 command 可以承受 App Server
round trip；任何进入连续 typing hot path 的未来 structural operation 必须迁到 editor worker/in-process
parser。

## 内置语言默认共用后台语法树

现有 18 个语言包全部使用 Tree-sitter；不再需要 `preferTreeSitter` 开关。
语言配置与 snippets 仍在各扩展中，对应 TextMate grammar 文件及注册已移除。
完整语言列表和资源维护命令见 [extensions](../extensions/README.md)。
语言包的 `tree-sitter/grammars.json` 是 Rust/Web 注册的唯一声明。生成器同时输出
Rust `SyntaxLanguage` 与 query 组合、协议 `SyntaxLanguageDto`、服务端映射，以及 Web 的
语言 ID/别名和 WASM/query 注册；正常准备构建时生成，`tree-sitter:verify` 检查生成物漂移。
Token 检查命令读取当前版本的后台 capture 缓存、主题作用域与实际语法样式，内嵌代码同时
显示其编辑器语言 ID；报告和无障碍视图共用同一份本地化文本。

Desktop 的 `TreeSitterLibraryService` 经 `platform/syntax` adapter 使用 App Server 里的
本机 Rust Tree-sitter。`syntax/openShared` 创建解析文档，后续 `syntax/update` 只传有版本的
UTF-16 编辑增量。`SyntaxDocument::update_edits` 更新同一棵树，不自动生成全文 token。
`syntax/query` 按视口取高亮/括号，或按版本缓存折叠、大纲与诊断；结构化选择沿用
`syntax/selectionRanges`。CPU 工作在 App Server 已有的 request worker 执行，不进入 renderer、
Electron Main 或异步网络执行器。所有文档操作按 connection + document ID 串行；
可取消查询携带 operation ID，`syntax/cancel` 经控制队列取消排队和正在执行的查询。

Web host 连接 App Server 时复用 Rust 语法服务；连接不可用时改用 Dedicated Worker 中的本地 WASM，恢复连接后再切回 Rust。每个模型只消费当前选定的后台会话。两种宿主读取各内置语言包 `extensions/*/queries/` 的同一份高亮规则，并支持 HTML 脚本/样式、Markdown 代码块/行内文本、Diff 代码、commit patch 和 rebase exec 的嵌套注入。注入保留全局坐标及编辑器语言 ID，括号和临时输入预览读取对应的内嵌树。TextModel 继续拥有文本、selection、history 与文件状态，后台只保存派生分析副本。
模型关闭发送 `syntax/close`，connection 关闭清理其文档。连接代次改变时旧会话明确失败，
不把旧增量重放到新连接；连接可用性变化时，仅重建派生语法会话，并以当前未保存文本作为完整快照，保留同一个 TextModel、版本、选择与撤销记录。
高亮、括号着色/引导线、折叠、大纲、语法诊断和结构化选择读取同一版本的树。
可见范围查询先返回；大纲、折叠与诊断共用按版本缓存的结构结果。主线程只保存捕获结果与
展示数据，不持有 parser 或语法树。高亮按需查询视口，滚动时再查询新范围；主题变化只重做
颜色映射。过期结果、取消和文档关闭在领域协议与模型边界处理。

使用共享树时，自动折叠跳过原有主线程语法/缩进全文扫描，App Server syntax provider 也跳过
该文档的旧分析路径；切换后释放旧的完整分析会话，共享模式只保留一份 Rust 树。显式选择 indentation 折叠策略仍使用已有策略。
LSP 的类型、补全、跨文件导航和语义高亮保持原有 owner。假设输入的着色使用临时树副本，
不改变共享文档树。

边栏、overview ruler、字体、行高及插入文字查询只读取相应的已注册装饰，不隐式生成全文
括号颜色。换行计算使用按版本缓存的逐行插入文字索引。这些公共改进由编辑器模型统一提供。

`editor.experimental.treeSitterTelemetry` 可记录 `ash.treeSitter.parse`、`.query`、`.facts`
performance measures，包含 Rust/Worker 执行位置、模型版本、增量复用与耗时，不含源码。
A/B 基线是 TextMate 高亮加现有 App Server Rust Tree-sitter 结构分析，不能解释为两种引擎
的纯算法比较。10 万行的同功能测试需保持文件不超过基线 4 MiB 上限，且 symbol/fold 数量
不超过基线结果上限，并验证结构结果没有截断。

Desktop 已使用编译后的 Rust parser；它仍经过 Ash 的进程协议与 TypeScript renderer，
不能当成 Zed 整个应用的跑分。
括号支持当前 grammar 的 `()`、`[]`、`{}`，不是任意用户自定义分隔符。结构查询复用解析器实际输入树上记录的 changed ranges，与显式编辑一起定位顶层子树区间，未变的 symbols/diagnostics/parser folds
按身份共享；UTF-16 坐标在子树新建时转换一次，后续相对子树原点平移。补丁直接从共享子树边界和
数量前缀生成，不再展开全部 symbols/diagnostics 后寻找差异。缩进与 region 只重读编辑行，分类不变
时复用折叠结果；分类变化时从前一个检查点扫描，状态汇合后保留后缀。换行仍更新受影响的折叠坐标，
折叠变化后合并有界列表；平面子树引用及数量索引仍需复制轻量条目。单个巨大顶层节点发生变化时仍查询整个该节点。错误语法的着色仍取决于 grammar/query；
当前 JavaScript grammar 对未闭合 `/*` 的处理与 TextMate 不完全相同。新增语言需提供内置
语法、完整 query 组合与增量/完整结果等价测试，TypeScript 必须包含 JavaScript 基础规则。

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

## Desktop 共享树的增量执行与传输

初次 `openShared` 完成后，renderer 在内容事件中立即提交 UTF-16 编辑和查询，不等待上一条
更新的确认；后端的 connection/document resource 统一保证操作顺序。更新失败或 connection
代次改变会让句柄失败，不在新连接重放旧文档；模型释放关闭自己的后台文档。取消只停止查询，
不会跳过已提交的文本更新。

视口扩大或滚动时，Rust 的可取消结构请求会给新视口的高亮让路，再通过原有的共享 promise
重试；符号、折叠和诊断的消费者仍收到完整的当前版本结果。WASM Worker 的同步遍历不能在
消息中途接收取消，因此不采用这项抢占。Rust 在取消时保留当前树上已完成的顶层子树分析；不可变结果保留对应的 Tree/Rope，
下次编辑在替换树前清理未完成版本的临时缓存，避免 node ID 回收后命中旧结果。
整份结构合并仍需完成；视口优先不代表免除结构分析工作。

视口括号查询跳过不含匿名子节点的顶层祖先，避免为一个屏幕枚举整份文件的声明。
回包坐标按 parser 已知的行位置计算 UTF-16 列，不再为了文件尾部的括号扫描从头到尾的文本。

共享结构查询使用固定坐标 tuple 与版本补丁。调用方带上最后实际接收的 facts revision 和
tab size；服务先移动该基线的坐标，再对有变化的 symbols/folds/diagnostics 列表发送局部 splice。
服务同时保留最新回包和已确认基线，取消旧回包后可继续沿已确认版本发送补丁；基线不可用时返回完整结果。积累超过 1024 次编辑会丢弃传输基线，下一次
按需返回完整结构；所有线上值仍经过从 Rust schema 生成的 decoder，包括 tuple 内的每个字段。
前端只缓存呈现需要的派生结果，文本、dirty 状态和 undo 继续由 TextModel 唯一拥有。

章节标题只扫描可见逻辑行所在的相邻搜索块，保留 MARK 多行表达式的全局块对齐；折叠隐藏的
大段文本不会因可见行跨度被扫描。相同文本版本与可见搜索窗口复用候选，token 变化只重新
判断候选是否属于注释，layout 不重复扫描文本。无换行且无注入文本时，行映射直接使用已有的惰性一对一映射，避免每次编辑为了构造空换行结果而读完全文。
这些主线程优化对 TextMate、WASM 和 Rust 均生效。

特殊 Unicode 行分隔符的初次检查流式读取文本快照；后续检查只读取本次插入文字和已有标记，
坐标由 TextModel 的装饰跟踪更新，不再在每次输入时逐行扫描全文。未带 resource/language
覆盖的配置读取按不可变的 base/workspace/policy 层身份复用合并结果，层变化时立即重新合并。

只改列而不改物理行的输入不重新整理折叠范围或隐藏行；相同的 provider 范围保留已有跟踪句柄、
手工范围和折叠状态。折叠模型仍保留完整的受限范围，侧边栏仅为可见标题创建装饰，滚动、布局、
折叠状态或显示选项变化时更新。物理行变化时重新对齐可见标题，避免在函数头末尾换行后，
装饰的跟踪起点移到函数体内。折叠快捷键和 sticky scroll 继续读取完整模型。

共享树 provider 按不可变 facts 复用符号转换，同版本消费者共享一次工作；单个调用取消不取消
其他消费者，编辑、模型关闭或服务释放使旧转换失效。符号转换和 OutlineModel 的顶层构建每
4096 项让出一次主线程，构建完成并通过版本检查后才发布，未变化的符号项可以复用展示对象。
这只拆分顶层批次，单个特别大的嵌套符号仍可能产生长任务；不能把本轮合成样本没有长任务
解释成所有文件、冷启动或所有机器都没有同步阻塞。

## 首次打开的公共主线程路径

普通 TextModel 直接保存稳定行 ID 和已校验的不可变 metadata，额外的行文档只在显式读取时
生成；ID 查询不隐式建立全文行对象。自定义 ID 和 metadata 仍在输入边界验证，文本、编辑和
undo 继续由 TextModel 拥有。长行策略用顺序文本偏移计算字符权重，避免逐行查询 Piece Tree。

LinkDetector 初次内置 URL 检测每 8192 行让出主线程；仅改列时只重扫变更行，物理行变化使
坐标缓存失效。结果仍经过取消、版本与释放检查，提供方结果保留优先级。默认颜色匹配按偏移
推进坐标，大批匹配/normalize 每 512 项让出；颜色块引起的无换行行映射只测量有插入文字的行。
颜色和链接原有防抖保留，整套完成的墙钟等待不等于主线程计算耗时。

Unicode worker 的首次请求由可释放调度器移到挂载之后；同步编辑合并为最新版本。警告扫描
只寻找候选字符，按需计算行号和混合脚本上下文，保留 CR/LF、UTF-16 坐标和取消语义。
worker 同步边界仍验证文本长度、行数和 EOL，行数计算使用 LF 查找。

生成的 App Server decoder 缓存不可变 schema 引用及数字数组校验规则，成功路径避免为每个
坐标分配递归错误路径；类型、安全整数/有限数、上下界、数组长度等约束保持完整，失败和
不支持的规则继续走通用校验。该优化不改变 wire schema，也不省略信任边界校验。

## Rust 解析文本的 Rope 存储

`ash-syntax` 用 Ropey 保存派生解析文本，解析器和查询 predicate 按 chunk 读取；每次编辑只在
共享节点的 Rope fork 上更新修改路径，不再复制完整 String 或平面行起点数组。Tree clone 与
Rope fork 一起提供原子提交，失败保留原 revision/text/tree。预览使用相同的增量 fork。

Desktop 的权威文本、文件状态和 undo 仍由 TextModel 拥有。App Server 从只读 RopeSlice 进行
UTF-16 边界转换，稀疏补丁使用树度量查询位置，完整大结果按字符流顺序映射；不为兼容旧接口
在每次编辑时重新拼接全文字符串。线上协议、默认共享树设置、Web WASM 路径与现有结果
上限保持一致。Rope 的行度量仅计 LF，CRLF/Unicode 字符的坐标语义不变。

共享树导出结构坐标时，零字节列直接对应零 UTF-16 列；其他列在对应行的 RopeSlice 上转换，避免先定位全局字节起点再从文档根重新查找。该路径不改变坐标语义、协议或结构事实。
