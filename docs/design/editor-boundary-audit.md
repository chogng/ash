# Stanza 编辑能力边界审计（M0）

2026-10-18，对当前工作区（包括暂停中的未提交段落改动）做静态职责与调用链审计。本报告完成[路线图](editor-roadmap.md)的 M0 清单；不表示 M1–M5 已迁移，也不包含新增功能、运行时验收或性能结论。

**目标是通用文本内核 + 外部 Code／Academy 能力包；Academy 由独立 Rust 扩展经共享扩展宿主和通用编辑器桥注入，Sessions 消费已注册能力。** IDE 不增加 Academy 的入口、菜单、布局或适配验收。`src/ash/workbench` 同时包含 IDE 产品接线和 Sessions 已在复用的基础设施，不能把“无需适配 IDE”解释成“不能复用 Workbench 服务”。

## 迁移状态（2026-10-19）

Academy Rust 注入链以及普通文档、论文、频道笔记的既有富文档实现迁移已落地，当前实现和边界见[包说明](../../extensions/academic/README.md)与[路线图状态](editor-roadmap.md#当前基线与待迁移状态)。下面的 649 文件、A01–A22 和装配链记录 2026-10-18 的迁移前基线；不把已迁出的旧路径视作现行实现，也不据 Academy 迁移宣称 Code 与完整组合里程碑已完成。

## 审计范围与证据口径

清点 `src/ash/editor` 下全部生产 `.ts`／`.css` 文件，排除任意 `test` 目录，共 **649 个**：`common` 230、`browser` 184、`contrib` 202、`standalone` 28、根入口 5。`contrib` 涉及 62 个直接子项，完整列在后文。数字用于检查清单覆盖，不是代码质量、迁移比例或运行时包大小。

对模型、事务、Schema、投影、输入、视图、注册、扩展装载、资源模型、工作副本、协作、Sessions／IDE 入口及测试调用方检查关键实现；其余按目录与静态依赖归组。本审计不是对 649 个文件的逐方法行为验收。静态引用包括类型引用，不能据此判定构建产物是否实际包含某个模块；M5 仍须检查实际加载集合。

外围范围覆盖 `workbench/contrib/{codeEditor,documentEditor,academic,collaboration}`、`workbench/services/{documentEditor,documentCollaboration,textmodelResolver,extensions}`、编辑器 Pane／注册、`extensions/academic`、Sessions 公共／桌面／Web 入口及其服务装配、Creator 入口参照、Chat 输入和 Changes 消费者，以及既有架构、单测、浏览器和 smoke 测试入口。Rust 及传输层只核对调用边界，不据本报告声称后端实现已经完成审计。

## 产品宿主与依赖方向

目标能力链是：**Academy 独立 Rust 扩展 → 公共 Rust SDK／Host RPC → 共享扩展宿主与通用编辑器桥 → Stanza 通用契约**；产品消费链是：**Sessions 入口 → 共享宿主已注册的编辑能力**。包内 contrib 组织完整编辑能力，Sessions 组织产品体验。Rust Provider、包内客户端资源与 TS 编辑器状态的运行边界以[路线图](editor-roadmap.md#目标边界与依赖方向)为准。将实现或注册迁入 `sessions/contrib` 不能完成外部扩展注入，也不预设需要 Academy 专用 Sessions contrib。

| 所有者                    | 目标职责                                                                                                               | 不承担的职责                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Stanza 通用文本内核       | 唯一文本、稳定位置、原子提交、版本／历史、基础选区与平台输入、基础文本几何、通用数据映射及释放                         | 语言算法、富文档 Schema、段落／表格规则、Word 布局、Sessions 工作流 |
| Code 能力包               | 语言与代码交互、代码视图附加能力；内部 contrib 按行为内聚                                                              | 新建另一份正文、接管宿主工作副本或会话状态                          |
| Academy 能力包            | 普通富文档与 Academic 配置共用的 Schema、结构命令、编辑策略、视图、样式、对象、布局和 codec；持有自身注册及实例资源    | 独立保存的正文／撤销栈、产品会话状态、账号与权限所有权              |
| Sessions 产品消费层       | 入口、`Menus.*`、上下文、编辑器选择、布局描述、恢复及会话关联；消费共享宿主注册的能力                                  | Academy 注册／装载／注入、富文档实现、另一份文档模型、私有安装器    |
| Sessions core／services   | 中立的布局、编辑器生命周期、已有会话／Chat 状态与扩展服务装配                                                          | Academy Schema 或专有模式判断                                       |
| 可复用 Workbench 下层服务 | 通用扩展能力投影／编辑器桥、EditorPane／EditorPart、模型引用、工作副本、文件、备份／冲突、DI、扩展目录／权限及协作连接 | Academy 产品入口、具体格式含义、Sessions 产品策略                   |
| IDE 装配入口              | 维持既有 Code 与共享消费者的行为；未来按切片收敛旧文档接线                                                             | 新增 Academy 产品适配、为新 Academy 功能建立第二套 UI 工作流        |

依赖遵守 [Sessions 分层](../../src/ash/sessions/LAYERS.md)：`sessions → workbench → editor → platform/base`；编辑能力包依赖公开契约，内核不导入包实现。Workbench 不反向导入 Sessions，Sessions 服务不导入其产品 contrib。现有 Workbench 服务若含格式语义，拆出语义后复用原 owner，不在 Sessions 复制同名服务。

Sessions 中是否设独立 Academy 入口或从已有文档入口进入，属于 M1 的入口设计；本报告不提前增加顶层模式。文档资源身份、会话身份和视图状态分别由现有 owner 持有，切换布局不关闭脏文档、不复制 Chat 草稿，也不把 Creator 的对象模型当成富文档模型。

## M0 迁移前装配链

| 链路                  | 当前事实与证据                                                                                                                                                                                                                                                                | 审计结论                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Sessions 启动         | [sessions.common.main.ts](../../src/ash/sessions/sessions.common.main.ts) 导入 `editor.all`、Workbench Code／snippets 和 Sessions 各贡献；桌面／Web 共用该入口                                                                                                                | 已有高层贡献入口，但未见 Academy 产品 contrib；不能以加入一条静态 import 作为包注入验收。                         |
| Sessions 服务         | [browser/workbench.ts](../../src/ash/sessions/browser/workbench.ts) 注册 `IModelService`、`ICodeEditorService`、`IWorkingCopyService`、`IDocumentEditorTextModelService`、`AppServerExtensionService`、`IEditorService` 等                                                    | 模型、工作副本、编辑器及扩展目录已有复用点；语言相关装配仍须按使用者拆分，不能整体删除。                          |
| Sessions 功能入口参照 | [Creator contrib](../../src/ash/sessions/contrib/creator/browser/creator.contribution.ts) 使用 `registerEditorPane`、`ISessionsLayoutService.openEntry`、`Menus.ActivityBar`；[布局契约](../../src/ash/sessions/services/layout/common/sessionsLayoutService.ts) 消费功能描述 | Creator 仅作产品消费参照，不决定 Academy 能力注入入口；其正文状态和装配方式不能替代 Rust 扩展运行链。             |
| IDE 启动              | [workbench.common.main.ts](../../src/ash/workbench/workbench.common.main.ts) 导入 `editor.code.all`、Academic 和普通文档贡献                                                                                                                                                  | 现有文档功能与 IDE 静态接线耦合；本次只列迁移债务，后续退出旧入口，不为 Academy 扩展 IDE 适配范围。               |
| 编辑器默认 bundle     | [editor.code.all.ts](../../src/ash/editor/editor.code.all.ts) 继续导入 [editor.all.ts](../../src/ash/editor/editor.all.ts)，后者同时注册 Code 功能与 `documentEditor.contribution`；`editor.main` 又装配完整 bundle                                                           | 当前无已经验收的纯文本独立装载闭包；更名 bundle 不会解除耦合。                                                    |
| 普通文档              | [documentEditor.contribution.ts](../../src/ash/workbench/contrib/documentEditor/browser/documentEditor.contribution.ts) 直接注册 `.ash-doc` Pane、创建／转换／导出命令及 IDE 文件菜单；`generalProfile` 选择默认富文档 Schema                                                 | 普通富文档也归 Academy；能力命令由扩展注册，通用桥投影到客户端，Sessions 仅消费产品入口及菜单。                   |
| Academic 包           | [package.json](../../extensions/academic/package.json) 只声明 `customEditors`，没有可执行 `main`／`browser` 入口；`academicEditor.contribution.ts`（旧入口，现已移除） 提前注册 `ash.academic` 内置 factory                                                                   | 包声明负责路由，实际实现仍随产品编译；尚未证明功能由外部包提供。扩展 ID 和旧文件身份不因 Academy 产品名自动改名。 |
| customEditors 装载    | [appServerExtensionService.ts](../../src/ash/workbench/services/extensions/browser/appServerExtensionService.ts) 仅为 `builtIn` 包查找 `getBuiltinEditorPaneFactory`，没有 factory 时跳过；[editor.ts](../../src/ash/workbench/browser/editor.ts) 保存静态 factory 表         | 现有路径不能直接承诺任意外部包注入 Renderer 视图，也不能把缺少实现静默跳过作为新能力失败策略。                    |

检查 Sessions 公共入口的静态引用闭包（含类型引用），没有到两个 Workbench `academicEditor.contribution.ts`／`documentEditor.contribution.ts` 注册入口的路径；却能到富文档类型／实现引用。**服务可达、类型可达与 Pane 已注册是不同事实。** 本轮未运行 Sessions 打开文档场景，不据此断言界面一定能打开或一定不能打开某种文件。

## 混合职责、目标归属与退出条件

下表编号用于后续迁移追踪。阶段沿路线图 M1–M5；同一行中的共享机制和业务实现须分别处理，不能整目录搬走。

| 编号／现有位置                                                                                                                                  | 现有混合职责                                                                                                                 | 目标归属                                                                                               | 顺序与旧入口退出条件                                                                                                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A01 根入口 `editor.{api,all,code.all,main}.ts`                                                                                                  | API 初始化 Standalone／语言服务，默认 bundle 注册两类业务，Code 入口实际是混合别名                                           | 内核基础入口；Code／Academy 各包入口；既有公开入口按真实消费者保持兼容                                 | M1 定义装配边界，M2 包切片，M5 核对依赖和构建；仅当所有生产调用方转移后退出默认业务导入。                                                                                                       |
| A02 `common/model/textModel.ts`、`common/model.ts`                                                                                              | 统一正文／版本／历史，同时直接构造 tokenization、bracket、diagnostics、guides；持有 Schema block 状态与富文档投影            | 正文与原子提交留内核；Code 模型附加状态归 Code；Academy Schema／投影附加状态归 Academy                 | M1 列现有构造和事件契约，M2 验证同一历史与原子失败，M3／M4 按链剥离，M5 去默认依赖。不得新建并行模型替代。                                                                                      |
| A03 `document.ts`、`documentSchema.ts`、`documentParagraph.ts`                                                                                  | 树结构与 Schema 引擎、默认 paragraph／heading／list／table／image／codeBlock、样式与段落默认值／校验位于 common              | Academy 结构模型／Schema 与样式 contrib；真正需要的通用扩展数据提交契约留内核                          | M2 段落切片，M3 连带旧文件解析迁出；`createDefaultDocumentSchema` 在 Pane／WorkingCopy 等调用方全部注入后退出下层默认回退。                                                                     |
| A04 `lineDocument.ts`、`lineDocumentProjection.ts`、`core/documentPosition.ts`                                                                  | 行 ID／位置与 mark／atom／facet／region／relation store、Schema 树投影混合；投影硬编码 codeBlock、image caption、citation 等 | 稳定文本身份／坐标机制留内核；具体投影和 rich store 使用归 Academy；可选通用数据模块仅按真实消费者保留 | M1／M2 证明文本与附加数据同步提交，M3 搬投影。当前 store 的直接生产使用集中于快照工厂、模型／投影及 API 导出，没有第二类消费者证明六种 store 都须常驻内核；M5 检查无 Academy 时不初始化其语义。 |
| A05 `textModelBlockState.ts`、`document{Transaction,History,Plugin,Decoration}*`、`core/documentSelection.ts`                                   | Schema 事务、结构选区、插件、映射、历史与通用模型提交交织                                                                    | Academy 结构事务／插件协议；内核维持统一提交、版本、undo/redo 与不透明附加数据的映射机制               | M1 明确提交边界，M2 测试一次操作只有一次可撤销结果；M3 替换旧直连。已有 `DocumentHistory` 的内部实现不能演变为可独立提交／保存的第二套正文历史。                                                |
| A06 `common/commands/documentCommands.ts`、`documentParagraphCommands.ts`                                                                       | 字符格式、段落、列表、表格、图片和剪贴板结构命令居于 common                                                                  | Academy 各功能 contrib；命令所需的纯文本原语留内核                                                     | M2 先迁现有段落命令，M3 按输入→事务→撤销→保存链迁其余；对应 Widget、工具栏和测试调用一并切换。                                                                                                  |
| A07 `browser/editorExtensions.ts`                                                                                                               | 通用贡献注册、Code 扩展与 `DocumentFormattingState`、段落数组、字体和富文档命令工厂混在一个上下文                            | 通用注册／实例生命周期留内核；Code 与 Academy 各自定义能力上下文                                       | M1 从两个真实消费者反推最小端口，M2 验证启停／代次／实例释放；M3 移出专有字段，不建立中央 union 随业务无限增长。                                                                                |
| A08 `browser/widget/richTextEditor/*`                                                                                                           | 富文档 DOM、contentEditable、表格导航、段落投影、HTML paste、格式动作、IME 与协作 Controller 直接绑定                        | Academy 视图／输入／对象／剪贴板 contrib；共享平台输入、挂载与位置接口由内核提供                       | M2 闭合现有段落切片；M3 迁完整可编辑表面及 CSS、NodeView、选区和异步资源释放。不得只移工具栏而让业务保留在基础 Widget。                                                                         |
| A09 `documentFormattingControls.*`、`documentOutlineNavigator.ts`、`contrib/{formatting,paragraphStyle,paragraphFormatting}`                    | 控件、多段状态与 outline 在 browser/common 装配，段落 contrib 由默认 bundle 自动注册                                         | Academy 样式／段落／导航 contrib；底层 SelectBox 等通用 UI 仍由原基础组件 owner 提供                   | M2／M3 与 Schema、命令和视图一起迁。暂停改动使用的是共享 `SelectBox`，不是原生 select；台账待随真实迁移同步。                                                                                   |
| A10 `contrib/{academic,citation}` 与 `workbench/contrib/academic/*`                                                                             | 论文 Schema、节点视图、引用命令／参考文献插件和宿主 profile 分布两层                                                         | Academy 包内 Academic 配置与 citation contrib；Sessions 只选择包提供的文档配置                         | M3 保持 `ash.academic`、旧扩展名、contentType、`stanza-academic-v1` 协作兼容身份；包缺失时不能改按普通文本保存。                                                                                |
| A11 `documentSerialization.ts`、`documentTransactionSerialization.ts`、`documentOutline.ts`                                                     | 文档格式、fragment MIME、结构事务与 outline 算法在 common                                                                    | Academy codec／clipboard／outline；通用文本快照及传输端口留原 owner                                    | M3 更新保存、备份、协作和剪贴板消费者后退出旧依赖；保留版本／未知字段兼容要求，后续 DOCX／PDF 不进入内核。                                                                                      |
| A12 `workbench/contrib/documentEditor/{editorProfile,documentEditorPane,documentEditorInput}.ts`                                                | Pane／引用生命周期、默认 Schema、富文档 Widget、toolbar、profile 与协作 service 构造混合                                     | Academy 包提供 surface／profile；通用编辑器桥适配 Pane／input；Sessions 消费注册；引用和 DI 留共享宿主 | M1 列引用与视图 owner，M2 Rust 扩展注入切片，M3 更新并排／恢复与协作路径；IDE 旧入口 M5 退场不成为新实现必经层。                                                                                |
| A13 `documentActions.ts`、`documentImportExport.ts`、`documentAccessibility.ts`                                                                 | 文件对话框、活动编辑器路由、文本／Markdown 转换、无障碍文字与具体 Pane 类型判断混合                                          | Academy 注册命令、转换和可访问文档语义；通用桥投影，Sessions 消费入口；对话框／资源访问复用宿主        | M3 按新建、打开、转换、导出、帮助闭环迁移；不要求 IDE 文件菜单或工作流适配 Academy。更新本地化与键盘／焦点契约。                                                                                |
| A14 `workbench/services/documentEditor/*`、`textmodelResolver/common/textModelResourceService.ts`                                               | 资源去重引用、dirty／save／backup／conflict 正确集中；输入和工作副本又直接耦合 DocumentSchema／默认 parse／serialize         | 原服务继续拥有资源、引用和工作副本；包提供领域 codec／创建／附加数据契约                               | M1 定义服务接入，M2 验证同 URI 多视图只一份工作副本，M3 去默认 Schema。迁移不能丢 Save As、恢复、外部修订冲突与协作保存基线。                                                                   |
| A15 `contrib/collaboration/*`、`common/services/documentCollaborationService.ts` 与 `workbench/services/documentCollaboration/*`                | 编辑事务重基／presence、Schema 序列化与连接、成员、权限及 App Server／Remote 适配横跨层                                      | Academy 结构同步与选区／presence 呈现；宿主共享连接／账号／权限；传输 DTO 只留适配边界                 | M3 与模型／codec 一起迁；只有版本化快照／事务跨边界，客户端同步状态不交给后端。保留离线、冲突重基、viewer 只读及在途结果拒绝。                                                                  |
| A16 `workbench/contrib/collaboration/browser/collaboration.contribution.ts`                                                                     | 频道笔记直接选择默认富文档 Schema 和 DocumentEditorPane，是 Academy 之外的既有富文档消费者                                   | 频道功能仍归原产品 owner；其文档视图消费 Academy 可选能力或经真实复用提取的包内通用富文档模块          | M1 明确该依赖与缺失能力时的行为，M3 迁消费者后才能删除旧实现；不在内核或 IDE 留一份富文档副本，也不顺便扩展频道产品功能。                                                                       |
| A17 `common/{languages,tokens}`、`model/{tokens,bracketPairsTextModelPart,guidesTextModelPart,languageRequestCoordinator,languageResultStore}*` | Code 算法／缓存和通用模型／视图服务直接相连                                                                                  | Code 能力包及其语言服务适配；通用身份／版本／取消契约可复用                                            | M2 一个 Code 行为验证包链，M4 逐项迁分词、语义 token、诊断、括号、guides 等；先转移请求及缓存 owner，再移默认构造。                                                                             |
| A18 `common/cursor*`、`commands/{shift,surroundSelection}Command.ts`、`browser/coreCommands.ts`、controller                                     | 普通移动／文本替换／IME 与语言缩进、括号／引号补全、代码意图混合                                                             | 通用输入／选区与替换留内核；语言编辑策略归 Code，富文档策略归 Academy                                  | M1 明确机制／策略边界，M4 迁 Code 策略；不能按 cursor 目录整体判为内核，也不能移走基本输入。                                                                                                    |
| A19 `browser/{view,viewParts,gpu}`、`common/{viewLayout,viewModel,config}`、`widget/codeEditor`                                                 | 基础行视图／几何与 Minimap、margin、代码装饰、语言设置、Code Widget 装配交织                                                 | 基础文本呈现／输入机制留内核；Code 视图贡献归 Code；配置按消费者拆分                                   | M1 核对基础文本必需项，M4 迁附加视图，M5 验证无 Code 环境；不为达成目录隔离重写第二份基础渲染器。                                                                                               |
| A20 `common/diff`、`widget/{diffEditor,multiDiffEditor}`、`widget/markdownRenderer`、contrib UI 工具                                            | 可选比较算法／视图和宿主工厂、代码片段渲染、通用交互混合                                                                     | 可选比较／文本模块；Code 及 Sessions Changes 按需消费；宿主工厂归适配层                                | M4／M5 拆依赖，不要求纯文本内核装载 Diff。保留现有 Changes、只读比较和 Markdown 代码块消费者，不将 Word 修订等同于文本 Diff。                                                                   |
| A21 `standalone/*`、`common/services/*`、`browser/services/*`                                                                                   | 独立宿主、模型服务、worker、语言／marker／格式化／默认粘贴 provider 统一装配                                                 | Standalone 是单独宿主适配；模型引用／通用 Worker 端口可共享；语言／formatter／Code provider 属能力包   | M1 契约与调用清单，M4 拆服务，M5 收敛公开入口。Standalone 当前直接引用 contrib，不能当成纯内核已存在的证据。                                                                                    |
| A22 Sessions／Workbench composition root 与全部测试／构建入口                                                                                   | 静态全功能导入；测试直接构建旧 Pane／内置 factory，并断言 rich 实现必须在 editor 目录                                        | 共享扩展宿主注入 Academy，Sessions 消费注册；Code 保留真实消费者；测试验证 owner 与行为而非冻结旧目录  | M2 增真实包链验证，M3／M4 转移测试，M5 最后退出旧导入与断言；本轮不修改测试去伪造通过。                                                                                                         |

重点源文件：[TextModel](../../src/ash/editor/common/model/textModel.ts)、[Schema](../../extensions/academic/common/model/documentSchema.ts)、[行投影](../../extensions/academic/common/model/lineDocumentProjection.ts)、[扩展上下文](../../src/ash/editor/browser/editorExtensions.ts)、[富文档 Widget](../../extensions/academic/browser/widget/richTextEditor/richTextEditorWidget.ts)、[模型服务](../../src/ash/workbench/services/documentEditor/browser/documentEditorTextModelService.ts)、[工作副本](../../src/ash/workbench/services/documentEditor/browser/documentWorkingCopy.ts)。表中短路径以 `src/ash/editor` 为根，明确标注 `workbench`／Sessions 的除外。

## 全量目录覆盖

### 非 contrib 模块

| 清点范围                                                 | 文件数    | 已审计的归属分界                                                                                                                |
| -------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 根入口                                                   | 5         | A01；`editor.worker.start.ts` 的通用端口／资源生命周期可保留，语言 bootstrap 随 Code。                                          |
| `common/core`                                            | 38        | 坐标、文本编辑／映射、分段等留内核；document selection／position 的结构解释按 A04／A05 迁；主题值等工具不因此自动成为启动依赖。 |
| `common/model`                                           | 55        | piece tree、文本编辑／历史／搜索／跟踪范围按通用机制保留；Schema／结构与语言分支分别按 A02–A05、A11、A17 迁。                   |
| `common/commands`                                        | 6         | replace／trim 等文本原语可留；shift／surround 中语言策略归 Code；两类 document 命令按 A06 迁。                                  |
| `common/cursor`                                          | 12        | A18，通用移动、组合输入、替换与语言编辑策略分离。                                                                               |
| `common/config`、`common/viewLayout`、`common/viewModel` | 7／7／15  | A19，文本几何／测量可留；语言 token、guides、Code 装饰及专有配置按消费者拆。                                                    |
| `common/languages`、`common/tokens`                      | 19／6     | A17，Code；可复用中立结果映射机制不能携带语言算法。                                                                             |
| `common/diff`                                            | 9         | A20，可选比较模块，非基础启动要求。                                                                                             |
| `common/services`                                        | 30        | A15／A17／A21，模型服务、worker／同步端口和语言、markers、Tree-sitter、collaboration 分开判归属。                               |
| `common` 根文件、`common/standalone`                     | 25／1     | 模型／事件／输入公共类型与语言注册、token、bracket／guide 契约混合，按 A02／A17–A21 分；公开枚举兼容面按真实消费者保留。        |
| `browser/controller`、`browser/config`                   | 22／7     | A18／A19，输入事件与策略分离；字体测量等机制不随语言能力搬走。                                                                  |
| `browser/view`、`browser/viewParts`、`browser/gpu`       | 8／52／25 | A19，基础文本几何与 Code 可选视图分离；Canvas／GPU 是实现手段，不按技术名判业务归属。                                           |
| `browser/widget`                                         | 51        | A08／A09／A19／A20，富文档、Code、Diff／multiDiff、Markdown 代码块分别有 owner。                                                |
| `browser/services`、`browser` 根文件                     | 10／9     | A07／A18／A21，Editor 注册／生命周期、语言／marker／worker 服务及 Code 命令装配分离。                                           |
| `standalone/browser`、`standalone/common`                | 22／6     | A21，独立宿主、颜色／主题机制与语言 Monarch／token 检查、quick access、provider 装配分离。                                      |

以上覆盖 447 个非 contrib 文件，和下面 202 个 contrib 文件合计 649。目录归组中的“分离”是有明确 owner 的迁移工作，不表示可以不核对该组剩余方法就直接整目录移动。

### 全部 62 个 contrib 子项

括号为生产 `.ts`／`.css` 文件数。这里的“可选文本”是按实际消费者装配的模块，不是新的默认内核；“Code UI 支撑”也不因能被复用而自动成为基础入口依赖。

| 现有子项                                                                                                                                 | 目标 owner／拆分要求                                                                                | 阶段   |
| ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------ |
| `academic` (2)、`citation` (5)                                                                                                           | Academy 的论文 Schema／NodeView 与引用／文献 contrib                                                | M3     |
| `formatting` (1)、`paragraphStyle` (1)、`paragraphFormatting` (1)、`documentEditor.contribution.ts` (1)                                  | Academy 字符／段落 contrib 与包注册入口，退出默认 bundle                                            | M2–M3  |
| `collaboration` (3)                                                                                                                      | Academy 结构同步；宿主提供连接／权限。可复用重基机制按真实消费者提取                                | M3     |
| `languageAnalysis` (1)、`tokenization` (2)、`bracketMatching` (4)、`wordHighlighter` (4)                                                 | Code 分析／token／括号／符号高亮                                                                    | M2／M4 |
| `suggest` (5)、`inlineCompletions` (5)、`parameterHints` (5)、`inlayHints` (2)、`codelens` (5)                                           | Code 对应交互；Provider 与结果取消／版本一起迁                                                      | M4     |
| `gotoSymbol` (11)、`documentSymbols` (2)、`gotoError` (2)、`rename` (3)、`codeAction` (10)                                               | Code 符号／诊断／重命名／代码操作；资源编辑路由由宿主适配                                           | M4     |
| `hover` (5)、`colorPicker` (10)、`linkedEditing` (2)、`inPlaceReplace` (2)、`smartSelect` (2)                                            | 当前 provider／语言驱动实现归 Code；Academy 需要同类交互时提供自身语义                              | M4     |
| `comment` (3)、`indentation` (3)、`format` (3)、`snippet` (4)、`folding` (9)、`stickyScroll` (8)、`sectionHeaders` (3)                   | Code；宿主 snippets／format provider 接线不能反向留进内核                                           | M4     |
| `dropOrPasteInto` (8)、`links` (2)                                                                                                       | 分开通用拖放／打开机制、Code provider 与默认实现、宿主资源访问；Academy 的结构 paste／link 由其拥有 | M3–M4  |
| `find` (12)、`multicursor` (2)、`anchorSelect` (2)、`caretOperations` (3)、`cursorUndo` (1)、`lineSelection` (1)、`linesOperations` (4)  | 可选文本交互；通用编辑原语保留，行操作中的代码策略归 Code，不能直接套用结构文档坐标                 | M4     |
| `clipboard` (1)、`insertFinalNewLine` (2)、`unicodeHighlighter` (4)、`unusualLineTerminators` (4)、`longLinesHelper` (1)、`wordWrap` (1) | 可选文本交互／保存策略；平台 clipboard 机制留原 owner，结构内容与 Code 策略按消费者拆               | M4     |
| `contextmenu` (1)、`fontZoom` (1)、`middleScroll` (3)、`placeholderText` (3)、`readOnlyMessage` (1)、`toggleTabFocusMode` (1)            | 可选文本 UI；保留底层输入／焦点机制，产品文案与菜单适配归宿主                                       | M4     |
| `quickAccess` (3)                                                                                                                        | 行定位可选文本；符号／编辑器命令导航依能力与宿主装配                                                | M4     |
| `peekView` (2)、`zoneWidget` (2)、`message` (2)、`inlineProgress` (2)、`editorState` (2)、`textEditorCapabilities.ts` (1)                | Code UI 支撑／实例能力辅助，按调用者复用；不是必须独立安装的包                                      | M4–M5  |
| `diffEditorBreadcrumbs` (1)                                                                                                              | 可选 Diff 与宿主导航适配                                                                            | M4     |

`formatting` 是富文档格式控件，`format` 是 Code formatter 交互，不能因为名字相似合并。两个直接文件项也计入 62 项，避免只清点目录而漏掉全局文档注册和能力辅助。

当前还存在以下非 contrib → contrib 的直接引用：富文档 Widget → collaboration controller；Standalone services → format／dropOrPasteInto；Standalone quick access → documentSymbols 和 quickAccess（后者为类型引用）。M3／M4 须更新真实调用者，M5 才能去掉例外。只禁止新增反向 import 无法消除当前闭包。

## 目标 contrib 拆分与注释要求

以下是逻辑职责，不是本轮要创建的空目录／API，也不要求每项独立安装。实际目录以 M2 调用链与构建、打包约束落定。

| 贡献 owner                        | 内聚范围                                                             | 关键注释必须解释                                                         |
| --------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 通用扩展桥与 Sessions 消费        | 共享宿主投影能力与绑定 Pane；Sessions 消费入口、布局、恢复与会话关联 | 包注册不归 Sessions；视图与会话寿命、切换布局和关闭文档的区别            |
| Academy document／schema          | 普通文档、Academic 配置、Schema、兼容与校验                          | 唯一状态与投影关系；哪些持久字段不可丢弃；兼容 ID 与失败处理             |
| Academy text formatting           | 字符格式与选区状态、字体控件                                         | 状态从模型派生；混合值、失焦与命令提交时机                               |
| Academy paragraph／styles         | 段落属性、样式引用／覆盖、对应控件                                   | 多段选区范围、样式解析优先级、一次命令的原子性                           |
| Academy lists／tables／media      | 各自的 Schema、命令、输入、呈现和资源请求                            | Enter／Tab 规则、对象身份、异步读取的取消／旧模型拒绝及资源释放          |
| Academy clipboard／codec          | fragment、HTML／文本／Markdown 转换、持久文件编码                    | 格式边界校验、转换损失、未知内容保留；宿主提供资源访问而不解释格式       |
| Academy surface／layout           | 富文档 DOM、连续视图、以后分页；命中／选区／IME 几何映射             | DOM owner、复用／重建条件、位置映射、缓存版本与无效化                    |
| Academy outline／citation／review | 导航、论文引用与文献；以后审阅的领域语义                             | 派生索引与正文 owner；计算版本和过期结果，避免派生状态成为另一份业务状态 |
| Academy collaboration             | 结构事务同步与 presence 呈现                                         | 本地原子提交、重基／回放、保存基线与连接断开的界限                       |
| Code 功能 contrib                 | 上表逐项完整交互，含 Provider 适配、命令、视图和资源                 | 请求身份／模型版本／包代次、取消、旧结果拒绝及实例释放                   |
| 可选文本／Diff 模块               | 有真实消费者的查找、多光标、比较等                                   | 能力选择与挂载、共享状态和实例状态、结构文档是否支持该坐标体系           |

把注册／释放、格式 codec 或输入语义拆到不同文件时，注释应指向唯一 owner，解释调用顺序和失败边界；不能让读者靠追踪多个全局副作用猜出装配。包的停用、升级或加载失败不允许留下旧命令／NodeView／请求写回新模型。脏文档不能靠自动关闭或强制降级来满足停用；M1 必须明确保留实例、拒绝停用或受控重载等具体生命周期策略，M2 再验收选定策略。

## 实施顺序及每步交付

| 顺序                       | 先完成的工作                                                                                                                                                    | 迁移与验收依赖                                                                                                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0（本报告完成）           | 固定当前边界、消费者、目标 owner、IDE 排除范围和下列缺口                                                                                                        | 本轮仅文档；暂停中的实现与既有失败记录保持原状。                                                                                                                           |
| M1 宿主与通用端口          | 先从 Academy 独立 Rust 程序经公共 SDK／Host RPC 的注册／调用确定通用编辑器桥，再定义客户端资源版本绑定、唯一模型提交／codec、恢复和释放；以 Code 行为检验中立性 | 不预建无调用方 API。明确频道笔记、Chat 输入、Changes、Standalone 和 IDE Code 的兼容路径；明确外部客户端组件运行位置。                                                      |
| M2a Code 注入切片          | 选择现有 Code 交互，从启用包进入 Provider／命令／视图到真实结果                                                                                                 | 验证包注册、取消、实例／模型切换与释放；保留 Chat 输入所用能力。无需扩展 IDE 产品工作流。                                                                                  |
| M2b Academy Rust 注入切片  | 复用暂停中的段落能力，从实际 Rust executable 经共享宿主注册并注入编辑器，贯通 Schema→命令→客户端视图→一次事务→保存重开；Sessions 消费注册结果                   | 先于新功能；两种包共同约束 M1 端口。验证包缺失／不兼容／停用、dirty 安全、并排同资源与恢复；不能仍依赖内置 factory 供应业务实现。                                          |
| M3a Academy 语义／状态     | 默认 Schema、结构命令、事务／投影、插件、codec、Academic 配置按 A03–A06／A10–A11 迁                                                                             | 新旧格式读取必须兼容，原子提交和统一历史先闭合；旧读取者未转移前不删实现。                                                                                                 |
| M3b Academy 视图／宿主闭环 | Widget、工具栏／对象输入、outline、转换／帮助、Pane、工作副本 codec、协作；更新频道笔记消费者                                                                   | 输入、IME、剪贴板、撤销、保存、备份／冲突／恢复和协作回归；Sessions 恢复／焦点与包代次一起验收。                                                                           |
| M4 Code 与可选文本模块     | 按模型附加状态→Provider／交互→视图策略→宿主／Standalone 装配迁；可与 M3 独立切片推进                                                                            | Code 不等同于 IDE 模式。Sessions Chat／Cowork 输入、代码文件与 Changes 仍有真实消费者；保留共享契约及既有 IDE Code 行为。                                                  |
| M5 收敛与退出              | 按消费者转移情况移除默认业务 import、旧 factory／重复注册、旧 IDE 文档接线及测试目录断言；核对 API、构建、资源和实际装载                                        | 基础文本／Code／Academy 注入及 Sessions 消费分别验收。未启用包时无其实现和资源的强制装载；一个功能只有一个有效 owner。退场涉及旧文件／恢复时给出兼容路径，不自动丢失数据。 |
| M6 后续功能                | 在 Academy 包内继续样式、Word 可编辑分页、页眉页脚／脚注、打印／PDF、DOCX、审阅与论文工作流                                                                     | 沿路线图 6.1–6.7；本轮及 M0 均不提前实现。                                                                                                                                 |

M2a／M2b 是同一门禁的两个切片，不要求 Code 全迁完才开始 Academy。M3a／M3b 说明依赖，实施时可按一个可用行为逐段闭合，不允许在中途留下两个可写 owner。每个切片都应及时清理失效入口，M5 是最终依赖复核，不是保留所有旧实现到最后的理由。

## 必须在 M1／M2 落定的缺口

1. **Rust Provider 与客户端接入**：沿公共 Rust SDK／Host RPC 和共享监管器注册能力，复用现有目录、启停、授权、取消和资源装载；以 Markdown 独立 Rust 扩展为参照，明确 Academy 结构编辑与客户端视图仍缺的契约。声明式 `customEditors` + 内置 factory 不算外置；必须验证真实 executable、客户端资源精确版本绑定及隔离。运行职责遵循[路线图](editor-roadmap.md#目标边界与依赖方向)，不另建协议、安装器或进程体系。
2. **原子附加数据与历史**：结构树、行投影、选择映射和文本版本必须在唯一模型的一次事务中一致；明确失败回滚、扩展停用和远端事务。不能只提供一个 opaque 字段就声称解决结构编辑，也不能把整个富文档引擎默认保留在内核。
3. **资源恢复与 codec 缺失**：包身份／版本、contentType、Schema 兼容身份如何找到读取者；未安装或加载失败时保留原文件、备份和脏内容，并给出可恢复结果。当前 `parseDocument` 默认 Schema 路径要在 M3 退出。
4. **共同消费者**：频道笔记对富文档的依赖要有一条明确的包消费路径；Chat／Cowork 输入及 Changes 对 Code／可选文本的依赖不能因 IDE 排除而消失。先查真实使用，再决定共享模块，不提前复制实现或新增平行 registry。
5. **产品入口与范围**：Sessions 的文档发现、新建／打开、会话关联、布局恢复和缺失能力提示需要明确；采用现有 `ISessionsLayoutService` 和菜单体系。IDE 无新增 Academy 入口与适配验收；旧 IDE 文档入口如何退场按 A12–A16／A22 的消费者和持久恢复依赖决定。

这些是实现阶段的契约决策，不阻塞本次静态 M0 清单完成；本报告没有替它们宣称运行时方案已存在。

## 测试与文档迁移清单

| 现有检查／消费者                                                                                                                                                                                     | 后续处理                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [editor-document-architecture.test.ts](../../test/architecture/editor-document-architecture.test.ts)、[editor-public-entrypoints.test.ts](../../test/architecture/editor-public-entrypoints.test.ts) | 现有断言要求 rich 文件和文档贡献在默认 editor bundle，属于旧边界。随真实迁移改为核心禁止业务依赖、包拥有实现、基础组合不装载两类功能；保留唯一模型、无反向宿主 import 等有效约束。 |
| [editor-architecture.test.ts](../../test/architecture/editor-architecture.test.ts)、[layer-boundaries.test.ts](../../test/architecture/layer-boundaries.test.ts)、DOM／测试布局检查                  | 保留文本行为与分层；增量核对 Sessions→Workbench 单向依赖和三种组合，不靠放宽全局排除来通过。                                                                                       |
| Editor 相关 owner 单测、Workbench documentEditor／Academic 测试                                                                                                                                      | 跟随 owner 转移，保持事务、坐标、Schema 校验、引用、保存／冲突、协作行为；基础文本必须在未装载两类能力时能独立验证。                                                               |
| [academic.integration.ts](../../test/integration/browser/academic.integration.ts)／spec                                                                                                              | 当前直接 import 贡献／Pane／Schema 和测试注入服务，仍可作为旧行为基线；增加真实 Rust 程序经共享宿主注册／注入编辑器的场景及 Sessions 消费场景，不能把测试手动注册当成生产注入。    |
| [test/automation/editor.ts](../../test/automation/editor.ts)、[editors.ts](../../test/automation/editors.ts)、Editor／Academic smoke                                                                 | 分清通用自动化、Code 行为与旧 IDE Academic 路径；保留可复用助手，新 Academy 产品场景移到 Sessions。旧测试退场以对应行为和恢复覆盖转移为条件。                                      |
| Sessions editor-history、Chat／Cowork 输入、Changes、Creator                                                                                                                                         | 验证保存／恢复／并排、会话切换／草稿、Diff 和现有产品回归；不把 Creator 模型改造成 Academy 模型。                                                                                  |
| Editor README、text-engine、document-engine、API 台账；`docs/editor-{architecture,extensions}.md`；[旧 Work / Code 设计](work-code-workbench.md)；Sessions 说明                                      | 随实现更新当前事实与目标边界；旧 Work 产品入口不能作为 Academy 必须适配 IDE 的依据。历史行为记录保持为历史，不自动升级为新边界验收。                                               |

2026-10-18 暂停实现的定向单测／浏览器失败、全量 Editor 单测服务缺口及组合测试入口失败统一见[根 TODO](../../TODO.md#stanza-编辑器--todo)。本轮仅核对文档格式、链接／锚点、清单覆盖与功能源文件未变化；没有重跑行为测试，也没有修复既有功能或测试。
