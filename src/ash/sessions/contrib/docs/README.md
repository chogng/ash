# Docs

Docs 持有 Sessions 的文档创建、打开、编辑器选择、HTML 写作块导入、格式导入导出、恢复状态与作品目录适配。文档按页面或连续正文排版，不使用无限画布、空间相机、指针绘图或矢量对象模型。

| 文件                                                           | 职责                                                           |
| -------------------------------------------------------------- | -------------------------------------------------------------- |
| [docs.contribution.ts](browser/docs.contribution.ts)           | 编辑器、配置、命令、文档工具视图及生成文档打开入口             |
| [docsEditorPane.ts](browser/docsEditorPane.ts)                 | Docs 的富文档正文、标题栏、保存、导出和格式工具                |
| [markdownDocsEditorPane.ts](browser/markdownDocsEditorPane.ts) | Docs 标题栏、作品操作和默认模式；借用共用 Markdown 窗格        |
| [docsEditorProfile.ts](browser/docsEditorProfile.ts)           | Docs 连续正文 profile 与 HTML 写作块导入                       |
| [documentActions.ts](browser/documentActions.ts)               | 创建、转换、文件 IO 和 `sessions.docs.activeDocument` 恢复状态 |
| [docsArtifactCatalog.ts](browser/docsArtifactCatalog.ts)       | 从文档和生成文件投影 Artifacts 卡片，不复制文档状态            |

Docs 命令使用 `sessions.docs.*`，恢复入口为 `sessions.restore.docs`。恢复时读取并迁移旧的 Artifacts 文档指针。作品标题栏和作品页布局属于 Artifacts 的共享呈现能力，Docs 通过公共契约消费。

Arkdown 的 Markdown 入口接续文档导出命令：Markdown 导出保留源码，纯文本导出读取正文投影；文件导出当前提供 `.md`。超过解析复杂度限制时保留原文并切换到可编辑源码，可缩减内容后返回正文视图。

富文档使用 Workbench 的 `DocumentEditorPane`、文档工作副本、保存及协作契约，并复用 Academy 包的通用富文本引擎。Docs 自己选择 `flowingText` 呈现并持有产品 profile；Academy 文档和频道笔记继续使用同一引擎。新建 Docs 和聊天写作块使用 `.md`，`MarkdownDocsEditorPane` 借用 [MarkdownEditorPane](../../../workbench/contrib/markdown/README.md)，默认显示可直接编辑的排版正文，可切换到共用 CodeEditor 的 Markdown 源码视图。IDE 的“Markdown document”入口使用同一窗格。现有 `.ash-doc` 继续使用结构化编辑器，不隐式往返转换。Markdown 的源码与历史由 `TextModel` 持有，`EditorWorkingCopy` 持有保存、dirty、外部变更和备份；Rust 只做当前源码的解析投影与编辑校验。共享引擎与文件服务不迁入 Sessions，避免 Workbench 反向依赖 Docs。

## 本机源码核对

核对日期：2026-11-13。

- VS Code：`extensions/markdown-language-features/src/preview/markdownEditorProvider.ts` 声明实验性的 hybrid/WYSIWYG `MarkdownEditorProvider`，通过 `CustomTextEditorProvider` 承载 `@vscode/markdown-editor`。`markdown-editor-src/editor.ts` 创建其模型、视图和控制器。包内 README 明确其混合呈现：非活动块显示渲染结果，活动块显示可编辑源码，因此不能直接等同于持续显示排版结果的富文本编辑器。`TextDocument` 保持唯一数据源，宿主接收增量文本修改并负责保存、dirty 状态和 undo/redo。
- 本机 ChatGPT/Codex 桌面包 `ChatGPT.app`（26.1106.51428）：`webview/assets/async/844065.cf19319287.js` 包含 Markdown 文件源码/渲染切换、草稿、保存错误和未保存变更回调；`739301.37a39f26d6.js`、`156997.9727518d80.js` 中可见 ProseMirror 文档和富文档编辑实现。包内这些事实不足以证明它使用 VS Code 的 Markdown 组件，也不能把所有编辑表面视为同一个编辑器。
- 本机 Claude Code 源树：`web/components/chat/MarkdownContent.tsx` 使用 `react-markdown` 和 `remark-gfm` 展示 Markdown；它不是 Docs 的直接编辑实现。
- 本机 `Claude.app`（5.11492.2）的主前端在 `Contents/Resources/ion-dist.asar`，与只包含部分 Artifact 资源的 `app.asar` 分开。主前端包含 Clarkdown 文档引擎、直接编辑组件和工作文档链路，详见下面的调用关系。不能从聊天输入框使用 Tiptap/ProseMirror 推断文档编辑器也使用同一引擎。

