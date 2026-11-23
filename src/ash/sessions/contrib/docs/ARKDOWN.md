# Arkdown

前端实现由 Workbench 的 [Markdown 贡献](../../../workbench/contrib/markdown/README.md) 持有。Chat Docs 与 Code 的可视化 Markdown 视图共用该组件。`ArkdownEditorPane` 承载 Markdown 文档，正文与源码通过同一个 Workbench `TextModel` 编辑，源码视图使用现有 `CodeEditorWidget`。Rust 核心位于 [`crates/arkdown`](../../../../../crates/arkdown/README.md)。其他 Markdown 场景见 [通用 Markdown](../../../workbench/contrib/markdown/README.md)。

| 文件                                                                                                         | 职责                                                  |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| [`arkdown.contribution.ts`](../../../workbench/contrib/markdown/browser/arkdown/arkdown.contribution.ts)     | 共享正文快捷键注册                                    |
| [`arkdownEditorPane.ts`](../../../workbench/contrib/markdown/browser/arkdown/arkdownEditorPane.ts)           | 借用 Workbench 文本工作副本，持有文档模式与无障碍接口 |
| [`arkdownRuntime.ts`](../../../workbench/contrib/markdown/browser/arkdown/arkdownRuntime.ts)                 | Rust/WASM 边界、只读语法投影及 `CollabBuffer` 适配    |
| [`arkdownCollabProfile.ts`](../../../workbench/contrib/markdown/browser/arkdown/arkdownCollabProfile.ts)     | Markdown 房间的版本化载荷、编码与大小限制             |
| [`arkdownEditor.ts`](../../../workbench/contrib/markdown/browser/arkdown/arkdownEditor.ts)                   | 正文 DOM、选区、输入及共用 CodeEditor 源码视图        |
| [`arkdownTableController.ts`](../../../workbench/contrib/markdown/browser/arkdown/arkdownTableController.ts) | 表格选区、把手、菜单和拖动预览；通过编辑器提交事务    |
| [`BufferCollabSession`](../../../workbench/services/collab/browser/bufferCollabSession.ts)                   | 通用缓冲区房间连接、重试、确认与增量同步              |

`EditorWorkingCopy` 与文本模型持有保存、dirty、外部变更和本地撤销历史。协作期间，`TextModel` 通过有作用域的编辑参与者将操作与选择性历史交给 Yrs；源码视图、正文、其他编辑器和保存仍使用同一缓冲区。离开房间时解除参与者并清除跨会话历史。Arkdown 的语法树是投影，不保留第二份可写文档。Sessions 的 `DocsEditorPane` 持有 Docs 标题栏、作品操作及默认模式，借用 Workbench 的编辑器，不再创建自己的工作副本。

通用 Markdown 预览、数学渲染和图片粘贴位于 [`contrib/markdown`](../../../workbench/contrib/markdown/README.md)。Chat 消息正文由 [`ChatMarkdownContentPart`](../../../workbench/contrib/chat/browser/widget/chatContentParts/chatMarkdownContentPart.ts) 进行流式 Markdown 渲染。Docs 导入直接生成 Markdown，不依赖 Academy 的结构化模型，也不迁移旧 `.ash-doc`。

