# Stanza

> 本文是 `src/ash/editor` 的 canonical 目录、所有权和装配入口。Stanza 类似 Monaco 在 VS Code 中的位置；`editor/` 是一个扁平领域目录，不是第二个品牌或额外架构层。文本内核的设计规范见 [`text-engine.md`](./text-engine.md)，跨 Workbench、文件、语言服务与 App Server 的系统边界见 [`docs/editor-architecture.md`](../../../docs/editor-architecture.md)。

## 快速理解

Stanza 以 VS Code `src/vs/editor` 为职责参照：`common` 拥有公共契约与同步内核，`browser` 拥有浏览器编辑器实现，`contrib` 拥有通用文本编辑功能，`test` 保存内核回归。客户端 Code 通过 `textModelFeatures` 的可释放端口接入；模型、事件与 token 来源对象保持稳定。宿主可复用这些机制或构造符合契约的实现再注入，具体扩展的 Schema、视图、codec 与验收归扩展和共享宿主，见[系统边界](../../../docs/editor-architecture.md)。运行环境不代替职责判断，功能自己的纯算法可以留在其 `browser` 目录。

| 产品或调用方式       | 加载入口             | 得到的能力                                                                                                                                                                                                                                                                             |
| -------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 基础文本组合         | `editor.all.ts`      | 仅装配基础文本命令，供显式选择功能的纯文本宿主使用，不注册 Workbench pane                                                                                                                                                                                                              |
| 兼容组合入口         | `editor.code.all.ts` | 安装客户端内置的通用编辑功能，不依赖 App Server 或扩展进程；宿主注册 text/diff pane                                                                                                                                                                                                    |
| 程序化调用           | `editor.api.ts`      | `editor.create/createModel`、`editor.addCommand/addEditorAction/addKeybindingRule/addKeybindingRules`、`languages.register/registerLanguages/registerProviderBatch/registerLanguage*Provider`、命名主题、standalone model registry、`TextModel`、transaction 和坐标值对象；不注册 pane |
| 基础 standalone 入口 | `editor.main.ts`     | 装配客户端内置 Code 与独立宿主控件，再导出 `editor.api.ts`                                                                                                                                                                                                                             |

客户端 Code 的 Code Action、Hover、Sticky Scroll 分别通过 `codeActionContributions.ts`、`hoverContribution.ts`、`stickyScrollContribution.ts` 注册。注册入口负责装配；Code Action 控制器拥有请求取消、解析和编辑提交，动作菜单的 DOM、键盘导航与关闭生命周期由 `platform/actionWidget` 统一管理。Hover 与 Sticky Scroll 控制器继续拥有各自的界面状态和释放逻辑。独立注册文件是否保留取决于对应职责，不统一套用 `.contribution.ts` 后缀。

Standalone 宿主用 `editor.addEditorAction` 注册全局编辑器动作，可提供快捷键、执行条件和右键菜单位置；动作会出现在 `getAction()` 与 F1 命令列表中。`editor.addKeybindingRule(s)` 可以单独注册带条件的快捷键，`command: null` 表示拦截该按键。两个入口都返回注销句柄。宿主通过 `languages.registerLanguages` 和 `languages.setLanguageConfiguration` 注册语言数据；客户端 Code 的可选输入策略消费这些数据实现配对、缩进与其他语言交互，停用后基础输入继续按纯文本工作。

Standalone 的 F1 快捷入口支持直接筛选命令，也支持 `>` 命令、`?` 帮助和 `@` 文档符号前缀。切换前缀会保留已输入的查询；关闭符号列表会取消尚未完成的符号请求。

`editor.createWebWorker({ worker, host, keepIdleModels })` 接收宿主创建的模块 Worker。Worker 模块从 `standalone/browser/standaloneWebWorker.ts` 导入并调用 `startStandaloneWebWorker(self, context => methods)`，宿主随后通过 `getProxy()` 调用其方法；`withSyncedResources(uris)` 把已注册的模型送入 Worker，后续编辑增量同步，模型释放时删除镜像。Worker 通过 `context.getMirrorModels()` 读取镜像，通过 `context.callHost(method, ...args)` 调用明确提供的宿主方法。默认空闲一分钟后停止同步并清除镜像；`keepIdleModels: true` 保持同步。调用方负责释放 `createWebWorker` 返回的对象。

