# Arkdown

前端实现位于 [`browser/arkdown`](browser/arkdown)，由 Sessions Docs 持有。`ArkdownEditorPane` 承载 Markdown 文档，正文与源码通过同一个 Workbench `TextModel` 编辑，源码视图使用现有 `CodeEditorWidget`。Rust 核心位于 [`crates/arkdown`](../../../../../crates/arkdown/README.md)。其他 Markdown 场景见 [通用 Markdown](../../../workbench/contrib/markdown/README.md)。

| 文件                                                                                       | 职责                                                  |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| [`arkdown.contribution.ts`](browser/arkdown/arkdown.contribution.ts)                       | Docs 正文快捷键注册                                   |
| [`arkdownEditorPane.ts`](browser/arkdown/arkdownEditorPane.ts)                             | 借用 Workbench 文本工作副本，持有文档模式与无障碍接口 |
| [`arkdownRuntime.ts`](browser/arkdown/arkdownRuntime.ts)                                   | Rust/WASM 边界、只读语法投影及 `CollabBuffer` 适配    |
| [`arkdownCollabProfile.ts`](browser/arkdown/arkdownCollabProfile.ts)                       | Markdown 房间的版本化载荷、编码与大小限制             |
| [`arkdownEditor.ts`](browser/arkdown/arkdownEditor.ts)                                     | 正文 DOM、选区、输入及共用 CodeEditor 源码视图        |
| [`BufferCollabSession`](../../../workbench/services/collab/browser/bufferCollabSession.ts) | 通用缓冲区房间连接、重试、确认与增量同步              |

`EditorWorkingCopy` 与文本模型持有保存、dirty、外部变更和本地撤销历史。协作期间，`TextModel` 通过有作用域的编辑参与者将操作与选择性历史交给 Yrs；源码视图、正文、其他编辑器和保存仍使用同一缓冲区。离开房间时解除参与者并清除跨会话历史。Arkdown 的语法树是投影，不保留第二份可写文档。Sessions 的 `ArkdownDocsEditorPane` 持有 Docs 标题栏、作品操作及默认模式，借用本目录的编辑器，不再创建自己的工作副本。

通用 Markdown 预览、数学渲染和图片粘贴位于 [`contrib/markdown`](../../../workbench/contrib/markdown/README.md)。Chat 消息正文由 [`ChatMarkdownContentPart`](../../../workbench/contrib/chat/browser/widget/chatContentParts/chatMarkdownContentPart.ts) 进行流式 Markdown 渲染。旧 `.ash-doc` 经过格式校验后单向迁移为 Markdown，原文件保留。

Clarkdown 的对齐以直接编辑行为为依据。正文使用区块窗口增量解析，引用与 HTML 保守完整解析，DOM 只替换变化区块。标题／段落和列表转换已接快捷键，表格支持 Tab 导航与末尾加行。Rust/WASM CRDT 会话已接入 Workbench 房间。安装包取证记录见 [Docs](README.md#clarkdown-功能复核)。

工具栏“Collaborate”创建或加入房间，空服务器地址使用当前 App Server；远端服务器沿用现有 URL 和访问令牌入口。“Copy room ID”复制标识，“Leave collaboration”停止同步并保留当前文件。加入内容不同的房间前确认替换；只读成员无法修改缓冲区。保存仍写入本地文件。

`arkdown-markdown-v1` 载荷为版本化 Base64 Yjs v1 更新，与结构化文档的 Schema 隔离。客户端用状态向量发送差量，按房间版本处理冲突和快照；响应丢失后保留原客户端序号及原请求重试。断线保留编辑，恢复后刷新并合并。服务端从旧状态和更新计算权威快照，不信任客户端提交的最终文本。

本地 App Server 房间在进程内共享，远端 SQLite 房间跨重启持久化并执行成员权限。房间 JSON 快照上限 4 MiB，单次事务上限 1 MiB；本地编辑与撤销先预检编码大小，超限拒绝且不改变正文或历史。历史每 256 次操作或 16 MiB 建立检查点，回收窗口外删除内容并保留 CRDT 身份。此入口不创建远端服务器，也不将 Markdown 文件绑定为频道结构化笔记。

协作服务契约位于 `workbench/services/collab/common/collabService.ts`，通过 `ICollabService` 注入。Rust `Buffer` 和 WASM `ArkdownBuffer` 持有文本操作与选择性历史；`Document` 继续用于独立文档编辑接口。房间 DTO 使用 `RoomSnapshot`、`RoomUpdate` 等名称，网络方法和持久化表名保持兼容。

`IBufferCollabService` 按 `TextModel` 持有会话与工作副本，多个视图复用同一会话，切换或关闭标签页后继续同步，离开房间或关闭窗口时释放。`arkdownRuntime.ts` 将 WASM 缓冲区适配到共享 `CollabBuffer` 契约，`arkdownCollabProfile.ts` 持有编码和限额预检。快照上限为 4 MiB，事务上限为 1 MiB，编码与解码使用相同限额。空闲时每 15 秒只读取版本元数据，发现缺口或重连时交换完整状态。永久拒绝停止自动重试，离线按退避重连，新房间 epoch 用于区分重建后的确认状态。

Docs 贡献加载 `arkdown.contribution.ts` 的正文快捷键，通过 `DOCS_ARKDOWN_EDITOR_ID` 注册 `ArkdownDocsEditorPane`。持久化编辑器 ID 为 `sessions.editor.docs.markdown`。Docs 入口通过 `artifactDetailEntry.workspaceMode` 进入 Chat。Markdown 语言标识、MIME 和协作载荷表达文件格式与协议。
