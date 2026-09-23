# Stanza

> 本文是 `ash-ts/src/ash/editor` 的 canonical 目录、所有权和装配入口。Stanza 类似 Monaco 在 VS Code 中的位置；`editor/` 是一个扁平领域目录，不是第二个品牌或额外架构层。TextBuffer 与富文档的设计规范分别见 [`text-engine.md`](./text-engine.md) 和 [`document-engine.md`](./document-engine.md)，跨 Workbench、文件、语言服务与 App Server 的系统边界见 [`docs/editor-architecture.md`](../../../../docs/editor-architecture.md)。

## 快速理解

Stanza 以 VS Code `src/vs/editor` 为职责参照：`common` 拥有编辑器公共契约与内核，`browser` 拥有浏览器编辑器实现，`contrib` 拥有可装配功能，`test` 保存内核级回归测试。运行环境不代替职责判断：功能自己的纯算法可以留在其 `browser` 目录，不要求每个 contribution 建立 `common`。当前代码的归属缺口见[对齐台账](./api-alignment-status.md)。Stanza 只有一个源码域、一套公开入口和一个同步权威：按行存储的 `TextModel`。Code 与 Academic 是建立在同一模型上的两套功能实现。

| 产品或调用方式 | 加载入口 | 得到的能力 |
| --- | --- | --- |
| 完整行式实现 | `editor.all.ts` | Code 使用的完整行式 contribution 集合；不注册 Workbench pane |
| Code 功能实现 | `editor.code.all.ts` | 加载完整行式实现，由 Code Workbench 注册 code/diff pane |
| Academic 功能实现 | `editor.academic.all.ts` | 只加载 Academic 富文档 contribution；不加载 Code bundle 或 Code pane |
| 程序化调用 | `editor.api.ts` | `editor.create/createModel`、`editor.addCommand/addEditorAction/addKeybindingRule/addKeybindingRules`、`languages.register/registerLanguages/registerProviderBatch/registerLanguage*Provider`、命名主题、standalone model registry、`TextModel`、schema、transaction 和坐标值对象；不注册 pane |
| 完整 standalone 入口 | `editor.main.ts` | 先加载 `editor.all.ts` 的完整行式 contribution，再导出 `editor.api.ts` |

Code Action、Hover、Sticky Scroll 分别通过 `codeActionContributions.ts`、`hoverContribution.ts`、`stickyScrollContribution.ts` 注册。注册入口负责装配；控制器继续拥有请求、界面状态和释放逻辑。独立注册文件是否保留取决于对应职责，不统一套用 `.contribution.ts` 后缀。

Standalone 宿主用 `editor.addEditorAction` 注册全局编辑器动作，可提供快捷键、执行条件和右键菜单位置；动作会出现在 `getAction()` 与 F1 命令列表中。`editor.addKeybindingRule(s)` 可以单独注册带条件的快捷键，`command: null` 表示拦截该按键。两个入口都返回注销句柄。括号、注释等语言行为由宿主通过 `languages.registerLanguages` 和 `languages.setLanguageConfiguration` 注册。

## 核心文档

Editor 维护以下核心入口。实现 README 可以补充局部细节，但不得复制核心规范。

| 文档 | Canonical responsibility | 不负责 |
| --- | --- | --- |
| [`README.md`](./README.md) | 扁平目录、单一 TextModel、依赖方向和 Workbench 模式装配 | 单套功能实现的完整行为和实现台账 |
| [`text-engine.md`](./text-engine.md) | 行式文本内核、view 架构、input、Contribution、当前状态和演进 | Workbench pane、文件协议和 App Server transport |
| [`text-engine-geometry.md`](./text-engine-geometry.md) | 文本几何、浏览器渲染后端、测量、输入坐标和长期目标契约；中文翻译见 [`text-engine-geometry.zh-CN.md`](./text-engine-geometry.zh-CN.md) | 不拥有完整行式 engine、Workbench pane 或文件协议 |
| [`document-engine.md`](./document-engine.md) | Schema-backed Block、transaction、browser projection、profile 和 collaboration | TextBuffer 语义和产品 pane 生命周期 |
| [`api-alignment-status.md`](./api-alignment-status.md) | 全量 VS Code API/owner 扫描结果、已清除的误导性同名职责和真实能力缺口 | 不把尚未实现的上游能力标记为已完成 |

跨系统的 editor/file/language/Workbench/App Server 关系只在 [`docs/editor-architecture.md`](../../../../docs/editor-architecture.md) 详细说明。[`browser/README.md`](./browser/README.md) 和其他子目录 README 面向实现维护者，记录局部调用路径、DOM ownership、failure semantics 和测试影响。

