# `ash-markdown`

> 本 README 是 Native Markdown 解析、布局和 presentation 的 crate-level canonical
> contract。跨 crate 的 Rust Workspace 边界见
> [`docs/ash-rs-architecture.md`](../../docs/ash-rs-architecture.md)；底层 scene、富文本和字体
> shaping contract 见 [`ash-ui-components`](../ui-components/README.md)。

`ash-markdown` 把有资源上限的 CommonMark/GFM 输入解析为只读文档 snapshot，并通过
`ash-ui-components` primitive 生成 Native Markdown 组件。它拥有 Markdown 结构、脚注与数学片段投影、
`syntect` 代码高亮、RaTeX 数学排版、安全链接策略、图片解码/布局、文字命中/选择/搜索几何、
复制文本投影、accessibility 语义树、滚动 snapshot 消费和主题 token；不拥有消息 identity、网络取图、
平台 URL opener/clipboard、输入事件分发、持久化或产品生命周期。

## 所有权与接口

| Symbol | 可见性 | 精确职责 |
| --- | --- | --- |
| `MarkdownDocument::parse` | public | 在 4 MiB 输入、100,000 blocks 和 64 层嵌套上限内建立不可变文档 snapshot |
| `MarkdownError` | public | 区分输入过大、嵌套过深和 block 数超限 |
| `MarkdownLayoutEngine` | public | 保留可复用 font shaping state，把文档、bounds、`ScrollState` 和 style 投影为一帧 `Markdown` |
| `MarkdownPresentation` | public | 绑定 caller-retained selection、search matches 与已授权解码的图片 snapshot |
| `Markdown` / `MarkdownLink` | public | 保存当前帧可见 primitive、文本命中/选择几何、语义树和 viewport-clipped link hit fragments |
| `MarkdownLinkPolicy` | public | 解析 document fragment 或绝对 URL，拒绝 credentials/未知 scheme，并只产出策略允许的 `MarkdownLinkTarget` |
| `MarkdownImages` / `decode_markdown_image` | public | 接收 host 已授权取得的 bytes，在 16,777,216 pixel 上限内解码为 `zui::ui::ImageData`；不执行 I/O |
| `MarkdownSyntaxHighlighter` / `SyntectMarkdownHighlighter` | public | 定义 fenced-code byte-range 高亮 contract，并提供 bundled syntax/theme 实现 |
| `render_markdown_math` / `MarkdownMathMode` | public | 在 64 KiB source 和 4,194,304 pixel 上限内把 inline/display LaTeX 排版并栅格化为 `ImageData` |
| `MarkdownSelectionController` / `MarkdownDocument::text_for_selection` | public | 保存 pointer selection anchor/focus，并把合法范围投影为可写入 clipboard 的文本 |
| `MarkdownDocument::search` | public | 在 copyable block text 上执行大小写敏感或 Unicode lowercase literal search |
| `MarkdownSemanticNode` | public | 暴露 document/block/link/table-row/cell 的 role、label、level、destination 和 viewport bounds |
| `MarkdownStyle` | public | 提供正文、标题、链接、代码、引用、列表和表格的 presentation token 与 geometry |
| `document::DocumentBuilder` | private | 消费 `pulldown-cmark` event，维护 inline format、quote/list/table nesting 和当前 block |
| `table::TableBuilder` | private | 把 table event 序列组装成保留 row/cell 边界的单个 `MarkdownTable` block |
| `document::push_run` | private | 合并相邻同样式 run，避免解析事件制造无意义的 span 碎片 |
| `inline_layout::layout_inline` | private | 调用 `TextLayoutEngine::layout_spans`，从同一次 shaping 取得 span fragments，并生成 code/link/strikethrough decoration |
| `document_text` | private | 规范化 block plain text、selection copy 与 literal search range；不得读取 scene geometry |
| `component_interaction` | private | 用同一次 shaping 的 UTF-8 cluster geometry 完成 point hit、selection/search fragments 和链接策略入口 |
| `component_paint` | private | 生成 rect/image/text primitive，并构造与当前 viewport geometry 一致的语义节点 |
| `math::MarkdownMathCache` | private | 按 source、mode、颜色和字号缓存 RaTeX 结果；失败项缓存为空并由布局回退为可见 source |
| `table_layout::layout_table` | private | 从全部 cell 的 intrinsic width 计算列宽，再按列宽 wrapping cell，并保存 row height |
| `component::ProjectedBlock` | private | 保存 shaping 后的单个 text/code/table/rule block 高度与宽度 |
| `Markdown::emit` | private | 把自然文档坐标减去有效 viewport offset，剔除不可见 block 并生成 scene primitive |

