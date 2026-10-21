# Stanza：单一文本内核、可装配能力与产品边界

> 本文说明 editor、文档扩展、Workbench、文件服务与 App Server 之间的系统边界。目录与装配入口见 [`src/ash/editor/README.md`](../src/ash/editor/README.md)，行式编辑与富文档的机制契约分别见 [`text-engine.md`](../src/ash/editor/text-engine.md) 和 [`document-engine.md`](../src/ash/editor/document-engine.md)。当前工作见[根 TODO](../TODO.md#stanza-编辑器--todo)，演进依赖见[编辑器设计](design/editor-roadmap.md)。

## 核心模型与产品装配

Stanza 是 Ash 的编辑器内核。每个打开文档在一个 Renderer realm 中只有一个权威 `TextModel`，同步拥有文本、版本、事务、快照与编辑历史。内容遵循 `TextModel → LineSequence → ModelLine`；字符由模型持有的 `ITextBuffer` 保存，PieceTree 是当前私有实现。

Code 使用行式文本能力。Academy 的 `DocumentTextModel` 扩展同一个核心模型，通过通用 snapshot/version 边界提交结构事务；mark、atom、facet、region 与 relation 承载富文档语义。资源服务、后台语法树和视图都不能成为第二个可写正文或编辑历史。

| 场景                                             | 装配入口                                              | 所有权                                                                                       |
| ------------------------------------------------ | ----------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 基础文本宿主                                     | `editor.all.ts`                                       | 仅装配基础文本命令                                                                           |
| 客户端 Code                                      | `editor.code.all.ts` + `workbench/contrib/codeEditor` | 客户端装配模型分析、通用编辑功能和 Widget；Workbench 注册 text/diff Pane，另行装配 MultiDiff |
| Standalone                                       | `editor.main.ts` / `editor.api.ts`                    | 独立宿主服务、公开 `editor` 与 `languages` API；文件持久化由调用方提供                       |
| Agent Window 的普通文档、Academic 论文与频道笔记 | 独立 `ash.academic` 扩展 + 共享客户端编辑器桥         | Academy 提供 Schema、结构事务、视图、分页和 codec；Workbench 提供资源与工作副本生命周期      |

`editor.api.ts` 包含浏览器宿主 API，不能作为 DOM-free 入口使用。无 DOM 的调用方应直接消费 `editor/common` 中所需的领域契约。

Academy 的客户端模块与样式绑定精确包版本和摘要，通过公共 SDK／Host RPC 接入共享宿主。产品包不内置 Academy 实现；安装、执行授权、版本准入和撤权遵循[扩展架构](editor-extensions.md)与[包契约](../extensions/academic/README.md)。停用会移除新路由并冻结已有视图，保留工作副本与未保存内容；重新启用后由显式重开获取替代能力。

独立 [Reference Manager](../extensions/reference-manager/README.md) 拥有 RIS 与 `.ash-library` 文献库，经带文档版本和 Pane／Provider 生命周期的调用句柄向 Academy 提交引用操作；正文、事务和历史仍归 Academy。PDF 渲染与批注归可选 [PDF Viewer](../extensions/pdf-viewer/README.md)，Chat 附件通过通用资源编辑器注册表取得只读预览。

### 产品范围与实施顺序

Stanza 的基础编辑能力优先：文本、事务、撤销／重做、选区、输入法、视图几何及模型生命周期先按各自契约闭合，文件与工作副本链由共享宿主验证。Academy 的 Schema、排版和研究工作流由插件侧载入，不成为基础编辑或 Code 启动的前置条件。

产品目标明确区分 Code IDE 与 Agent Window：IDE 专用于代码；Academy 只在 Agent Window 中提供富文档与论文工作流。`workbench` 中可复用的编辑器桥、模型引用、文件和工作副本服务仍是共享基础设施，宿主范围由产品装配决定，不在 Stanza 内核判断窗口类型。

Academy 的独立 Activity Bar 图标和工作界面仍是入口候选；若采用，Sessions 消费插件已注册的能力，并复用现有侧栏、EditorPart 与对话宿主。该候选不代表入口已经实现，也不要求新建窗口布局或另一份文档／会话状态。旧 IDE 文档接线的收敛及宿主范围验收仍待实施，目标与现状见 [Agent Window 文档工作区设计](design/work-code-workbench.md)，具体动作见[根 TODO](../TODO.md#work--通用文档--todo)。

## 所有权与依赖方向

依赖遵循 `Sessions → Workbench → Editor → Platform → Base`，同时保持 `common` 与 `browser` 的运行环境边界。`base` 不得反向引用编辑器；位置、版本、selection、语言请求和文档身份留在 editor 领域。

| 所有者                              | 责任                                                                                                      | 边界                                             |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| `editor/common`                     | 文本、坐标、事务、history、tracked range、每实例 cursor／selection、纯 ViewModel 与布局，以及语言服务契约 | 不依赖 DOM、Workbench、Electron 或 generated DTO |
| `editor/browser`                    | Widget、DOM 输入、行投影、ViewPart、命中测试、渲染协调和编辑器控件                                        | 不决定文件持久化、产品 Pane 或工作区策略         |
| `editor/contrib`                    | 可移除的 Code 功能、命令、controller、请求和投影                                                          | 不注册 Workbench Pane，不建立第二套模型          |
| Academy 扩展                        | 富文档 Schema、结构命令、历史语义、视图、样式、协作与 codec                                               | 通过核心模型提交；不把包实现导入客户端 Code      |
| Workbench Editor Part／Group／Pane  | 标签、组、窗口、Pane 选择、引用、显隐、关闭与视图状态                                                     | 不实现文本事务或 Widget 内部行为                 |
| Workbench 模型与 working-copy 服务  | 按资源共享模型、dirty、保存、revert、冲突、备份与恢复                                                     | 视图借用引用，文件传输不缓存 live model          |
| `ITextFileService` / `IFileService` | 文本解码与编码请求、文件传输、条件写入、取消和变更通知                                                    | 不拥有 selection、undo 或审核基线                |
| 语言与语法 adapter                  | 将扩展、Worker、Rust／LSP 能力注册到 editor contract                                                      | 后台只持有分析镜像，结果按模型与版本应用         |

事件、生命周期、取消和通用几何优先复用 `base`；scroll clamp、可见行、overscan、editor ARIA 和语言 lane 等领域语义不能下沉。TypeScript 服务通过所属宿主的实例化容器构造并注册，窗口与实例的释放责任随作用域确定。

## 资源打开、保存与恢复

```text
Explorer / 命令 / 资源 opener
        ↓ resource + 打开选项
EditorPart → Pane registry → 选定 Pane
        ↓ acquire
共享模型服务 → 已有模型引用，或 ITextFileService.resolve → IFileService
        ↓
TextModel ← 同步编辑事务 → 每实例 ViewModel / Widget
        ↓ 保存队列
保存参与者 → 文本、EOL、编码与修订快照
        ↓
ITextFileService.save → IFileService → App Server 条件写入
        ↓ 成功回执
更新保存基线；保存期间的后续编辑继续保持 dirty
```

`IEditorPart.openEditor` 是产品调用面，`IEditorPaneRegistry` 拥有 Pane 声明与选择。调用方提交资源与打开选项，不预读文件或伪造 `initialText`；`preferredEditorId` 只显式选择已注册资源视图。App Server 不决定最终 Pane，也不持有 Renderer 的 live model。

Code 的 `BrowserTextModelService` 按资源共享模型引用；已有模型优先于磁盘内容。普通文本、Diff 与其他消费者释放各自引用，不销毁其他视图仍持有的模型。富文档资源由共享文档模型服务持有包模型与工作副本；具体格式语义由扩展提供。

### 文件格式与持久化

`ITextFileService.resolve` 在读取前检查大小，并委托文件 Provider 解码。Rust 文件系统 codec 处理 BOM、严格 UTF-8、UTF-16 与显式选择的传统编码；自动猜测受客户端设置与候选列表约束。无法解码或识别为二进制的内容进入有界只读 Binary Pane，可经编码入口重新打开。

所选编码及其保存基线属于模型服务，EOL 属于文本模型。编码变化可以使工作副本 dirty，保存队列同时捕获文本与编码；编码失败拒绝发布，不替换不可表示字符。重载和 revert 使用持久化编码，保存保留 BOM 与模型 EOL。完整编码与检测契约见 [Text file service](../src/ash/workbench/services/textfile/README.md)。

Code Action 保存参与者由 `codeEditor/browser/saveParticipants.ts` 注册，在模型保存队列中执行，完成后才取写入快照。`editor.codeActionsOnSave` 的 `explicit` 对应手动保存，`always` 也处理焦点或窗口切换；延迟自动保存不执行代码操作。当前文件由外层队列写入，WorkspaceEdit 对其他关闭文件的写入跳过保存参与者。查询期间的模型变化使旧结果失效；失败保留 dirty。另存为使用目标文件模型的同一保存链。

文件写入使用 expected-revision／CAS 与原子发布。`IFileService` 将 App Server `fs/changed` 转成失效通知，经 TextFile 服务交给模型服务；Code 的后台检查跳过 dirty 模型，干净模型可重载，保存被磁盘修订拒绝时报告冲突。干净重载保留既有撤销历史，显式 revert 清空被丢弃的历史。

Electron 本地文件的 OS 权限保存失败可显式重试管理员保存：同一保存队列重新取得快照，经 `IElevatedFileService` 转到 Rust 授权与原子发布，跳过已完成的保存参与者。授权期间的编辑保持 dirty；提交前取消保留原文件，提交后仅用真实写入回执更新基线。结果不明时保留 dirty。目录授权拒绝与配置只读策略不能通过 OS 提权绕过；Web 不提供此能力。

### 工作副本与生命周期

`IWorkingCopyService` 索引格式对应的工作副本，不拥有第二份模型。备份与恢复由 workspace-scoped working-copy 服务承担，视图关闭、切换或后台断连不能丢失未保存内容。

文本模型的维护调度与编辑事务分开：浏览器文件模型可在 idle 阶段压实 PieceTree，关闭模型时取消任务；压实不改变版本、事件或 history，已捕获快照继续可读。大文件策略在模型创建时固定，限制全量 tokenization、同步及派生语言功能，保留基础编辑、滚动、查找与保存；阈值由模型实现维护。

## 语言、配置与异步结果

Standalone 的 `languages` API 与 Workbench adapter 汇入同一组 editor 服务；Workbench 不经公开 API 转发。每个宿主作用域内分别维护以下事实：

| 服务                           | 拥有                                               |
| ------------------------------ | -------------------------------------------------- |
| `LanguageService`              | 语言身份、文件关联与资源识别                       |
| `LanguageConfigurationService` | 注释、括号、缩进、Enter 与语言编辑规则             |
| `LanguageFeaturesService`      | 补全、Hover、格式化、诊断等 Provider registry      |
| 平台配置 registry 与配置服务   | Schema、默认覆盖、用户／工作区设置及语言级配置解析 |

扩展贡献随装载、更新与撤销进入这些 owner；产品不维护第二份 MIME、后缀或语言配置表。模型、Widget 和扩展消费所属窗口的同一组服务；Standalone 的独立作用域由自己的宿主负责。

每个 contribution 拥有请求取消、session 与控件释放。异步请求绑定模型身份、版本和 request identity，同 lane 的旧请求被新请求替代；模型变化、调用取消、Worker 重启与释放均使对应旧结果失效。Worker 返回值经协议边界验证后，仍须经过同步 application gate 才能进入结果状态，不能直接修改模型。

Worker 文档镜像使用快照与版本化增量同步。增量结果的基线必须由 Renderer 实际应用确认，丢弃的结果不能成为下一次基线。token、diagnostic 和 completion 的状态与投影由对应 owner 管理，不能用 tracked range 将过期分析伪装成新版本结果，也不能把 Worker 传输增量等同于端到端零复制。

格式化的提供者选择归 Workbench，语言级 `editor.defaultFormatter` 由配置服务解析；编辑器的格式化贡献拥有输入触发、取消与编辑应用。Inlay 通过 decoration 的 injected text 进入行几何，不写入正文或历史。Snippet 插入、嵌套合并与撤销由 Snippet contribution 和同一文本事务链负责。

### 语法会话与主题样式

基础高亮、预览、大纲、折叠、结构选择与假设编辑共用模型的 Tree-sitter 会话。Desktop 使用 Rust／Rope；Web 在连接可用时使用 Rust，断线时使用本地 Tree-sitter Worker。grammar 与 query 随语言资源提供，模型 tokenization 与结构请求共享会话，Semantic Tokens 独立叠加。

模型获取等待 `TokenizationTextModelPart.whenReady` 时，就绪状态属于 `TextModel`。首个请求期间更换语言或 Provider，等待应转到当前后端；当前后端失败、调用取消或模型释放仍向调用方返回错误。旧后端完成不能表示当前模型就绪，输入热路径也不能等待后台分析。

活动主题由 `IThemeService` 唯一持有。Tree-sitter capture 的首段表示 token 类型，其余段表示修饰信息；样式经活动 `IColorTheme.getTokenStyleMetadata` 取得，嵌入语言使用自身 language ID。内置、用户与扩展主题共用 `semanticTokenColors`，不建立第二份高亮主题模型。旧 TextMate grammar 声明只保留 manifest 校验，不加载语法文件或启动 TextMate runtime。

## 视图、输入与 Workbench 宿主

每个 Widget 拥有自己的 `CursorsController`、selection、composition、ViewModel 和投影生命周期，共享文档仍只有一个 `TextModel`。换行、折叠、View Zone、滚动和命中使用同一组 editor 坐标；Pane 只提供外部尺寸、显隐与资源引用。

`View` 持有输入 controller 及 EditContext／Textarea 生命周期，并通过统一 command／transaction 提交编辑。IME 的 provisional revision 在提交前受保护，取消不能污染 history；浏览器适配器保留组合结束数据，空完成也会回滚该 revision 并恢复原选区，不依赖输入法是否透传 Escape。Textarea 保留原生上下文供系统输入，同时由 View 统一绘制组合文本与光标，输入镜像保持透明。键盘、pointer、clipboard 与 composition 使用同一模型和选区契约；系统事件迟到或视图销毁后不得应用旧编辑。

跨编辑器绘制由 `editor/browser/view.ts` 协调，通用帧原语来自 `base/browser/scheduler`。先准备视口与控件写入，再绘制文本和更新行宽，最后测量并更新依赖几何的部件；同步命中测试使用同一阶段顺序。ViewPart 只拥有自己的 DOM／Canvas 和失效状态，不复制 selection、layout、scroll 或 feature state。具体机制见[浏览器实现](../src/ash/editor/browser/README.md)与[文本几何](../src/ash/editor/text-engine-geometry.md)。

Workbench 的 `EditorGroupModel` 唯一维护标签、顺序、活动项、preview／pinned、sticky 与组锁定；`EditorGroupView` 负责 DOM 和 Pane 生命周期。`EditorParts` 与 auxiliary-window 服务管理窗口及活动 Part；导航与最近关闭记录归 `HistoryService`。跨窗口宿主只提供窗口、布局与生命周期机制，不取得额外文件或模型权限。

Diff／MultiDiff 的模型、计算、取消与 Widget 归 editor；文件或 Git 来源、Pane、标题菜单与配置归 Workbench。比较会话借用两侧模型引用，修改侧只读状态必须传入实际编辑器；关闭会话不能销毁其他视图仍使用的文本。MultiDiff 不另存一份 `diffEditor.hideUnchangedRegions.enabled`。

可访问性属于 view/input contract：聚焦输入面、文本与选区镜像、completion/listbox、live-region、键盘导航和高对比度语义必须随控件维护。自动化事件覆盖与真实物理 IME、屏幕阅读器的验证范围分别记录。

## Agent 文件审核与批量编辑

Agent 文本操作经 `AppServerTextDocumentHost` 进入现有模型与 WorkspaceEdit；它只持有快照引用和版本绑定的调用，不拥有文本或审核状态。接受／拒绝由 Workbench Chat Editing 负责。

| 职责                                             | 所有者                                                          |
| ------------------------------------------------ | --------------------------------------------------------------- |
| Agent 读取、版本快照、应用请求与保存结果         | `AppServerTextDocumentHost`，应用回调由窗口装配传入             |
| 审核基线、逐块／整文件决策、连续写入与审核顺序   | `IChatEditingService` / `ChatEditingService`                    |
| 编辑器审核工具栏、差异标记、删除文本与无障碍入口 | `ChatEditingEditorOverlay` / `ChatEditingCodeEditorIntegration` |
| 正文、历史、文件格式、工作副本与保存             | 既有 `TextModel`、模型引用和 `IBulkEditService`                 |

拒绝只恢复未接受的 Agent 修改。用户在其他位置的编辑进入审核基线；直接改写待审核块时采用用户内容。拒绝后通过同一模型引用保存，后续文件工具与命令读取同一结果。待审核的关闭文件保留模型引用，审核结束后释放。创建、移动和删除按工作区事务整组审核，同一资源的后续 Agent 写入加入原组。

Workbench 与 Agents 窗口分别装配审核服务。当前文档协议没有 Turn 身份，审核记录按窗口保存在内存，不按 Chat Turn 分组或跨窗口重启恢复。Agent 结构化文档写入的已选工作见[Work 文档服务待办](../TODO.md#work--通用文档--todo)。

Rename、Code Action 和 WorkspaceEdit 使用同一 `IBulkEditService`。预览按文件与操作分组，选择变化重新计算只读 MultiDiff 快照；源文件变化使已批准预览失效，要求重新执行。批量编辑拥有有序应用、失败回滚和逆操作，成组撤销先核对最新快照再逆序恢复，文本撤销仍由模型历史承担。

## 长期不变量

- 一个文档在一个 Renderer realm 中只有一个权威 `TextModel`；视图重建不能丢失正文、选区或历史。
- 文本变化经原子事务同步提交版本、事件与 history，输入不等待文件、IPC 或语言服务。
- 文件保存、外部变更、冲突和恢复由模型／工作副本服务决定，View 不持有第二份保存状态。
- 后台只消费版本化快照或镜像；过期结果不能写入新版本。
- composition 的提交、取消与历史由同一输入契约负责。
- contribution 可以释放或停用，基础文本能力及未保存内容仍保持有效。
- editor 身份、DOM vocabulary 与公共类型保持单一，不以兼容为由恢复旧 runtime 或平行状态。

## 验证范围

已有记录来自 2026-10-21 的 macOS 定向复核，以及 2026-10-22 的 Windows 与 WSLg Linux 本机复核。它们覆盖各批次检出的部分 Code 编辑、语言功能、Diff、保存与重启恢复；Windows／Linux 的 Code 场景还覆盖 300,001 行文件和中文重启。受控 LSP 进程不代表任意外部语言服务器兼容性，WSLg 结果不外推到所有 Linux 桌面。

构建来源、精确命令、首败与复验保留在原产物中：macOS 的 `.build/local-editor-acceptance/`、`.build/local-widget-acceptance/`、`.build/local-acceptance-20261021/` 与 `/tmp/ash-stanza-*.log`；Windows 的 `.build/local-todo-windows-20261022/validation.json`；Linux 的 `.build/wsl-linux-code-20261022/validation.json`。这些是历史证据路径，部分产物不在本机。Windows 终端宿主启动修复及 Stanza 在真实 App Server 下的编辑、写盘、关闭重开与退出后恢复，另见本机 `.build/stanza-windows-host/validation.json`；受控 Chromium 中文组合输入验证见 `.build/stanza-ime-selection/validation.json`。Windows 真实微软拼音的候选窗、提交／取消、选区方向、撤销重做及保存重开，连同 Native／textarea 首败与复验，见 `.build/stanza-windows-ime/validation.json` 及同目录证据清单。

真实扩展签名包的多窗口／远端组合、其他平台／输入法、屏幕阅读器、跨页输入与目标 Word 往返仍以[根 TODO](../TODO.md#stanza-编辑器--todo)为准。本文不维护实施批次、通过数量或完成清单；后续实现变化直接修正所属正文，具体未完成工作只在根 TODO 维护。
