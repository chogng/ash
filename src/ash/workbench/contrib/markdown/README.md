# Markdown

`MarkdownEditorPane` 是 IDE 和 Sessions Docs 共用的 Markdown 文件编辑器。普通 `.md` 文件默认使用 Text Editor；“Reopen With…” 中的“Markdown document”打开 Arkdown 正文视图。正文与源码通过同一个 `TextModel` 编辑，源码视图使用现有 `CodeEditorWidget`。

| 文件                       | 职责                                                 |
| -------------------------- | ---------------------------------------------------- |
| `markdown.contribution.ts` | 可选编辑器注册、富文本快捷键与现有 Markdown 贡献     |
| `markdownEditorPane.ts`    | 文本工作副本、文件生命周期、模式操作与宿主无障碍契约 |
| `arkdown.ts`               | Rust/WASM 边界及只读语法投影                         |
| `arkdownEditor.ts`         | 正文 DOM、选区、输入及共用 CodeEditor 源码视图       |

`EditorWorkingCopy` 与文本模型继续持有保存、dirty、外部变更和撤销历史。Arkdown 的语法树是投影，不保留第二份可写文档。Sessions 的 `MarkdownDocsEditorPane` 持有 Docs 标题栏、作品操作及默认模式，借用本目录的编辑器，不再创建自己的工作副本。

`MarkdownPreview`、聊天和悬浮提示的只读渲染有各自的资源及安全边界，继续由原 owner 持有。原有 `.ash-doc` 结构化文档不经过 Markdown 往返转换。

Clarkdown 的对齐以直接编辑行为为依据：源码保真、选区、中文输入、剪贴板、结构操作、历史与外部更新分别验证。当前 Arkdown 仍使用完整解析；列表、表格等结构命令和协作尚未达到 Clarkdown 的对应能力。安装包取证记录见 [Docs](../../../sessions/contrib/docs/README.md#claude-文档链路)。