## 所有权与依赖方向

| 目录 | 允许依赖 | 拥有 | 不得拥有 |
| --- | --- | --- | --- |
| `common/core` | `base/common` | 文本坐标、文档坐标、selection、纯变换算法 | DOM、Workbench service、App Server DTO |
| `common/model` | `common/core`、`base/common` | `TextModel`、`ITextBuffer`、有序逻辑行、LineId、mark/atom/facet/region/relation、history、schema、transaction、serialization | 文件传输、浏览器 focus、产品 profile |
| `common/services` | `common/languages`、编辑器公共契约、`base/common`、`platform/common` | 语言身份、语言配置和 provider registry 的独立服务契约，以及公开 API 的基础值对象组合 | contribution-owned 契约或实现、App Server DTO、产品 provider、Workbench adapter |
| `common/cursor`、`common/viewModel`、`common/viewLayout` | 文本内核与 `base/common` | 行式编辑器实例状态和纯布局投影 | DOM 和产品判断 |
| `browser` | `common`、`base/browser` 和显式前端 service contract | code/document/diff/multi-diff widget、输入、viewport、contribution registry 与 editor-facing runtime adapter | Workbench pane/input、文件/working-copy 生命周期、Workbench 模式选择 |
| `standalone/common`、`standalone/browser` | `editor/browser`、`editor/common`、`platform` | 单窗口 services、命名主题、URI/language model registry、`editor.create/createModel` 生命周期 | 用户主题持久化、文件 dirty/save/revert、Workbench service 或 pane |
| `contrib/<feature>` | 对应 engine 的最小 contract | 可移除的编辑能力及其命令、状态和投影 | 第二套 model、产品级 `if code/academic` |
| `editor.*.all.ts` | contribution entry | 静态 editor 能力装配 | Workbench pane/input 注册、模型或功能实现 |
| `workbench/contrib/{codeEditor,multiDiffEditor,documentEditor,academic}` | Editor 与 Workbench contract | pane/input、产品 profile、factory 注入和服务接线 | 编辑事务、selection、viewport 或 feature controller |

顶层依赖遵循[代码组织规范](../../../../.github/instructions/source-code-organization.instructions.md)：`workbench → editor → platform → base`。因此 Editor 可以依赖 Base 和 Platform；反向依赖禁止。Editor 内部由贡献消费公共契约，公共契约与 registry 不反向依赖贡献，即使只是类型导入。`common` 不使用 DOM 是运行环境限制，不是文件归属标准。每个 `TextModel` 原生拥有有序逻辑行和稳定 `LineId`；Code 使用只有行与文档 metadata 的受限 profile，Academic 额外使用 mark、atom、facet、region 与 relation。浏览器投影和 Workbench 不得为代码区域或其他语义对象再创建隐藏模型。

语言提供者、请求及返回值统一声明在 `common/languages.ts`；`ILanguageFeaturesService` 与 `LanguageFeaturesService` 只依赖该公共契约。Standalone、Workbench 和扩展适配器直接注册这些类型；贡献中的 service / controller 继续持有提供者选择、版本检查、取消与结果应用。共享 registry 不导入贡献文件，也不替功能保存请求状态。


内容主轴只有 `TextModel → LineSequence → ModelLine`。持久语义通过互相正交的 `RangeStore`、`PointStore`、`LineFacetStore`、`RegionStore` 与 `RelationStore` 引用 `LineId`；字符仍由 TextModel 私有拥有的 `ITextBuffer` 保存。buffer 当前由 Builder 构建的红黑树 `PieceTreeTextBuffer` 实现，PieceTree 不属于公开模型拓扑。

## 一个品牌，两套功能实现

Stanza 是整个编辑器的名称，但 Code 与 Academic 是两套独立的 feature implementation：Code 组合文件级行式命令、语言能力、diff 与 Code Workbench pane；Academic 组合 group、typed block、document transaction、citation、formatting 与 Academic Workbench pane。二者都使用 `TextModel`，但不复用对方的 pane、controller 集合或 mode bundle。

 Academic 代码区域是当前 `TextModel` 中一个带类型和连续行范围的 projection。`RichTextEditorWidget` 直接编辑这段行范围；它不创建嵌套 `TextModel`，也不启动 Code pane 或 Code contribution bundle。

## 一个同步内核，两套投影

### 行式文本 engine

