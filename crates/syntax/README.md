# `ash-syntax`

> 本 README 拥有 `ash-syntax` 当前 public/private interface、执行路径、失败语义与修改影响。
> 跨 Desktop、Native、EditorHost 和 LSP 的语言分析边界由
> [`docs/syntax-analysis.md`](../../docs/syntax-analysis.md) 拥有。

`ash-syntax` 对宿主提供有界、增量、与 presentation 无关的源码结构分析。当前实现支持
JavaScript/JSX、TypeScript/TSX、Rust、JSON/JSONC、Shell、Python、Go、HTML、CSS/SCSS/Less、
INI/Properties、Markdown、SQL、TOML、XML/DTD/XSL、YAML、Diff、Git commit/rebase/ignore 与 Starlark/bazelrc，使用 tree-sitter 保存每个打开文档的
增量 parse tree，并为精确 host revision 派生 syntax tokens、folding ranges、document symbols、parse
diagnostics，以及按需的 structural selection scopes。它不读取文件、不监听 workspace、
不持久化索引、不启动语言服务器，也不依赖 legacy editor runtime、`ash-editor`、Native paint types 或 App
Server DTO。

## 所有权与公共接口

源码语言身份与文件关联由 `ash-language` 拥有；`SyntaxLanguage::for_language` 从共享
`LanguageId` 选择本 crate 支持的解析器。没有解析器的语言仍保留原身份，不能降为纯文本身份。

| API / type                         | 当前职责                                                                                                         | 明确不做                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `SyntaxDocument`                   | 保存一个打开文档的 Rope、parser、tree、revision 与 limits                                                        | 文件加载、保存、dirty state、并发调度             |
| `SyntaxLanguage`                   | 选择 crate 内已注册且经过测试的 grammar/query 组合                                                               | 接受任意 native grammar pointer 或用户 query      |
| `DocumentRevision`                 | 绑定宿主权威文本和派生 snapshot；更新时必须单调增加                                                              | 充当磁盘 revision、Git identity 或全局 sequence   |
| `SyntaxEdit`                       | 以当前文档的 UTF-8 byte range 表达 replace/insert/delete；`apply_edits` 原子接收同一旧 revision 上的非重叠 batch | 接受编辑器 UTF-16 position 或猜测编码             |
| `SyntaxSnapshot`                   | 返回同一 revision 的 tokens、folds、symbols 与 diagnostics                                                       | 暴露 `tree_sitter::Tree`、`Node` 或跨语言统一 AST |
| `SyntaxDocument::selection_ranges` | 按一个 exact UTF-8 byte range 返回有界、innermost-first named parser scopes                                      | 把整棵 tree 放进普通 snapshot 或声称 semantic AST |
| `AnalysisLimits`                   | 限制文档和派生 collection 的资源使用                                                                             | 限制宿主队列、IPC message 或 workspace 文件数     |
| `SyntaxTokenKind`                  | 提供不含主题颜色的语言中立 highlight category                                                                    | 决定主题、foreground 或 decoration layer          |
| `DocumentSymbol`                   | 表达 tree-sitter tags query 发现的语法声明                                                                       | 类型解析、跨文件 reference、rename 或 completion  |

`SyntaxPoint.column` 和 `SyntaxRange.bytes` 都使用 UTF-8 byte offset。Desktop Stanza adapter 必须显式在
UTF-16 position 与该 contract 之间转换；Native host 可以直接使用 byte range，但仍必须
拒绝不匹配当前 EditorHost revision 的 snapshot。

## 内部接口与执行路径

| private symbol                | 精确职责                                                                   | 不能承担                                        |
| ----------------------------- | -------------------------------------------------------------------------- | ----------------------------------------------- |
| `LanguageConfiguration::load` | 把 `SyntaxLanguage` 绑定到 grammar、highlights、tags 和 folds query        | product language detection 或动态安装 grammar   |
| Rope 的行与字符度量           | 把 byte offset 转换为 tree-sitter row/byte-column，并定位 UTF-16 code unit | Unicode display column 或 LSP position encoding |
| `collect_tokens`              | 运行 grammar highlight query、映射稳定 category 并应用结果上限             | 主题选择或编辑器 provider registration          |
| `collect_folding_ranges`      | 运行语言包 folds query，派生多行结构范围                                   | UI 折叠状态                                     |
| `collect_selection_ranges`    | 只沿 requested selection 的 named ancestor chain 收集 scopes               | 全树遍历、selection history 或 edit application |
| `collect_symbols`             | 从 tags query 的 `definition.*` 与 `name` capture 构造声明                 | workspace index lifecycle                       |
| `collect_diagnostics`         | 收集 error/missing node，并应用结果上限                                    | compiler diagnostics 或 quick fix               |

