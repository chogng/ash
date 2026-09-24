# `ash-diff`

> 本 README 是共享代码差异数据层的 crate-level canonical contract。`ash-editor` 与 TUI
> 只消费这里的行映射、字符范围和 hunk，不在各自 presentation 中重新实现匹配算法。Editor
> presentation 的 canonical contract 见 [`app-rs/editor/README.md`](../../app-rs/editor/README.md)。

`ash-diff` 计算原始文本和修改后文本之间可复现、可取消且有资源上限的代码差异。它拥有精确
换行符解析、Myers 最短编辑路径、替换配对、Unicode 字素级内联范围、Git 风格 hunk header、
比较策略和输入验证；不拥有文件读取、Git 进程、语法高亮、编辑器光标、终端渲染或 UI 生命周期。

## 所有权与接口

| Symbol | 可见性 | 精确职责 |
| --- | --- | --- |
| `DiffEngine` | public | 冻结一次 diff 的策略；提供 text/bytes 与 cancellable/non-cancellable 入口 |
| `DiffDocument::from_text` | public | 用默认三行上下文、精确比较和默认 limits 构建映射 |
| `DiffDocument::with_options` | public | 以显式 `DiffOptions` 构建映射 |
| `DiffOptions` | public | 组合 context、whitespace、case、line-ending、inline 与 limits policy |
| `DiffLimits` | public | 限制每侧 bytes/lines、最大 edit distance 和 Myers trace cells |
| `DiffCancellation` / `NeverCancel` | public | 由 host 提供低成本取消探针；crate 不拥有 timer 或 task lifecycle |
| `DiffLine` / `LineEnding` | public | 保留一基行号、line text 和 LF/CRLF/CR/EOF terminator |
| `DiffRow` / `DiffRowKind` | public | 表达 Context、Added、Removed、Modified 及两侧行 correspondence |
| `InlineChange` | public | 用 UTF-8 byte range 表达 grapheme-boundary 内联变化 |
| `DiffHunk` | public | 表达 Git-style old/new start/count 与 document row 半开范围 |
| `engine::split_lines` | private | 单次扫描 UTF-8，保留精确 line ending 并观察 cancellation |
| `myers::edits` | private | 在 edit-distance/trace limits 内计算最短行或 grapheme 编辑路径 |
| `engine::map_rows` | private | 把编辑路径配对为稳定行映射，并为 Modified 行计算 inline ranges |
| `engine::group_hunks` | private | 根据 context 合并相邻变化并生成 Git-style header |

```text
DiffEngine::compute[_bytes][_cancellable]
├─ input bytes / UTF-8 / NUL / byte-limit validation
├─ split_lines → exact LineEnding
├─ comparison_keys
│  └─ whitespace / case / line-ending policy
├─ myers::edits
│  └─ cancellation + edit-distance + trace-memory checkpoints
├─ map_rows
│  └─ inline::changes → grapheme Myers → UTF-8 byte ranges
└─ group_hunks → DiffDocument
```

## 精确语义

- 行号从 1 开始；Git-style hunk 的 empty side 在文件开头可以使用 start `0`。
- `Added` 没有 original line，`Removed` 没有 modified line；`Modified` 是同一连续 change run
  中按顺序配对的删除/新增行，不表示语法级语义修改。
- `LineEndingPolicy::Sensitive` 是默认值，因此 LF、CRLF、CR 与缺少末尾换行会参与匹配；
  `Ignore` 只改变 equality，不丢弃 `DiffLine` 保存的真实 ending。
- `WhitespacePolicy` 和 `CaseSensitivity` 只改变匹配 key；`DiffRow` 始终保留原始两侧文本。
- `InlineChange` 的 range 使用 UTF-8 byte offset，边界保证落在 Unicode grapheme boundary；
  insertion/deletion 的缺失侧使用 empty range。
- `DiffHunk::row_start..row_end` 只能通过同一个 `DiffDocument::rows_for_hunk` 读取。

## 失败、资源与接入义务

`DiffEngine` 在分行、comparison-key 构建、line Myers 和 inline Myers 中观察
`DiffCancellation`。Host 应提供 cheap、thread-safe 且在单次计算中单调的实现。默认 limits
限制每侧 8 MiB、200,000 行、20,000 edit distance 和 8,000,000 trace cells；达到边界返回
`InputTooLarge`、`TooManyLines`、`EditDistanceLimit` 或 `TraceLimit`，不能继续分配到 OOM。

bytes API 拒绝 NUL、无效 UTF-8，并分别返回 `BinaryInput`、`InvalidUtf8`。本 crate 不猜测编码、
不读取磁盘，也不调用 Git：

- `ash-editor` 用 `DiffDocument` 驱动 side-by-side DiffEditor，`app` 只负责宿主接入；
- `ash-tui` 用同一 document 驱动 Ratatui 行渲染、左右导航和折叠；
- `ash-git` 继续拥有 Git patch check/apply、仓库进程和路径解析；
- `ash-ui` 继续拥有 TabList、文字和矩形 primitive，不依赖本 crate。

## 测试、修改影响与限制

```bash
cargo test --manifest-path Cargo.toml -p ash-diff
cargo clippy --manifest-path Cargo.toml -p ash-diff --all-targets -- -D warnings
```

测试覆盖精确 line ending、缺失 final newline、空白/大小写策略、Unicode Emoji 字素范围、
Git-style fixture/header、纯插入/删除 anchor、NUL/UTF-8/byte limit、取消、complexity limit 和
两侧文本重建。`myers_tests` 穷举长度 0–5 的 binary sequences，对照独立动态规划 reference，
验证编辑脚本有序、可重建且 edit distance 最短。

修改 `DiffRow` 或 hunk header 必须同步检查 `ash-editor`/TUI projection；修改 comparison key 必须保持
source text/ending 不丢失；修改 Myers trace 必须保留取消和 memory bound；修改 inline range
必须继续使用 UTF-8 grapheme boundary。

当前仍不拥有语法 token、移动代码检测、二进制 diff、非 UTF-8 解码、增量复用或 file watcher。
这些能力出现第二个真实消费者和独立 contract 后再扩展；不能让 Native/TUI presentation
反向决定共享 diff 语义。