`TextModel` 是文本、分行、版本、transaction、undo/redo、tracked range 和 snapshot 的唯一同步权威。`CodeEditorWidget` 使用它，但不拥有共享 model；Widget 保持根 DOM 和编辑器身份，View 通过 `onBeforeAttached` / `onBeforeDetached` 报告每次模型挂载。`browser/editorBrowser.ts` 只拥有与 VS Code 同路径的浏览器编辑器契约；`browser/widget/codeEditor/codeEditorWidget.ts` 负责编辑器装配、操作、模型切换和 view state，`codeEditorContributions.ts` 统一拥有每次挂接的 contribution 实例化阶段与生命周期。`BrowserTextModelService` 管理普通文件的 model reference、dirty/conflict 和保存语义；Workbench 的 working copy 持有 reference，并拥有保存前处理、保存、回退、快捷键、结果呈现和 Pane 生命周期。Standalone 则由 `standalone/browser` 管理 URI/language identity；外部传入 model 时 editor 不拥有 model，使用 `value` 隐式创建时 editor 拥有 model，并在切走它时释放。

`CodeEditorWidget` 的主题、语言配置和语言功能服务通过构造参数注入，Widget 不创建这些共享服务。Workbench 与 Standalone 拥有服务注册；每次模型挂载只创建一个子作用域，持有本次贡献和局部服务，拆除时不释放宿主共享服务。测试通过 `test/browser/testCodeEditor.ts` 显式装配依赖。

### 富文档 engine

Academic 使用与 Code 相同的 `TextModel`、`TextBuffer`、`LineSequence` 和版本号，并用 schema 定义允许的 mark、atom、facet、region、relation、selection、transaction history、plugin state 与 serialization。`TextModel.lineDocument` 给出当前不可变语义快照；字符和逻辑行始终由 TextModel 唯一保存。Workbench-owned `DocumentEditorTextModelService` 负责 reference、working copy 和保存边界。

Code 与 Academic 都使用原生 line-first TextModel。Schema-backed 命令必须通过 `TextModel.dispatch()` 同时更新 TextBuffer 与语义快照；不能直接修改 PieceTree 实现。新增能力应依赖 TextModel、TextBuffer 或五类语义 store 的小而完整 contract，不得创建第二套 model authority。

## Contribution 装配

Contribution 必须满足以下条件：

- 移除后对应 engine 仍能保持模型有效性和基本编辑正确性；
- 依赖 engine contract，而不是读取产品 ID；
- schema-bearing 能力通过 `EditorProfile` 稳定组合，不能在打开文档后任意开关；
- 不隐式 import 另一个模式 bundle；跨 engine 适配只能 import 所需实现。
- 正式产品只承诺 `editor.code.all.ts` 与 `editor.academic.all.ts` 两个完整模式入口，不承诺任意 contribution 子集都能组成受支持的产品。

因此 transaction、selection mapping、IME commit、schema validation 和 model lifecycle 属于 engine；find、folding、suggest、citation toolbar 与 collaboration projection 等属于 contribution 或 profile composition。

## 入口与调用路径

```text
Shared Workbench ─────────→ workbench/contrib/multiDiffEditor ─────────→ multi-diff pane/controller/action registration
Code build mode ───────┬→ editor.code.all.ts → editor.all.ts ─────────→ Code feature implementation
                       └→ workbench/contrib/codeEditor ────────────────→ code/diff pane + input registration
Academic build mode ───┬→ editor.academic.all.ts → document contribution only
                       └→ workbench/contrib/academic ──────→ profile + document pane registration

editor.api.ts ─────────────→ editor.create/createModel + languages.register/registerLanguage*Provider + TextModel/document APIs
editor.main.ts ────────────→ editor.all.ts + editor.api.ts
standalone/{common,browser} ─→ window services + model/editor/language/theme registries; never Workbench persistence
```

`LanguageService` 只管理语言 ID 与文件关联，`ComposableLanguageConfigurationService` 只管理括号、注释、缩进等编辑规则，`LanguageFeaturesService` 只管理能力 provider registry。Standalone 的 `languages` API 和 Workbench 的 App Server、TextMate、扩展适配器都写入这组共享 registry；具体 contribution 消费 registry 并拥有自身请求与展示流程，不要求额外创建 model-level service。公共 provider 契约归 `common/languages.ts`，Editor 不读取服务器 DTO。各 registry 已统一消费公共契约；贡献仅保留自身的请求编排和结果处理。

格式化职责与当前行为：