```text
MarkdownDocument::parse
└─ pulldown_cmark::Parser
   └─ DocumentBuilder::consume
      ├─ inline format/link stack
      ├─ quote/list context
      ├─ TableBuilder → MarkdownTable rows/cells
      └─ MarkdownBlock

MarkdownLayoutEngine::layout
├─ MarkdownBlock + MarkdownStyle
├─ zui::ui::TextLayoutEngine
│  └─ TextLayout size + per-span/per-UTF-8-cluster wrapped/BiDi visual fragments
├─ SyntectMarkdownHighlighter → fenced-code TextSpan colors
├─ MarkdownMathCache → RaTeX parse/layout/SVG → bounded RGBA ImageData
├─ MarkdownPresentation → selection/search/image snapshots
├─ layout_inline → inline backgrounds/decorations/link hit fragments
├─ layout_table → intrinsic column sizing → wrapped cell layout
├─ content_height + clamped ash_ui_components::ScrollState
└─ Markdown::emit
   ├─ PaintRect: code/table/quote/rule/inline/selection/search decoration
   ├─ PaintImage: decoded RGBA image + inline/display typeset math
   ├─ MarkdownLink: viewport-clipped hit fragments
   ├─ MarkdownSemanticNode: document/block/link/table structure
   └─ TextBlock/TextSpan: wrapped rich text and highlighted code

Markdown::paint
├─ zui Element(Markdown viewport bounds) → automatic inspection
└─ UiScene::with_clip(viewport bounds)
```

`MarkdownLayoutEngine` 必须由 host 复用；每次 document、bounds、style 或 scroll snapshot 变化时重新
生成 immutable `Markdown`。`Markdown` 不保存 parser 或 font system，也不接受输入事件。
`ash_ui_components::ScrollState` 是 product-owned retained state，组件只消费其 snapshot；wheel normalization、
scrollbar 和 input routing 继续复用 `ash-ui-components` 的通用 scroll contract。

## 解析、信任与显示语义

解析启用 CommonMark、GFM block quote、table、strikethrough、task-list、footnote 和 math 扩展。Soft break
折叠为空格，hard break 保留换行；fenced code 的 info string 作为语言标签显示。表格保留
row/cell 边界，先以所有 cell 的 intrinsic width 分配整表列宽，再在各列内部独立换行；header
使用独立背景和粗体，网格线只绘制一次。

Markdown 输入是不可信文本：

- raw/inline HTML 只作为可见字符串保留，不解释 DOM、脚本、attribute 或 URL；
- 图片 reference 可由 host 授权取得 bytes 后交给 `decode_markdown_image`；未加载时显示 alt
  placeholder，解析和 layout 不发起网络、文件或 data-URL I/O；
- inline/display math 由 pure-Rust RaTeX 解析、排版并栅格化；非法或超限表达式保留为可见
  source，不中断其余文档布局；
- link destination 进入 `MarkdownLink` 的同源命中 geometry；只有
  `MarkdownLinkPolicy::evaluate` 成功产生的 external `MarkdownLinkTarget` 才能交给 host
  opener；document fragment 通过 `Markdown::fragment_bounds` 路由到同一帧 heading/footnote geometry；
- `text_for_selection` 只返回文本，真正写入系统 clipboard 仍由 platform host 执行；
- crate 没有文件、网络、WebView、shell 或 platform clipboard 依赖，因此 parse/layout 不能触发外部副作用。

host 从 pointer event 调用 `Markdown::activate_link_at`，不能把 parser destination 直接交给
shell。图片 loader 必须先应用 product policy，再把取得的 bytes 解码并按 destination 放进
`MarkdownImages`。同一个 `ImageId` 在 renderer cache 生命周期内必须始终指向同一份 immutable pixels。

## 测试、修改影响与限制

```bash
cargo test --manifest-path Cargo.toml -p ash-markdown
cargo clippy --manifest-path Cargo.toml -p ash-markdown --all-targets -- -D warnings
bazel test //app-rs/markdown:markdown-unit-tests
```

测试覆盖 block/inline parsing、脚注与 math event、RaTeX inline/display scene projection 和非法公式
回退、列表与任务 marker、引用 nesting、代码高亮、
表格 header/body、raw HTML、输入上限、安全 URL/fragment policy、图片有界解码与 inline/block
scene projection、Unicode search、selection/copy/hit geometry、语义 heading/table/link 节点、
段落换行和 viewport clamp。修改 parser option 或 `DocumentBuilder` 时必须同步检查资源上限、
HTML/image 信任边界和 block fixtures；修改 `ProjectedBlock`/spacing 时必须同步检查 content
height、offscreen culling 与 scroll clamp；修改 rich span/selection contract 时必须同步检查
`zui::ui::TextLayout` UTF-8 cluster geometry、renderer validation 和 [`ash-ui-components`](../ui-components/README.md)。

当前仍不拥有平台 URL 打开、clipboard 写入、网络/文件取图和 pointer/keyboard 事件路由；
这些副作用由 `app` 或其他 host 绑定现有 policy/input service。尚未支持 Markdown source
内声明的 table alignment、block-level retained cache，也尚未提供把 `MarkdownSemanticNode`
自动写入特定平台 accessibility API 的 adapter。
