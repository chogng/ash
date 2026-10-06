# `ash-syntax`

> 本 README 拥有 `ash-syntax` 当前 public/private interface、执行路径、失败语义与修改影响。
> 跨 Desktop、Native、EditorHost 和 LSP 的语言分析边界由
> [`docs/syntax-analysis.md`](../../docs/syntax-analysis.md) 拥有。

`ash-syntax` 对宿主提供有界、增量、与 presentation 无关的源码结构分析。当前实现支持
JavaScript/JSX、TypeScript/TSX、Rust、JSON、JSONC 和 Shell，使用 tree-sitter 保存每个打开文档的
增量 parse tree，并为精确 host revision 派生 syntax tokens、folding ranges、document symbols、parse
diagnostics，以及按需的 structural selection scopes。它不读取文件、不监听 workspace、
不持久化索引、不启动语言服务器，也不依赖 legacy editor runtime、`ash-editor`、Native paint types 或 App
Server DTO。

## 所有权与公共接口

| API / type                         | 当前职责                                                                                                         | 明确不做                                          |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `SyntaxDocument`                   | 保存一个打开文档的 text、line index、parser、tree、revision 与 limits                                            | 文件加载、保存、dirty state、并发调度             |
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

| private symbol                | 精确职责                                                             | 不能承担                                        |
| ----------------------------- | -------------------------------------------------------------------- | ----------------------------------------------- |
| `LanguageConfiguration::load` | 把 `SyntaxLanguage` 绑定到 grammar、highlights query 和 tags query   | product language detection 或动态安装 grammar   |
| `LineIndex`                   | 以增量 line starts 把 byte offset 转换为 tree-sitter row/byte-column | Unicode display column 或 LSP position encoding |
| `collect_tokens`              | 运行 grammar highlight query、映射稳定 category 并应用结果上限       | 主题选择或编辑器 provider registration          |
| `collect_folding_ranges`      | 从已解析 tree 的明确容器节点派生多行范围                             | UI 折叠状态                                     |
| `collect_selection_ranges`    | 只沿 requested selection 的 named ancestor chain 收集 scopes         | 全树遍历、selection history 或 edit application |
| `collect_symbols`             | 从 tags query 的 `definition.*` 与 `name` capture 构造声明           | workspace index lifecycle                       |
| `collect_diagnostics`         | 收集 error/missing node，并应用结果上限                              | compiler diagnostics 或 quick fix               |

```text
SyntaxDocument::open / open_with_limits
  → validate_document_size
  → LanguageConfiguration::load
  → Parser::parse
  → LineIndex::new

SyntaxDocument::apply_edit / apply_edits
  → revision / range / UTF-8 boundary / size validation
  → LineIndex::point
  → Tree::edit on a cheap tree clone
  → String::replace_range
  → Parser::parse with the edited previous tree
  → commit tree + line index + revision
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
实现会恢复被替换文本，权威 revision/tree 保持不变。解析成功仍可包含可恢复的语法错误，这些
错误作为 diagnostics 返回，不会导致整次操作失败。

grammar query 可能为父节点提供通用分类，并为子节点提供更具体分类，因此 highlight capture
可以重叠。range 顺序是确定的；consumer 应让较晚、较窄的 capture 覆盖较早 capture。各结果
collection 达到对应 `AnalysisLimits` 后停止收集，不会把仍可使用的部分 snapshot 变成错误。
即使 `max_diagnostics` 把 diagnostics 截断为零，`SyntaxSnapshot::has_errors` 仍保留准确事实。

## 测试、修改影响与当前限制

```bash
cargo test --manifest-path Cargo.toml -p ash-syntax
cargo clippy --manifest-path Cargo.toml -p ash-syntax --all-targets -- -D warnings
bazel test //ash-rs/syntax:syntax-unit-tests
```

`src/syntax_tests.rs` 覆盖 Rust token/fold/symbol projection、JSON/JSONC token/fold/comment、Shell
command/operator/comment token、ECMAScript grammar、单行和多行增量编辑、revision binding、UTF-8
boundary、selection scope ordering、更新后的 line index、resource limits，以及失败不修改文档。

新增 grammar 时必须同时增加 `SyntaxLanguage`、`LanguageConfiguration::load` 的 grammar/query
绑定、capture mapping 测试和语言 fixture。修改 edit coordinate contract 时必须同步检查所有
host adapter；修改 symbol category 时必须同步检查未来 workspace index schema。若 crate 开始
读取 workspace、保存数据库、选择主题或处理 LSP request，说明 ownership 已经漂移。

当前限制：

- Current：注册 JavaScript/JSX、TypeScript/TSX、Rust、Shell grammar，以及由独立私有语言模块选择的 JSON/JSONC grammar；JSON 与 JSONC
  共用上游 comment-capable JSON parser，syntax snapshot 不代替 language server 的严格格式校验；
- Current：单个 edit 和同一旧 revision 上的非重叠 batch 都使用 UTF-8 byte range；宿主负责事件 coalescing；
- Current：文本保存在 `String`，中间插入需要移动后续 bytes；超大文档的 rope/chunked input 尚未实现；
- Current：snapshot 派生为同步调用；异步 worker、debounce 与 cancellation 由产品宿主负责；
- Current：App Server 使用 connection/model-owned open/change/close session 将 Rust、JSON 与 JSONC 的完整
  analysis snapshot 投影为 UTF-16 wire DTO；Stanza 消费 token、parse diagnostic、symbol 与 folding；
- Current：App Server 的 `syntax/selectionRanges` 只为离散命令按当前 selection 返回有限 scopes；普通
  `syntax/analyze` 不携带全树 selection nodes，Stanza Smart Select 负责 revision/cancellation/stale gate；
- Current：Native `ash-editor` 已私有组合 incremental analysis 与 folding；Stanza folding/document-symbol
  provider 已接入，具体 outline presentation 仍由产品 UI 决定；
- Current：`ash-codebase` 已作为独立 consumer 持久化 verified declaration facts；磁盘/dirty
  arbitration 由 `ash-codebase` overlay 拥有，不进入本 crate；
- Potential：继续增加按需 structural operations；mutation 仍由 Editor 生成 undo transaction 并验证
  revision，本 crate 不拥有 editor history。