- 文档、范围和输入格式化分别使用 `DocumentFormattingEditProvider`、`DocumentRangeFormattingEditProvider`、`OnTypeFormattingEditProvider`，从 `ITextModel` 读取模型，通过 `CancellationToken` 接收取消。
- `format.ts` 整理整文与范围提供者，按扩展身份忽略大小写去重，并通过 `FormattingConflicts` 选择。后注册的策略优先，释放后恢复旧策略。Standalone 服务与 Workbench 生命周期分别注册默认排序策略；默认格式化器配置和选择界面仍待实现。
- 整文与选区命令只执行选中的提供者，空结果或失败不切换到其他提供者。手动命令传递 `FormattingMode.Explicit`，保存格式化传递 `Silent`。
- `editor.action.formatSelection`（Ctrl/Cmd+K、Ctrl/Cmd+F）把空选区扩展为当前行；多选区优先使用批量接口，否则逐范围查询。结果交叠时合并请求范围重新查询，丢弃旧结果；选区变化取消等待，所有编辑共享一次撤销。命令可用状态随提供者注册、注销和模型语言变化更新。
- `format.ts` 拥有请求选择、交叠处理、取消和 worker 调用，`formattingEdit.ts` 提交编辑；不再构造格式化控制器。`formatActions.ts` 注册命令、当前键盘入口和保存钩子。Widget 将既有 worker 客户端注册到模型作用域，模型解绑时释放；格式化选项读取当前模型。资源级 worker-service 与完整上游格式化调度 API 仍待对齐，`formatEditor` 是当前模型绑定调用入口。
- 输入格式化要求提供者声明触发字符；Standalone 支持显式注册，`formatOnType` 自动触发链仍未接通。扩展注册协议尚未提供触发字符，因此扩展桥接只注册文档和范围格式化。

Workbench 模式 contribution 是唯一能力选择点。Code 与 Academic 各自加载一个功能实现 bundle，并与对应 Workbench contribution 配对；Academic 不以 `editor.all.ts` 为基底。共享入口在窗口启动时只加载一个 bundle；切换模式通过 reload 创建新的 Renderer 生命周期。新增模式必须先登记 `WorkbenchModeId` 并补齐 Browser/Electron 的穷尽 loader 映射；不得在共享 Workbench、widget 或 model 内增加模式分支。

## 关键实现符号

| 符号 | 责任 | 修改时必须同步检查 |
| --- | --- | --- |
| `TextModel` | TextBuffer、LineId、version、history、line snapshot | cursor、selection、language result version gate、model tests |
| `LineDocumentSnapshot` | 有序逻辑行与 mark/atom/facet/region/relation 的单版本只读视图 | schema projection、codec、renderer、model tests |
| `ITextBuffer` | `common/model.ts` 拥有的字符与物理行存储 contract；PieceTree 是当前私有实现 | TextModel edit、snapshot、worker mirror、maintenance |
| `CodeEditorWidget` | Code 模式的行式 DOM projection 与 input/navigation surface | viewport、accessibility、contributed controllers |
| `StandaloneServices` | standalone 窗口级 model/language-identity/language-configuration/language-features/theme/worker 服务；服务与 worker 只允许首次初始化覆盖，theme 始终由 `StandaloneThemeService` 拥有 | `editor.api.ts`、standalone 生命周期测试、调试入口 |
| `StandaloneEditor` | `standaloneCodeEditor.ts` 的独立编辑器 owner；绑定主题、决定 model 所有权，并让 `create`、创建事件与 editor registry 共享同一对象身份 | `standaloneEditor.ts`、model/editor 生命周期测试 |
| `StandaloneThemeService` | 命名主题注册、默认 Light、活动主题切换与系统高对比度投影；不读取 Workbench 配置 | `editor.create` 的 `theme`/`autoDetectHighContrast`、`editor.defineNamedTheme/setTheme`、主题服务测试 |
| `CodeEditorContributions` | 每次模型挂载的贡献创建、延迟调度与释放；Quick Diff 也走同一创建路径 | 模型切换、首次交互、失败后仍可渲染、显式获取贡献 |
| `registerEditorContribution` | 编辑器贡献的统一注册；构造器、视图前配置、视图后安装共用 ID 和注册顺序 | `editor.*.all.ts`、text/document 挂载点和 contribution 顺序 |
| `RichTextEditorWidget` | 结构化节点、marks、selection 与 node-view lifecycle | schema profile、clipboard、collaboration decoration |
| `EditorProfile` | schema、empty document、node view、toolbar、plugin 和 collaboration schema ID 的稳定组合 | Academic bundle、持久格式兼容性、协作房间兼容性 |
| Workbench `registerEditorPane` | Workbench pane descriptor 注册 | 模式入口、editor ID 唯一性、pane matching 顺序；不得从 `editor` bundle 调用 |