Clarkdown 的对齐以直接编辑行为为依据。正文使用区块窗口增量解析，引用与 HTML 保守完整解析，DOM 只替换变化区块。标题／段落和列表转换已接快捷键，表格编辑通过 Rust 结构操作提交。Rust/WASM CRDT 会话已接入 Workbench 房间。安装包取证记录见 [Docs](README.md#clarkdown-功能复核)。

表格的单元格内容和列对齐仍使用 GFM。列宽、表头开关、合并跨度及单元格底色由表格后紧邻的 `<!-- ash-table {JSON} -->` 注释保存；Rust 验证完整布局后将其折叠进对应表格的投影范围，未知字段、非法尺寸、重叠跨度或无效颜色保留为原始文本。列宽为 0（自动）或 48–4000 像素，底色限定为 gray、red、orange、yellow、green、blue、purple。合并后的覆盖单元格仍保留源坐标，DOM 只显示所属合并格。行列操作、粘贴和布局变更作为单次 TextModel 事务提交。整表移动保留源码及布局注释，通过 Rust 校验后的删除和插入编辑在同一事务中提交。所有变更共用保存、撤销和协作链路；控制器仅持有当前选区及拖动预览。HTML 导出恢复布局，纯文本导出不包含布局注释。

单元格内的正文、标题、列表和清单使用闭集结构标签 `<p>`、`<h1>`–`<h6>`、`<ul>`、`<ol>`、`<li>` 保存在同一行 GFM 单元格源码中。仅单元格上下文将这些精确标签投影为结构节点，含属性或未知 HTML 仍为惰性文本。任务项在 `<li>` 内以 `[ ] `／`[x] ` 保存勾选状态。`set_cell_block` 操作同时覆盖实格、缺格和矩形选区，`offset` 可定位单格内的当前块；操作仍由 Rust 提议并经同一 TextModel 保存和撤销。格内回车拆分列表项或段落，空列表项回车返回正文，标题后回车创建正文。HTML 导出保留这些结构。

Docs 的下划线、高亮和文字颜色保存在 Markdown 源码中的成对行内 `<u>`、`<mark>`、`<span data-text-color="…">` 标签中。颜色值限定为 red、yellow、green、teal、purple，呈现随主题变化。Rust 只识别这些精确标签，其他 HTML 仍为惰性文本；部分选区清除格式时拆分原标记，保留其他格式与源码语法。列表缩进操作由 Rust 生成文本编辑，经同一 TextModel 事务保存和撤销。

Docs 文档排版由同一个 Markdown 工作副本持有。文件开头的单个 `ash-typography` 围栏保存标题与正文的 `serif`／`sans` 选择；未设置时均沿用无衬线字体。有效记录在正文与纯文本导出中隐藏，Markdown 保留记录，DOCX 与 PDF 应用对应字体。修改共用保存、撤销和协作链路，不写入 Profile 设置；其他位置、未知字段或无效记录作为普通代码显示。底部“排版”修改整份文档，选区“文字样式”修改标题级别。

Docs 评论由同一个 Markdown 工作副本持有。UUID 形式的 `<span data-comment-id="…">` 锚定正文，各次创建、回复、编辑、解决和删除作为独立的版本化 `ash-comments` 围栏记录追加；线程按逻辑时钟及事件 UUID 确定顺序，删除保留墓碑。选区锚点只插入行内标记，不重写段落；锚点与事件在一个 TextModel 事务中提交。并发回复通过现有文本 CRDT 合并，不互相替换共享 JSON 数组。评论侧栏和正文只读取投影，不另存线程状态。删除引用文字后保留原始摘录和线程。

有效评论记录在正文和纯文本导出中隐藏，Markdown 源码及导出保留评论历史。未知版本、无效 UUID、冲突事件或超过 4096 条事件／1048576 个 UTF-16 单元的元数据不启用评论编辑，原记录作为代码显示。单条评论最多 8000 个 UTF-16 单元。正文代码块不支持行内锚点，可使用文档评论。作者使用 Profile 范围的本机标识区分「自己」与「协作者」，不推断真人姓名；未发表的草稿仅由当前视图持有。只读文档可阅读线程。

工具栏“Collaborate”创建或加入房间，空服务器地址使用当前 App Server；远端服务器沿用现有 URL 和访问令牌入口。“Copy room ID”复制标识，“Leave collaboration”停止同步并保留当前文件。加入内容不同的房间前确认替换；只读成员无法修改缓冲区。保存仍写入本地文件。

`arkdown-markdown-v1` 载荷为版本化 Base64 Yjs v1 更新，与结构化文档的 Schema 隔离。客户端用状态向量发送差量，按房间版本处理冲突和快照；响应丢失后保留原客户端序号及原请求重试。断线保留编辑，恢复后刷新并合并。服务端从旧状态和更新计算权威快照，不信任客户端提交的最终文本。

本地 App Server 房间在进程内共享，远端 SQLite 房间跨重启持久化并执行成员权限。房间 JSON 快照上限 4 MiB，单次事务上限 1 MiB；本地编辑与撤销先预检编码大小，超限拒绝且不改变正文或历史。历史每 256 次操作或 16 MiB 建立检查点，回收窗口外删除内容并保留 CRDT 身份。此入口不创建远端服务器，也不将 Markdown 文件绑定为频道结构化笔记。

协作服务契约位于 `workbench/services/collab/common/collabService.ts`，通过 `ICollabService` 注入。Rust `Buffer` 和 WASM `ArkdownBuffer` 持有文本操作与选择性历史；`Document` 继续用于独立文档编辑接口。房间 DTO 使用 `RoomSnapshot`、`RoomUpdate` 等名称，网络方法和持久化表名保持兼容。

`IBufferCollabService` 按 `TextModel` 持有会话与工作副本，多个视图复用同一会话，切换或关闭标签页后继续同步，离开房间或关闭窗口时释放。`arkdownRuntime.ts` 将 WASM 缓冲区适配到共享 `CollabBuffer` 契约，`arkdownCollabProfile.ts` 持有编码和限额预检。快照上限为 4 MiB，事务上限为 1 MiB，编码与解码使用相同限额。空闲时每 15 秒只读取版本元数据，发现缺口或重连时交换完整状态。永久拒绝停止自动重试，离线按退避重连，新房间 epoch 用于区分重建后的确认状态。

Arkdown 编辑窗格加载正文快捷键。Docs 通过 `DOCS_ARKDOWN_EDITOR_ID` 注册 `DocsEditorPane`。持久化编辑器 ID 为 `sessions.editor.docs.markdown`。Docs 入口通过 `artifactDetailEntry.workspaceMode` 进入 Chat。Markdown 语言标识、MIME 和协作载荷表达文件格式与协议。