## 核心文档

Editor 维护以下核心入口。实现 README 可以补充局部细节，但不得复制核心规范。

| 文档                                                       | Canonical responsibility                                                                                                              | 不负责                                           |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| [`README.md`](./README.md)                                 | 扁平目录、单一 TextModel、依赖方向和 Workbench 贡献装配                                                                               | 单套功能实现的完整行为和实现台账                 |
| [`text-engine.md`](./text-engine.md)                       | 行式文本内核、view 架构、input、Contribution 与生命周期契约                                                                           | Workbench pane、文件协议和 App Server transport  |
| [`text-engine-geometry.md`](./text-engine-geometry.md)     | 文本几何、浏览器渲染后端、测量、输入坐标和长期目标契约；中文翻译见 [`text-engine-geometry.zh-CN.md`](./text-engine-geometry.zh-CN.md) | 不拥有完整行式 engine、Workbench pane 或文件协议 |
| [根目录 Editor TODO](../../../TODO.md#stanza-编辑器--todo) | 当前未完成的用户行为、owner 复核与验收事项                                                                                            | 不把尚未实现的上游能力标记为已完成               |

跨系统的 editor/file/language/Workbench/App Server 关系只在 [`docs/editor-architecture.md`](../../../docs/editor-architecture.md) 详细说明。[`browser/README.md`](./browser/README.md) 和其他子目录 README 面向实现维护者，记录局部调用路径、DOM ownership、failure semantics 和测试影响。

## 所有权与依赖方向

| 目录                                                     | 允许依赖                                                             | 拥有                                                                                                                         | 不得拥有                                                                        |
| -------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `common/core`                                            | `base/common`                                                        | 文本坐标、文档坐标、selection、纯变换算法                                                                                    | DOM、Workbench service、App Server DTO                                          |
| `common/model`                                           | `common/core`、`base/common`                                         | `TextModel`、`ITextBuffer`、有序逻辑行、LineId、mark/atom/facet/region/relation、history、schema、transaction、serialization | 文件传输、浏览器 focus、产品 profile                                            |
| `common/services`                                        | `common/languages`、编辑器公共契约、`base/common`、`platform/common` | 语言身份、语言配置和 provider registry 的独立服务契约，以及公开 API 的基础值对象组合                                         | contribution-owned 契约或实现、App Server DTO、产品 provider、Workbench adapter |
| `common/cursor`、`common/viewModel`、`common/viewLayout` | 文本内核与 `base/common`                                             | 行式编辑器实例状态和纯布局投影                                                                                               | DOM 和产品判断                                                                  |
| `browser`                                                | `common`、`base/browser` 和显式前端 service contract                 | code/document/diff/multi-diff widget、输入、viewport、contribution registry 与 editor-facing runtime adapter                 | Workbench pane/input、文件/working-copy 生命周期、Workbench 模式选择            |
| `standalone/common`、`standalone/browser`                | `editor/browser`、`editor/common`、`platform`                        | 单窗口 services、命名主题、URI/language model registry、`editor.create/createModel` 生命周期                                 | 用户主题持久化、文件 dirty/save/revert、Workbench service 或 pane               |
| `contrib/<feature>`                                      | 对应 engine 的最小 contract                                          | 可移除的编辑能力及其命令、状态和投影                                                                                         | 第二套 model、产品级 `if code/academy`                                          |
| `editor.*.all.ts`                                        | contribution entry                                                   | 静态 editor 能力装配                                                                                                         | Workbench pane/input 注册、模型或功能实现                                       |
| `workbench/contrib/{codeEditor,multiDiffEditor}`         | Editor 与 Workbench contract                                         | pane/input、产品 profile、factory 注入和服务接线                                                                             | 编辑事务、selection、viewport 或 feature controller                             |

顶层依赖遵循[代码组织规范](../../../.github/instructions/source-code-organization.instructions.md)：`workbench → editor → platform → base`。因此 Editor 可以依赖 Base 和 Platform；反向依赖禁止。Editor 内部由贡献消费公共契约，公共契约与 registry 不反向依赖贡献，即使只是类型导入。`common` 不使用 DOM 是运行环境限制，不是文件归属标准。每个 `TextModel` 原生拥有有序逻辑行和稳定 `LineId`；通用语义快照通过 mark、atom、facet、region 与 relation 引用同一内容。宿主的派生模型和投影不创建第二份可写正文或编辑历史。

语言提供者、请求及返回值统一声明在 `common/languages.ts`；`ILanguageFeaturesService` 与 `LanguageFeaturesService` 只依赖该公共契约。Standalone、Workbench 和扩展适配器直接注册这些类型；贡献中的 service / controller 继续持有提供者选择、版本检查、取消与结果应用。共享 registry 不导入贡献文件，也不替功能保存请求状态。

内容主轴只有 `TextModel → LineSequence → ModelLine`。持久语义通过互相正交的 `RangeStore`、`PointStore`、`LineFacetStore`、`RegionStore` 与 `RelationStore` 引用 `LineId`；字符仍由 TextModel 私有拥有的 `ITextBuffer` 保存。buffer 当前由 Builder 构建的红黑树 `PieceTreeTextBuffer` 实现，PieceTree 不属于公开模型拓扑。

## 宿主复用与能力注入

宿主负责选择模型、Widget、Provider 和文件生命周期，并通过已有公开契约装配。复用基础模型或自行实现投影不会改变业务归属；Stanza 不能反向导入扩展实现，模型、选区和历史也不能因注入而产生第二份权威状态。

## 同步文本内核与浏览器投影

`TextModel` 是文本、分行、版本、transaction、undo/redo、tracked range 和 snapshot 的唯一同步权威。`CodeEditorWidget` 使用它，但不拥有共享 model；Widget 保持根 DOM 和编辑器身份，View 通过 `onBeforeAttached` / `onBeforeDetached` 报告每次模型挂载。`browser/editorBrowser.ts` 只拥有与 VS Code 同路径的浏览器编辑器契约；`browser/widget/codeEditor/codeEditorWidget.ts` 负责编辑器装配、操作、模型切换和 view state，`codeEditorContributions.ts` 统一拥有每次挂接的 contribution 实例化阶段与生命周期。`BrowserTextModelService` 管理普通文件的 model reference、dirty/conflict 和保存语义；Workbench 的 working copy 持有 reference，并拥有保存前处理、保存、回退、快捷键、结果呈现和 Pane 生命周期。Standalone 则由 `standalone/browser` 管理 URI/language identity；外部传入 model 时 editor 不拥有 model，使用 `value` 隐式创建时 editor 拥有 model，并在切走它时释放。

`CodeEditorWidget` 的主题、语言配置和语言功能服务通过构造参数注入，Widget 不创建这些共享服务。Workbench 与 Standalone 拥有服务注册；每次模型挂载只创建一个子作用域，持有本次贡献和局部服务，拆除时不释放宿主共享服务。测试通过 `test/browser/testCodeEditor.ts` 显式装配依赖。

Diff 的版本化结果由 `common/diff/diffModel.ts` 持有。`browser/widget/diffEditor/diffEditorOptions.ts` 校验创建选项并持有动态布局选项，Workbench 把已注册的单栏宽度设置传入这里。`browser/widget/diffEditor/diffEditorWidget.ts` 负责组合两侧编辑器与滚动、布局和导航；`components/diffEditorSash.ts` 持有双栏宽度比例和可操作的分隔线。`components/diffEditorDecorations.ts` 持有两侧临时 decoration，并把差异行、行内范围和纯插入或删除时的空范围投影到既有编辑器 decoration 系统。`components/diffEditorViewZones/diffEditorViewZones.ts` 持有两侧对齐留白和行内模式的原始行，其生命周期随 Diff Widget 结束。差异标记选项和图标由同目录的 `registrations.contribution.ts` 定义，颜色由 `platform/theme/common/colors/editorColors.ts` 注册，右侧概览 DOM 由 `features/overviewRulerFeature.ts` 持有。修改 Diff 外观时沿这条调用链核对主题、换行、边栏和概览，而不是在 Widget 中另建绘制状态。

`components/accessibleDiffViewer.ts` 从当前版本化结果读取差异文本，F7/Shift+F7 沿 Widget 现有导航状态逐行阅读，Escape 恢复原焦点。`diffEditor.contribution.ts` 注册 Alt+F1 帮助和 Alt+F2 全部差异纯文本视图；`commands.ts` 注册命令面板入口。Workbench 的 `accessibility.verbosity.diffEditor` 设置控制编辑器焦点上的帮助提示。

`diffEditor.renderIndicators` 默认显示新增行的加号和删除行的减号，可在创建或更新 Diff Widget 时覆盖。设置变化同时更新单栏和双栏标记，关闭标记仍保留差异背景。单栏删除行不属于修改侧文本模型，其减号与边栏背景由同一 View Zone 的 `marginDomNode` 持有，沿用修改侧编辑器的边栏宽度、滚动和释放流程。

## Contribution 装配

Contribution 必须满足以下条件：

- 移除后对应 engine 仍能保持模型有效性和基本编辑正确性；
- 依赖 engine contract，而不是读取产品 ID；
- 贡献只依赖所需实现，不读取工作台模式决定编辑规则。
- `editor.all.ts` 仅装配基础文本命令，`editor.code.all.ts` 装配客户端 Code 贡献。

transaction、selection mapping、IME commit 和 model lifecycle 属于内核；find、folding 与 suggest 等可移除功能归各自 contribution。宿主对语义快照的校验仍在其拥有的边界完成。

## 入口与调用路径

```text
Shared Workbench ─────────→ workbench/contrib/multiDiffEditor ─────────→ multi-diff pane/controller/action registration
Code build mode ───────┬→ editor.code.all.ts → editor.all.ts ─────────→ Code feature implementation
                       └→ workbench/contrib/codeEditor ────────────────→ code/diff pane + input registration
Shared Workbench ─────────→ model references / dirty / backup / file transport

editor.api.ts ─────────────→ editor.create/createModel + languages.register/registerLanguage*Provider + TextModel + generic line snapshots
editor.main.ts ────────────→ editor.code.all.ts + editor.api.ts
standalone/{common,browser} ─→ window services + model/editor/language/theme registries; never Workbench persistence
```

`LanguageService` 只管理语言 ID 与文件关联，`ComposableLanguageConfigurationService` 只管理括号、注释、缩进等编辑规则，`LanguageFeaturesService` 只管理能力 provider registry。Standalone 的 `languages` API 和 Workbench 的 App Server、TextMate、扩展适配器都写入这组共享 registry；具体 contribution 消费 registry 并拥有自身请求与展示流程，不要求额外创建 model-level service。公共 provider 契约归 `common/languages.ts`，Editor 不读取服务器 DTO。各 registry 已统一消费公共契约；贡献仅保留自身的请求编排和结果处理。

格式化职责与当前行为：

- 文档、范围和输入格式化分别使用 `DocumentFormattingEditProvider`、`DocumentRangeFormattingEditProvider`、`OnTypeFormattingEditProvider`，从 `ITextModel` 读取模型，通过 `CancellationToken` 接收取消。
- `format.ts` 整理整文与范围提供者，按扩展身份忽略大小写去重；同一个宿主 adapter 同时注册两个接口时仍只算一个提供者。`FormattingConflicts` 使用最近注册的选择策略，释放后恢复旧策略。Workbench 的窗口贡献读取语言级 `editor.defaultFormatter`，显式冲突通过 Quick Pick 选择本次格式化器，或通过“配置默认格式化器”保存当前语言默认值；自动格式化遇到冲突或失效默认值不弹窗、不静默改用其他提供者。独立 Standalone 宿主未注册选择策略时仍取排序后的首个提供者。
- 整文与选区命令只执行选中的提供者，空结果或失败不切换到其他提供者。手动命令传递 `FormattingMode.Explicit`，保存格式化传递 `Silent`。
- `editor.action.formatSelection`（Ctrl/Cmd+K、Ctrl/Cmd+F）把空选区扩展为当前行；多选区优先使用批量接口，否则逐范围查询。结果交叠时合并请求范围重新查询，丢弃旧结果；选区变化取消等待，所有编辑共享一次撤销。命令可用状态随提供者注册、注销和模型语言变化更新。
- `format.ts` 拥有请求选择、交叠处理、取消和 worker 调用，`formattingEdit.ts` 提交编辑；不再构造格式化控制器。`formatActions.ts` 注册命令、当前键盘入口和保存钩子。Widget 将既有 worker 客户端注册到模型作用域，模型解绑时释放；格式化选项读取当前模型。资源级 worker-service 与完整上游格式化调度 API 仍待对齐，`formatEditor` 是当前模型绑定调用入口。
- 输入格式化要求提供者声明触发字符。`FormatOnType` 在启用 `formatOnType` 后消费 `onDidType`，支持普通字符和 Enter，通过同一模型 Worker 提交最小编辑，并与触发字符一次撤销；设置关闭、provider 撤回、模型／语言变化、只读和组合输入开始取消等待。App Server LSP 桥接协商 `firstTriggerCharacter`／`moreTriggerCharacter`，按目录与语言注册，并将输入后位置、字符、格式选项与快照发送至 `textDocument/onTypeFormatting`；取消传播到 LSP，旧版本或已撤回能力的结果不再应用。独立扩展宿主的 provider 注册协议仍只桥接文档和范围格式化。

共享扩展宿主在恢复标签页之前接入 Academy 的实时能力注册；旧的静态文档和 Academy factory 已退出。`DocumentTypes` 保存活跃文档类型和包声明的保护路由，默认代码 pane 排除这些资源；文档 pane 使用已准入 profile 的 Widget、Schema 和 codec。Workbench 范围的 `DocumentEditorTextModelService` 管理资源引用，多视图共享模型和保存状态，最后一个引用释放时才销毁模型。

## 关键实现符号

| 符号                           | 责任                                                                                                                                                                                 | 修改时必须同步检查                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `TextModel`                    | TextBuffer、LineId、version、history、line snapshot                                                                                                                                  | cursor、selection、language result version gate、model tests                                          |
| `LineDocumentSnapshot`         | 有序逻辑行与 mark/atom/facet/region/relation 的单版本只读视图                                                                                                                        | schema projection、codec、renderer、model tests                                                       |
| `ITextBuffer`                  | `common/model.ts` 拥有的字符与物理行存储 contract；PieceTree 是当前私有实现                                                                                                          | TextModel edit、snapshot、worker mirror、maintenance                                                  |
| `CodeEditorWidget`             | Code 模式的行式 DOM projection 与 input/navigation surface                                                                                                                           | viewport、accessibility、contributed controllers                                                      |
| `StandaloneServices`           | standalone 窗口级 model/language-identity/language-configuration/language-features/theme/worker 服务；服务与 worker 只允许首次初始化覆盖，theme 始终由 `StandaloneThemeService` 拥有 | `editor.api.ts`、standalone 生命周期测试、调试入口                                                    |
| `StandaloneEditor`             | `standaloneCodeEditor.ts` 的独立编辑器 owner；绑定主题、决定 model 所有权，并让 `create`、创建事件与 editor registry 共享同一对象身份                                                | `standaloneEditor.ts`、model/editor 生命周期测试                                                      |
| `StandaloneThemeService`       | 命名主题注册、默认 Light、活动主题切换与系统高对比度投影；不读取 Workbench 配置                                                                                                      | `editor.create` 的 `theme`/`autoDetectHighContrast`、`editor.defineNamedTheme/setTheme`、主题服务测试 |
| `CodeEditorContributions`      | 每次模型挂载的贡献创建、延迟调度与释放；Quick Diff 也走同一创建路径                                                                                                                  | 模型切换、首次交互、失败后仍可渲染、显式获取贡献                                                      |
| `registerEditorContribution`   | 编辑器贡献的统一注册；构造器、视图前配置、视图后安装共用 ID 和注册顺序                                                                                                               | `editor.*.all.ts`、text/document 挂载点和 contribution 顺序                                           |
| `RichTextEditorWidget`         | 结构化节点、marks、selection 与 node-view lifecycle                                                                                                                                  | schema profile、clipboard、collaboration decoration                                                   |
| `EditorProfile`                | schema、empty document、node view、toolbar、plugin 和 collaboration schema ID 的稳定组合                                                                                             | Academy bundle、持久格式兼容性、协作房间兼容性                                                        |
| Workbench `registerEditorPane` | Workbench pane descriptor 注册                                                                                                                                                       | 模式入口、editor ID 唯一性、pane matching 顺序；不得从 `editor` bundle 调用                           |

如果 common model 开始 import Workbench/generated DTO、contribution 开始拥有第二套 model state、或产品 ID 出现在 feature/controller 中，即表示所有权已经漂移。

Standalone 调用者通过 `ash-light`、`ash-dark`、`ash-high-contrast-light`、`ash-high-contrast-dark` 这些内置主题名，或通过 `editor.defineNamedTheme` 注册的自定义主题名调用 `editor.setTheme`。`IColorTheme` 与编译后的内置主题快照属于 `platform/theme` 和 `StandaloneThemeService` 的内部状态，不从 `editor.api.ts` 导出，也不能通过 standalone service override 注入。

F1 的 `Developer: Inspect Tokens` 动作在光标旁显示当前词法 token 的语言、原始 scope、修饰符和前景色；普通与 Monarch tokenizer 的 scope 与编码后的主题颜色由同一次分词结果保留。光标移动和主题变化会刷新内容，Escape、模型卸载或编辑器释放会关闭检查器。检查器只读取模型已有分词结果，不另起分词链。

`editor.defineTheme` 接受标准 `base`、`inherit`、`rules` 和 `colors`，内置基底为 `vs`、`vs-dark`、`hc-black`、`hc-light`，颜色来自 Ash 平台主题。`languages.setTokensProvider` 接受普通或编码 tokenizer，`registerTokensProviderFactory` 按模型需要延迟创建。两者进入同一个 TokenizationRegistry；主题切换同步更新着色与复制使用的颜色表。`languages.setColorMap` 可以设置编码颜色表，传入 `null` 恢复当前主题的颜色表。

`languages.onLanguage` 在模型首次使用语言时激活，`onLanguageEncountered` 也接收 Monarch 嵌入语言的首次使用。监听可在服务初始化前注册并释放；`getLanguages` 返回独立的语言描述。`setMonarchTokensProvider` 编译声明式规则，状态随模型的逐行分词缓存传递；规则支持 include、捕获组、条件、状态栈、rematch 和嵌入语言，使用同一主题及语言编码表。注册和延迟创建的 tokenizer 随返回句柄释放。

`editor.colorize` 和 `colorizeElement` 使用相同 tokenizer 生成一次性的 HTML，复用已有的 HTML 转义与 token 样式序列化，不创建模型或 Worker。元素入口读取 `lang` / `data-lang`，也可通过 `mimeType` 指定语言；片段需要更新时由调用者重新着色。

`editor.create({ model: null })` 创建尚未挂接模型的编辑器，不分配文本模型或 Worker；后续 `setModel` 挂接已注册的模型，编辑器身份保持不变。`updateOptions` 接受 `theme` 和 `autoDetectHighContrast`，它们修改同一窗口的共享主题。内部通过 `StandaloneServices.get(serviceId)` 获取服务，`initialize` 返回该窗口的实例化容器。

完整 standalone 入口提供 F1 命令面板和“切换高对比度主题”动作。F1 输入 `?` 可筛选命令面板、符号、行号和字符偏移量四种导航入口；选择后调用对应的原动作。平台 QuickInputController 统一负责选择弹层和焦点恢复；Workbench 使用窗口宿主，standalone 使用当前编辑器宿主，并随编辑器释放。命令面板枚举当前可用的编辑器动作，执行仍走原动作、上下文条件和错误通知链。

## 失败与兼容边界

- 文本和结构化 mutation 失败必须在提交前抛出，不能留下部分版本、history、structure index 或 plugin state。
- 异步语言、diff、文件和协作结果必须按 model version 或服务器版本拒绝过期结果。
- Workbench 模式 bundle 在 Renderer 启动时静态装配，不提供运行时卸载 contribution 的承诺。
- Stanza 自有的公开入口、editor ID、content type 和 DOM vocabulary 必须使用 `stanza` 品牌；Workbench 通用 editor part 与主题语义 token 仍由各自 owner 命名。不得重新引入旧 editor 兼容标识。

## 测试与修改影响

- `test:editor:unit` 编译并运行 Stanza 内核、Code/Diff Pane、语言与普通文件宿主 adapter 测试。
- `test:editor:browser` 验证 Stanza 的 TextModel、Code、Diff、输入、布局、主题、语言和可访问性。扩展客户端通过 `test:browser:integration <spec>` 独立验证；完整浏览器入口和 CI 继续覆盖这些扩展用例。
- `test/architecture/editor-architecture.test.ts` 验证扁平目录、单一 TextModel authority 和模式 bundle。

修改产品装配时运行相关架构测试和 Common／Renderer 类型检查；修改模型、输入或序列化时运行对应的 unit/browser suite。按代码 owner 选择验证范围，扩展组合与产品环境验收不计入 Stanza 基础完成条件。