如果 common model 开始 import Workbench/generated DTO、contribution 开始拥有第二套 model state、或产品 ID 出现在 feature/controller 中，即表示所有权已经漂移。

Standalone 调用者通过 `ash-light`、`ash-dark`、`ash-high-contrast-light`、`ash-high-contrast-dark` 这些内置主题名，或通过 `editor.defineNamedTheme` 注册的自定义主题名调用 `editor.setTheme`。`IColorTheme` 与编译后的内置主题快照属于 `platform/theme` 和 `StandaloneThemeService` 的内部状态，不从 `editor.api.ts` 导出，也不能通过 standalone service override 注入。

`editor.defineTheme` 接受标准 `base`、`inherit`、`rules` 和 `colors`，内置基底为 `vs`、`vs-dark`、`hc-black`、`hc-light`，颜色来自 Ash 平台主题。`languages.setTokensProvider` 接受普通或编码 tokenizer，`registerTokensProviderFactory` 按模型需要延迟创建。两者进入同一个 TokenizationRegistry；主题切换同步更新着色与复制使用的颜色表。`languages.setColorMap` 可以设置编码颜色表，传入 `null` 恢复当前主题的颜色表。

`languages.onLanguage` 在模型首次使用语言时激活，`onLanguageEncountered` 也接收 Monarch 嵌入语言的首次使用。监听可在服务初始化前注册并释放；`getLanguages` 返回独立的语言描述。`setMonarchTokensProvider` 编译声明式规则，状态随模型的逐行分词缓存传递；规则支持 include、捕获组、条件、状态栈、rematch 和嵌入语言，使用同一主题及语言编码表。注册和延迟创建的 tokenizer 随返回句柄释放。

`editor.colorize` 和 `colorizeElement` 使用相同 tokenizer 生成一次性的 HTML，复用已有的 HTML 转义与 token 样式序列化，不创建模型或 Worker。元素入口读取 `lang` / `data-lang`，也可通过 `mimeType` 指定语言；片段需要更新时由调用者重新着色。

`editor.create({ model: null })` 创建尚未挂接模型的编辑器，不分配文本模型或 Worker；后续 `setModel` 挂接已注册的模型，编辑器身份保持不变。`updateOptions` 接受 `theme` 和 `autoDetectHighContrast`，它们修改同一窗口的共享主题。内部通过 `StandaloneServices.get(serviceId)` 获取服务，`initialize` 返回该窗口的实例化容器。

完整 standalone 入口提供 F1 命令面板和“切换高对比度主题”动作。平台 QuickInputController 统一负责选择弹层和焦点恢复；Workbench 使用窗口宿主，standalone 使用当前编辑器宿主，并随编辑器释放。命令面板枚举当前可用的编辑器动作，执行仍走原动作、上下文条件和错误通知链。

## 失败与兼容边界

- 文本和结构化 mutation 失败必须在提交前抛出，不能留下部分版本、history、structure index 或 plugin state。
- 异步语言、diff、文件和协作结果必须按 model version 或服务器版本拒绝过期结果。
- Academic schema 与 `collaborationSchemaId` 是持久兼容边界；改变节点语义时必须同步迁移、serialization 测试和 collaboration 测试。
- Workbench 模式 bundle 在 Renderer 启动时静态装配，不提供运行时卸载 contribution 的承诺。
- Stanza 自有的公开入口、editor ID、content type 和 DOM vocabulary 必须使用 `stanza` 品牌；Workbench 通用 editor part 与主题语义 token 仍由各自 owner 命名。不得重新引入旧 editor 兼容标识。

## 测试与修改影响

- `test:editor:unit` 编译并运行 editor 内核测试，以及随 owner 迁移到 Workbench 的 code/document pane 与 collaboration adapter 测试。
- `test:editor:browser` 在同一浏览器 suite 内验证 Code/Academic TextModel 挂载点、输入、布局、代码块行范围和可访问性集成。
- `test/architecture/editor-architecture.test.ts` 验证扁平目录、单一 TextModel authority 和模式 bundle。

修改 product composition 时至少运行架构测试和两个 Renderer 类型检查目标；修改 model、input、serialization 或 schema 时运行对应 engine 的 unit/browser suite。浏览器集成测试应在统一 Stanza 测试入口下按具体 model 挂载点命名，不再以历史 engine 代号表达架构所有权。