### Claude 文档链路

以下文件均为 `ion-dist.asar` 中的 `assets/v1/` 资源，名称对应上述安装版本。

| 文件                                             | 已确认的行为                                                                                                                                                                  |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared-6-Cb4RZD1A.js`                           | 工作文档目录、内容与 hash；识别 `.clark`、`.cd`，维护工作副本及导出格式。不能将工作文档统一视为普通 `.md` 文件。                                                              |
| `c86bf9d9f-COuYNoN4.js`、`c8e31bf58-COho4Kng.js` | 工作副本 HTML 导出和草稿展示，调用 `ClarkdownEditor.set_source()`、`render_html()`。                                                                                          |
| `c18f7ee13-C74vft_X.js`                          | 懒加载下面的编辑器组件与 WASM 绑定。                                                                                                                                          |
| `c4517f799-DhULzHGF.js`                          | 注册 `<clarkdown-editor>`；Shadow DOM 中使用正文滚动视图与 `contenteditable` 输入接收区。处理输入、中文组合输入、删除、格式及撤销重做，将视图位置映射为源码位置，再修改文档。 |
| `c2abd4ebb-suZcxVhm.js`                          | `ClarkdownEditor` 的 WASM 绑定，提供 `source`、`splice`、`apply_op`、`undo/redo`、`encode_update/apply_update`、`applyExternalTracked` 等接口。                               |
| `c35955a62-DsUXHNAG.wasm`                        | 引擎与编辑器版本均为 `0.1.872`；包含 Rust 构建路径、`pulldown-cmark` 与 `yrs` 依赖信息。                                                                                      |

已在本机离线加载上述 WASM，验证 Markdown 标题及粗体渲染、`splice` 修改、撤销恢复原文和编码更新。该组件是以源码位置驱动的可视文档编辑器，正文使用 DOM 流式排版，不依赖无限画布；它并非 VS Code 的 Markdown 组件。源码中仍有 `mode` 等呈现选项，本次未确认各 Docs 页面的实际默认模式。

核对范围：工作副本展示/导出至 Clarkdown 引擎的调用已确认，打包组件的直接编辑能力已确认；尚未追到 Docs 页面 iframe 内部挂载该组件的完整调用，因此不能把打包实现等同于所有账号、所有 Docs 入口的当前运行实现。

### Clarkdown 的 Rust 依赖证据

从 `c35955a62-DsUXHNAG.wasm` 保留的 Cargo registry 源文件路径确认下列依赖和版本。二进制 SHA-256 为 `be9e406c42334b8870488e7e765e2e9df890638700993c042712610349441db9`。这是已观察到的依赖子集，不是还原后的完整 Cargo.lock；无法仅凭路径区分直接和传递依赖，也不能确定全部启用的 features。表中的用途按各库公开接口归纳，不表示已经追踪到 Claude 的每一个调用点。

| 已观察到的依赖         | 版本      | 可复用的能力                                                |
| ---------------------- | --------- | ----------------------------------------------------------- |
| `pulldown-cmark`       | `0.13.4`  | CommonMark 解析、扩展语法和源码区间；不直接提供富文本编辑器 |
| `yrs`                  | `0.26.0`  | Yjs 兼容的 Rust CRDT、事务、更新编码及撤销能力              |
| `unicode-segmentation` | `1.13.3`  | 字素和单词边界，支持正确处理组合字符和 emoji                |
| `serde_json`           | `1.0.150` | JSON 序列化与解析                                           |
| `wasm-bindgen`         | `0.2.123` | Rust/WASM 与 JavaScript 的接口绑定                          |

同一二进制还可确认 `arc-swap 1.9.1`、`base64 0.22.1`、`console_error_panic_hook 0.1.7`、`event-listener 5.4.1`、`itoa 1.0.18`、`smallvec 1.15.2`。未观察到的依赖不能据此判为不存在。核心五项的公开发布元数据分别为 MIT 或 MIT/Apache-2.0 许可证；这些库的许可证不覆盖 Claude 自己的实现。

二进制还保留 `clarkdown-ir`、`clarkdown-syntax`、`clarkdown-editor`、`clarkdown-collab`、`clarkdown-import-html`、`clarkdown-export-html`、`clarkdown-theme`、`clarkdown-wasm` 的 Rust 源文件路径。其中存在 `incremental.rs`、`ops.rs`、`yrs_text.rs` 等文件。这些是引擎自身模块的证据，不能当作可安装的公开 crate。

公开接口参考：[pulldown-cmark 源码区间](https://docs.rs/pulldown-cmark/0.13.4/pulldown_cmark/struct.OffsetIter.html)、[Yrs](https://docs.rs/yrs/latest/yrs/)、[Unicode 分段](https://docs.rs/unicode-segmentation/latest/unicode_segmentation/)、[wasm-bindgen](https://rustwasm.github.io/docs/wasm-bindgen/)。Ash 已有 `pulldown-cmark 0.13.6` 和 `unicode-segmentation` 工作区依赖；自主实现应按 Ash 的兼容性选版本，不为复刻安装包而降级。

### Open Claude UI 与实现取舍

已核对 [Caho1/open-claude-ui](https://github.com/Caho1/open-claude-ui/tree/be395eb4b783cad3148fd9a4ef7641a3d198dd52) 的源码、依赖及导出入口。其自身代码采用 MIT 许可证，提供 UI 组件、动效和宿主桥接示例；`RichComposerWithMentions.tsx` 是聊天文本输入框。Clarkdown 出现在逆向分析文档的 API 描述中，仓库没有提供对应的编辑器实现或 WASM。仓库的 MIT 许可证不能作为 Claude 安装包内 Clarkdown 引擎的开源依据。

Docs 的实现方向是维护自己的产品层，复用开源依赖，逐步建立可同时用于 WASM 和原生宿主的 Rust 文档核心：

- Docs 持有连续正文体验、格式工具、目录和 Agent 文档操作；不使用空间画布。
- Rust 核心持有文档语义、源码位置映射、结构化编辑操作、事务和撤销语义；同一份实现编译为浏览器 WASM 和原生库。WASM 绑定与 App Server 适配器只处理边界，不各写一套语义。
- Workbench 的 Markdown 基座持有 Arkdown 的 DOM 呈现、选区、命中检测、剪贴板及 IME，源码输入复用 CodeEditor。现有 documentEditor 基座继续承载结构化富文档；Academy 和频道笔记消费其 profile。浏览器选区和排版不能通过把 parser 编译成 WASM 自动获得。
- 输入热路径优先在前端 WASM 执行，后端使用同一核心进行 Agent 编辑、校验和导入导出。纯后端执行也是可选路径，但每次编辑都需处理异步 RPC、版本、乱序与断线；在测量和验证这些行为前，不将它视为本地 WASM 的等价替换。
- 保存、工作副本、dirty、外部变更和恢复继续由 Workbench 持有。富文档保留结构化模型，Markdown 保留文本模型；不在每次编辑时通过 Markdown 导入导出往返同步，以免丢失格式或文档信息。同一个编辑会话的写入必须经过其模型或事务 owner，不能让 WASM 与原生副本分别覆盖状态。
- Ash 当前的 `ash-collab` 使用有序结构化文档事务、版本和重放契约，并非 Yrs。采用 `yrs` 需要单独设计格式、同步和历史迁移，不能直接把 CRDT 更新替换进现有事务字段。

Rust 核心命名为 [Arkdown](../../../../../crates/arkdown/README.md)，位于 `crates/arkdown`，Cargo 包名为 `ash-arkdown`。初版包含源码保留解析、UTF-8/UTF-16 区间、字素导航、带版本的文本事务、撤销重做、HTML 预览，以及原生与 WASM 绑定的一致性验证。Docs 的新建和聊天写作入口已连接 Arkdown WASM，支持正文直接编辑、加粗、斜体、源码切换、中文组合输入和共享撤销重做。常规构建准备及 Vite 负责从 Rust 源码生成浏览器绑定。当前使用完整解析，协作和 `.ash-doc` 适配尚未提供；现有结构化文档保存与协作契约继续由原 owner 持有。

若后续选择 VS Code 的混合 Markdown 体验，应让其使用现有 Markdown 文本工作副本，将编辑应用为文本变更，并复用保存、撤销、外部变更及只读语义。不能把渲染后的 HTML 当作 Markdown 文件的数据源，也不能仅凭两者都支持可视编辑就替换富文档引擎。