```text
SyntaxDocument::open / open_with_limits
  → validate_document_size
  → LanguageConfiguration::load
  → Rope::from_str（仅 LF 划分物理行）
  → Parser::parse_with_options（按块读取）

SyntaxDocument::apply_edit / apply_edits
  → revision / range / UTF-8 boundary / size validation
  → Rope 行/字节/字符度量
  → Tree::edit on a cheap tree clone
  → 在共享节点的 Rope fork 上 remove/insert
  → Parser::parse_with_options with the edited previous tree
  → commit Rope + tree + revision
  → SyntaxDocument::snapshot

SyntaxDocument::snapshot
  ├─ collect_tokens
  ├─ collect_folding_ranges
  ├─ collect_symbols
  └─ collect_diagnostics

SyntaxDocument::selection_ranges(exact byte range)
  → range / UTF-8 boundary validation
  → named_descendant_for_byte_range
  → bounded ancestor walk（默认最多 64 层）
```

编辑校验发生在文本修改之前。解析使用已应用 edit 的旧 tree clone；如果 tree-sitter 取消解析，
丢弃未提交的 Rope/tree fork，权威文本、revision/tree 保持不变。解析成功仍可包含可恢复的语法错误，这些
错误作为 diagnostics 返回，不会导致整次操作失败。

grammar query 可能为父节点提供通用分类，并为子节点提供更具体分类，因此 highlight capture
可以重叠。range 顺序是确定的；consumer 应让较晚、较窄的 capture 覆盖较早 capture。各结果
collection 达到对应 `AnalysisLimits` 后停止收集，不会把仍可使用的部分 snapshot 变成错误。
即使 `max_diagnostics` 把 diagnostics 截断为零，`SyntaxSnapshot::has_errors` 仍保留准确事实。

## 测试、修改影响与当前限制

```bash
just verify ash-syntax
bazel test //crates/syntax:syntax-unit-tests
```

`src/syntax_tests.rs` 同时使用 `test/fixtures/tree-sitter/languages.json` 验证全部语言，覆盖 HTML/Markdown/Diff 注入、内嵌语言标识、括号和预览；并覆盖 Rust token/fold/symbol projection、JSON/JSONC token/fold/comment、Shell
command/operator/comment token、ECMAScript grammar、单行和多行增量编辑、revision binding、UTF-8
boundary、selection scope ordering、更新后的 Rope 行坐标、跨块 UTF-8/UTF-16、共享快照、resource limits，以及失败不修改文档。

新增 grammar 时必须同时增加 `SyntaxLanguage`、`LanguageConfiguration::load` 的 grammar/query
绑定、capture mapping 测试和语言 fixture。修改 edit coordinate contract 时必须同步检查所有
host adapter；修改 symbol category 时必须同步检查未来 workspace index schema。若 crate 开始
读取 workspace、保存数据库、选择主题或处理 LSP request，说明 ownership 已经漂移。

当前限制：

- Current：注册全部现有内置语言包的 grammar/query；资源与来源说明位于对应 `extensions/*/queries/`，Rust grammar 由本 crate 编译组合，Web 使用对应包内的 WASM。JSON 与 JSONC
  共用上游 comment-capable JSON parser，syntax snapshot 不代替 language server 的严格格式校验；
- Current：单个 edit 和同一旧 revision 上的非重叠 batch 都使用 UTF-8 byte range；宿主负责事件 coalescing；
- Current：文本由 Ropey 共享节点的 Rope 保存，普通编辑与预览只复制修改路径，不复制全文或平面行索引；parser 和 query predicate 都按块读取，符号名及跨块的单行展示需要时才构造字符串；`text()` 返回借用的只读 RopeSlice，显式转成 String 会遍历全文；
- Current：snapshot 派生为同步调用；异步 worker、debounce 与 cancellation 由产品宿主负责；
- Current：App Server 使用 connection/model-owned open/change/close session 将内置语言的完整
  analysis snapshot 投影为 UTF-16 wire DTO；共享编辑模式按视口返回 capture、内嵌语言 ID 和括号，其余 facts 按版本缓存；
- Current：App Server 的 `syntax/selectionRanges` 只为离散命令按当前 selection 返回有限 scopes；普通
  `syntax/analyze` 不携带全树 selection nodes，Stanza Smart Select 负责 revision/cancellation/stale gate；
- Current：Native `ash-editor` 已私有组合 incremental analysis 与 folding；Stanza folding/document-symbol
  provider 已接入，具体 outline presentation 仍由产品 UI 决定；
- Current：`ash-codebase` 已作为独立 consumer 持久化 verified declaration facts；磁盘/dirty
  arbitration 由 `ash-codebase` overlay 拥有，不进入本 crate；
- Potential：继续增加按需 structural operations；mutation 仍由 Editor 生成 undo transaction 并验证
  revision，本 crate 不拥有 editor history。

## 共用后台树的按需查询

Desktop 共享模式调用 `update_edits` 更新树而不计算整份 snapshot。`editor_highlight` 只查询
视口并返回 UTF-16 行捕获，`editor_brackets` 返回视口及祖先括号，`editor_facts` 从同一树
用解析器实际使用的 edited Tree 记录 changed ranges，与显式编辑范围一起定位顶层子树区间，
仅对这些区间重做查询；不再独立编辑另一份旧树后重复做整树比较。
多光标编辑保留彼此独立的区间，中间未变子树直接复用，即使 parser 重新分配了它们的 node ID。不可变
`EditorFacts` 共享未变子树；每个子树仅在新建时把范围转换成相对原点的 UTF-16 坐标。
`EditorFacts::delta` 依据子树复用区间与事实数量前缀直接生成局部 splice，不重建整份
`SyntaxSnapshot`，也不复制、平移和比较整份已确认结果。单行压缩代码的边界按 UTF-16 列定位。
保留对应的 Tree/Rope，确保共享 node identity 与坐标在旧版本仍可读取；取消后已完成的
子树查询可以继续复用，新的编辑会先清理未完成版本的临时缓存。

缩进与 region 只重新分类编辑行；分类未变化时直接复用折叠结果。分类变化时从各编辑区间的前一个
检查点扫描，状态与旧检查点汇合后跳过未变间隔、保留后缀。换行会平移受影响的折叠和检查点坐标；tab size
改变需要重新分类全文。检查点限制栈深，避免深层 region 嵌套造成缓存内存平方增长。
子树引用与数量索引仍是平面序列，更新时复制轻量条目；折叠范围变化时仍会重新合并有界
折叠列表。编辑单个巨大顶层节点仍需重新查询该节点，跨越全文的缩进或 region 变化也可能
传播到 EOF。`editor_preview` 使用共享节点的 Rope/tree fork，保留持久树。
编辑器查询规则由对应 `extensions/*/queries/` 拥有；语言包的 `tree-sitter/grammars.json`
声明 highlights、tags、folds 和 injections，注册表连接语言 ID 与 Rust 查询配置。Desktop 和 Web 通过共享语法服务使用相同查询。`*.folds.scm` 使用
`@fold` 捕获结构节点，单行范围被忽略，结束于下一行行首的节点不折叠该行；同起始行优先使用
结构范围，再补缩进和 region。`*.tags.scm` 使用 `@definition.*` 与 `@name` 提供语法大纲。
HTML/Markdown 等嵌入语言的编辑器折叠和大纲复用高亮的 included-range parser，坐标保持在宿主文档中。
Git rebase、ignore、Bazelrc 等逐行格式提供大纲，不制造没有结构意义的折叠。
本 crate 编译时嵌入查询，并由 Cargo 依赖静态链接 grammar。

## Rope 坐标与原子更新

Ropey 只启用 SIMD，不启用 unicode_lines/cr_lines，保持与 Tree-sitter 一致的 LF 行号；CRLF 中
CR 仍占 UTF-8/UTF-16 列，单独 CR 和 Unicode 分隔符不增加物理行。UTF-16 输入先用 Rope 度量定位
字符，再检查 round-trip，拒绝 surrogate pair 中间位置，不把向下取整的字符索引当作合法输入。
解析回调允许 Tree-sitter 从 UTF-8 字符内部请求原始字节，查询捕获的文本提供方可跨多个 chunk。

编辑范围仍针对同一个旧版本并降序处理；文本和 Tree 都先创建共享 fork，只有解析成功后才提交
revision 与结构缓存变更。预览也使用独立 Rope/tree fork，通过同一增量编辑流程生成临时结果，
不改变文档 revision、文本或 facts 缓存。Rope 代替平面行索引，避免每次编辑复制全部行起点。

后端结构处理的手动性能夹具可运行：

```sh
just test ash-app-server --lib shared_facts_latency_probe -- --ignored --nocapture
```

它在相同 profile 下分别测打开、连续改名和换行的 parse/update 与 facts 请求，覆盖 1 千、
1 万、10 万行级文件的头部、中部、末尾，并检查局部补丁大小。该测试不包含窗口绘制或 IPC；
10 万行回归另外断言局部编辑不遍历全文，Unicode/CRLF、取消、跳过版本、tab size 与结果限额
由确定性测试验证。
