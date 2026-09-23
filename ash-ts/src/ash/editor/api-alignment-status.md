# Editor API 对齐状态

## Standalone 目录对齐（2026-09-22，进行中）

起始工作树干净，基线 `9526e1364`。完整目录调查为 6 个同路径文件、3 个仅 Ash 文件、26 个仅上游生产文件（20 个 TypeScript、4 个 CSS、2 个图像）。名称差异只用来调查，不作为实现队列或完成指标。

用户已确认：将 `standalone/browser/namedEditorThemeService.ts` 迁入 `standalone/browser/standaloneThemeService.ts`，将 `standalone/common/namedEditorTheme.ts` 迁入 `standalone/common/standaloneTheme.ts`；迁完全部引用后删除两个旧路径，Git 基线可恢复。当时保留 `standalone/common/builtinLanguages.ts` 的内置语言装配职责；该决定随后由“语言声明归属修正”更新。语言批量注册、provider 批量替换和 Worker 工厂注入能力仍予保留。

首批准入链：`editor.create / setTheme / defineNamedTheme` → StandaloneServices → 单窗口主题服务 → 原主题注册表与强制颜色监听 → 已有主题绑定更新 → 主题服务单测、公开入口单测与真实浏览器主题场景。主题数据仍由平台颜色注册表编译，编辑器根、菜单根、焦点、布局和模型状态的 owner 不变。

| 准确路径（相对 `ash-ts/src/ash/editor/`） | 关系 | 首批动作 |
| --- | --- | --- |
| `standalone/browser/namedEditorThemeService.ts` → `standalone/browser/standaloneThemeService.ts` | 仅 Ash → 仅上游 | 迁移原实现，统一类名，保留主题状态和监听释放 |
| `standalone/common/namedEditorTheme.ts` → `standalone/common/standaloneTheme.ts` | 仅 Ash → 仅上游 | 迁移主题契约，保留已确认的 Ash 主题数据 |
| `standalone/browser/standaloneServices.ts`、`standaloneEditor.ts`、`editor.api.ts` | 双方都有 | 同批迁移上述主题引用，不建立别名或第二个服务 |
| `test/browser/namedEditorThemeService.test.ts`、`standaloneEditor.test.ts` | 既有测试 | 原主题和公开入口行为回归 |
| `README.md`、`api-alignment-status.md` | 既有文档 | 更新当前归属与验证，保留历史记录 |

初始调查确认：`model: null` 尚不支持；构造选项类型位于错误 owner；运行时主题选项没有进入主题服务；StandaloneServices 使用固定字段集合而非标准服务参数；DiffWidget 是只读差异展示，不提供两侧可编辑器，不能包一层便称为完整 standalone diff；Quick Input 只有选择列表契约，缺少快捷入口；TokenizationRegistry 已存在，但标准 token 主题、provider 适配与 Monarch 尚未接通。后续修改须逐条补齐所需 owner 和真实调用，不预建外围文件。

基线 `typecheck:stanza` 在 Node 24.21.0 下通过。系统默认 Node 25 的首次命令被仓库版本检查拒绝；没有据此跳过检查。本段暂不声明功能完成。

创建续批准入：`editor.create({ model: null }) / updateOptions` → StandaloneEditor → CodeEditorWidget 原模型挂接槽 / 原主题服务 → 无模型时不创建 TextModel 或 Worker，后续挂接 caller model，运行时切换主题。增加准确路径 `browser/widget/codeEditor/codeEditorWidget.ts`（双方都有，仅构造时允许空模型）、`standalone/browser/standaloneCodeEditor.ts`（选项类型归位、主题选项转交）、既有 `test/integration/browser/standalone.integration.ts` / `.spec.ts`（仓库根下 `ash-ts/`）。模型与 DOM 的原 owner、挂接和释放机制不变。

服务续批准入：现有 editor / languages API → `StandaloneServices.get(serviceId)` → 唯一窗口容器 → 现有模型、语言、命令与主题实例。`StandaloneServiceCollection` 直接成为原 ServiceContainer 的窗口作用域，取消内部第二个容器和无参数 get；保留已确认的 Worker 注入数据。准确新增修改范围为 `standalone/browser/standaloneLanguages.ts` 及既有 `ash-ts/test/integration/browser/language.integration.ts`，其余沿用前两批路径。所有注册、创建与释放仍走原容器实现，不引入额外查找机制。

已实现并经定向行为验证：两个主题文件迁移及旧引用退出；构造选项类型回到 `standaloneCodeEditor.ts`；`model: null` 创建时没有模型和 Worker，后续可挂接、编辑并释放 caller model；编辑器 ID 在无模型时就确定并保持稳定；`updateOptions` 的主题与自动高对比度选项进入唯一主题服务；模型事件使用 `ITextModel`；语言变化事件保留调用上下文和外部释放容器。主题实现目前仍采用已确认的 Ash 主题数据，不把路径迁移算成完整 token 主题契约完成。

### 尚未闭合的完整目录清单

以下路径均相对 `standalone/`，记录尚未闭合的职责；已有文件仍不代表完整契约。主题、命令选择弹层、高对比度动作、token 规则、Monarch 与独立着色接通后，当时为 18 个同路径、1 个保留的 Ash 文件、14 个缺失生产文件。

| 上游缺失路径 | 当前下层条件 |
| --- | --- |
| `browser/standalone-tokens.css` | token 规则、继承和颜色表已进入既有 ViewLine presentation 与富文本复制链；尚无需要单独生成 token class 样式的调用方，不创建空 CSS |
| `browser/inspectTokens/inspectTokens.ts`、`inspectTokens.css` | 需要完整 token 结果、主题解释及真实检查控件；目前未注册检查动作 |
| `browser/quickAccess/standaloneHelpQuickAccess.ts` | 命令面板和符号选择已接通 Quick Input；通用 Quick Access registry/provider 契约仍待闭合。Go to Line action 仍使用已确认保留的 Ash 输入框 |
| `browser/referenceSearch/standaloneReferenceSearch.ts` | 本地引用跳转由现有语言导航控制器和 PeekViewWidget 承担；标准 ReferencesController 状态与模型链尚未对齐 |
| `browser/standaloneWebWorker.ts`、`browser/services/standaloneWebWorkerService.ts` | 当前是模型绑定的编辑 Worker 与既有消息端口；标准通用 Worker 服务、代理与多资源同步仍缺失 |
| `browser/standaloneTreeSitterLibraryService.ts` | 未发现本地同契约 Tree-sitter 库服务与加载链 |
| `browser/iPadShowKeyboard/iPadShowKeyboard.ts`、`iPadShowKeyboard.css`、`keyboard-dark.svg`、`keyboard-light.svg` | 现有输入 owner 没有这条设备专用入口；需实际设备语义与焦点验证，不能只放图像与按钮 |

已有文件仍待核对的端口：

- `standaloneEditor.ts`：Diff / Multi-file Diff 创建和列表事件；命令、动作和按键注册；marker 读写及事件；Worker；同步 model-line 着色 / tokenize；字体重测；link / editor opener。独立字符串和元素着色以及标准 defineTheme 已接通。上游 API 工厂的产品品牌命名与 Ash 工厂命名差异单列，不据此复制上游产品标识。
- `standaloneCodeEditor.ts`：实例 command / action / context key；完整全局模型配置；StandaloneCodeEditor 与可编辑 StandaloneDiffEditor 的公开契约。现有 DiffEditorWidget 仅绘制只读行，没有原始 / 修改两侧 ICodeEditor，不能伪装为标准 diff editor。
- `standaloneLanguages.ts`：selector 评分、新符号名与范围语义 token。语言列表、编码、激活事件、同步 / 延迟 / encoded token provider 和 Monarch 已进入真实模型链。现有补全 provider 适配只提取 language ID，尚不能表达完整 scheme / pattern 选择；部分 provider 签名仍是已记录的 Ash 请求形态。
- `standaloneServices.ts`：通用服务覆盖、动态按键注册、配置批量同步及其模型选项效果。当前 `initialize` 已返回实现 IInstantiationService 的唯一容器，withServices 延迟装配及释放已验证；工厂注入仍保留 Ash 扩展。
- `standaloneCodeEditorService.ts`：显式 active editor 设置尚无对应 action 消费链；仍保留现有聚焦与最近活动语义。

### 用户已确认的 Ash 底层归属

| 准确路径（相对 `ash-ts/src/ash/`） | 现状与建议 |
| --- | --- |
| `platform/quickinput/browser/quickPick.ts` | 仅 Ash；用户已确认迁移并删除。现已迁入 `platform/quickinput/browser/quickInput.ts`，唯一生产消费者同步迁移，旧路径退出；Git 可恢复。平台 QuickInputController 已承接共享弹层，Standalone 和 Workbench 都使用它。 |
| `editor/common/diff/diffModel.ts`、`diffComputationService.ts`、`lineDiff.ts` | 用户已确认保留共享差异计算与版本有效性。DiffEditorWidget 仍是只读行展示，两侧 CodeEditor、模型切换、编辑后差异和滚动对齐尚未实现；本批没有增加伪装成可编辑器的 createDiffEditor。 |
| `platform/webWorker/browser/browserWorkerClientPort.ts` | 用户已确认保留 Editor Worker 与 Workbench TextMate 共用的传输和释放实现。base WebWorkerClient 已有请求、取消与失败协议，但标准代理、双向 channel、多资源同步和外部模块加载仍需沿同一协议补齐。 |

用户答复“按建议迁移 Quick Pick，保留共享底层”，确认上表全部建议，包括准确旧路径的删除。共享计算与传输能力继续由现有文件负责，不再重复询问。

Quick Access 符号迁移原先等待仅 Ash 文件的归属确认；用户在准确迁移方案后答复“继续”，本批据此迁移并删除 `editor/contrib/gotoSymbol/browser/gotoSymbolController.ts`、`gotoSymbol.contribution.ts`、`media/gotoSymbol.css`。`DocumentSymbolService` 继续共享。其余 Workbench、Sessions 的 QuickPick 消费者不在本批迁移范围。

Quick Input 首批准入：Workbench 命令面板 → WorkbenchQuickInputService → 平台 QuickPick → 原 InputBox / QuickInputList → 筛选、选择、关闭和焦点恢复。修改准确路径限定 `platform/quickinput/browser/quickPick.ts`（已确认仅 Ash，迁入上游同路径 `quickInput.ts` 并删除旧路径）、`workbench/services/quickinput/browser/quickInputService.ts`（双方都有，仅迁移 import 与类名）、本台账。保留当前状态、DOM、事件、样式及生命周期，先用既有 `workbench/services/quickinput/test/browser/quick-input.test.ts` 验证。

前序完整检查已通过：`check-editor-alignment.mjs --test=all`、`build:stanza`；后续批次继续追加受影响验证。

Quick Input 宿主续批准入：F1 / 公开 quickCommand action → StandaloneQuickInputService → 当前 editor 容器的 QuickInputController → 原 QuickPick / InputBox / List → 筛选可用编辑器动作、执行与取消恢复焦点。Workbench 的同一行为也经过该 Controller，窗口布局和上下文仍由 Workbench 服务维护。这里不复制上游 provider 私有实现，也不提前增加没有本地消费者的 Quick Access registry API。

| 准确路径（相对 `ash-ts/src/ash/`） | 关系与本批动作 |
| --- | --- |
| `platform/quickinput/browser/quickInputController.ts` | 仅上游；承接现有 WorkbenchQuickInputService 的 DOM 宿主、唯一 active picker 和焦点恢复状态，两种运行环境均实际消费 |
| `platform/quickinput/browser/quickInput.ts`、`quickInputList.ts` | 已迁移 / 双方都有；本地化现有界面文案，程序设置 value 进入同一筛选事件链 |
| `platform/quickinput/browser/media/quickInput.css` | 仅上游；迁入 Ash 控件既有样式，不读取或复制上游 CSS |
| `workbench/services/quickinput/browser/quickInputService.ts`、`media/quickInput.css` | 双方都有；移走共享宿主状态与样式，保留窗口挂载、上下文和布局 |
| `editor/standalone/browser/quickInput/standaloneQuickInputService.ts`、`standaloneQuickInput.css` | 仅上游；每个实际 editor 使用同一平台 Controller，跟随 editor 生命周期，尺寸约束归 editor 宿主 |
| `editor/standalone/browser/quickAccess/standaloneCommandsQuickAccess.ts` | 仅上游；标准 quickCommand 动作从当前 editor 的已注册可用动作生成选择项，执行进入现有命令服务 |
| `editor/standalone/browser/standaloneServices.ts`、`editor/editor.main.ts` | 双方都有；分别注入 standalone Quick Input、装配完整入口动作 |
| `workbench/services/localization/common/localizationCatalogs.ts` | 既有语言包数据；补本批英文和中文文案，不迁移归属 |

验证限定既有 `workbench/services/quickinput/test/browser/quick-input.test.ts`、`workbench/services/localization/test/common/localizationService.test.ts`，以及 `ash-ts/test/integration/browser/standalone.integration.ts` / `.spec.ts`。第一条实际 F1 链验证通过后，再继续符号入口等上层功能。

F1 首条行为链及现有浏览器全量 611 项通过；Quick Input / 本地化定向单测 10 项通过。程序设置 value 的事件原已由 InputBox 发出，本批保留该机制并验证只通知一次。

高对比度动作准入：F1 命令面板 → 标准 `editor.action.toggleHighContrast` → 唯一 StandaloneThemeService → 已有主题绑定 → 全窗口编辑器切换对应明暗高对比度，再次执行恢复原主题。新增准确路径 `editor/standalone/browser/toggleHighContrast/toggleHighContrast.ts`（仅上游，独立动作实现）；其余变更限定已准入的 `editor/editor.main.ts`、语言包、standalone 浏览器测试和本台账。不改动主题注册表、强制颜色检测或 CSS。

Token 主题续批准入：宿主通过 standalone languages/editor API 注册 tokenizer 和主题 → TokenizationRegistry / StandaloneThemeService → 现有 SyntaxProviderWorker 与 TokenizationTextModelPart → 原 LanguageToken.presentation 与 ViewLine → 自定义 scope 着色、主题切换、富文本复制保持相同颜色。现有语法 provider、行索引、DOM 和 Worker 工厂仍是唯一实现；不复制上游 trie、适配器私有类图或 CSS。

| 准确路径（相对 `ash-ts/src/ash/editor/`） | 关系与本批职责 |
| --- | --- |
| `common/languages/supports/tokenization.ts` | 双方都有；保留标准 token 分类，增加独立规则匹配与 encoded 颜色索引，供主题及 provider 适配消费 |
| `standalone/common/standaloneTheme.ts`、`standalone/browser/standaloneThemeService.ts` | 已迁移；扩展标准主题数据、继承、tokenTheme 和颜色表，保留已确认的 Ash 命名主题 |
| `standalone/common/themes.ts` | 仅上游；从 Ash 已有平台语法颜色生成标准内置主题规则，不复制上游规则数据 |
| `standalone/browser/standaloneLanguages.ts`、`standaloneEditor.ts`、`editor.api.ts` | 双方都有；公开真实 tokenizer 注册、颜色表和 defineTheme 入口及类型；消费原注册表和唯一主题服务 |
| `common/languages.ts`、`common/services/editorWebWorker.ts` | 双方都有；encoded token 结果进入当前语法缓存与既有 presentation，不改变请求和模型版本 owner |
| `common/model/tokens/tokenizationTextModelPart.ts` | 双方都有；将现有 presentation 转为一致的 line-token metadata，供复制与 token API 使用 |
| `test/common/modes/supports/tokenization.test.ts` | 上游同路径新增测试；检验属性继承、scope 边界、颜色索引和 fontStyle |
| `test/browser/namedEditorThemeService.test.ts`、`standaloneEditor.test.ts`；既有 standalone 两份浏览器场景 | 原测试扩展；从注册入口验证着色、切换、异步注册与释放，不用成员存在断言代替行为 |

新 token 实现采用按 scope 长度排序的本地规则数组，并缓存每个实际 scope 的匹配结果；颜色表随主题编译一次。UI 绘制继续读取既有 LanguageToken.presentation，不增加平行主题服务或新 DOM。

同链补充 `common/tokenizationRegistry.ts`（双方都有）：延迟 factory 注册和移除必须发出语言变化，使已经打开的模型实际请求新 factory；只修改这两个生命周期通知。encoded token 解码使用模型已有 languageIdCodec，沿当前 createSyntaxWorker 传入，不创建新的编码表。

Token 主题行为验证：4 项 Playwright 场景通过，覆盖自定义 scope 的颜色与字体、主题切换重着色、LineTokens 与富文本复制一致、外部编码颜色表、延迟 factory 只调用一次以及释放后拒绝迟到结果。上游 provider 测试还明确要求首 token 从 0 开始、后续 offset 不倒退；适配层统一规范化，保留 provider 原数组。主题服务现在返回包含 tokenTheme 的主题，原对象身份测试改为验证其主题 ID，颜色与事件测试保留。其他目录差异仍在上表，不把本批通过视为全部完成。

语言激活续批准入：宿主在创建编辑器前订阅 `languages.onLanguage` → `StandaloneServices.withServices` 在窗口装配完成后安装监听 → ModelService 创建模型或切换语言 → 现有 LanguageService 的一次性激活记录 → 回调注册 tokenizer → 原模型着色链。当前 LanguageService 已有 basic/rich 事件，但没有生产调用触发它们；本批补齐 ModelService 这一实际模型注册 owner 的通知，保留现有配置、模型和分词 owner。

准确路径限定 `standalone/browser/standaloneServices.ts`（双方都有；增加延迟安装与释放）、`standalone/browser/standaloneLanguages.ts`（双方都有；公开激活监听与语言列表）、`common/services/modelService.ts`（双方都有；模型登记后及语言切换时通知宿主语言服务）、`test/browser/standaloneEditor.test.ts`、`test/common/modelService.test.ts`、既有 standalone 浏览器两文件、`README.md` 和本台账。嵌入语言尚未接入，不把当前 direct-language 激活等同于 Monarch 嵌入行为。

Monarch 首批准入：宿主在语言激活回调注册声明式规则 → `setMonarchTokensProvider` → 编译规则与逐行状态机 → 同一个 TokenizationRegistry → 原模型分词、主题与 ViewLine。规则输入没有现存 Ash 实现；本批只增加上游准确路径 `standalone/common/monarch/monarchTypes.ts`、`monarchCommon.ts`、`monarchCompile.ts`、`monarchLexer.ts`。类型文件拥有外部 grammar 契约；compiler 拥有宏展开、include 和输入校验；tokenizer 用不可变字符串数组记录状态栈，不复制上游栈节点、缓存工厂或 collector 类。窗口语言、主题和配置依赖经现有容器构造注入。

其余准确修改路径为 `standalone/browser/standaloneLanguages.ts`、`editor.api.ts`（同步/异步注册入口及释放）、新增同路径测试 `standalone/test/browser/monarch.test.ts`、既有 standalone 浏览器两文件、README 和本台账。先验证跨行状态、分组、空行退出和声明式规则替换；嵌入语言需单独验证返回宿主状态、编码语言 ID、异步加载和注销。DOM、布局、滚动及渲染 owner 不变。

同链追加准确路径 `common/config/editorConfigurationSchema.ts`（双方都有）：已有 `editor.maxTokenizationLineLength` schema 没有进入运行时配置注册表；在原 schema owner 注册相同默认值及正整数校验，使 Monarch 的配置读取和更新真实生效。用上述 Monarch 配置行为测试验证，不新建设置 owner。

独立着色续批准入：宿主使用 standalone editor 着色 API 生成代码片段 → `standalone/browser/colorizer.ts`（上游同路径缺失） → 已注册 tokenizer / 同一颜色表 → 现有 `common/languages/textToHtmlTokenizer.ts` 的转义与样式序列化 → 返回 HTML 或更新调用者提供的元素。元素由调用者拥有；不创建编辑器、模型或第二套分词状态缓存。允许修改 `standalone/browser/standaloneEditor.ts`、`editor.api.ts`、既有 standalone 两份浏览器场景、`test/browser/standaloneEditor.test.ts`、README 和本台账。已有 HTML 序列化器只读取，不复制其逻辑。ModelLine 的强制同步分词缺口仍独立记录，不以异步模型当前快照冒充同步完成。

上述链路定向验证通过：Monarch 的 5 项单测覆盖嵌套状态、输入状态不变、捕获组、rematch、宏、regex 中的字面状态参数、空行 / LF、长度配置、循环拒绝、嵌入语言延迟加载及 metadata。公开注册测试覆盖 factory 只创建一次、释放后拒绝迟到定义、非法替换保留当前 provider、旧注册释放不影响新 provider。3 项 Playwright 场景验证跨行注释重算、嵌入语言返回宿主及独立 HTML 的颜色、转义、缩进和模型数量不变。Colorizer 输出为一次性的内联样式 HTML；现有模型的同步强制分词和持续跟随主题的片段绑定仍未宣称完成。

任务期间 HEAD 从起始基线前进至 `f9f059f46`；新增提交包括前端 Diff 和 TextMate 分词职责调整，均保留。完整回归发现 `ash-ts/test/integration/browser/textModel.integration.ts` 仍只注入后端诊断 / 符号 provider，没有词法 provider，却断言关键字着色和 Worker 存在。追加该准确测试路径准入：使用仓库 Rust grammar 和已有 TextMate Worker 工厂为 BrowserTextModelService 提供词法输入；后端 fixture 的 tokens 改为空，明确验证两条真实来源。保留现有颜色、块光标、符号和编辑断言，不改变生产 provider 职责。失败的 3 项定向重跑均通过，完整检查在当前 HEAD 重新执行。

本批最终验证：`check-editor-alignment.mjs --test=all` 退出码 0，239 / 239 个单测文件与 623 项 Playwright 场景通过；台账、文件集合、CSS 归属、类型和 diff 检查通过，源码目录没有新增 JavaScript。Monarch 定向测试新增捕获组 rematch 后跨行进入 / 退出嵌入语言，共 6 项通过。当前 HEAD 上的 `build:stanza`、`build:renderer` 均通过，无构建 warning。测试保留已有 JSDOM Canvas 和 NO_COLOR / FORCE_COLOR 环境提示。目录复核仍为 18 个同路径、1 个经批准保留的 Ash 文件、14 个缺失生产文件；上文待补端口与待确认迁移未宣称完成。

## 语言声明归属修正（2026-09-22）

本轮修正此前“合并内置语言表”仍与扩展重复定义的问题。Editor 核心只注册纯文本；产品语言关联、编辑规则和 TextMate grammar 由真实扩展贡献提供，standalone 宿主显式注册其他语言。`standalone/common/builtinLanguages.ts` 已退出，平台资源识别不再维护另一份 MIME/后缀表。旧编辑规则只作为测试 fixture 保留。

语言注册表仍由现有 LanguageService 实例持有，扩展释放时关联、规则和 grammar 一同退出。JSON provider 继续由 Workbench 装配；TextModel 与词法 Worker 留在前端。普通文件在扩展加载前也能选择文本编辑器，PDF 和明确二进制类型保留更高优先级，显式 Open With 仍然有效。

本轮定向验证覆盖默认纯文本、宿主注册/释放、八种语言的真实扩展装载、输入/撤销/保存、无障碍选区和 Electron 文件打开。116 项单测通过；29 个不同的 Chromium 场景及两个 Electron 场景完成验证。浏览器复验曾暴露首次着色与辅助阅读选区操作的时序冲突，测试改为等待首轮真实着色后操作；两个相关场景各重复三次通过。桌面和 Stanza 生产构建、结构检查通过。既有 JSDOM Canvas 与 Playwright 颜色环境提示仍存在，生产构建无新增 warning。

此项是语言声明与高亮职责的修正，不代表全部语言服务或 Editor API 与 VS Code 完全一致。准确路径与验证记录见 [迁移计划](../../../../app/docs/crate-migration-plan.md#第五批补充语言声明与-vs-code-职责对齐)。

## Folding 元数据与命令参数边界（2026-09-21）

本批已修复注册时丢失参数约束，以及直接 action 调用把 `null` / `false` 等值变成默认参数的问题。起始基线 `09682509e`，已有上一批 6 个暂存文件；本批保护既有变更，不创建或删除文件。

准入链：命令服务 / 直接 editor action → 命令注册或 InternalEditorAction 的参数边界 → base 类型约束校验 → 既有 FoldingController → 原折叠记录与隐藏行。约束声明由 Folding 动作拥有；平台层不依赖 Folding，控制器只接收已校验参数。注册批次的替换与释放仍由原 CommandRegistry 管理。

| 准确路径（相对 `ash-ts/src/ash/`） | 文件关系 | 本批职责 |
| --- | --- | --- |
| `base/common/types.ts` | 双方都有 | 以标准 validateConstraint / validateConstraints 契约提供唯一类型约束校验 |
| `platform/commands/common/commands.ts` | 双方都有 | 原命令定义携带 metadata，注册时把参数约束接入 handler；保留原批次所有权 |
| `editor/browser/editorExtensions.ts` | 双方都有 | 编辑器命令注册携带已有 metadata |
| `editor/common/editorAction.ts` | 双方都有 | 直接 action 调用在默认参数转换前使用同一校验 |
| `editor/contrib/folding/browser/folding.ts` | 双方都有 | 声明 Fold / Unfold 参数约束与公开 schema，移除控制器内的重复校验 |
| `workbench/services/localization/common/localizationCatalogs.ts` | 既有 Ash 语言包数据 | 按仓库文案要求补英文与简体中文词条，不迁移归属 |
| `editor/api-alignment-status.md` | 既有台账 | 记录范围和验证 |

测试限定既有 `base/test/common/types.test.ts`、`platform/commands/test/common/commands.test.ts`、`workbench/services/commands/test/common/commandService.test.ts`、`workbench/services/localization/test/common/localizationService.test.ts`，以及 `ash-ts/test/integration/browser/standalone.integration.ts` / `.spec.ts`。验证参数拒绝早于副作用、成功参数完整传递、替换与释放、非默认语言，以及真实 action / 命令服务的隐藏行结果。上游只用于核对公开 metadata / 类型约束契约及测试；保留 Ash 注册结构、DOM、焦点和折叠模型。

Fold / Unfold 的 metadata 现在包含本地化说明、参数约束及 `levels` / `direction` / `selectionLines` schema，可从公开 action 读取。两个外部调用入口使用同一 base 校验；错误值不会进入控制器，省略参数仍执行默认行为。原批次注册机制没有重构，本批不宣称 CommandRegistry 的完整公开对象与方法契约已经对齐。Folding 的其他公开状态与 provider 契约继续待核对。

本批验证：

- 基础类型、命令注册、Workbench 命令服务和本地化共 21 项定向单测、4 个文件通过；中文 metadata 从真实语言包服务加载后验证。
- 11 个 Folding Chromium 场景通过，包括两条新增的命令服务与公开 metadata 场景；原错误参数场景追加 `null`、`false`、`0`、空字符串。
- `check-editor-alignment.mjs --test=all` 通过：1,243 项编辑器单测、234 个文件与 600 项浏览器测试全部通过；台账、文件集合、CSS 归属和类型检查通过，源码目录没有新增 JavaScript。保留测试环境既有的 JSDOM Canvas 提示。
- `build:stanza`、`build:renderer` 均通过，无新增构建警告。仓库未配置 TypeScript formatter / linter；人工复核本批 diff，`git diff --check` 通过。
- 未运行上游 VS Code 窗口；公开契约与预期来自本地上游声明及测试，不标为完整界面一致。总台账仍为 80 项已处理、41 项待核对。

## Folding 命令参数续批（2026-09-21）

本批已接通 `editor.fold` / `editor.unfold` 的 `levels`、`direction` 和零起始 `selectionLines`。起始已有上一批暂存的 7 个文件变更，保持暂存内容；本批仅在工作区追加修改。

准入链：公开 editor action / 带参数快捷键 → 已有 EditorAction 参数传递 → FoldingController → EditorFoldingModel 的同一组折叠记录 → 隐藏行、装饰和选区。View、隐藏行、装饰、文本和释放 owner 沿用原实现，不增加 DOM、样式或状态载体。

| 准确路径（相对 `ash-ts/src/ash/editor/`） | 文件关系 | 本批职责与验证 |
| --- | --- | --- |
| `contrib/folding/browser/folding.ts` | 双方都有；已有 Fold / Unfold 动作 | 在命令边界读取参数，使用显式行号或当前选区，转入原控制器操作 |
| `contrib/folding/browser/foldingModel.ts` | 双方都有；Controller 消费 | 原记录上按祖先 / 后代层数确定目标，合并多选区后一次修改状态 |
| `contrib/folding/test/browser/foldingModel.test.ts` | 既有测试 | 验证层数、方向、重复范围和默认折叠行为的区别 |
| `api-alignment-status.md` | 既有台账 | 记录边界、行为证据与验证结果 |

测试装配与真实入口验证限定既有 `ash-ts/test/integration/browser/standalone.integration.ts` / `.spec.ts`，覆盖 action 参数、快捷键参数、行号覆盖与焦点。无新增或删除文件。Folding 目录仍为 8 个同路径和 1 个既有 Ash 文件；上游路径无缺失。

实现依据是上游动作参数声明、模型测试，以及解释空行号数组和默认参数所需的最小行为片段。Ash 保留自己的有序范围记录，普通折叠仍查找未折叠祖先，指定方向 / 层数时计入已处于目标状态的范围；所有目标在修改状态前确定。命令元数据 schema 与控制器其余公开契约不纳入本批。

行为结果：显式行号覆盖当前选区；层数省略或为 0 时使用 1，`up` 按包含当前行的范围向外处理，其他方向向内处理。重复或重叠行号只改一次状态，范围外行号无操作。空数组在普通折叠与向上操作中无操作；显式向下时以文档为起点，处理深度小于层数的范围。参数形状错误在状态变化前拒绝，文本保持不变。

本批验证：

- Folding 定向单测 25 项、7 个文件通过；9 个 Chromium 命令场景通过，其中新增 4 个参数场景。
- `check-editor-alignment.mjs --test=all` 通过：1,243 项单测、234 个文件与 598 项浏览器测试全部通过。台账、文件集合、CSS 归属和类型检查通过，源码目录没有新增 JavaScript；保留测试环境既有的 JSDOM Canvas 提示。
- `build:stanza` 通过，无新增构建警告。仓库未配置 TypeScript formatter / linter；人工复核本批 diff，`git diff --check` 通过。
- 未运行上游 VS Code 窗口；预期依据本地上游公开参数、模型测试与最小行为片段，不标为完整界面一致。总台账仍为 80 项已处理、41 项待核对。

## Folding 命令续批（2026-09-21）

已接通递归、全部、指定层级和手动范围的 13 个标准动作，移除控制器自己的组合键解析与等待状态。多选区使用原折叠模型，每次命令先确定目标再改状态，多个光标落在同一范围时不会重复折叠到父级。

起始工作树干净，基线 `7b43fde26`。准入链：默认 / 自定义组合键或公开 action → 已有命令与快捷键服务 → FoldingController → EditorFoldingModel → 隐藏行、装饰、选区与焦点。此前这些动作绕过标准注册；多选区只处理主光标，层级命令会改动其他层级，手动范围创建后没有折叠。

| 准确路径（相对 `ash-ts/src/ash/editor/`） | 文件关系 | 本批修改与唯一职责 |
| --- | --- | --- |
| `contrib/folding/browser/folding.ts` | 双方都有；editor.all 装配 | 标准动作进入现有操作，移除独立按键解析器；当前编辑器维护 foldingEnabled 条件，操作覆盖各选区 |
| `contrib/folding/browser/foldingModel.ts` | 双方都有；Controller 消费 | 保留现有范围与折叠状态；修正指定层级、重复折叠上移与手动范围创建 / 删除语义 |
| `contrib/folding/test/browser/foldingModel.test.ts`、`foldingDecorations.test.ts` | 既有测试 | 同步模型行为和动作入口；真实物理按键由浏览器验证 |
| `api-alignment-status.md` | 既有台账 | 记录批次范围、验证和仍未完成的公开契约 |

场景装配与行为测试仅追加既有 `ash-ts/test/integration/browser/standalone.integration.ts` / `.spec.ts`。不创建或删除文件，不修改 DOM、CSS、折叠范围来源或滚动 owner。上游证据限定命令 ID、组合键、配置条件以及 foldingModel 行为测试；实现继续使用 Ash 的折叠记录和模型事件。标准指定层级动作采用上游已有的 1–7 级，不添加上游没有的 8 / 9 级命令。`editor.fold` / `editor.unfold` 的 levels、direction、selectionLines 参数留待单独闭合，本批不声称完成全部 Folding API。

本批行为结果：

- `editor.foldAll` / `editor.unfoldAll`、`editor.foldRecursively` / `editor.unfoldRecursively`、`editor.createFoldingRangeFromSelection` / `editor.removeManualFoldingRanges`、`editor.foldLevel1`–`editor.foldLevel7` 接入同一注册链。默认与自定义组合键共用超时、Escape 和焦点变化取消。
- `foldingEnabled` 由当前贡献维护，配置变化立即生效，模型移除 / 贡献释放时复位。只读编辑器仍允许改变折叠状态。
- 普通折叠覆盖所有选区；重复调用从已折叠子范围移到展开的父范围。指定层级仅折叠该层，并跳过包含选区起始行的范围，保留其他层级的原状态。
- 手动范围按各选区创建并立即折叠，选区收回标题；结束于下一行第一列时不包含该行。删除时按光标选取最近的手动范围，非空选区删除相交手动范围，范围外的空光标删除全部手动范围，提供者范围保留。

Folding 仍为 9 个生产文件：8 个同路径、1 个既有 Ash 文件，大小写差异和上游缺失路径均为 0。总台账的 80 / 41 状态不变；没有把注册动作或新增公开操作计为完整控制器契约对齐。

本批验证：

- Folding 定向单测 22 项、7 个文件通过；新增的 5 个 Chromium 场景通过，覆盖公开动作、多光标、默认 / 自定义组合键、取消、配置切换、模型移除与重新装入。
- `check-editor-alignment.mjs --test=all` 通过：1,240 项单测、234 个文件与 594 项浏览器测试全部通过；台账、文件集合、CSS 归属和类型检查通过，源码目录没有新增 JavaScript。保留测试环境既有的 JSDOM Canvas 提示。
- `build:stanza` 通过，无新增构建警告。仓库未配置 TypeScript formatter / linter；人工复核 touched diff，`git diff --check` 通过。
- 未运行上游 VS Code 窗口；本批预期来自本地上游公开动作与模型行为测试，不标为完整界面一致。

## Contrib 行为修复（2026-09-21）

本轮接续下方目录审查，修复已复现的五类配置行为、补通九个标准命令，并按用户确认完成文件迁移与删除。保留 Ash 的文本、折叠、选区、DOM 和请求 owner；CSS 与布局结构没有变更。下方审查记录描述修复前的状态。

准入链为配置 / 键盘 / editor action → `editor.all.ts` 装配的既有控制器 → 当前请求、控件或编辑状态 → DOM、文本、选区、撤销和取消结果。路径均相对 `ash-ts/src/ash/editor/`；现有文件只修改本表职责。

| 生产路径 | 起始关系与调用方 | 修复结果 |
| --- | --- | --- |
| `contrib/inlineCompletions/browser/controller/inlineCompletionsController.ts` | 双方都有；输入、命令与模型事件 | 自动请求读取 `inlineSuggest.enabled`；动态关闭和只读切换清除建议并取消请求；显式触发仍可用于关闭自动建议的编辑器 |
| `contrib/hover/browser/contentHoverController.ts` | 双方都有；hoverContribution | 消费启用模式、delay 和多光标修饰键配置；配置或修饰键变化重新判断当前悬停并取消失效请求 |
| `contrib/inlayHints/browser/inlayHintsController.ts` | 双方都有；editor.all | 四种 enabled 模式控制同一组节点；按下、松开 Ctrl+Alt / Ctrl+Option 和窗口失焦更新显示，不重新请求 |
| `contrib/folding/browser/folding.ts` | 双方都有；editor.all 与折叠动作 | indentation 策略不请求语言提供者；切换策略取消旧请求；数量上限优先保留外层范围，范围移除同步恢复隐藏行；标准 fold / unfold 使用原折叠模型 |
| `contrib/find/browser/findController.ts` | 双方都有；editor.all 与查找动作 | 标准 find / replace 动作及快捷键进入原控件 |
| `contrib/suggest/browser/suggestController.ts` | 双方都有；editor.all 与补全动作 | 标准 triggerSuggest 动作及快捷键进入原请求、会话和控件 |
| `contrib/inlineCompletions/browser/controller/commands.ts`、`inlineCompletionContextKeys.ts` | 仅上游；editor.all 与 Inline 控制器 | trigger / commit / hide 操作原控制器；控制器维护实际消费的可见状态键，接受和隐藏快捷键受该状态约束 |
| `contrib/links/browser/links.ts` | 仅上游；editor.all 与 host onOpenLink | 原链接检测、provider 查询和打开职责合并；消费 links 配置及与多光标相反的修饰键，普通点击定位光标；关闭时取消请求、拒绝迟到结果 |
| `standalone/browser/quickAccess/standaloneGotoLineQuickAccess.ts` | 仅上游；editor.main | 标准 gotoLine 动作调用用户确认保留的 Ash 输入框 |
| `editor.all.ts`、`editor.main.ts` | 双方都有；产品入口 | 更新贡献注册；Go to Line 从完整入口加载，最小 standalone API 不装入贡献 |

用户明确确认下列仅 Ash 文件的处理方式；删除文件均可从本轮起始 Git HEAD 恢复，旧 TypeScript 引用已清空：

| 路径 | 原生产调用 | 已执行的决定 |
| --- | --- | --- |
| `contrib/links/browser/linksController.ts`、`contrib/links/common/languageLinks.ts` | 各 1 个 | 职责迁入 `contrib/links/browser/links.ts`，迁移调用与测试后删除 |
| `contrib/quickAccess/browser/quickAccessController.ts` | editor.all | 保留现有输入框实现，标准动作使用上游 standalone 路径 |
| `contrib/hover/browser/diagnosticHoverController.ts`、`contrib/hover/test/browser/diagnosticHoverController.test.ts` | 0 个 | 删除未接入产品的旧实现与专用测试 |
| `contrib/collaboration/common/envelopeSerialization.ts` | 0 个 | 删除实现及旧序列化测试；协作同步行为测试保留 |
| `contrib/editorState/browser/editorStateController.ts`、`contrib/editorState/common/editorInteractionState.ts` | bundle → controller → state；无状态读取方 | 删除两个文件及 bundle 注册 |

配套测试限定既有 `contrib/find/test/browser/findController.test.ts`、`contrib/suggest/test/browser/suggestTrigger.test.ts`、`contrib/inlineCompletions/test/browser/inlineCompletionsController.test.ts`、`test/common/modes/linkComputer.test.ts`、`test/common/collaboration-synchronizer.test.ts`，以及 `ash-ts/test/integration/browser/standalone.integration.ts` / `.spec.ts`。链接 provider 与 URL 合并的测试迁到真实浏览器，原纯 URL 扫描测试保留。

全量验证追加 `test/browser/standaloneEditor.test.ts`：provider 测试改从公开 action 进入窗口命令服务，编辑器使用作用域释放；真实快捷键继续由 Chromium 场景覆盖。

浏览器全量验证追加准入 `ash-ts/test/integration/browser/textModel.integration.ts`（既有 Ash 场景装配）：真实按键 → 已注册查找动作 → 原 CodeEditorPane → 查找控件。该 fixture 缺少命令与快捷键服务，复用既有 `registerCodeEditorServices` 补齐并启动按键监听；Workbench 生产装配已具备服务，无需修改。同批调整 standalone 场景的共享 snooze 装配：直接请求两个控制器，保留双编辑器显示、共同暂停和释放后恢复的断言；不再向未聚焦节点派发合成快捷键。

当前 Editor 为 **535 个生产文件：436 个上游同路径、99 个 Ash 自有；298 个上游路径未引入**。其中 contrib 为 **164 个：106 个同路径、58 个 Ash 自有；189 个上游路径未引入**。声明总账仍为 80 项已处理、41 项待核对；标准命令接通不表示各控制器完整公开契约已经对齐。Inlay 的完整行内布局、补全其余契约、Workbench Quick Access 归属和 richTextEditorWidget 到协作 contribution 的依赖仍需继续处理。

本轮最终验证：

- `test:editor:unit`：1,238 项、234 个文件通过。随后调整的 Inline / Suggest 单测与公开入口架构检查定向复验 11 项通过；保留测试环境既有的 JSDOM Canvas 提示，没有新增缺失服务错误。
- `check-editor-alignment.mjs --test=browser`：结构、台账、CSS、类型检查和 589 项浏览器测试全部通过，未生成源码目录下的 JavaScript。首次全量检查发现的命令入口与服务装配测试问题已修正，原效果和释放断言保留。
- `build:stanza` 通过，无新增构建警告。仓库未配置 TypeScript formatter / linter；已人工检查本轮 diff，`git diff --check` 通过。
- 未运行上游 VS Code 窗口；预期依据本地上游公开配置、动作及行为测试，不将本轮修复标为完整界面一致。

## Contrib 扩展审查：修复前记录（2026-09-21）

此前对整个 `contrib` 完成生产文件、导入、注册入口和测试入口扫描，并对下列六类问题做了浏览器抽查。该次审查只更新台账，没有修改生产实现或测试；其中确认的配置、命令与无消费者代码问题已由上方修复批次处理。

审查基线：Ash `36571dd38`，本地只读 VS Code `1aaf9d931d8`。本轮起始工作树干净。统计包含此前检查的 Sticky Scroll 8 个文件；其他贡献共 159 个生产文件。

| 文件集合 | 数量 | 含义 |
| --- | --- | --- |
| Ash 生产文件 | 167 | 包含 TypeScript 与 CSS，排除测试 |
| 双方同路径 | 103 | 仍需按公开契约和实际行为验收 |
| 仅 Ash | 64 | 包含 Academic、Citation、协作等专属能力，也包含尚未归位的通用编辑器功能；不能统一判为多余文件 |
| 仅上游 | 192 | 只是缺失路径清单，不能当作直接创建文件的任务队列 |

### 已复现的行为与命令缺口

下表使用现有 `standalone.html` 测试装配，通过 `updateOptions`、真实键盘与鼠标、provider 请求记录、命令注册表及 DOM 状态检查。没有运行上游窗口；预期取自本地上游公开配置、动作注册及必要的交互判断。

| 优先处理范围 | Ash 入口与当前 owner | 实际结果 | 对齐目标与回归场景 |
| --- | --- | --- | --- |
| Links 配置与点击 | `editor.all.ts` → `contrib/links/browser/linksController.ts` → host `onOpenLink` | 设置 `links: false` 后，鼠标经过 URL 再普通左击仍调用 host。控制器没有读取链接选项，也没有要求打开链接的修饰键 | 对应职责在上游 `contrib/links/browser/links.ts`。先核实已有 Ash 文件决定，再收口配置、修饰键和取消；验证关闭后的请求与点击、普通定位光标、修饰键打开 |
| Inline Completions 开关 | `contrib/inlineCompletions/browser/controller/inlineCompletionsController.ts` 的 `onDidType` → scheduler → provider | `inlineSuggest.enabled: false` 后键入 `abc`，仍发出 automatic 请求并显示建议 | 同路径现有控制器消费配置；验证初始关闭、动态关闭、待返回请求、重新开启 |
| Hover 开关与延迟 | `hoverContribution.ts` → `contrib/hover/browser/contentHoverController.ts` → pointer timer | `hover.enabled: 'off'` 后仍显示 `alpha documentation`。代码固定等待 300ms，没有消费 `hover` 选项 | 同路径 owner 消费启用模式与延迟；验证初始关闭、动态关闭、延迟和修饰键模式 |
| Inlay Hints 显示模式 | `contrib/inlayHints/browser/inlayHintsController.ts` → provider → hint DOM | `inlayHints.enabled: 'offUnlessPressed'` 且没有按键时，仍显示 `value:`。控制器只区分 `'off'` 与其他值 | 验证四种 enabled 值及 Ctrl+Alt / Ctrl+Option 按下、松开和失焦；完整字体、padding、长度和行内布局仍需另行验收 |
| Folding 策略 | `contrib/folding/browser/folding.ts` 的范围来源 → provider | `foldingStrategy: 'indentation'` 时仍请求语言折叠 provider；代码同时没有消费 `foldingMaximumRegions` | 保持现有折叠状态 owner，接通策略和数量上限；补充切换策略、取消旧请求、范围截断及隐藏区更新测试。数量上限本轮只有静态证据 |
| Find / Folding / Suggest / Inline / Quick Access 命令 | 对应控制器的本地按键处理器；已有编辑器 action / command 注册链 | 下列 9 个标准命令均不在注册表；Quick Fix 作为对照存在。快捷键处理没有形成相应命令入口 | 命令操作现有唯一控制器，不建立第二套状态；同时验证命令执行效果、物理按键、自定义快捷键、上下文条件及释放 |

缺少的 9 个命令：`actions.find`、`editor.action.startFindReplaceAction`、`editor.fold`、`editor.unfold`、`editor.action.triggerSuggest`、`editor.action.inlineSuggest.trigger`、`editor.action.inlineSuggest.commit`、`editor.action.inlineSuggest.hide`、`editor.action.gotoLine`。代码中的 `executeCommands('editor.action.inlineSuggest.commit', ...)` 和 `setSelections('editor.action.gotoLine', ...)` 只是来源标记，不是命令注册。上游 Go to Line 的动作属于 `standalone/browser/quickAccess/standaloneGotoLineQuickAccess.ts`，共享定位职责属于 `contrib/quickAccess/browser/gotoLineQuickAccess.ts`，不能把整个动作强塞进 contrib。

现有测试缺口：Links 集成测试明确以普通点击打开作为预期，修复时需同步改正，并保留 host 调用与生命周期覆盖；Inlay Hints 只覆盖 `on/off`；Folding 覆盖总开关和请求取消；Inline Completions 覆盖输入、取消与 snooze；Hover 覆盖语言、provider、模型和焦点变化。它们不能证明上表配置组合或标准命令已生效。

### 归属与装配待核实

- `contrib/hover/browser/diagnosticHoverController.ts` 和 `contrib/collaboration/common/envelopeSerialization.ts` 仍只有测试引用，未发现生产导入。前者依赖的旧 marker class / dataset 也仅见于自身与测试；这证明其生产链未接通，不等于诊断功能整体缺失。两者的删除或迁移仍需按准确路径处理。
- `contrib/editorState/browser/editorStateController.ts` 创建 `common/editorInteractionState.ts` 的状态副本，只持续写入焦点、选区、滚动和版本；没有生产读取方或事件订阅者。应先确认是否还有必要的功能消费方，不能把有注册入口等同于有业务用途。
- `browser/widget/richTextEditor/richTextEditorWidget.ts` 仍直接创建并公开返回 `contrib/collaboration/common/controller.ts` 的具体控制器。公共协作协议虽已迁回 common，Widget 到 contribution 的实现依赖仍待收敛；此前协议迁移不代表整条职责链已完成。
- `gotoSymbol`、`callHierarchy`、`quickAccess`、`sectionHeaders`、`unicodeHighlighter`、`unusualLineTerminators` 等仍有仅 Ash 载体。已有审批按原记录沿用；没有新决定的文件本轮不改变归属。Academic、Citation 和协作的专属能力也不能按上游缺失路径批量迁移。

实施顺序应先闭合上述配置行为，再按现有命令服务补通标准操作，随后逐项处理载体与无消费方状态。每一批仍需重新列出准确路径、已有文件决定、唯一 owner 和真实入口测试；此次目录扫描不是整目录重写授权。

### 本轮验证

- `check-editor-alignment.mjs --structure-only --full` 通过：Editor 台账仍为 80 已处理、41 待处理；本次未把成员差异或文件数量计为完成。CSS 扫描没有原样复制、品牌替换等价或品牌残留项。
- `pnpm --dir ash-ts run test:editor:browser:build` 通过；Playwright CLI 使用该产物完成上表五类配置场景及一组标准命令检查，均观察到缺口。
- `pnpm --dir ash-ts run test:editor:browser --grep 'links|inlay hints|folding toggles|inline completion debounces|hover'` 通过，48 个既有浏览器测试通过。此入口同时完成测试 TypeScript 编译和浏览器产物构建，没有新增测试。
- 本轮没有运行完整单测、完整浏览器套件、Stanza 产品构建或上游同场景对照；不能引用之前批次的验证数字作为本轮结论。

## Sticky Scroll 文件与调用链（2026-09-21）

`contrib/stickyScroll` 的 8 个生产文件现在全部与上游同路径。模型来源、候选行、DOM 和命令已接入原有 `editor.all.ts` 注册链；文件齐全不表示全部上游交互已经实现。

本批起始工作树干净。用户确认将仅 Ash 的 `common/stickyScrollModel.ts` 迁移并删除；其祖先筛选由 `browser/stickyScrollProvider.ts` 接管，测试迁至 `test/browser/stickyScroll.test.ts`。旧 import 和旧贡献 ID 均退出。

| 路径（相对 `contrib/stickyScroll/`） | 起始关系 | 生产调用方与唯一职责 | 本批结果 |
| --- | --- | --- | --- |
| `browser/stickyScrollElement.ts` | 仅上游 | ModelProvider / Provider：带版本的作用域树及一基行号 | 数据契约进入实际计算链 |
| `browser/stickyScrollModelProvider.ts` | 仅上游 | Provider：选取文档符号、现有折叠范围或缩进范围 | 按累计范围选择符号组并保持来源；声明行取 selectionRange；并发取消、隔离提供者错误 |
| `browser/stickyScrollProvider.ts` | 仅上游 | Controller：候选行、更新调度和失效 | 过滤隐藏标题，配置的展示项不重复请求模型 |
| `browser/stickyScrollWidget.ts` | 仅上游 | Controller：标题 DOM、行节点复用及布局 | 保留 LineId 身份；复用正文着色，显示行号、折叠按钮及结尾预览；布局和焦点随状态更新 |
| `browser/stickyScrollActions.ts` | 仅上游 | Contribution / 标题键盘入口：六个标准命令 | 开关、聚焦、上下移动、定位和返回编辑器；标准 StickyScrollContext 菜单及选中状态 |
| `browser/stickyScrollController.ts` | 双方都有 | Contribution：候选行与编辑器滚动、选区之间的协调 | 标题定位、结尾预览、折叠、按高度限制行数；定义悬停预检与点击、右键与键盘菜单 |
| `browser/stickyScrollContribution.ts` | 双方都有 | editor.all：装配与初次更新 | 服务经实例化容器注入，构造阶段不启动请求 |
| `browser/stickyScroll.css` | 双方都有 | Widget：Stanza 标题行与两个并列按钮 | 固定行号区域、着色文字、折叠按钮状态及主题焦点颜色；按钮不相互嵌套 |

外围修改限定为 `common/editorContextKeys.ts` 的两个状态键、现有 standalone 浏览器测试与本台账。模型文字和 LineId 归 TextModel，折叠状态归 EditorFoldingModel，滚动和坐标归现有 View；没有新增第二套编辑状态。

续批起始工作树干净。准入链：滚动、悬停或点击标题 → Controller → Widget → TextModel 的 `tokenization.renderedTokens` / `EditorFoldingModel` → 文字样式、行号、隐藏行和焦点 → standalone Playwright 场景。准确生产路径为本目录的 `browser/stickyScrollWidget.ts`、`browser/stickyScrollController.ts`、`browser/stickyScroll.css`（续批开始时均为双方已有）；修改仅覆盖上述行为。测试路径为既有 `ash-ts/test/integration/browser/standalone.integration.ts`、`ash-ts/test/integration/browser/standalone.integration.spec.ts`；文档仅更新本文件。没有新建或删除文件。

Widget 继续拥有并复用标题按钮，在同一行中增加独立折叠按钮和装饰性行号；调用正文已经使用的 `projectStanzaSemanticTokenLine`，不增加文字或 token 状态。Controller 监听着色、光标、模型选项及布局变化，折叠直接修改同一个折叠模型，等同步滚动完成再更新标题，保留键盘焦点。`showEndForLine` 和 `isInFoldingIconDomNode` 已有实际输入调用方；Shift 释放、指针离开或窗口失焦时退出结尾预览。标题数量同时受配置上限和编辑器约四分之一高度约束。

导航续批准入：修饰键点击 → Widget 的 `getEditorPositionFromNode` 与浏览器文字命中 → 当前编辑器选区 → 已确认的 `languageNavigationController.navigate('definition')` → 既有请求取消、结果去重和打开逻辑。仅修改上述 Widget、Controller 与既有浏览器测试；文字渲染返回的 CharacterMapping 由 Widget 保存，没有新建导航请求 owner。默认 Ctrl/Cmd、配置多光标使用 Ctrl/Cmd 时的 Alt 均有定向验证。

菜单续批准入：右键 / Shift+F10 → Controller → `IContextMenuService` → `MenuId.StickyScrollContext` → `ToggleStickyScroll` → 当前编辑器选项。增加的生产路径为 `standalone/browser/standaloneServices.ts`、`../platform/actions/common/actions.ts` 与本目录 `browser/stickyScrollActions.ts`，均为双方已有文件；测试装配增加既有 `test/browser/testCodeEditor.ts`，文档仍只更新本文件。Standalone 注册真实命令、快捷键、通知、菜单与 ContextView 服务；浏览器菜单及按钮继续由 Platform/Base 拥有。快捷键复用 KeybindingResolver，通知写入可观察记录并报告到嵌入页控制台，菜单主题绑定到自己拥有的浮层根节点。Controller 构造注入菜单服务；菜单随模型释放，关闭后恢复来源标题焦点；选中状态读取当前编辑器的 stickyScroll 选项。

全量验证暴露 Workbench 测试装配缺少菜单依赖，追加准入既有 `../workbench/contrib/codeEditor/test/browser/codeEditorPane.test.ts`：复用 Editor 测试服务注册，并断言 stickyScroll 控制器实际创建成功。没有修改 Workbench 生产实现。

模型来源续批准入：滚动后的标题、文档变化或提供者注册变化 → `StickyLineCandidateProvider.update` → `StickyModelProvider.update` → 当前文档符号提供者与现有折叠模型 → 保持有效来源、选择覆盖范围最大的符号组、按配置顺序选择范围 → 模型来源单测与 standalone Playwright。准确生产路径为本目录的 `browser/stickyScrollModelProvider.ts`（提供者选择、错误和取消）及 `browser/stickyScrollProvider.ts`（传递既有错误报告入口）；两者均为双方已有。测试路径为既有 `test/browser/stickyScroll.test.ts`、`ash-ts/test/integration/browser/standalone.integration.ts`、`ash-ts/test/integration/browser/standalone.integration.spec.ts`，文档仍只更新本文件。保留当前工作树中的导航和菜单改动。TextModel、折叠模型和 View 的状态及 Widget DOM、布局、焦点职责不变；不创建或删除文件。

悬停续批准入：修饰键及指针 → 现有 Controller / Widget 命中映射 → `ILanguageFeaturesService.definitionProvider` → 版本绑定的可用性预检 → 标题根节点状态与文字下划线 → standalone Playwright。准确生产路径为本目录既有 `browser/stickyScrollController.ts` 和 `browser/stickyScroll.css`，均为双方已有。预检由 Controller 的指针会话取消；点击后的导航仍由既有导航控制器处理，其请求生命周期不同。只使用现有标题根节点状态，不改变内部 DOM、文字、布局或主题颜色；标题键盘定位后仍可通过 F12 跳转。测试继续使用上述 standalone 两个文件。

模型来源已支持多个提供者并行返回、首次比较含子符号的累计范围、后续优先沿用 `outlineProviderId` 对应的有效来源；空结果和单个提供者错误不会丢弃其他有效来源。没有文档符号时选用现有折叠范围；没有折叠范围或折叠关闭时计算缩进范围。上游的独立 OutlineModel 分组与缓存尚未引入，本批选择状态仍归 StickyModelProvider。

修饰键悬停预检与下划线提示已接通。同一单词内移动复用当前检查；松开修饰键、离开标题、重绘、语言 / 提供者 / 配置变化及释放时取消预检并移除提示。提示使用文字当前颜色，高对比度主题同样显示下划线，悬停不改变编辑器选区。

尚未完整对齐的能力：控件高度事件在本地暂无消费方，不增加空端口；标准 `gotoSymbol/browser/goToSymbol.ts` 查询入口仍是导航模块的待处理项。预检只读取定义可用性，点击使用已有导航 owner。开关命令修改当前编辑器选项，Workbench 持久配置不在本批。控制器仍保留在下方待核对表，不能按成员数记作全量完成。

当时 Editor 文件集合为 **537 个：432 个上游同路径、105 个 Ash 自有；302 个上游路径未引入**。本批 CSS 审计无阻断项。实际验证：

- 续批 `test:editor:browser --grep 'sticky'`：15 项通过，包括正文与标题颜色一致、着色更新不丢焦点、固定行号、相对与自定义行号、鼠标 / Enter / Space 折叠、隐藏按钮后转移焦点、Shift 结尾预览及窗口高度限制。
- 续批 `check-editor-alignment.mjs --test=browser` 通过，包括结构、台账、CSS、类型检查与 555 个浏览器测试；`build:stanza` 通过。
- 导航与菜单续批：3 个定义跳转测试及 3 个菜单测试通过，覆盖准确列号、修饰键配置、模型切换取消、来源编辑器、焦点恢复、高对比度、命令错误、组合键和菜单生命周期。首次编译遇到商城生成协议不同步，运行仓库 `typecheck:common` 同步后恢复，无商城源码修改。
- 导航与菜单全量验证：`check-editor-alignment.mjs --test=all` 通过，包括 1,234 个单元测试（235 个文件）与 565 个浏览器测试；`build:stanza` 通过。修正测试装配后，单独运行 `codeEditorPane.test.ts` 的 12 项测试通过，缺失服务错误消失；该测试环境既有的 JSDOM Canvas 提示仍存在，浏览器行为由 Playwright 验证。
- 模型来源与悬停定向验证：2 个来源选择浏览器场景及 16 个悬停 / 点击相关场景通过，覆盖多提供者、来源移除、空符号与关闭折叠、修饰键配置、高对比度、无定义及过期结果拒绝。
- 模型来源与悬停全量验证：`check-editor-alignment.mjs --test=all` 通过，包含 1,242 个单元测试（模型来源 12 项）与 579 个浏览器测试；结构、台账、CSS 归属、类型检查及 `git diff --check` 通过，`build:stanza` 通过。未出现新增缺失服务或编译错误；保留测试环境原有的 JSDOM Canvas 提示。
- 首批 `test:editor:unit --grep 'Sticky scroll scope sources'`：4 个模型来源测试通过。
- 首批 `test:unit --run test/architecture/editor-architecture.test.ts`：23 项通过、1 项失败。失败断言要求 `smartSelect/common/selectionRanges.ts`，该路径在 HEAD 中已经不存在，断言和相关实现均未由本批修改。
- 未启动上游 VS Code 做同场景运行比较；上游证据来自公开契约及行为测试。本批不能据此宣称完整界面行为一致。

## 现有功能链剩余修正（2026-09-21）

本轮处理上次审查的八类问题，起始工作区干净。范围继续限定为现有功能链：保留单一文本、token、历史和后端 diff owner，不引入整套前端 diff / Tree-sitter。下面的当前结果覆盖历史批次中已经过时的缺口描述；历史数字只代表当时状态。

| 审查项 | 本轮结果 |
| --- | --- |
| 协议生成顺序 | common 类型检查先同步已提交的 Rust 协议快照，普通测试和构建入口无需手动准备。 |
| 语言与请求生命周期 | 悬停、智能选区、跳转、层级、文档符号、符号图标和颜色控件读取当前模型语言，失效时取消请求并拒绝迟到结果。 |
| 签名上下文 | 使用 provider 声明的触发 / 重触发字符，传递重触发状态和活动签名；扩展桥保留 JSON 上下文。 |
| 重命名与 Quick Fix | 标准 action / command 接通现有控制器；条件随模型、语言、provider 和只读状态更新。 |
| 请求职责 | 删除五个单消费者请求 service；共享 DocumentSymbolService 与 ColorService 保留。 |
| Peek / Color Picker | 控件进入对应路径，拥有自身挂载、事件和释放，调用方管理请求和编辑。 |
| 内部光标入口 | Widget.selections、contribution.selectionController 和 getViewModelCursorController 已退出，调用方使用 ICodeEditor / IViewModel。 |
| CSS 与记录 | 六份只替换品牌的 CSS 已重写，无效主题变量改用 Ash 注册颜色，输入样式命中实际 DOM；更新本记录与 browser/README.md。 |

此前轮次记录 **533 个生产文件：427 个上游同路径、106 个 Ash 自有；307 个上游路径未引入**。54 份 CSS 中，与上游原样相同、仅替换品牌后相同、上游品牌残留均为 **0**。同名声明总账仍为 **80 项已处理、41 项待核对**；新路径、相同成员名和通过 Ash 测试不等于完整上游契约。

common 保持 **211 个文件：180 个同路径、31 个 Ash 自有；46 个上游路径未引入**。其中 22 个由现有 owner 承担、22 个属于已排除的 diff / Tree-sitter、2 个没有当前消费者。fixBrackets 和 languageFeatureDebounce 已接通；不是待新增文件。

本轮文档准入：现有 `browser/README.md` 与本记录，修正职责、剩余范围及验证状态，不移动文档。

### 构建协议准备

准入路径：`ash-ts/package.json`（Ash 构建入口）、本记录。构建 / 测试 / 直接 common 类型检查先同步 Rust 已提交的协议快照，再检查消费方。`ash-rs/app-server-protocol/schema/typescript` 仍有 Advisor 类型；此前“协议已移除”的判断不准确，实际是忽略跟踪的前端 generated 目录过期。生成器与后端协议不变，通过现有 sync 脚本刷新，不手改生成内容、不删除 Advisor 功能。验证 `typecheck:common`、常规测试及生产构建。

### 悬停与智能选区

鼠标悬停 / 扩大选区 → contribution → 控制器 → 当前模型和 provider registry → 结果显示或选区变化。控制器唯一持有请求和释放，保留既有 View 坐标、DOM 与 smartSelectionExpansion 纯算法。用户已授权收拢职责；删除旧文件前迁完全部生产与测试引用，恢复来源为本批开始时 Git HEAD。

| editor 相对路径 | 关系 | 动作 |
| --- | --- | --- |
| `contrib/hover/browser/hoverController.ts` | 仅 Ash | 迁到 contentHoverController.ts，合并请求选择与校验；监听语言、注册和释放。 |
| `contrib/hover/browser/contentHoverController.ts` | 仅 VS Code | 承接现有悬停 DOM 与请求生命周期，不新增界面层。 |
| `contrib/hover/browser/hoverContribution.ts` | 双方都有 | 容器构造控制器并注入语言服务。 |
| `contrib/hover/common/hover.ts` | 仅 Ash | 移入控制器后删除无独立状态的 service。 |
| `contrib/smartSelect/browser/smartSelectController.ts` | 仅 Ash | 迁到 smartSelect.ts，合并范围请求，取消失效选区请求。 |
| `contrib/smartSelect/browser/smartSelect.ts` | 仅 VS Code | 承接现有键盘入口与纯选择算法的调用。 |
| `contrib/smartSelect/common/selectionRanges.ts` | 仅 Ash | 请求归控制器后删除 service。 |
| `editor.all.ts` | 双方都有 | 迁移 smartSelect import。 |
| `test/browser/standaloneEditor.test.ts` | 仅 Ash 测试 | 注册测试直接验证 registry；DOM 生命周期由浏览器测试验证。 |

同批测试路径：`ash-ts/test/integration/browser/standalone.integration.ts`、`standalone.integration.spec.ts`；Workbench 适配测试 `services/language/test/common/languageFeaturesService.test.ts`、`services/language/test/browser/appServerLanguageProviders.test.ts`、`services/language/test/browser/appServerSyntaxProviders.test.ts`、`services/extensionHost/test/browser/appServerExtensionHostService.test.ts` 只迁移旧 service 引用到实际 provider 契约。真实 standalone 编辑器验证请求在语言、注册、选区、文本、模型和释放变化时取消，迟到结果不显示，下一次请求使用当前语言。首条链通过后再迁移导航与层级。

### 导航、层级与文档符号

本轮新增准入：导航 / 层级 / 文档符号快捷键 → 各自控制器 → registry → 当前语言和快照 → 跳转、Peek 或符号列表。悬停与智能选区取消及当前语言场景已分别通过 8 项浏览器测试，允许继续同类迁移。保留 Ash 层级 UI、Peek 与 View 的现有 owner；收回单消费者请求 service，保留多消费者 DocumentSymbolService 与纯算法。

准确路径（均相对 `ash-ts/src/ash/editor`）：`contrib/gotoSymbol/browser/languageNavigationController.ts`、`languageNavigation.contribution.ts`、`gotoSymbolController.ts`、`gotoSymbol.contribution.ts`；`contrib/callHierarchy/browser/languageHierarchyController.ts`、`languageHierarchy.contribution.ts`。这些仅 Ash 文件已获本轮职责收拢授权：控制器注入 registry，读取当前语言，统一取消；层级展开返回时复核会话，节点移除时释放自己的监听器。旧 `contrib/gotoSymbol/common/languageNavigation.ts`、`languageDocumentSymbolSearch.ts`、`contrib/callHierarchy/common/languageHierarchy.ts` 的生产调用全部迁入控制器后删除，Git HEAD 可恢复。测试 `test/common/languageNavigation.test.ts`、`languageHierarchy.test.ts` 迁到 `test/browser` 同名路径，使用新增测试辅助 `test/browser/testLanguageFeatureEditor.ts` 走真实 Widget；Workbench `services/language/test/browser/appServerLanguageProviders.test.ts` 改走 provider 契约。既有两份 standalone 浏览器测试追加取消、当前语言、层级展开和重复会话场景。没有新增无调用方的公开 API。

### 签名触发信息与编辑器动作

新增准入链：输入 provider 声明的字符 → 签名控制器排队 → 请求携带重触发状态与活动签名；F2 / Ctrl+. / 公开 action → editor 作用域条件 → 既有 Rename / Code Action 控制器。准确生产路径：`common/languages.ts`、`common/editorContextKeys.ts`、`browser/widget/codeEditor/codeEditorWidget.ts`、`contrib/parameterHints/browser/parameterHints.ts`、`contrib/rename/browser/rename.ts`、`contrib/codeAction/browser/codeActionController.ts`、`codeActionContributions.ts`（双方都有）；新增上游同路径 `contrib/codeAction/browser/codeActionCommands.ts` 承接 QuickFixAction，由 contribution 接入。只补当前 UI 的触发、接受、取消命令，不制造尚无能力的 refactor/source actions。

Workbench 准入：`services/language/browser/appServerLanguageProviders.ts` 与 `api/browser/extensionHostLanguageBridge.ts`（已有 Ash 适配层），各自声明现有签名触发字符，避免与 completion 的字符混淆；扩展 host 传递 JSON 上下文，App Server 保持现有已生成协议能力。测试准入：现有 `contrib/parameterHints/test/browser/parameterHints.test.ts`、两份 standalone 浏览器测试、`workbench/services/extensionHost/test/browser/appServerExtensionHostService.test.ts`。验证自定义触发与只在活动会话重触发、无声明时仅显式调用、签名上下文、动态 provider / 只读条件和公开动作真实效果。状态继续归控制器，条件由 Widget 的现有上下文管理器统一维护。

注册 ID 迁移补充：`test/browser/editorExtensions.test.ts` 同步 CodeActionController.ID，旧 ID 的生产和测试引用同批退出。

### 光标内部入口退出

补充测试准入：`contrib/find/test/browser/findController.test.ts` 的 fixture 解构也持有 Widget.selections；同步改用 Widget 的选区与模型入口，保留查找、替换、撤销断言。

准入：单词高亮与编辑器交互状态 → ICodeEditor 的选区、事件 → IViewModel 的既有操作 → 唯一 CursorsController。`browser/widget/codeEditor/codeEditorWidget.ts` 删除公开 selections 与重复 model-state 引用；`browser/editorExtensions.ts` 移除两个 context 的 selectionController；`common/viewModel/viewModelImpl.ts` 删除 WeakMap 和 getViewModelCursorController。调用方 `contrib/wordHighlighter/browser/wordHighlighter.contribution.ts`、`contrib/editorState/browser/editorStateController.ts` 迁到编辑器契约，前者同时不再缓存语言 ID。以上均已有文件，不新增转发层或光标 owner。

测试准确路径：`test/browser/viewModel/testViewModel.ts`、`viewModelImpl.test.ts`、`test/browser/coreCommands.test.ts`、`test/browser/widget/codeEditorWidget.test.ts`、`contrib/transpose/test/browser/transposeController.test.ts`、`contrib/wordHighlighter/test/browser/wordHighlighter.test.ts`、`ash-ts/test/integration/browser/textModel.integration.ts`。前五项改用真实 ViewModel/Widget 端口；高亮测试创建真实 Widget，保留 Unicode、多文件、取消和导航行为覆盖；浏览器多光标测试经 setSelections 执行。只删除已迁走的入口与对应内部计数断言，保留公开事件与结果断言。

### Peek 与颜色控件归属

导航 / 层级 / Quick Diff → PeekViewWidget → ZoneWidget 的留白与覆盖层；颜色控制器 → ColorPickerWidget → 已有 ColorPickerModel 与控件。准入路径：`contrib/peekView/browser/editorPeekViewWidget.ts` 迁入上游对应 `contrib/peekView/browser/peekView.ts`，标题更新与关闭事件归 Widget，控制器收到关闭后释放请求和子编辑器；`contrib/colorPicker/browser/editorColorPickerDialog.ts` 迁到 `colorPickerWidget.ts`，控件挂载、移除和用户事件归 Widget，控制器只处理颜色请求与提交。旧文件引用清空后删除，Git HEAD 可恢复。保留已有 DOM、配色、尺寸和颜色模型，不复制上游私有 header/body 类。

同批准确调用方：`contrib/gotoSymbol/browser/languageNavigationController.ts`、`contrib/callHierarchy/browser/languageHierarchyController.ts`、`contrib/colorPicker/browser/colorPickerController.ts`、`workbench/contrib/scm/browser/quickDiffEditorController.ts`；验证文件为既有 standalone 两份浏览器测试及 `test/integration/browser/textModel.integration.spec.ts`。标准入口没有完整上游接口时继续标明范围，不因改名宣称全部契约完成。首个 Peek 关闭链先用真实浏览器验证，颜色控件再独立验证。

### 编辑器样式与同因修正

同因补充准入：沿本轮颜色控件和文档符号调用链，确认 `contrib/colorPicker/browser/colorPickerController.ts`、`colorDetector.ts`、`contrib/symbolIcons/browser/symbolIcons.ts`、`symbolIcons.contribution.ts` 仍缓存创建时语言。现有控制器改读模型当前语言，语言/提供者/释放立即取消请求，颜色面板同时响应只读变化；不改变共享 ColorService 与 DocumentSymbolService 的归属。符号贡献通过现有容器注入 registry。验证准确路径为 `contrib/colorPicker/test/browser/colorPickerController.test.ts`、新增 `test/browser/symbolIcons.test.ts`（现有真实 Widget 辅助）、既有 standalone 两份浏览器测试。测试隔离符号导航与后台图标两个独立消费者，另以真实图标装配验证动态注册和语言变化。

准入链：View 已有选区、装饰、空白、边栏和输入 DOM → 所属 CSS → Ash 已注册主题变量 → 浏览器计算样式、点击目标与 IME 焦点。准确路径：`browser/viewParts/decorations/decorations.css`、`glyphMargin/glyphMargin.css`、`margin/margin.css`、`selections/selections.css`、`whitespace/whitespace.css`、`lineNumbers/lineNumbers.css`、`viewLines/viewLines.css`；`browser/controller/editContext/textArea/textAreaEditContext.css`、`browser/controller/editContext/native/nativeEditContext.css`；`browser/gpu/css/decorationCssRuleExtractor.ts` 与其 `media/decorationCssRuleExtractor.css`。均有真实 DOM owner；六份仅换品牌的旧样式按本地 DOM 重新实现，删除不产生的 radius / overflow 等选择器，不复制上游声明。其余只修正具体无效变量与高对比选择器。

`common/core/editorColorRegistry.ts` 补当前选区、行号、空白和边栏实际需要的 token，使用现有主题颜色建立四种主题默认值。测试准入：`test/integration/browser/textModel.integration.spec.ts`、`standalone.integration.ts`、`standalone.integration.spec.ts`；覆盖主题切换、聚焦与失焦选区、空白、行号、输入、颜色面板、关闭释放与输入法。保留 View 的坐标和现有 DOM 层级，不制造颜色别名桥接。

### 最终验证

- `check-editor-alignment.mjs --test=all` 通过：235/235 份单测文件、513/513 项 Playwright 浏览器用例，以及台账、类型、结构和生成产物检查。
- 最后的颜色提供者清理补强会立即移除已退出提供者的旧色块；补强后的 6 项颜色单测与 12 项相关浏览器用例通过，同时重新完成全测试 TypeScript 编译与 Renderer / Stanza 构建。两种生产构建没有 warning。
- Electron UI 的聊天编辑器输入 / 换行 / 焦点和两项编辑器窗口布局场景均通过，3/3。使用仓库 Playwright 入口，没有依赖截图判断。
- 全量单测仍输出既有 JSDOM Canvas 提示，以及测试装配中的 markerDecorationsService / IInlineCompletionsService 提示各 5 次；本轮新测试的装配和 Canvas 提示已清除。浏览器仍有环境变量 NO_COLOR 提示。
- 旧生产引用为零；CursorsController 仅由自身文件与 ViewModelImpl 使用。54 份 CSS 的原样复制、仅替换品牌复制和品牌残留均为零。没有新增未跟踪 JavaScript 产物；结构审计和 `git diff --check` 通过。

全部改动保留在工作区，未暂存或提交。本轮完成的是上述八类问题和相同原因的现有调用链修正；完整上游 API、前端 diff / Tree-sitter、新的 Rename 预览和 Code Action 分类等能力不计作已实现。

## 签名提示命令与签名切换（2026-09-21）

准入链：快捷键 / `getAction().run()` / `trigger()` → 已有 EditorAction / EditorCommand 注册表 → 当前编辑器的签名提示控制器 → 查询、关闭或切换返回的签名 → 现有 DOM 与上下文状态。检查发现 `trigger()` 尚未分发已注册命令；先补该入口，再接功能命令，避免组件内保留另一套动作实现。

| 准入路径（相对 editor，另有标注除外） | 存在关系 | 唯一 owner、本批动作与验证 |
| --- | --- | --- |
| `browser/widget/codeEditor/codeEditorWidget.ts` | 双方都有 | `trigger` 分发本编辑器的动作 / 命令并报告异步错误；现有上下文管理器维护 signature provider 可用性，随注册、语言、模型及释放更新。验证编辑器作用域、条件和错误。 |
| `common/editorContextKeys.ts` | 双方都有 | 补实际被触发动作消费的 `hasSignatureHelpProvider`，不承载状态。 |
| `contrib/parameterHints/browser/parameterHints.ts` | 双方都有 | 注册触发、关闭、上一项和下一项；控制器持有结果和活动签名，维护可见 / 多签名上下文，尊重已有 cycle 配置。按键进入公开 trigger，不增加状态服务或 DOM owner。 |
| `contrib/parameterHints/test/browser/parameterHints.test.ts` | 仅 Ash 测试 | 真实 Widget 验证动作条件、命令取消、切换、不重复查询与释放。 |
| `test/browser/widget/codeEditorWidget.test.ts` | 双方都有 | 验证公开 trigger 的目标编辑器、payload、条件与错误报告。 |
| `ash-ts/test/integration/browser/standalone.integration.ts`、`standalone.integration.spec.ts` | 仅 Ash 测试 | 实际键盘和公开命令验证切换、循环边界、焦点 / 选区 / DOM 稳定、无障碍状态和动态 provider。 |
| `browser/README.md`、`api-alignment-status.md` | 仅 Ash 文档 | 更新已接通的命令、状态职责、验证和剩余契约差异。 |

独立实现：保持提示 div/strong、现有主题 class、输入焦点、View 坐标及 CSS；切换只更新现有签名节点，不请求 provider、不改变正文和选区。结果和活动下标由现有控制器统一持有，上下文只反映该状态。沿现有构造注入取得编辑器作用域的上下文服务。上游仅核对命令 ID、快捷键、provider 条件及 cycle=false 到边界时关闭的行为，不搬入其 Model/Widget 私有结构。关闭命令可取消在途请求；可见上下文仍只描述实际显示。

本批开始时上一批签名提示改动已暂存；保留暂存区，只追加本批工作区变化。

最终结果：

- 四个命令均已接通：`editor.action.triggerParameterHints`、`closeParameterHints`、`showPrevParameterHint`、`showNextParameterHint`。按键通过 editor 的 keydown 事件先消费，再进入公开 `trigger`，正文导航不会重复处理。切换保留原签名节点，以 `aria-current` 标记活动签名，并提供键盘说明。
- 两份受影响单测共 77 项通过（签名提示 10 项、Widget 67 项），无警告。常规入口被下述范围外错误阻塞后，使用临时配置继承 `ash-ts/tsconfig.test.json`，仅将 include 缩到两份测试与原声明文件，并将相同 types 解析为绝对路径；编译通过后用原 `test/unit/editor.ts --run` 执行，未跳过类型检查。
- `pnpm --dir ash-ts test:editor:browser` 完整通过，459/459 项，其中签名提示定向场景 31 项。验证公开动作和命令、动态 provider / 语言 / 模型上下文、循环边界、焦点与选区不变、DOM 复用、取消和原有输入链。浏览器只保留既有 `NO_COLOR` 环境提示。
- Stanza 直接编译目标 `tsc -p ../build/vite/stanza/tsconfig.json --noEmit` 与现有 `editor.vite.config.ts` 生产打包均通过，无警告。
- 当时 `check-editor-alignment.mjs --test=all`、常规单测入口和构建被 `platform/sessions/common/sessionApi.ts` 的四处类型错误阻塞。原先“生成协议已移除 Advisor”的判断已纠正：Rust 已提交快照仍有这些成员，是本地生成目录过期且检查顺序错误；本轮通过既有同步脚本及 package 生命周期修复。
- 结构、台账、CSS ownership 和 `git diff --check` 通过；生产文件集合仍为 537 个（422 同路径、115 Ash 自有），声明核对仍为 80/41。没有新增文件或修改 CSS。provider 触发字符声明、标准 signature-help 请求契约与独立 Model/Widget 接口仍待后续调用链处理。

## 签名提示查询、排队触发与关闭（2026-09-21）

准入链：Ctrl/Cmd+Shift+Space 或输入 `(`/`,` → 标准 bundle 的签名提示贡献 → 公共 signature-help registry → 当前快照与光标查询 → 现有提示 DOM 与 View 坐标 → Escape、配置变化或释放取消。现有 `ParameterHintsService` 只有控制器一个生产消费者；请求信号、排队任务、启用配置和提示显示必须由同一会话持有，不能让关闭后遗留的任务重新打开提示。

| 准入路径（相对 editor，另有标注除外） | 存在关系 | 唯一 owner、本批动作与验证 |
| --- | --- | --- |
| `contrib/parameterHints/browser/parameterHints.ts` | 仅 VS Code | 承接现有贡献、DOM、请求与可取消排队任务；注入语言 registry，读取当前语言和配置，校验返回的签名，修复首次定位及默认活动签名。真实 Widget/Playwright 验证输入、关闭与生命周期。 |
| `contrib/parameterHints/browser/parameterHintsController.ts` | 仅 Ash | bundle 唯一调用迁入准确路径后删除，不保留别名，Git 可恢复。 |
| `contrib/parameterHints/common/languageParameterHints.ts` | 仅 Ash | 请求选择及结果校验收回控制器后删除；公共 provider 类型保留在 `common/languages.ts`。Git 可恢复。 |
| `editor.all.ts` | 双方都有 | 仅修改签名提示的副作用 import。 |
| `contrib/parameterHints/test/browser/parameterHints.test.ts` | 仅 Ash 测试 | 新增真实编辑器创建链测试，验证请求快照、提供者错误隔离、空结果、结果校验和取消。 |
| `ash-ts/src/ash/workbench/services/language/test/browser/appServerLanguageProviders.test.ts`、`ash-ts/src/ash/workbench/services/extensionHost/test/browser/appServerExtensionHostService.test.ts` | 仅 Ash 测试 | 通过公共请求调用已注册的 provider，移除旧请求服务依赖，保留宿主协议断言。 |
| `ash-ts/test/integration/browser/standalone.integration.ts`、`standalone.integration.spec.ts` | 仅 Ash 测试 | 验证快捷键、输入触发合并、Escape 取消排队/在途请求、语言/配置/提供者/光标/焦点/模型变化、首次位置及背景编辑器不请求。迁移原卸载测试的贡献 ID。 |
| `ash-ts/test/architecture/editor-architecture.test.ts` | 仅 Ash 测试 | 增加准确 bundle 路径断言。 |
| `common/cursor/cursor.ts` | 双方都有 | 追加准入：输入回归发现 `setStates` 在文本提交后才记录旧文档版本；编辑事务记录提交前版本，事件直接携带准确的前后状态，不改变光标操作或事件入口。 |
| `test/browser/widget/codeEditorWidget.test.ts` | 双方都有 | 追加准入：通过真实输入/编辑/导航验证选区事件的旧选区、旧版本与新版本，覆盖签名提示所需的区分依据。 |
| `browser/README.md`、`api-alignment-status.md` | 仅 Ash 文档 | 更新唯一请求 owner、验证与未完成的标准接口。 |

独立实现：保留 Ash 的 div/strong 提示 DOM、现有 CSS 和 View 布局来源，不复制上游 Model/Widget 私有结构。以可取消的一次调度替代不受关闭约束的微任务；模型内容变化立即中止旧查询，在编辑完成后读取最新光标。同一次编辑引起的选区事件不取消新触发，独立导航会取消。上游证据只用于定位 `parameterHints.ts`、查询的提供者错误隔离以及触发合并/关闭语义。完整标准命令、provider 触发字符声明、签名切换及独立 Model/Widget 公共契约仍单独记录。

选区事件回归：输入、粘贴和 `executeEdits` 原先把提交后的版本写入 `oldModelVersionId`，因此消费方无法用事件区分编辑与导航。三个真实 Widget 用例在修复前均失败；光标 owner 在现有事务中保留提交前版本后通过，不再由签名提示猜测事件来源。Widget 测试文件的全局 JSDOM Canvas 装配同步补齐，与其局部窗口的处理一致。

最终验证：

- `check-editor-alignment.mjs --test=all` 通过：234/234 份单测文件、450/450 项 Playwright 用例，以及结构、台账、类型和生成文件检查。
- 25 项签名提示浏览器场景覆盖在途与排队取消、连续输入、动态开关、共享模型、语言变化、首次位置、默认活动签名、焦点和迟到结果。真实 Widget 单测另覆盖请求快照、错误隔离、结果校验、只读查询与模型释放。
- Renderer 与 Stanza 生产构建通过，无构建警告。全量测试保留既有 Canvas、marker / inline-completion 测试装配及颜色环境提示；新增选区用例带出的 Canvas 提示已修复测试装配，随后该文件 65/65 项复验通过且无警告。
- 旧请求服务、旧控制器文件及代码引用已退出。Editor 生产文件为 537 个：422 个同路径、115 个 Ash 自有，上游尚缺 312 个路径；common 文件集合与 80/41 声明计数不变。没有修改 CSS 或新增品牌引用。
- 本批闭合已有签名提示链；完整标准命令、provider 触发字符声明、签名切换及独立 Model/Widget 公共接口仍未完成，不计为完整签名提示 API 对齐。

上一批重命名变化已由用户提交；本批改动留在工作区，未创建提交。

## 重命名准备与提交会话（2026-09-21）

准入链：F2 → 标准 bundle 的重命名贡献 → 公共 rename registry → 准备位置与原提供者 → 输入新名称 → 同一快照内提交 → 编辑器事务或宿主工作区编辑。原 `RenameService` 仅有一个生产消费者，准备与提交使用分离请求，提交时丢失提供者归属并重读光标，语言还停留在装配时的值；本批按已授权的职责收敛，将该请求和取消状态迁入重命名贡献。

| 准入路径（相对 editor，另有标注除外） | 存在关系 | 唯一 owner、本批动作与验证 |
| --- | --- | --- |
| `contrib/rename/browser/rename.ts` | 仅 VS Code | 承接现有贡献、输入 DOM 与准备/提交会话；注入语言服务，保留原提供者、快照、位置及信号，校验本地编辑版本。验证取消、一次提交和一次撤销。 |
| `contrib/rename/browser/renameController.ts` | 仅 Ash | 唯一 bundle 调用迁入准确 owner 后删除；不保留别名或测试专用导出，Git 可恢复。 |
| `contrib/rename/common/languageRename.ts` | 仅 Ash | 唯一生产消费者的调度迁出后删除；公共契约继续由 `common/languages.ts` 拥有，Git 可恢复。 |
| `editor.all.ts` | 双方都有 | 仅迁移 rename 副作用 import。 |
| `contrib/rename/test/browser/renameController.test.ts` | 仅 Ash 测试 | 迁为真实 Widget 装配，覆盖原提供者、可选准备、命令通知、错误与宿主提交边界。 |
| `ash-ts/src/ash/workbench/services/language/test/browser/appServerLanguageProviders.test.ts` | 仅 Ash 测试 | 直接验证已注册的 rename provider 及公共请求，移除旧服务引用。 |
| `ash-ts/test/architecture/editor-architecture.test.ts` | 仅 Ash 测试 | 更新标准 bundle 的准确 rename 路径断言。 |
| `test/browser/editorExtensions.test.ts` | 仅 Ash 测试 | 追加准入：bundle 身份断言改为上游对应 `editor.contrib.renameController`，验证命令注册保持存在。 |
| `ash-ts/test/integration/browser/standalone.integration.ts`、`standalone.integration.spec.ts` | 仅 Ash 测试 | 真实键盘/指针验证准备与编辑期间取消、重复 Enter、失效、焦点和撤销。 |
| `browser/README.md`、`api-alignment-status.md` | 仅 Ash 文档 | 更新会话 owner 与验证结果，保留未完成的标准命令/API 差异。 |

独立实现：沿用现有 input/status DOM、View 坐标及 CSS，不复制上游 Widget 或私有类图。一个会话持有一次请求及成功准备的提供者；没有可选 prepare 方法时按公共契约使用当前词。内容、选区、语言、提供者、只读、焦点离开与释放使会话失效；输入自身的指针事件由输入组件消费，避免改变底层选区。编辑交给宿主以后保留其错误报告，旧回调不能关闭新的会话。上游只用于确认 `rename.ts` 的调度归属、F2 可写条件和位置/内容取消语义；完整 RenameAction、预览及名称建议不在本切片内。

焦点回归：编辑器的失焦通知会延迟到下一轮事件循环，提供者在此之前完成时，准备结果会抢回焦点，提交结果会改动已离开的文档。两个 Playwright 用例在修复前均失败；重命名组件在自己的根节点上同步处理焦点离开，保留编辑器内转移焦点，修复后全部 30 项重命名浏览器场景通过。

最终验证：

- `check-editor-alignment.mjs --test=all` 通过：233/233 份单测文件、427/427 项 Playwright 用例，以及结构、台账、类型和生成文件检查。
- Renderer 与 Stanza 生产构建通过，无构建警告。全量测试保留既有 Canvas、marker / inline-completion 测试装配及颜色环境提示；与上一批日志对比没有新增类别或数量，本批定向单测无警告。
- 原提供者、原快照、无可选准备方法、错误隔离、编辑基线校验、重复提交、宿主完成/失败及撤销均由真实 Widget 验证。浏览器另覆盖两阶段的九类失效、Escape、输入框点击、空名称、过期/空/错误结果与当前语言。
- 旧请求服务、旧控制器入口及代码引用已退出。Editor 生产文件为 538 个：421 个同路径、117 个 Ash 自有，上游尚缺 313 个路径。common 文件集合和 80/41 声明计数不变；本批未改 CSS，没有新增品牌引用。
- 完整 RenameAction 命令、重命名预览、名称建议及独立 Widget 公共接口尚未完成；本批不计为完整重命名 API 对齐。

本批开始时工作树为空；改动留在工作区，未创建提交。

## 代码操作查询、解析与应用生命周期（2026-09-21）

准入链：Ctrl/Cmd+. → `codeActionContributions.ts` 装配 → `CodeActionController` 查询公共 registry → 菜单选择原提供者的动作 → 原快照内解析 → 编辑器事务或宿主工作区编辑 → 取消 / 释放拒绝迟到结果。现有独立 `CodeActionService` 只有该控制器一个生产消费者，且解析阶段脱离菜单取消信号；按用户已授权的职责收敛，本批将其逻辑收回已有控制器，原服务文件在调用清零后退出，Git 可恢复。

| 准入路径（相对 editor，另有标注除外） | 存在关系 | 唯一 owner、本批动作与验证 |
| --- | --- | --- |
| `contrib/codeAction/browser/codeActionController.ts` | 双方都有 | 统一持有当前查询快照、原动作 / 提供者、解析及菜单状态；注入共享 registry。关闭、模型/语言/选区/提供者/只读变化取消查询和解析，提交前核对版本，防止重复点击重复提交。沿真实菜单验证取消与一次撤销。 |
| `contrib/codeAction/browser/codeActionContributions.ts` | 双方都有 | 保留诊断装配与注册入口，通过容器创建控制器，停止创建旧服务。 |
| `contrib/codeAction/common/languageCodeActions.ts` | 既有 Ash 请求载体 | 查询、解析与校验迁出后删除；公共契约仍在 `common/languages.ts`，不新增服务别名。 |
| `contrib/codeAction/test/browser/codeAction.test.ts` | 双方都有 | 通过真实 Widget 和 contribution 装配保留原提供者身份、禁止串用 resolver 的回归，增加事务和错误边界验证。 |
| `ash-ts/src/ash/workbench/services/language/test/browser/appServerLanguageProviders.test.ts` | 既有 Ash 测试 | App Server 契约断言直接消费已注册 provider 与公共快照请求，移除旧服务依赖。 |
| `ash-ts/test/integration/browser/standalone.integration.ts`、`standalone.integration.spec.ts` | 既有 Ash 测试 | 以可控异步 provider 验证真实快捷键、菜单点击、Escape、各类失效、解析期间重复点击与撤销。 |
| `browser/README.md`、`api-alignment-status.md` | 既有 Ash 文档 | 更新唯一请求 owner、验证结果与剩余标准接口差异。 |

独立实现：沿用 Ash 的 menu/button DOM、View 坐标和既有焦点恢复规则。一个菜单会话只使用一个快照和 AbortSignal，动作条目保存原 provider 与原对象；不以弱映射跨会话保留解析归属。工作区编辑的宿主回调保持不变，取消校验到宿主调用之前为止，已交给宿主的编辑不宣称可撤回。上游只核对公共 provide/resolve 契约、原提供者归属、缺失 edit 时解析以及模型解绑释放场景；不移植内部模型、菜单、灯泡与命令结构，不把本批计为标准 code-action API 全量对齐。

浏览器验证补充准入：真实按钮点击冒泡到正文 pointer/mouse 起始监听后改变选区，使菜单在 click 前失效。控制器在自己的菜单节点阻断这两个起始事件向正文传播，保留按钮默认焦点、click 和键盘路径；同批用 Playwright 真鼠标点击及双击验证，不修改正文指针 owner。

定向验证：27 个 Playwright 场景和 3 份单测文件通过。覆盖查询 / 解析两阶段的八类失效、Escape、原动作与快照身份、鼠标双击与 Enter / 空格激活、一次撤销、禁用 / 错误 / 版本不符结果、更新后的语言、宿主提交完成或失败时保留新菜单，以及提供者错误隔离。

最终验证：

- `check-editor-alignment.mjs --test=all` 通过：233/233 份单测文件、398/398 个 Playwright 用例，以及结构、台账和类型检查。
- Renderer 与 Stanza 生产构建通过，无新增构建警告。全量测试只保留既有 Canvas、marker / inline-completion fixture 服务及颜色环境提示；本批定向单测无警告。
- 旧请求服务及代码引用已退出。Editor 生产文件为 539 个：420 个同路径、119 个 Ash 自有；common 文件集合与 80/41 的声明计数不变，没有新增 CSS 或上游品牌引用。
- 最终结构与 `git diff --check` 检查通过；标准代码操作命令、kind 过滤、灯泡及完整公共 controller 接口仍未在本批实现。

本批开始时工作树为空；上一批行内提示变化已由用户提交。本批改动留在工作区，未创建提交。

## 行内提示请求与释放归回控制器（2026-09-21）

准入链：Standalone / Workbench 注册行内提示 → `InlayHintsController` 消费公共 registry 与模型快照 → 显示提示 → 编辑、语言/配置变化、提供者退出或功能释放时取消请求并清理节点 → Playwright 从公开编辑器入口验证。当前 `InlayHintsService` 只有该控制器一个生产调用方；按用户已授权的职责收敛，本批把请求选择与校验移回同路径控制器，删除不再有调用方的原文件，Git 可恢复。

| 准入路径（相对 editor，另有标注除外） | 存在关系 | 调用方、唯一 owner 与本批动作 / 验证 |
| --- | --- | --- |
| `contrib/inlayHints/browser/inlayHintsController.ts` | 双方都有 | contribution 装配调用；控制器统一持有请求、提示结果与节点，直接注入公共 registry / 防抖服务；响应模型、配置与 registry 失效，释放自己创建的节点。浏览器验证取消、刷新、节点复用和卸载。 |
| `contrib/inlayHints/common/languageInlayHints.ts` | 既有 Ash 请求载体 | 唯一生产调用方迁移后退出；没有公共 provider 契约遗留，不新增别名或替代服务。 |
| `ash-ts/src/ash/workbench/services/language/test/browser/appServerLanguageProviders.test.ts` | 既有 Ash 测试 | 使用注册的 provider 与公共快照请求验证 App Server 适配，移除旧请求 service 依赖；保留原断言。 |
| `ash-ts/src/ash/workbench/contrib/codeEditor/test/browser/codeEditorPane.test.ts` | 既有 Ash 测试 | 完整回归暴露旧 pane fixture 缺少防抖服务；补齐真实服务注册，断言实际窗格创建了行内提示 contribution，再运行该文件。 |
| `ash-ts/test/integration/browser/standalone.integration.ts` | 既有 Ash 测试 | 通过真实 Standalone 注册、编辑、配置、语言、模型切换与功能释放，提供可控异步 provider。 |
| `ash-ts/test/integration/browser/standalone.integration.spec.ts` | 既有 Ash 测试 | 验证动态注册、连续编辑防抖、旧结果拒绝、提供者错误、开关、释放、节点几何和模型内容不变。 |
| `browser/README.md`、`api-alignment-status.md` | 既有 Ash 文档 | 记录请求 / DOM owner、已验证行为与剩余能力差异。 |

独立实现：保留 Ash 的 span 提示与 `View.getPositionContentCoordinates` / `viewportLayout` 坐标来源。控制器只持有当前结果和自己的节点；布局仅更新坐标，不重建节点。公共请求仍由 `common/languages.ts` 创建并检验快照，防抖复用公共服务。上游证据限于公共 inlay provider / controller 职责及 registry、语言、配置、dispose 的可观察触发；不引入上游 fragment、装饰器或缓存类图。本批不改变 CSS、焦点目标和提示契约。

定向结果：15 个 Playwright 场景与 App Server / Editor 架构两份单测文件通过。覆盖动态注册、文本/语言失效、连续编辑合并、旧结果迟到、开关、模型切换、功能与编辑器释放、提供者失败隔离、文本缩短、节点复用、几何，以及原文/版本/焦点/选区不被提示修改。

最终验证：

- `check-editor-alignment.mjs --test=all` 通过：233/233 份单测文件、373/373 个 Playwright 用例，以及结构、台账、类型检查。
- Renderer 与 Stanza 生产构建通过，无新增构建警告。完整回归发现 pane fixture 缺少防抖服务；补齐后该文件 12 项测试通过，并断言真实窗格创建了行内提示功能。本次新增的装配警告已清除；既有 Canvas、marker / inline-completion fixture 服务和颜色环境提示不变。
- 最终结构审计与 `git diff --check` 通过。生产文件变为 540 个：420 个同路径、120 个 Ash 自有；common 文件集合和 80/41 声明核对计数不变。没有新增 CSS、上游品牌引用或生成文件。
- 本批开始时工作树为空；全部改动保留在工作区，未创建提交。

仍保留 Ash 的 provider 协议、全模型请求范围和 span 显示；延迟解析、按修饰键显示及文字占位排版并未在本批实现。没有新增公共声明或 CSS，不把本批记为整个上游行内提示功能完成。

## 公共语言契约收回 common（2026-09-21）

准入链：Standalone / Workbench / 扩展注册语言提供者 → `ILanguageFeaturesService` 公共 registry → contribution 请求编排 → 既有编辑器行为。检查发现公共 registry 对 12 组 contribution 类型的反向依赖；本批把 50 个已有契约收回 `common/languages.ts`，不更换提供者协议、模型、请求或 UI owner。上游证据只用于确认公共语言契约及 registry 的所属模块，本批不复制其私有实现，也不把 Ash 快照协议宣称为标准签名全量对齐。

上一批括号修复改动已暂存；本批保留索引内容，工作区迁移完整保留 `completeBracketPairs`。按用户“该抽抽、该收收、该留留”整理契约和真实调用方；只有全部声明迁出、调用方清零的 `contrib/inlineCompletions/common/inlineCompletions.ts` 退出，其余 contribution 实现文件保留。

| 准入路径（相对 editor，带 ash-ts 的为仓库相对） | 存在关系 | 本批动作 |
| --- | --- | --- |
| `README.md` | 既有 Ash 职责 / 测试 | 更新契约归属、剩余实现差异及实际验证。 |
| `api-alignment-status.md` | 既有 Ash 职责 / 测试 | 更新契约归属、剩余实现差异及实际验证。 |
| `browser/README.md` | 既有 Ash 职责 / 测试 | 更新契约归属、剩余实现差异及实际验证。 |
| `common/languages.ts` | 双方都有 | 收回 50 个已有 provider、请求及结果契约；保留现有快照与 AbortSignal 语义。 |
| `common/services/languageFeatures.ts` | 双方都有 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `common/services/languageFeaturesService.ts` | 双方都有 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `contrib/callHierarchy/browser/languageHierarchyController.ts` | 既有 Ash 职责 / 测试 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `contrib/callHierarchy/common/languageHierarchy.ts` | 既有 Ash 职责 / 测试 | 只移出公共类型，原请求调度、校验、状态及生命周期保持原处。 |
| `contrib/codeAction/browser/codeActionController.ts` | 双方都有 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `contrib/codeAction/common/languageCodeActions.ts` | 既有 Ash 职责 / 测试 | 只移出公共类型，原请求调度、校验、状态及生命周期保持原处。 |
| `contrib/codeAction/test/browser/codeAction.test.ts` | 双方都有 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `contrib/colorPicker/common/languageColors.ts` | 既有 Ash 职责 / 测试 | 只移出公共类型，原请求调度、校验、状态及生命周期保持原处。 |
| `contrib/colorPicker/test/browser/colorPickerController.test.ts` | 既有 Ash 职责 / 测试 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `contrib/colorPicker/test/common/color.test.ts` | 既有 Ash 职责 / 测试 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `contrib/documentSymbols/common/languageDocumentSymbols.ts` | 既有 Ash 职责 / 测试 | 只移出公共类型，原请求调度、校验、状态及生命周期保持原处。 |
| `contrib/folding/common/languageFoldingRanges.ts` | 既有 Ash 职责 / 测试 | 只移出公共类型，原请求调度、校验、状态及生命周期保持原处。 |
| `contrib/gotoSymbol/common/languageDocumentSymbolSearch.ts` | 既有 Ash 职责 / 测试 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `contrib/gotoSymbol/common/languageNavigation.ts` | 既有 Ash 职责 / 测试 | 只移出公共类型，原请求调度、校验、状态及生命周期保持原处。 |
| `contrib/hover/browser/hoverController.ts` | 既有 Ash 职责 / 测试 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `contrib/hover/common/hover.ts` | 既有 Ash 职责 / 测试 | 只移出公共类型，原请求调度、校验、状态及生命周期保持原处。 |
| `contrib/inlayHints/browser/inlayHintsController.ts` | 双方都有 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `contrib/inlayHints/common/languageInlayHints.ts` | 既有 Ash 职责 / 测试 | 只移出公共类型，原请求调度、校验、状态及生命周期保持原处。 |
| `contrib/inlineCompletions/browser/controller/inlineCompletionsController.ts` | 双方都有 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `contrib/inlineCompletions/browser/model/provideInlineCompletions.ts` | 双方都有 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `contrib/inlineCompletions/common/inlineCompletions.ts` | 既有 Ash 职责 / 测试 | 全部类型迁入公共 owner 后移除空载体；上一批 completeBracketPairs 契约完整保留。 |
| `contrib/inlineCompletions/test/browser/inlineCompletionsController.test.ts` | 既有 Ash 职责 / 测试 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `contrib/parameterHints/browser/parameterHintsController.ts` | 既有 Ash 职责 / 测试 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `contrib/parameterHints/common/languageParameterHints.ts` | 既有 Ash 职责 / 测试 | 只移出公共类型，原请求调度、校验、状态及生命周期保持原处。 |
| `contrib/rename/common/languageRename.ts` | 既有 Ash 职责 / 测试 | 只移出公共类型，原请求调度、校验、状态及生命周期保持原处。 |
| `contrib/rename/test/browser/renameController.test.ts` | 既有 Ash 职责 / 测试 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `contrib/smartSelect/common/selectionRanges.ts` | 既有 Ash 职责 / 测试 | 只移出公共类型，原请求调度、校验、状态及生命周期保持原处。 |
| `contrib/symbolIcons/browser/symbolIcons.ts` | 双方都有 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `editor.api.ts` | 双方都有 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `standalone/browser/standaloneLanguages.ts` | 双方都有 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `ash-ts/src/ash/workbench/api/browser/extensionHostLanguageBridge.ts` | 既有 Ash 职责 / 测试 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `ash-ts/src/ash/workbench/services/language/browser/appServerLanguageProviders.ts` | 既有 Ash 职责 / 测试 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `ash-ts/src/ash/workbench/services/language/browser/appServerSyntaxProviders.ts` | 既有 Ash 职责 / 测试 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `ash-ts/src/ash/workbench/services/language/common/jsonLanguageFeatures.ts` | 既有 Ash 职责 / 测试 | 改为直接引用 common/languages；保留实现引用及运行行为，移除重复类型入口。 |
| `ash-ts/test/architecture/editor-architecture.test.ts` | 既有 Ash 职责 / 测试 | 增加 common 不依赖 contribution 的导入边界回归。 |

独立实现与验证：从本地现有声明迁移，保持所有字段、可选性、返回类型、取消、选择顺序与状态副作用；各 contribution 的服务继续拥有请求编排，公共模块只增加契约。公共边界回归、现有 provider / 适配器单测、真实 Playwright 场景及两种生产构建用于确认迁移。

结果：`common` 对 contribution 的类型依赖已清零，12 组共 50 个契约只有一个声明 owner；逐项比对迁移前后字段和签名一致，公开入口的 214 个具名导出保持不变。原行内补全类型文件及其代码引用已退出，上一批括号修复的字段和行为保留。现有 contribution 请求 service 的进一步组织、Ash 协议与上游标准 provider 签名的差异仍在，不把契约归位算作这些实现已全部对齐。

本批验证：

- 6 份定向单测文件通过，含依赖边界、Standalone 注册、共享 registry、Workbench 安装、App Server 提供者和扩展宿主；33 个定向 Playwright 场景通过。
- `check-editor-alignment.mjs --test=all` 通过：结构、台账、类型检查、233/233 份单测文件、358/358 个 Playwright 用例。
- `build:renderer`、`build:stanza`、`git diff --check` 通过。构建无新增 warning；既有 JSDOM Canvas、旧 fixture 服务装配与颜色环境提示保持原状。
- 当前生产文件为 541 个：420 个同路径、121 个 Ash 自有；common 保持 211 个文件、46 个上游路径未引入。80/41 的声明核对计数不变，没有新增 CSS 或上游品牌引用。
- 上一批已暂存 patch 逐字节核对未变；本批结果留在工作区，未创建提交。

## 补全括号修复与异步分词试算（2026-09-21）

准入链：带 `completeBracketPairs` 的行内补全 → 控制器 / `provideInlineCompletions` → 模型分词试算 → 现有 Syntax Worker / TextMate 语法 → `fixBracketsInLine` → 既有接受与撤销命令。上一批防抖改动已由用户提交；本批继续当前工作区，不修改提交历史。

| 准入路径（相对 editor，另有标注除外） | 存在关系 | 唯一职责与本批动作 |
| --- | --- | --- |
| `common/model/bracketPairsTextModelPart/fixBrackets.ts` | 仅上游 → 双方都有 | 读取 token 类型、语言和括号配置；独立实现缺失闭括号补齐及多余闭括号移除，不复制上游 AST 遍历。 |
| `common/languages.ts`、`common/services/editorWebWorker.ts`、`common/services/semanticTokensDto.ts` | 双方都有 | 增加独立试算 lane 和可选 provider 能力；复用已选择的 tokenizer、传输和取消，不将试算冒充已提交文本。 |
| `common/tokenizationTextModelPart.ts`、`common/model/tokens/tokenizationTextModelPart.ts` | 双方都有 | 新增实际调用的异步 `tokenizeLinesAtAsync`；现有同步不可用语义保留。试算有自己的请求 lane，结果不进入模型 token store。 |
| `contrib/inlineCompletions/common/inlineCompletions.ts` | 已确认的 Ash 现有补全契约 | 添加 provider 可选修复标记，保持当前 range 与附加编辑语义。 |
| `contrib/inlineCompletions/browser/model/provideInlineCompletions.ts`、`browser/controller/inlineCompletionsController.ts`（同 contribution 下） | 双方都有 | 等待试算，检查取消和版本；控制器显式注入语言配置服务。修复后的文本仍经现有接受命令。 |
| `../workbench/services/textMate/common/textMateTokenizationService.ts`、`textMateSyntaxProvider.ts` | Ash 既有 TextMate owner | 借用当前行前的词法状态并复用 scanLine；不替换缓存版本、不发布试算 token。 |
| `test/common/model/bracketPairsTextModelPart/fixBrackets.test.ts` | 模块行为测试 | 新增括号、token 边界、嵌入语言、字符串及注释场景。 |
| `test/common/syntaxProviderWorker.test.ts`、`contrib/tokenization/test/common/tokenizationTextModelPart.test.ts`、`test/common/syntaxWire.test.ts`、`test/common/syntaxWire.delta.test.ts` | 现有测试 | 验证试算、传输、取消和真实 token 缓存隔离。 |
| `../workbench/services/textMate/test/common/textMateTokenizationService.test.ts` | 现有测试 | 验证跨行词法状态与试算前后缓存内容一致。 |
| `contrib/inlineCompletions/test/browser/inlineCompletionsController.test.ts`、`ash-ts/test/integration/browser/standalone.integration.ts`、`standalone.integration.spec.ts`（后两项为仓库相对） | 现有测试设施 | 同步装配并从真实输入、接受与撤销入口验证结果。 |
| `ash-ts/test/integration/browser/themes.integration.ts`、`themes.integration.spec.ts`（仓库相对） | 既有真实 TextMate Worker 设施 | 验证试算跨 Worker 传输、跨行字符串状态及缓存不变。 |
| `browser/README.md`、`api-alignment-status.md` | 现有文档 | 记录异步边界、生产链和实际验证。 |

实现依据：当前 TextModel 和 View 的文本、DOM、坐标及滚动职责保持唯一。语法状态归现有 Worker / TextMate 缓存，试算使用独立 lane，结果只在原请求仍有效时用于补全；没有语法或 provider 未提供试算能力时保持其原始补全文本，不猜测词法类型。同步与异步接口表达两种能力，不添加同步 tokenizer 或新的资源模型服务。

common 当前 **211 个文件：180 个同路径、31 个 Ash 自有；46 个上游路径未引入**。`fixBrackets.ts` 已接入生产链。其余路径仍为 22 个由现有 owner 承担的职责、22 个本次范围外的完整 diff / Tree-sitter 文件，以及没有实际消费者的 `editorFeatures.ts`、`services/inMemoryTextModelService.ts`；不创建空入口或第二套模型生命周期。

定向验证已通过 7 份单测文件和 9 个 Playwright 场景，覆盖括号嵌套、字符串/注释/正则、嵌入语言、UTF-16、多行补全、保留后缀、替换范围、附加编辑与一次撤销、取消及真实 TextMate Worker。Renderer 与 Stanza 生产构建通过。

本批最终验证：

- `check-editor-alignment.mjs --test=all` 通过：结构、台账、类型检查、233/233 份单测文件、358/358 个 Playwright 用例。
- 复查补齐较长括号优先匹配和无样式 token 的嵌入语言信息后，重跑受影响的 2 份单测、9 个 Playwright 场景与 Renderer / Stanza 构建，全部通过。
- `git diff --check` 通过，没有新增 CSS 或上游品牌引用。构建无新增 warning；测试保留原有 JSDOM Canvas、旧 fixture 服务装配和颜色环境提示。没有把私有实现或未运行的上游 UI 标为已对齐。

## 行内补全自动请求与公共防抖服务（2026-09-21）

准入链：输入文本 / 已注册编辑命令 → `InlineCompletionsController` → `ILanguageFeatureDebounceService` 的模型与提供者延迟记录 → 当前版本的补全请求 → 既有提示与接受命令。起始工作区干净；继续采用已确认的现有功能链范围。

| 准入路径（相对 editor，另有标注除外） | 存在关系 | 唯一职责与本批动作 |
| --- | --- | --- |
| `common/services/languageFeatureDebounce.ts` | 仅上游 → 双方都有 | 新增公共延迟查询与采样契约；按服务作用域、registry、配置、模型和当前提供者隔离，不拥有计时器或请求。 |
| `contrib/inlineCompletions/browser/controller/inlineCompletionsController.ts` | 双方都有 | 当前控制器注入延迟服务，复用 RunOnceScheduler 合并输入/命令触发；手动请求即时，组合输入暂停。语言切换取消旧任务，下一次请求读取当前模型语言；取消和释放归同一控制器。 |
| `standalone/browser/standaloneServices.ts`、`../workbench/browser/workbench.ts` | 双方都有 | 各自现有宿主容器注册服务；不增加全局 feature registry。 |
| `test/browser/testCodeEditor.ts`、`contrib/inlineCompletions/test/browser/inlineCompletionsController.test.ts` | 现有测试设施 | 同步真实容器装配，验证命令调度、必需依赖、接受与撤销。 |
| `test/common/services/languageFeatureDebounce.test.ts` | Ash 测试（所属生产模块同名） | 验证延迟上下限、独立作用域、模型与提供者变化、已释放模型。 |
| `ash-ts/test/integration/browser/standalone.integration.ts`、`standalone.integration.spec.ts`（仓库相对） | Ash 现有设施 | Playwright 从真实输入/快捷键验证请求合并、手动触发、组合输入、提供者变化、取消、过期响应和释放。 |
| `browser/README.md`、`api-alignment-status.md` | 现有文档 | 记录调度与采样的不同职责及实际验证。 |

独立实现：控制器继续持有唯一提示 DOM、选择范围与请求；位置使用现有 View 坐标。公共服务弱引用模型和提供者，避免延迟记录保留已卸载的提供者；提供者集合或语言改变后重新估计；控制器只提交成功且仍有效的请求耗时。自动等待限定在 50–500 ms，冷启动为 50 ms，后续按观测耗时平滑调整。WordHighlighter 的用户延迟配置保持原语义。没有新 DOM、CSS、快捷键、文本副本或同步 tokenizer。

实现已接通：普通输入和组合输入结束事件进入既有控制器；手动请求会撤销排队的自动任务；成功且未取消的请求才更新延迟。服务通过两个宿主的真实容器注入，没有新增对 contribution 契约的 common 反向依赖。

common 当前 **210 个文件：179 个同路径、31 个 Ash 自有；47 个上游路径未引入**。上一批的四项额外能力中，防抖服务已接通；其余三项维持以下明确边界：

| 上游额外能力 | 当前结果 |
| --- | --- |
| `editorFeatures.ts` | 未引入。现有文本高亮提供者已按语言服务引用计数共享，关闭最后一个消费者时释放，没有重复注册需要另建全局 feature 启动器解决。 |
| `services/inMemoryTextModelService.ts` | 未引入。ModelService 与 Workbench 资源引用服务继续拥有模型；当前链没有 synthetic document 消费者。 |
| `model/bracketPairsTextModelPart/fixBrackets.ts` | 未引入。需要先建立补全插入文本的词法分词能力；当前异步模型分词不能被未经词法识别的字符扫描替代。 |

其余 22 个缺失文件保留现有职责，22 个完整 diff / Tree-sitter 文件仍在本次范围外。下方批次数字与结论按时间保留。上游行为依据为工作区源码契约，没有运行 VS Code 本身的 UI 对照，不宣称全量界面或能力对齐。

本批验证：

- 两份定向单测文件、21 个 Playwright 场景通过，覆盖真实输入、组合输入、手动触发、耗时调整、语言切换、失焦、过期响应、取消和释放。
- `check-editor-alignment.mjs --test=all` 通过：结构、台账、类型检查、232/232 个单测文件和 349/349 个 Playwright 用例通过。
- `build:renderer`、`build:stanza` 和 `git diff --check` 通过；生产构建没有新增 warning。公共缓存改用弱引用后，重新运行受影响单测和两种生产构建。
- 没有改 CSS，没有新增上游品牌引用，保留既有 6 份等价样式债务。JSDOM Canvas、既有测试服务装配和 Playwright 颜色环境提示仍存在。

## common 剩余文件逐项收尾（2026-09-21）

用户要求把剩余项全部处理，沿用“现有功能链”的范围，以及按职责抽取、收回和保留的决定。起始工作区干净；重新比较得到 49 个上游缺失文件，其中 diff 15 个、Tree-sitter 7 个仍在范围外。其余 27 个按实际消费者和状态 owner 逐项核对，不以创建无调用文件或替换私有容器来消除差异。

本批准入：复制选区 → `ViewModelImpl.getRichTextToCopy` → 行 token HTML 序列化 → 剪贴板 HTML；模型仍持有文本和 token，ViewModel 选择范围并组装多行内容。

| 准入路径 | 存在关系 | 本批动作与验证 |
| --- | --- | --- |
| `common/languages/textToHtmlTokenizer.ts` | 仅上游 → 双方都有 | `tokenizeLineToHTML` 接收现有行 token，负责范围裁剪、HTML 转义及 token 样式；Ash 的原始 tab 与 span 片段输出保持不变，不创建分词状态。 |
| `common/viewModel/viewModelImpl.ts` | 双方都有 | 移出逐 token HTML 循环和转义函数，继续持有多选区、行范围、EOL 与外层复制容器。 |
| `common/encodedTokenAttributes.ts` | 双方都有 | 缺少颜色时仍生成字体样式，避免合法的字体 metadata 被丢弃。 |
| `test/common/modes/textToHtmlTokenizer.test.ts` | 对应上游测试路径，新建 Ash 测试 | 独立验证跨 token 裁剪、UTF-16、HTML 转义、tab、空范围和缺色字体。 |
| `ash-ts/test/integration/browser/standalone.integration.ts`、`standalone.integration.spec.ts`（仓库相对路径） | Ash 现有设施 | 经过真实 copy 事件验证两种输入方式的选区文本、HTML 和缺色字体；复用既有复制、剪切、粘贴和撤销场景。 |
| `api-alignment-status.md`、`browser/README.md` | 现有文档 | 记录 27 项的实际归属、范围差异和验证。 |

独立实现：将 Ash 现有无 DOM 的序列化逻辑收回到对应 common 文件，读取现有 `IViewLineTokens`，不引入上游整文同步 tokenizer 或另一份 token store。文本内容和剪贴板的多行结构保持原行为；缺色时只省略 color 声明，字体语义仍由 token metadata 提供。本批不改变编辑器 DOM、CSS、焦点或输入 owner。

### 剩余 27 项的最终归属核对

以下路径相对 `common/`。每个缺失文件均有去向；“保留”表示已有功能继续由当前 owner 实现，不表示拥有该上游文件的全部 API。旧批次的“仍缺 49”等统计是历史记录。

| 上游文件 | 本次结论 | 当前生产 owner 与依据 |
| --- | --- | --- |
| `languages/textToHtmlTokenizer.ts` | 已补齐当前消费端口 | `ViewModelImpl.getRichTextToCopy` 调用 `tokenizeLineToHTML`，原逐 token 实现退出；复制文本、字体与转义经过真实浏览器验证。 |
| `languages/modesRegistry.ts`、`services/languagesAssociations.ts` | 保留宿主级语言注册 | `services/languagesRegistry.ts` 的 `registerMany/resolveLanguageId` 与 `LanguageService` 持有注册优先级、文件匹配和释放；Standalone / 扩展宿主使用同一套实例归属，不增加全局注册源。 |
| `languages/nullTokenize.ts` | 保留现有无提供者语义 | `model/tokens/tokenizationTextModelPart.ts` 用当前模型语言生成默认行 metadata，Worker 无提供者时没有语法结果；不存在编码 tokenizer 的状态切换需求。 |
| `model/fixedArray.ts` | 保留私有容器 | `TokenizationStateStore` 的 Map 只存逐行结束状态；换容器没有新增语义或当前性能证据。 |
| `model/intervalTree.ts` | 保留跟踪范围实现 | `TrackedRangeCollection` 和 TextModel 统一映射编辑、装饰及 stickiness；不并行引入第二个装饰索引。 |
| `model/textModelStringEdit.ts` | 保留稳定行身份转换 | `lineDocumentProjection.ts` 与模型事务持有 LineId 编辑映射；上游整行替换转换不能替代“保留编辑起始行身份”的约定，其余 StringEdit 端口没有生产调用方。 |
| `model/tokens/abstractSyntaxTokenBackend.ts`、`model/tokens/tokenizerSyntaxTokenBackend.ts` | 保留异步分词 owner | `TokenizationTextModelPart` → `LanguageRequestCoordinator` → `SyntaxProviderWorker` 使用版本绑定请求、状态缓存和取消；不再创建同步编码分词后端。 |
| `model/tokens/tokenizationFontDecorationsProvider.ts` | 保留 token 字体展示 | `languageTokenLineIndex.ts` 的 `StyledTokenSource` 与行渲染器消费 provider 字体信息；语义字体来自 token metadata，不另建字体装饰状态。 |
| `tokens/contiguousMultilineTokens.ts`、`tokens/contiguousMultilineTokensBuilder.ts`、`tokens/contiguousTokensEditing.ts`、`tokens/contiguousTokensStore.ts`、`tokens/tokenWithTextArray.ts` | 保留单一 token 存储 | `languageTokens.ts`、`LanguageTokenLineIndex` 和 `LineTokens` 承担结果保存、编辑失效与可见行读取；上游连续编码数组不是当前持久状态格式。 |
| `services/editorWorkerHost.ts` | 保留唯一 Worker 通道 | `services/textModelSync.ts` 与 `base/common/worker/webWorker.ts` 持有同步、版本校验、传输和释放；没有独立 Editor host 回调通道。 |
| `services/getIconClasses.ts` | 保留 Platform 图标绘制 | `platform/theme/browser/fileIconThemeService.ts` → Workbench 资源标签，按资源解析并渲染图标；没有 Editor 图标 CSS 类生成器消费者。 |
| `services/modelUndoRedoParticipant.ts` | 保留模型历史 owner | `ModelService` 的关闭模型历史预算与重开恢复、`TextModel` 历史持有现有撤销行为；没有跨资源 edit-stack 重开参与者。 |
| `services/semanticTokensStyling.ts`、`services/semanticTokensStylingService.ts` | 按既有决定不恢复包装 | `semanticTokensProviderStyling.ts` 转换 provider 结果；主题和具名 token 的 owner 保持唯一。 |
| `services/textResourceConfigurationService.ts` | 保留资源配置查询 | `ModelService` 经 `IConfigurationService` 查询资源/语言覆盖并监听更新；EOL 经 `ITextResourcePropertiesService` 解析。未出现需要独立资源配置 facade 的生产消费者。 |
| `multiDiffEditor.ts` | 保留 Ash 定位契约 | `MultiDiffEditorWidget` 使用 item ID、行位置和 DiffModel；上游 cards 变体与 original/modified URI viewState 并非当前布局/定位格式。后端 diff 范围不变。 |
| `standaloneStrings.ts` | 文案留在实际界面 owner | 文案由现有命令与组件消费；没有需要共享上游字符串集合的调用链。 |
| `editorFeatures.ts` | 未引入额外能力 | 当前采用宿主服务和逐编辑器 contribution；没有进程级 EditorFeature 创建需求，不增加空 registry。 |
| `model/bracketPairsTextModelPart/fixBrackets.ts` | 已补齐当前消费端口 | 后续批次已接通 `completeBracketPairs`、异步词法试算和 `fixBracketsInLine`；保持字符串、注释与原有插入事务语义。 |
| `services/inMemoryTextModelService.ts` | 未引入额外能力 | 当前独立模型由 ModelService 注册；没有 synthetic document 或 `registerModelAndPositionCommand` 的生产调用。仅存在服务接口不能证明需要另一套引用 owner。 |
| `services/languageFeatureDebounce.ts` | 已补齐当前消费端口 | 后续批次已接通共享延迟采样，Inline Completions / Inlay Hints 的控制器持有各自计时器与请求；WordHighlighter 用户延迟保持原含义。 |

更新后的归属结论：**3 个补入并接通、22 个保留现有职责、2 个没有当前消费者的额外能力**；另有 **22 个 diff / Tree-sitter 文件明确排除**。common 现有 **211 个文件：180 个同路径、31 个 Ash 自有；46 个上游路径未引入**。此前 209/48 的数字只对应本批最初结果。文件归属核对不代表整个 VS Code Editor 的功能与 API 全量完成。

本批验证：

- 三份定向单测文件通过；12 个 Chromium 复制场景通过，覆盖两种输入方式、完整/部分/多选区、整行复制、关闭语法 HTML、颜色表缺项及字体保留。
- `check-editor-alignment.mjs --test=all` 通过：结构、台账、类型检查、231/231 个单测文件与 329/329 个 Playwright 用例通过。
- `build:renderer`、`build:stanza`、`git diff --check` 通过；没有新增生产构建 warning 或未跟踪 JavaScript 产物。未修改 CSS，既有 6 份等价样式债务保持原状态。
- 文件集合复核确认 48 个缺失路径全部落入上表 26 项或范围外的 22 项，没有遗漏；既有 JSDOM Canvas、测试服务装配与 Playwright 颜色环境提示保留。

## 缩进与括号辅助线的模型查询和显示（2026-09-21）

准入链：模型缩进规则 / 括号树 → ViewModel 可见行查询 / 既有括号适配 → `IndentGuidesOverlay` → 主题辅助线。起始工作区干净。用户已授权继续补齐现有功能；本批不增加括号索引、前端 diff 或 Tree-sitter。

| 准入路径 | 存在关系 | 唯一职责与处理 |
| --- | --- | --- |
| `browser/viewParts/indentGuides/indentGuides.ts`、`indentGuides.css` | 双方都有 | 使用已有 common 缩进层级和活动范围查询；ViewPart 只持有可见行 DOM 和像素几何，修正首尾高度并消费主题颜色。 |
| `common/core/editorColorRegistry.ts` | 双方都有 | 注册实际被绘制使用的缩进、活动缩进和六级括号辅助线颜色；四种主题与用户覆盖共用现有目录。 |
| `contrib/bracketMatching/browser/bracketColorizationPresentation.ts` | Ash 自有，既有适配职责保留 | 从同一模型颜色池策略确定辅助线层级；不缓存或计算第二份括号树。 |
| `test/browser/widget/codeEditorWidget.test.ts`、`contrib/bracketMatching/test/browser/bracketColorizationPresentation.test.ts` | 现有测试设施 | 验证空白行、缩进单位与 tab 不同、活动位置、选项更新和颜色池。 |
| `contrib/indentation/test/browser/indentationGuides.test.ts` | 既有辅助线测试 | 随浏览器重复 helper 退出，改从真实模型公共入口验证混合空白和语言 off-side 规则。 |
| `ash-ts/test/integration/browser/standalone.integration.ts`、`standalone.integration.spec.ts`（仓库相对路径） | Ash 现有浏览器测试设施 | Playwright 验证实际颜色、笔画、首尾几何、换行、主题切换、开关及鼠标输入。 |
| `common/core/README.md`、`browser/README.md`、`api-alignment-status.md` | 现有文档 | 同步职责、验证和保留差异。 |

独立实现：查询复用 Ash 已有 ViewModel 与模型 guide part；移除 ViewPart 的缩进扫描，不复制上游算法。CSS 围绕既有 Ash 辅助线节点独立编写，使用公共颜色 token 和现有笔画尺寸 token；节点不参与焦点、鼠标命中或辅助阅读。软换行只在为缩进保留的空间内延续辅助线。括号源和文本测量继续保留现有 Ash 几何职责，上游运行时界面尚未验证。

几何补充准入：启用实际笔画后，原先沿开括号列绘制会穿过函数体文字。既有 `BracketGuide` 增加模型可见列，由同一括号树的最小缩进查询提供；ViewPart 只转换为像素，并在必要时连接开闭括号，避免浏览器重新扫描文本块。该变更仍限于上表括号源、ViewPart 和现有测试，不增加服务或存储。

实现结果：浏览器的缩进扫描、活动块扫描和 tabSize 副本已退出，空白行与 off-side 规则由 common 查询统一处理；软换行、折叠、模型选项和光标变化进入原有视图事件链。14 个实际使用的辅助线颜色进入编辑器颜色目录，支持四种主题与用户覆盖，活动线同时通过粗细区分。同列括号线优先显示，单行括号不会抢走所在多行块的活动状态，连接线限制在本行内。

保留差异：Ash 继续使用既有六级颜色池和括号几何适配；没有引入上游的 30 级样式池或全套辅助线布局算法。common 文件数仍为 **208：177 个同路径、31 个 Ash 自有，49 个上游文件未引入**。本批补齐生产消费和绘制，不以新增文件数作为完成标准。

本批验证结果：

- 三份定向单测文件通过，覆盖混合空白、off-side 规则、空白行活动范围、模型选项更新、括号最小缩进及独立颜色池。
- `check-editor-alignment.mjs --test=all` 通过：结构、台账、类型检查、230/230 个单测文件和 327/327 个 Playwright 用例通过。
- 完整回归后，同列去重进一步改为直接比较模型可见列，避免 CSS 小数像素序列化影响；最终源码再通过六个相关 Playwright 场景及 `build:renderer`、`build:stanza`。浏览器验证四种主题、用户覆盖、活动笔画、端点几何、软换行、折叠、滚动和鼠标输入，不使用截图作为判定。
- `git diff --check` 通过；生产构建没有新增 warning。JSDOM Canvas、测试服务装配和 Playwright 颜色环境提示仍是既有输出。
- CSS 审计的既有等价复制债务由 7 份降为 6 份；本批等价复制和新增上游品牌引用均为 0，没有未跟踪 JavaScript 产物。

## 括号装饰的主题着色（2026-09-21）

准入链：模型括号树 → 六级 inline decoration → 行渲染 / 辅助技术文本 / GPU 字形 → 编辑器主题颜色。起始工作区干净；现有装饰已有 class，但尚无颜色规则，直接写入的 token 前景色也会压过装饰。用户已授权继续补齐现有链路，本批不引入新的括号索引或引擎。

| 准入路径 | 存在关系 | 唯一职责与处理 |
| --- | --- | --- |
| `common/core/editorColorRegistry.ts` | 双方都有 | 注册六级括号颜色，提供四种主题默认值与用户覆盖入口。 |
| `browser/widget/codeEditor/editor.css`、`browser/viewParts/viewLines/viewLine.ts` | 双方都有 | 由现有编辑器样式消费六级装饰；语法前景色通过行内组件变量传递，装饰可覆盖颜色，不增加文本节点层级。 |
| `browser/gpu/viewGpuContext.ts` | 双方都有 | 主题事件使装饰颜色与字形缓存失效，覆盖只改括号颜色的主题切换。 |
| `browser/gpu/renderStrategy/viewportRenderStrategy.ts`、`fullFileRenderStrategy.ts` | 双方都有 | 装饰前景色与已有删除线颜色共用 CSS 变量解析，两个绘制策略都消费实际主题值。 |
| `standalone/browser/standaloneCodeEditor.ts` | 双方都有 | 宿主先绑定主题根，再创建视图，保证同步绘制前 CSS 变量已更新；构造失败和正常关闭均释放绑定。 |
| `test/browser/semanticTokenPresentation.test.ts`、`editorSemanticTokenViewport.test.ts`、`namedEditorThemeService.test.ts`、`../platform/theme/test/common/design-tokens.test.ts` | 现有测试设施 | 验证 token 展示数据、换行后的片段与文本合成、四种主题的颜色对比度，声明实际由行渲染器写入的组件变量。 |
| `test/integration/browser/standalone.integration.ts`、`standalone.integration.spec.ts`、`gpuText.integration.ts`、`gpuText.integration.spec.ts` | Ash 现有浏览器测试设施 | Playwright 验证实际计算颜色、语法色优先级、开关与颜色池、主题切换及 GPU 字形颜色。 |
| `test/integration/browser/textModel.integration.spec.ts` | Ash 现有浏览器测试 | 在已有屏幕阅读器宿主场景中验证富文本括号颜色与可见行一致。 |
| `common/core/README.md`、`browser/README.md`、`api-alignment-status.md` | 现有文档 | 同步颜色、样式和缓存职责，记录准入、验证及保留差异。 |

独立实现：沿 Ash 已有六级 class 与配色目录编写规则，不复制上游颜色或 CSS。DOM、文本、焦点、滚动及模型装饰生命周期仍由原 owner 持有；组件变量只传递单个 token 的可选前景色，字体与背景保持原行为。GPU 继续使用既有 CSS 规则提取器和字形图集，主题变化从既有事件入口清理缓存。括号辅助线的几何与显示是另一条链，本批不增加其样式或算法。

实现结果：六个标准颜色标识已进入共享主题目录，现有 Workbench schema 与 Standalone 用户主题可以覆盖它们；可见行、辅助阅读文本和 GPU 均实际消费。装饰颜色优先于 token 前景色，关闭颜色后恢复语法色。GPU 的两种绘制策略解析 CSS 变量，并在颜色变化时重建字形；主题根绑定早于视图创建，避免同步绘制读到上一次主题的变量。

common 仍为 **208 个 TypeScript 文件：177 个同路径、31 个 Ash 自有；49 个上游文件尚未引入**。本批补齐已有模块的生产行为，没有增加空文件。保留 Ash 的六级循环配色、独立颜色池及无效括号不着色规则，未引入上游跳过透明色的调色板算法。上游核对以当前工作区源码契约为准；其浏览器构建未就绪，本次没有运行上游 UI，也不把本批记为整个编辑器界面已完全对齐。

本批验证结果：

- 定向单测通过，覆盖 token 前景色、软换行片段、主题与独立编辑器生命周期、颜色变量审计；默认六色在四种主题背景上的对比度均不低于 4.5:1。
- 六个定向 Playwright 场景通过，覆盖两种输入方式的文本和焦点、四种主题、用户覆盖、颜色开关与独立颜色池、辅助阅读文本，以及短行和长行对应的两种 GPU 绘制策略。GPU 检查实际图集像素，确认新颜色出现、旧颜色清除，绘制仍由 GPU 完成。
- `check-editor-alignment.mjs --test=all` 通过：结构、台账、类型检查、230/230 个单测文件及 322/322 个 Playwright 用例通过。
- `build:renderer`、`build:stanza` 和 `git diff --check` 通过；没有新增构建 warning 或未跟踪 JavaScript 产物。
- CSS 审计确认本批等价复制和新增上游品牌引用均为 0；保留 7 份既有 CSS 债务。JSDOM Canvas、测试服务装配和 Playwright 颜色环境提示仍是既有输出。

## common 编辑器颜色归属与主题加载（2026-09-21）

准入链：编辑器装配/切换主题 → 编辑器颜色注册 → Platform 解析当前颜色目录 → 宿主主题事件 → CSS 变量、标尺与概览尺绘制。起始工作区干净。用户已授权按职责迁移；本批先验证主题加载，再迁移现有颜色消费者。

| 准入路径 | 存在关系 | 唯一职责与处理 |
| --- | --- | --- |
| `common/core/editorColorRegistry.ts` | 仅 VS Code → 双方都有 | 接回现有光标、当前行、标尺和概览尺的颜色定义及公开名称，保留 Ash 配色值。 |
| `../platform/theme/common/colorRegistry.ts`、`../platform/theme/common/colors/editorColors.ts` | 双方都有 | 注册目录允许功能模块加载时增加颜色；移出上述定义，保留语法 token、组件与 diff 配色。 |
| `../platform/theme/common/colorTheme.ts` | Ash 现有主题 owner | 主题选择与覆盖值固定，解析结果随注册目录失效；移除启动时封闭颜色目录、静态标识快照与迁出颜色的聚合别名。 |
| `../platform/theme/browser/themeStyles.ts` | Ash 现有 DOM 主题绑定 | 首次写入每个变量前记录原值，释放时也恢复后加载颜色。 |
| `standalone/browser/namedEditorThemeService.ts`、`../workbench/services/themes/browser/workbenchThemeService.ts` | Ash 现有宿主 / 双方都有 | 注册目录变化通过现有主题事件通知当前消费者；监听随宿主释放。 |
| `../workbench/services/themes/common/colorThemeData.ts`、`colorThemeSchema.ts` | 双方都有 | 查询当前颜色目录，保留用户覆盖与 token 规则；主题对象不再通过展开变为陈旧快照。 |
| `browser/viewParts/overviewRuler/decorationsOverviewRuler.ts`、`browser/viewParts/rulersGpu/rulersGpu.ts` | 双方都有 | 现有直接消费者改用编辑器颜色 owner，渲染算法不变。它们已位于 View 的静态装配链，无需新增入口。 |
| `../platform/theme/test/common/colorRegistry.test.ts`、`themeService.test.ts`、`testThemeService.ts`、`design-tokens.test.ts`、`../platform/theme/test/browser/themeStyles.test.ts` | 现有测试设施 | 覆盖目录增加、主题解析失效、变量恢复；编辑器专属断言迁回编辑器测试。 |
| `test/browser/namedEditorThemeService.test.ts`、`editorDecorationViewport.test.ts`、`../workbench/services/themes/test/browser/workbenchThemeService.test.ts` | 现有测试设施 | 验证宿主事件、现有配色、覆盖值、释放与概览尺绘制。 |
| `test/integration/browser/themes.integration.ts`、`themes.integration.spec.ts`、`textModel.integration.ts`、`textModel.integration.spec.ts` | Ash 现有浏览器测试设施 | Playwright 验证后加载颜色、主题切换、焦点及高对比度的实际样式。 |
| `common/core/README.md`、`api-alignment-status.md` | 现有文档 | 同步职责、验证及剩余差异。 |

独立实现：注册表继续持有唯一颜色定义，保留不可变目录供主题判断缓存是否过期；主题不持有监听，宿主负责通知与释放。View 与各 ViewPart 继续拥有原 DOM、焦点、滚动和布局；本批不修改 CSS。颜色消费仍经 `--ash-*` 和现有绘制入口。用户主题覆盖值与 token 规则保持只读，颜色目录增加不能覆盖用户选择。

实现结果：12 个颜色定义从 Platform 迁至编辑器，旧注册与 `ColorId` 聚合别名退出；`colorIdentifiers` 静态快照由调用方直接查询当前目录取代。Workbench 主题 schema 显式加载编辑器颜色，并随当前目录提供属性。注册表通知由已有宿主主题事件传递，DOM 绑定记录后加载变量的原值，关闭时恢复；没有新增第二份颜色定义或主题服务。

common 当前 **208 个 TypeScript 文件：177 个同路径、31 个 Ash 自有；仍缺 49 个上游文件**。本批补的是现有颜色消费链，未提前注册尚无消费者的上游颜色。下方其他批次中的文件数和阻塞结论保留为历史记录。

本批验证结果：

- 主题定向单测覆盖实际模块后加载、缓存失效、用户覆盖、TextMate 规则、schema 属性、导出及 DOM 变量恢复。颜色审计补齐滚动条已有的组件尺寸变量声明；尺寸实际由 `scrollableElement.ts` 写入，不属于主题 token。
- `check-editor-alignment.mjs --test=all` 通过：结构、台账、类型检查、230/230 个单测文件和 318/318 个 Playwright 用例通过。
- 新增 Playwright 场景验证工作台后加载颜色及释放，四种主题下光标、当前行边框与标尺的计算样式，以及切换时焦点保持。
- `build:renderer`、`build:stanza` 和 `git diff --check` 通过；没有新增构建 warning 或未跟踪 JavaScript 产物。
- 保留既有 JSDOM Canvas、测试服务装配输出及 Playwright 颜色环境提示；未改 CSS，结构检查仍记录 7 份既有 CSS 债务。

## common 动作执行与编辑器上下文（2026-09-21）

准入链：注释、多光标、格式化快捷键 → `CodeEditorWidget.getAction` → `common/editorAction.ts` → 当前编辑器上下文检查 → 已注册 action 修改当前模型/选区 → Widget 与 Playwright 行为验证。起始工作区干净。用户已授权迁移和保留职责差异；本批不改 DOM 层级、布局、主题或快捷键定义。

| 准入路径 | 存在关系 | 唯一职责与局部动作 |
| --- | --- | --- |
| `common/editorAction.ts` | 仅 VS Code → 双方都有 | `InternalEditorAction` 读取启用条件并执行绑定的动作；没有注册表或模型副本。 |
| `browser/editorBrowser.ts`、`browser/widget/codeEditor/codeEditorWidget.ts` | 双方都有 | 补 `getAction`，从已有注册表按需绑定；上下文作用域归稳定编辑器实例，模型服务作用域保留。 |
| `standalone/browser/standaloneCodeEditor.ts`、`browser/widget/codeEditor/embeddedCodeEditorWidget.ts` | 双方都有 | 两个实际子类显式注入并传递必需上下文服务。 |
| `contrib/comment/browser/comment.ts`、`contrib/multicursor/browser/multicursor.ts`、`contrib/format/browser/formatActions.ts` | 双方都有 | 快捷键通过编辑器绑定的 action 检查启用条件、执行并处理异常；退出直接执行 action 的路径。 |
| `contrib/linesOperations/browser/linesOperations.ts` | 双方都有 | 写操作补齐 writable 条件，查询可用性与实际编辑限制一致；不修改编辑算法。注释动作同样补齐声明。 |
| `test/browser/testCodeEditor.ts`、`test/browser/widget/codeEditorWidget.test.ts` | 双方都有 | 真实容器注册必需上下文服务，验证动作、条件变化、跨编辑器隔离和模型切换。 |
| `../workbench/contrib/codeEditor/test/browser/codeEditorPane.test.ts` | Ash 测试设施 | Pane 的真实装配 fixture 同步注册必需上下文服务，不修改生产 Pane。 |
| `test/integration/browser/standalone.integration.ts`、`standalone.integration.spec.ts`、`textModel.integration.ts` | Ash 测试设施 | 从编辑器入口执行动作，验证实际键盘效果和编辑器隔离；文本模型宿主同步注册必需上下文服务。 |
| `browser/README.md`、`api-alignment-status.md` | 现有文档 | 同步动作与上下文的职责、验证及剩余差异。 |

HTML 复制保留源码 tab 的现有契约；模型配置继续由 ModelService 和配置服务持有。本批不为这些差异新增不兼容的同名接口。

实现保留已有动作注册表，`getAction` 按需构造绑定，不建立第二份注册表或动作缓存。上下文服务变为 Widget 的显式构造依赖，Standalone、Embedded 和测试装配同步迁移；编辑器级子作用域保留稳定 context，模型级子作用域继续管理 Worker 等服务。模型分离时清空对应 context 值，关闭后查询根作用域不会留下该编辑器的条件。

common 当前 **207 个 TypeScript 文件：176 个同路径、31 个 Ash 自有；仍缺 50 个上游文件**。本批只接入有生产调用的 `getAction`，没有为减少成员差异提前补 `getActions`、`getSupportedActions` 或未接入的全局 feature 注册器。

本批验证结果：

- 最小切片：Widget 61 项测试、两种输入模式的 Playwright 动作隔离场景通过，随后迁移三个快捷键入口。
- `check-editor-alignment.mjs --test=all` 通过：结构、台账、类型检查、230/230 个单测文件及 316/316 个 Playwright 用例通过。
- 覆盖只读开关、不同焦点编辑器的动作隔离、动作句柄跨模型切换、分离与关闭、格式化提供者注册/语言切换/释放，以及注释、多光标、格式化和撤销的现有键盘行为。
- `build:renderer`、`build:stanza` 和 `git diff --check` 通过；没有新增构建 warning 或未跟踪 JavaScript 产物。
- 保留既有 JSDOM Canvas、测试服务装配输出及 Playwright 颜色环境提示。未改 CSS，结构检查仍记录 7 份既有 CSS 债务。

## common 职责迁移：文本操作与括号装饰（2026-09-21）

用户授权“职责差异该抽抽，该收收，该留留”。本批开始工作区干净；沿两条现有生产链迁移职责，没有加入前端 diff 或 Tree-sitter。common 当前 **206 个 TypeScript 文件：175 个同路径、31 个 Ash 自有；仍缺 51 个上游文件**。下方旧批次统计保留为历史，不表示所有 VS Code 能力已经实现。

准入与实现结果：

| 用户行为与生产链 | 本批文件及存在关系 | 唯一职责与处理 |
| --- | --- | --- |
| 合并行 → `JoinLinesAction` → `TextEdit.apply` → 模型文本 | `common/model/textModelText.ts`、`common/core/text/getPositionOffsetTransformerFromTextModel.ts`，仅 VS Code → 双方都有 | 文本和 UTF-16 坐标直接由 TextModel 提供；适配器不保存文本副本，也不缓存过期坐标。`AbstractText` 的转换接口允许模型坐标实现。 |
| 删行 → `DeleteLinesAction` → `TextEdit.mapRange` → 光标与撤销 | `contrib/linesOperations/browser/linesOperations.ts`，双方都有 | 移除私有 offset edit 结构、编辑应用、偏移映射和全串坐标扫描；复用 common 编辑与坐标能力。CRLF、多光标顺序及 UTF-16 行为保留。 |
| 括号树 → 模型装饰查询 → ViewModel → 文本行/辅助技术文本 | `common/model/decorationProvider.ts`、`common/model/bracketPairsTextModelPart/colorizedBracketPairsDecorationProvider.ts`，仅 VS Code → 双方都有；`textModel.ts`，双方都有 | TextModel 持有并释放提供者。按需计算 inline decorations，处理颜色池、选项及括号变化；没有第二份括号索引。只补当前使用的范围查询契约，未宣称全部上游成员完成。 |
| 括号辅助线 → `LanguageBracketGuideSource` → `IndentGuidesOverlay` | `contrib/bracketMatching/browser/bracketColorizationPresentation.ts`，Ash 自有；`browser/viewParts/indentGuides/indentGuides.ts`，双方都有 | 保留 Ash 辅助线几何适配，移除该文件中的颜色计算。源契约归实际布局消费者，名称改为 `BracketGuideSource`。 |
| 编辑器装配 → View/输入/行渲染 | `browser/editorExtensions.ts`、`browser/widget/codeEditor/codeEditorWidget.ts`、`browser/view.ts`、`browser/view/viewController.ts`、`browser/viewParts/viewLines/{viewLine,viewLines}.ts`、`browser/controller/editContext/editContext.ts`、`browser/controller/editContext/native/{nativeEditContext,screenReaderSupport,screenReaderContentRich}.ts`，双方都有 | 清除旧 `BracketColorizationSource`、`BracketColorizationSpan`、`getLineBrackets` 与重复裁剪路径；输入链不再接收颜色源。DOM、焦点、文本测量和滚动 owner 保持原职责。 |
| 每编辑器颜色开关 → 装饰可见性 | `common/viewModel/viewModelDecorations.ts`，双方都有 | 过滤当前编辑器关闭的括号装饰；配置改变使查询缓存失效。监听和缓存清理进入 Disposable 生命周期，移除绕过父类释放的旧 dispose 实现。 |

保留的差异：稳定 LineId 编辑规则、版本绑定 Worker 快照、具名 token store、宿主级语言注册与后端 diff 仍各有实际职责。括号提供者保留 Ash 的六级 class 和无效括号不着色行为，本批没有引入上游主题注册器、颜色样式或错误括号装饰。

配套验证涵盖 common 模型文本、行命令、括号模型查询、ViewModel 失效、装饰与语义 token 合成、Widget 释放，以及 Playwright 中的颜色开关、颜色池、多光标编辑和撤销。原括号匹配测试改为断言该控制器拥有的 matching decorations；ViewModel 测试分别计入行重映射与括号树重建的失效事件。

GPU 回归原先用隐藏的 DOM 行测量宽度；这些行在 GPU 渲染时允许不保留文本。测试现在通过已有连字选项切到实际 DOM 渲染后比较宽度，再切回 GPU，保留初始状态、删除/撤销、行布局和绘制顺序断言；没有为测试改变 GPU 生产渲染行为。

本批验证结果：

- `check-editor-alignment.mjs --test=all` 通过：结构、台账、类型检查、230/230 个单测文件及 314/314 个 Playwright 用例通过，包含 Chromium 和 Chrome GPU。
- `build:renderer`、`build:stanza` 通过；`git diff --check` 通过，没有新增未跟踪的 JavaScript 产物。
- 定向浏览器验证覆盖颜色开关、独立颜色池、创建后启用辅助线、CRLF/Unicode 多光标合并与删行、撤销，以及辅助技术文本和 DOM 选区。
- 保留既有 JSDOM Canvas、测试服务装配输出及 Playwright 颜色环境提示；未改 CSS，结构检查仍记录 7 份既有 CSS 债务。

## common 缺失文件续批：链接与 token 分类（2026-09-21）

按“先补现有功能链需要的 common 文件”继续核对全部缺口。本批增加两个有生产调用的模块；没有恢复空服务或加入未被产品使用的上游引擎。当前 common 有 **202 个 TypeScript 文件：171 个同路径、31 个 Ash 自有；仍缺 55 个上游文件**。文件数量不表示 API 或功能完全对齐，下方旧批次数字保留为历史。

| 新增路径 | 生产调用与行为 |
| --- | --- |
| `common/languages/linkComputer.ts` | `LinksController → LinkService → computeLinks`，识别 HTTP(S)/file 链接，处理 UTF-16 范围、尾部标点和括号。提供者覆盖重叠检测结果，过期或取消请求不提交结果；打开目标仍交给宿主。只实现当前使用的 `computeLinks` 契约。 |
| `common/languages/supports/tokenization.ts` | `TokenizationTextModelPart → toStandardTokenType`，按完整 scope 单词识别 comment/string/regex/regexp，支持带点 scope，避免把 commentary 等误判。未引入上游编码 tokenizer 后端。 |

链接公共类型统一由 `common/languages.ts` 持有，服务、贡献、独立编辑器公开入口和 Workbench 提供者均已迁移。

### 其余 55 个文件的处理结论

15 个 `common/diff/**` 文件和 7 个 Tree-sitter 文件属于本批明确排除的完整引擎。其余 33 个文件逐项核对如下；“保留现有实现”只表示当前链路已有职责归属，不表示实现了该文件的全部 VS Code API。

| 缺失文件（相对 common） | 当前职责与处理结论 |
| --- | --- |
| `core/editorColorRegistry.ts` | 保留 Platform 的 `colors/editorColors.ts` 注册链。迁移仍未完成：主题在模块初始化时生成并封闭注册表，需先调整主题生命周期；直接迁移会重复注册或引入反向依赖。 |
| `core/text/getPositionOffsetTransformerFromTextModel.ts`、`model/textModelText.ts` | Worker 与异步语言请求使用版本绑定的字符串快照；没有需要活模型文本适配器的生产消费者。 |
| `editorAction.ts`、`editorFeatures.ts` | 命令由 `browser/editorExtensions.ts`、贡献与服务装配持有。上游内部 action 包装与进程级 feature 注册尚未接入。 |
| `languages/modesRegistry.ts`、`services/languagesAssociations.ts` | 当前 `LanguagesRegistry` 按宿主和注册所有者管理匹配、优先级及释放；保留此唯一注册源。 |
| `languages/nullTokenize.ts` | 当前模型以空 token store 和默认行 metadata 处理无提供者情况；上游 tokenizer 接口未接入。 |
| `languages/textToHtmlTokenizer.ts` | 富文本复制由 `ViewModelImpl.getRichTextToCopy` 持有，保留源码 tab 与文本内容。上游 HTML tokenizer 的 tab 展开行为未引入。 |
| `model/bracketPairsTextModelPart/colorizedBracketPairsDecorationProvider.ts` | 括号树拥有结构，`bracketColorizationPresentation.ts` 向渲染器提供颜色与辅助线；尚未迁移到上游模型装饰提供者接口。 |
| `model/bracketPairsTextModelPart/fixBrackets.ts` | 补全结果的括号修复能力未接入；已有输入配对使用当前括号树及语言配置。 |
| `model/decorationProvider.ts`、`model/intervalTree.ts` | 当前 TextModel 与 `TrackedRangeCollection` 持有装饰、跟踪范围和编辑映射；上游装饰接口与区间树算法未引入。 |
| `model/fixedArray.ts` | `TokenizationStateStore` 使用 Map；不为替换私有容器单独增加文件。 |
| `model/textModelStringEdit.ts` | 当前稳定 LineId 变换保留编辑起始行身份；上游整行替换转换不满足该契约，无其他当前消费者。 |
| `model/tokens/abstractSyntaxTokenBackend.ts`、`model/tokens/tokenizerSyntaxTokenBackend.ts` | 现有模型通过版本绑定语言请求、具名 token store 和行索引管理分词；上游同步编码 token 后端未接入。 |
| `model/tokens/tokenizationFontDecorationsProvider.ts` | 当前字体样式随语法/语义 token 展示信息传递；独立 token 字体装饰提供者未接入。 |
| `multiDiffEditor.ts` | 当前多文件 diff 使用 `MultiDiffEditorItem` 与 item/row 定位；上游布局变体和资源 viewState 契约未接入。 |
| `services/editorWorkerHost.ts` | Worker 通道由 `base/common/worker/webWorker.ts` 和 `services/textModelSync.ts` 持有，保留单一传输链。 |
| `services/getIconClasses.ts` | 文件图标由 Platform 的 `fileIconThemeService.ts` 渲染；没有使用上游图标 CSS 类生成器的调用方。 |
| `services/inMemoryTextModelService.ts` | 独立编辑器由 ModelService 持有模型，Workbench 由资源模型服务持有引用；上游 synthetic document 服务未接入。 |
| `services/languageFeatureDebounce.ts` | 当前高亮贡献拥有定时调度；基于提供者延迟的自适应 debounce 服务未接入。 |
| `services/modelUndoRedoParticipant.ts` | 当前模型历史与 Workbench 关闭文档历史持有撤销状态；上游跨模型 edit-stack 重开参与者未接入。 |
| `services/semanticTokensStyling.ts`、`services/semanticTokensStylingService.ts` | 按下方既有决定不恢复：当前具名 token 由 `semanticTokensProviderStyling.ts` 转换，服务包装没有独立职责。 |
| `services/textResourceConfigurationService.ts` | ModelService 直接读取资源/语言配置，资源换行符由现有 properties 服务提供；上游完整资源配置服务未接入。 |
| `standaloneStrings.ts` | 文案仍由实际界面和命令持有，没有需要这些上游共享字符串的调用方。 |
| `tokens/contiguousMultilineTokens.ts`、`tokens/contiguousMultilineTokensBuilder.ts`、`tokens/contiguousTokensEditing.ts`、`tokens/contiguousTokensStore.ts`、`tokens/tokenWithTextArray.ts` | 当前具名 token store/行索引处理结果、编辑和渲染读取；上游编码 token 存储体系未接入，不并存第二份持久 token 状态。 |

### 本批验证

- 链接与模型分词定向单测：2 文件、13 项通过，覆盖实际服务与模型链。
- `check-editor-alignment.mjs --test=unit`：结构、台账、类型检查及 229/229 个测试文件通过。
- `build:renderer`、`build:stanza` 通过，无新增构建 warning。
- Playwright Chromium：链接真实鼠标点击及编辑后清除通过；TextMate Worker 与语义提供者替换场景通过。首次链接用例的 DOM 选择器及鼠标操作修正后，重跑该用例通过。
- 保留既有 JSDOM Canvas、测试服务装配输出及 Playwright 颜色环境提示；未改 CSS，结构检查仍记录 7 份既有 CSS 债务。

## common 缺失文件补齐：分词状态存储（2026-09-21）

用户本批选择“先补现有功能链需要的 common 文件”，不引入前端 diff 与 Tree-sitter 完整引擎。起始工作区干净；目录调查覆盖双方 TypeScript 文件集合，并检索缺失模块的公开符号在 Ash 中的生产引用。符号同名只作为调查线索，不代表职责一致。

准入链：文本编辑 → `TokenizationTextModelPart` 的版本绑定请求 → `SyntaxProviderWorker` → `TokenizationStateStore` → 复用有效行 token、重算受上文状态影响的行 → Worker 与模型分词行为测试。Worker 仍拥有一个模型请求缓存及其释放；新 store 只拥有该成功版本的逐行结束状态，不创建后台调度器或第二份 token 数据。

| 路径 | 存在关系 | 本批处理 |
| --- | --- | --- |
| `common/model/textModelTokens.ts` | 仅 VS Code → 双方都有 | 独立实现 `TokenizationStateStore.getEndState/setEndState`，由生产 Worker 使用；其余上游类与方法未实现。 |
| `common/services/editorWebWorker.ts` | 双方都有 | 缓存行只保留文本、行尾标志和 token；结束状态归 store，首行初始状态单独保留。支持对象或语言变化时不复用缓存；成功校验后才提交新缓存。 |
| `test/common/syntaxProviderWorker.test.ts` | Ash 现有测试 | 补充缓存命中、可变 tokenizer state、跨行状态传播、行尾变化、提供者替换和失败后重试测试。 |

`textModelStringEdit.ts` 本批未创建：上游整行替换长度转换会覆盖编辑起始行，而 Ash 的稳定 LineId 规则要求保留起始行身份；不能直接替换现有 `projectLineIds`。`core/editorColorRegistry.ts` 也未创建：现有注册由 Platform 的 `colors/editorColors.ts`、统一 `ColorId` 和主题初始化消费，必须先解决这条依赖链，不能增加反向导入或二次注册。

当前 common 有 **200 个 TypeScript 文件：169 个同路径、31 个 Ash 自有；仍缺 57 个上游 TypeScript 文件**。这不是整个 common 已补齐。Ash 自有文件沿用本页已有职责决定，没有删除、重命名或扩张其职责。上游的 3 张编辑算法示意图、5 份 Tree-sitter 查询不计入 TypeScript 数量。

### 剩余同路径缺口

以下为完整文件集合差异，不是自动实施队列。Diff 与 Tree-sitter 完整引擎不在本批范围；两份 semantic styling 服务按本页既有记录不恢复无职责包装。其他模块仍需确认完整生产调用链与下层依赖，不能以“没有同名符号”推断没有对应功能。

- `common/core/editorColorRegistry.ts`
- `common/core/text/getPositionOffsetTransformerFromTextModel.ts`
- `common/diff/defaultLinesDiffComputer/algorithms/diffAlgorithm.ts`
- `common/diff/defaultLinesDiffComputer/algorithms/dynamicProgrammingDiffing.ts`
- `common/diff/defaultLinesDiffComputer/algorithms/myersDiffAlgorithm.ts`
- `common/diff/defaultLinesDiffComputer/computeMovedLines.ts`
- `common/diff/defaultLinesDiffComputer/defaultLinesDiffComputer.ts`
- `common/diff/defaultLinesDiffComputer/heuristicSequenceOptimizations.ts`
- `common/diff/defaultLinesDiffComputer/lineSequence.ts`
- `common/diff/defaultLinesDiffComputer/linesSliceCharSequence.ts`
- `common/diff/defaultLinesDiffComputer/utils.ts`
- `common/diff/documentDiffProvider.ts`
- `common/diff/externalLinesDiffComputer.ts`
- `common/diff/legacyLinesDiffComputer.ts`
- `common/diff/linesDiffComputer.ts`
- `common/diff/linesDiffComputers.ts`
- `common/diff/rangeMapping.ts`
- `common/editorAction.ts`
- `common/editorFeatures.ts`
- `common/languages/linkComputer.ts`
- `common/languages/modesRegistry.ts`
- `common/languages/nullTokenize.ts`
- `common/languages/supports/tokenization.ts`
- `common/languages/textToHtmlTokenizer.ts`
- `common/model/bracketPairsTextModelPart/colorizedBracketPairsDecorationProvider.ts`
- `common/model/bracketPairsTextModelPart/fixBrackets.ts`
- `common/model/decorationProvider.ts`
- `common/model/fixedArray.ts`
- `common/model/intervalTree.ts`
- `common/model/textModelStringEdit.ts`
- `common/model/textModelText.ts`
- `common/model/tokens/abstractSyntaxTokenBackend.ts`
- `common/model/tokens/tokenizationFontDecorationsProvider.ts`
- `common/model/tokens/tokenizerSyntaxTokenBackend.ts`
- `common/model/tokens/treeSitter/cursorUtils.ts`
- `common/model/tokens/treeSitter/tokenStore.ts`
- `common/model/tokens/treeSitter/treeSitterSyntaxTokenBackend.ts`
- `common/model/tokens/treeSitter/treeSitterTokenizationImpl.ts`
- `common/model/tokens/treeSitter/treeSitterTree.ts`
- `common/multiDiffEditor.ts`
- `common/services/editorWorkerHost.ts`
- `common/services/getIconClasses.ts`
- `common/services/inMemoryTextModelService.ts`
- `common/services/languageFeatureDebounce.ts`
- `common/services/languagesAssociations.ts`
- `common/services/modelUndoRedoParticipant.ts`
- `common/services/semanticTokensStyling.ts`
- `common/services/semanticTokensStylingService.ts`
- `common/services/textResourceConfigurationService.ts`
- `common/services/treeSitter/treeSitterLibraryService.ts`
- `common/services/treeSitter/treeSitterThemeService.ts`
- `common/standaloneStrings.ts`
- `common/tokens/contiguousMultilineTokens.ts`
- `common/tokens/contiguousMultilineTokensBuilder.ts`
- `common/tokens/contiguousTokensEditing.ts`
- `common/tokens/contiguousTokensStore.ts`
- `common/tokens/tokenWithTextArray.ts`

### 本批验证

- 定向 `test:editor:unit`：Worker 与模型分词两份测试共 19 项通过。
- `check-editor-alignment.mjs --test=unit`：结构、台账、类型检查及 228/228 个 Editor/关联 Workbench 测试文件通过；没有新增源码 JavaScript。结构检查仍报告既有成员差异和 7 份 CSS 品牌替换债务，本批未修改 CSS。
- `build:stanza`：通过，无构建 warning。
- Playwright Chromium：TextMate Worker 启动/重启、语义 provider 替换/移除共 2 项通过；验证状态与 token 样式，不以截图判断。
- 完整单测日志含 JSDOM Canvas 能力提示，以及部分装配场景的 `markerDecorationsService` / `IInlineCompletionsService` 缺失输出；这些装配路径不在本批改动内，不能把测试通过解读为日志无错误。Playwright 仍提示 `NO_COLOR` / `FORCE_COLOR` 环境冲突。
- 首次测试启动使用 Node 25，被仓库版本检查拒绝；切换至 `.nvmrc` 指定的 Node 24.21.0 后完成以上验证。
- `git diff --check` 通过。


## common 全目录复核与收尾（2026-09-21）

本次重新扫描 common 全部 202 个 TypeScript 文件的导入、公开声明和生产/测试引用，并检查重复函数；对上一轮剩余 34 个 Ash 自有文件复核实际职责。工作区开始时干净。清理依据是无效入口与重复职责，不按上游文件数量删除功能。

| 清理项 | 最终处理 |
| --- | --- |
| `viewModel/visualRangeGeometry.ts` | 删除仅供选区使用的泛型范围包装及不可达空范围分支；矩形计算归 `visualSelectionGeometry.ts`，直接产生选区矩形，减少中间数组和对象。 |
| `viewModel/pointerHitTest.ts` | 删除无生产调用的逻辑行命中算法；未折行测试也使用生产中的视觉行路径，保留滚动、gutter、空行、tab 和 Unicode 覆盖。 |
| `model/documentFragment.ts`、`model/documentText.ts` | 删除两个文件。片段提取及纯文本转换归已有 `documentSerialization.ts`，共用节点查找和文本块判断；widget、working copy 与测试直接引用该 owner。 |
| `core/documentPosition.ts` | 删除没有调用方的绝对位置反查、路径解析和边界偏向逻辑；保留富文档 DOM 使用的文本点到绝对位置转换及节点尺寸计算。 |
| `tokens/languageTokenLineIndex.ts`、`languageTokens.ts` | 移除只剩测试使用的自定义样式 resolver 注入及类型；实际路径直接调用唯一转换函数，不再重复验证它自己产生的样式。虚拟化测试改为观测真实行读取。 |
| `languages.ts` | 删除早先远程补全目录框架遗留的 catalog 解码校验；实际 provider 注册与目录事件继续由 registry 管理。 |
| `config/diffEditor.ts` | 删除无生产调用、上游也没有的 options 解析器；保留配置注册在用的默认值。 |
| `core/text/positionToOffsetImpl.ts`、`core/misc/indentation.ts` | 删除无调用的额外行数组转换器、缩进增加 helper；实际坐标转换、输入和缩进命令路径不变。 |

完成后 common 有 199 个 TypeScript 文件（168 个同路径、31 个 Ash 自有）。剩余 Ash 文件继续承担富文档数据/事务/历史/协作、后端差异计算、模型范围跟踪、语言请求与结果、token 行索引及实际视图几何，均有生产消费者。它们不因 VS Code 没有同名文件而成为垃圾。已有上游同路径公共能力如 `ArrayEdit`、`RangeMapping`、`Rect`、`MirrorTextModel` 等不以暂时无静态调用为由删除；本次也未增加空实现或测试专用生产调用。

旧 API、已删除源文件的生产和测试 import 已清除；以下各批数据保留为历史记录。本节描述本次清理范围，不表示全部 VS Code API 已实现。

验证完成：

- `check-editor-alignment.mjs --test=unit` 通过：结构检查、Stanza 类型检查、Editor 与关联 Workbench 单测 228/228 文件通过，无新增源码 JavaScript 产物。
- Playwright `--project chromium` 全量 309/309 通过，涵盖鼠标、折行选区、富文档剪贴板、主题和语言 Worker；本批未运行 `chrome-gpu` 项目。
- 最后复跑富文档、鼠标及两份架构测试，4/4 文件通过，其中架构断言 26 项。
- 最终 `build:stanza`、`build:renderer` 通过，无新增构建 warning；`git diff --check` 通过。保留既有 JSDOM Canvas 与 Playwright 颜色环境提示；CSS 未修改。
- 再次扫描确认剩余 31 个 Ash 自有文件均有生产 import；已删除源路径无生产或测试 import，历史台账中的旧路径保留用于说明迁移。


## common 样式服务续批清理（2026-09-21）

删除 `services/semanticTokensStyling.ts`、`services/semanticTokensStylingService.ts`，移除 `semanticTokensProviderStyling.ts` 中的无状态 provider 包装类，保留实际转换函数。VS Code 的对应服务根据 provider legend、主题和语言解析数字 token metadata；Ash 使用带名称的 `LanguageToken`，当前转换完全不读取 provider，原服务只有额外的对象与缓存，没有独立职责。

生产调用链为模型语义 provider → `SemanticTokensTextModelPart` 的请求与版本检查 → token store → `StyledTokenSource` → 渲染行。模型直接接受 token 结果，语法和语义路径共用转换函数，不再保存结果 provider 或为每个模型创建样式服务。模型、行缓存和 DOM 的归属没有变化。`textResourceConfiguration.ts` 的资源换行符契约继续保留。

本批从干净工作区开始，删除 2 个同路径文件后 common 有 202 个 TypeScript 文件，其中 168 个与 VS Code 同路径、34 个仅 Ash；该数量不代表 API 一致性。下方上一批统计保留为历史记录。

验证：`check-editor-alignment.mjs --test=unit` 通过，包含结构检查、Stanza 类型检查和 Editor/关联 Workbench 单测 228/228 文件；定向语义 token 单测 3/3 文件（18 项）、编辑器架构测试 23 项通过。新增提供者替换、移除和迟到结果验证，原样式测试改为直接断言模型渲染结果。Playwright 的提供者高亮切换和真实 TextMate Worker 场景 2/2 通过，测试提供者限制为目标模型后再次运行高亮场景通过。`build:stanza`、`build:renderer` 通过，无新增构建 warning；保留既有 JSDOM Canvas 与 Playwright 颜色环境提示，未修改 CSS。

## common 目录清理（2026-09-21）

按用户要求检查整个 `common` 文件集合、生产引用和测试引用：清理前 212 个 TypeScript 文件，169 个有 VS Code 同路径、43 个仅 Ash；本批删除 9 个旧文件，新增上游同路径的 `services/editorWorker.ts` 契约，清理后 204 个文件（170 个同路径、34 个仅 Ash）。文件数只描述目录变化，不代表完整 VS Code API 已对齐。

准入链：补全/格式化与 TextMate → 编辑器 Worker 客户端 → 通用消息传输与文本同步 → 当前版本的结果应用；复用请求取消、镜像同步、结果确认、增量属性和真实浏览器 Worker 测试。原工作区干净。本批新增通用 Worker 模块独立实现 Ash 已有的消息行为，不复制上游实现；同路径不表示已经提供上游完整代理 API。

| 删除的文件（相对 common） | 处理结果 |
| --- | --- |
| `services/languageWorkerWire.ts` | 请求、取消、错误及端口契约归 `base/common/worker/webWorker.ts`；镜像与请求快照归已有 `services/textModelSync`；结果基线归分词 DTO 模块。 |
| `services/editorWorkerWire.ts` | 编辑请求契约归 `services/editorWorker.ts`；编辑与补全编解码归 `editorWebWorker.ts`；语法结果及增量编解码归 `semanticTokensDto.ts`。 |
| `model/syntaxService.ts` | 分词请求、token store 直接由 `model/tokens/tokenizationTextModelPart.ts` 管理；提供者优先级归 Worker 实现。删除没有生产请求入口的重复诊断存储与 `requestAll` 包装；模型已有的诊断流程继续工作。 |
| `model/textBufferFactory.ts` | 创建逻辑收回现有 PieceTree builder，调用方直接使用。 |
| `model/textBufferSnapshot.ts` | 公共快照契约归 `model.ts`；唯一消费者 PieceTree 私有实现分段快照。 |
| `model/textModelLargeFile.ts` | 大文件策略收回唯一生产使用方 `textModel.ts`。 |
| `viewModel/rangeGeometry.ts` | 删除无生产调用的逻辑行矩形算法；唯一在用的枚举收回视觉行几何实现。 |
| `viewModel/textMeasurer.ts`、`viewModel/editorViewportContracts.ts` | 共享视图契约归已有 `common/viewModel.ts`，删除零散契约文件。 |

旧文件没有别名或转发入口。实现、生产引用、单测、浏览器场景及架构断言一起迁移；两个重复的 SyntaxService 并发/取消测试由既有 `languageRequestCoordinator` 测试覆盖，提供者选择和错误隔离测试改为直接验证 Worker。

### 剩余 34 个仅 Ash 文件

以下文件保留当前独立职责，不能按上游是否有同名文件删除。判断依据为生产调用与状态归属；没有宣称逐行验证每一种行为，也没有把公开 API 差异标为已解决。

| 文件（相对 common） | 保留理由与生产调用方 |
| --- | --- |
| `commands/documentCommands.ts` | 富文档事务命令；富文档 widget、citation 调用。 |
| `core/documentPosition.ts`、`core/documentSelection.ts` | 富文档坐标与选区；widget、事务和协作使用。 |
| `core/textSegmentation.ts` | 文本分段算法；编辑输入、折行和单词补全共享。 |
| `diff/diffComputationService.ts`、`diff/lineDiff.ts` | 版本绑定计算契约和行差异结果；后端适配器、diff widget、SCM 使用，不能换名后冒充上游不同的结果契约。 |
| `diff/diffModel.ts` | 两个模型的差异请求状态与取消；diff、多文件 diff、SCM 使用。 |
| `model/decorationCollection.ts`、`model/trackedRange.ts` | 装饰集合与编辑后位置跟踪；多种 contribution 和模型使用。 |
| `model/document.ts`、`model/documentSchema.ts` | 富文档类型与 schema 校验；模型、序列化和 Academic 使用。 |
| `model/documentDecoration.ts`、`model/documentFragment.ts` | 富文档装饰映射与片段操作；模型插件、widget 使用。 |
| `model/documentHistory.ts`、`model/historyCoalescing.ts` | 文档历史与编辑合并规则；TextModel、editStack、协作使用。 |
| `model/documentOutline.ts`、`model/documentText.ts` | 富文档提纲与文本转换；widget、pane、working copy 使用。 |
| `model/documentPlugin.ts` | 事务插件契约；TextModel、文档 profile 使用。 |
| `model/documentSerialization.ts`、`model/documentTransactionSerialization.ts` | 文档与事务的持久化/传输边界；working copy、协作使用。 |
| `model/documentTransaction.ts` | 富文档事务和选区映射；TextModel、命令、协作使用。 |
| `model/lineDocument.ts`、`model/lineDocumentProjection.ts`、`model/textModelBlockState.ts` | TextModel 内的行身份、富文档语义与状态映射，不是第二套文本模型。 |
| `model/languageRequestCoordinator.ts`、`model/languageResultStore.ts` | 模型版本、取消与结果接受；补全、诊断、分词各自持有实例，共享同一实现。 |
| `model/tokens/semanticTokensTextModelPart.ts` | 语义 token 提供者请求与行索引；模型分词组件使用。 |
| `services/documentCollaborationService.ts` | 富文档协作边界；编辑器协作贡献和 Workbench 适配器使用。 |
| `tokens/languageTokenLineIndex.ts`、`tokens/languageTokens.ts` | Ash token 数据与增量行索引；分词、样式、渲染器使用。 |
| `viewModel/pointerHitTest.ts`、`viewModel/visualCursorNavigation.ts` | 命中测试与视觉导航算法；View 和输入控制器使用。 |
| `viewModel/visualRangeGeometry.ts`、`viewModel/visualSelectionGeometry.ts` | 折行后的范围与选区几何；光标和选区绘制使用。 |

同路径文件还检查了引用入口：`editorWebWorkerMain.ts` 经 Worker URL 加载；`core/ranges/rangeMapping.ts`、`rangeSingleLine.ts`、`core/2d/rect.ts`、`core/edits/arrayEdit.ts` 当前没有静态生产导入，属于已有上游同路径基础 API，并有独立测试，本批没有借清理删除这些公开能力。

### 本批验证

- `check-editor-alignment.mjs --test=unit` 完成：结构检查、Stanza 类型检查、Editor 与关联 Workbench 单测 228/228 文件通过；无新增源码 `.js` 产物。
- 通用 Worker 和两份编辑器架构测试 3/3 文件通过（28 项），覆盖请求取消隔离、通知失败、目录职责和单一模型约束。
- `build:stanza`、`build:renderer` 通过，无新增构建 warning。
- Playwright 全量 309/310 项通过。唯一失败为 GPU 场景撤销后的 `punctuationLineAdvanceMatchesDom`；当前代码定向复跑和改动前 HEAD 对照均在同一断言失败。对照后本批 85 个已跟踪 TypeScript 路径完整恢复，无覆盖冲突。本批未改动 GPU 实现或放宽断言。
- 测试仍报告既有 JSDOM Canvas 能力提示与 Playwright 颜色环境变量提示；CSS 审计报告已有 7 份品牌替换差异，本批未修改 CSS。
- 旧源文件 import、旧语言 Worker 协议和 SyntaxService 引用已清零；同步更新几何文档和架构测试的归属。

旧章节保留当时的审计数据，本批归属优先于旧“最终保留”结论。

## 语言目录清理（2026-09-21）

按用户“全部处理完”的要求，`common/languages` 的目录归属清理已完成：44 个 TypeScript 文件收敛为 15 个，全部有 VS Code 同路径；6 个剩余旧文件均已退出，没有保留转发入口。仍在使用的 Ash 模型和 Worker 机制按实际职责保留在下表归属中，不能把同路径数量视为整个 Editor 的 API 一致性证明。下面旧审计中的文件名与数量保留为当时记录。

| 退出的文件（相对 `common/languages`） | 当前归属或删除原因 |
| --- | --- |
| `languageRegistry.ts` | `common/services/languagesRegistry.ts`；生产调用方和测试使用 `LanguagesRegistry`，保留原有注册替换与文件关联行为。 |
| `languageFeatureRequest.ts`、`languageWorkspaceEdit.ts` | 公共请求、编辑契约和校验进入 `common/languages.ts`，调用方直接引用。 |
| `languageId.ts` | 语言身份校验由 `language.ts` 拥有；选择器校验由 `common/languageSelector.ts` 拥有。 |
| `completion/languageWordCompletionProvider.ts` | 单词提取实现进入真实调用方 `common/services/editorWebWorker.ts`。 |
| `completion/languageCompletionCatalogWire.ts`、`completion/languageCompletionProviderModuleWire.ts`、`completion/languageCompletionProviderModules.ts`、`completion/languageCompletionResolveWire.ts` | 没有生产入口，删除未接线的远程补全模块框架及其专用测试；在用的补全请求和延迟详情解析保持原行为。 |
| `languageProviderModules.ts`、`languageProviderModuleWire.ts`、`syntax/syntaxProviderModules.ts`、`syntax/syntaxProviderModuleWire.ts`、`syntax/syntaxModuleWorkerClient.ts` | 唯一生产使用方 TextMate 在 Worker 启动时直接注册 provider；删除动态模块激活协议和包装层。语法目录、主题同步及失败后的 Worker 重建仍由 TextMate 客户端负责。 |
| `completion/languageCompletionProviders.ts`、`syntax/syntaxProviders.ts` | 提供者契约归 `common/languages.ts`；注册状态归 `common/languageFeatureRegistry.ts`。 |
| `completion/languageCompletionService.ts`、`completion/languageCompletions.ts` | 结果契约和结构校验归 `common/languages.ts`；模型请求、结果存储及 snippet 校验归 `contrib/suggest/browser/suggest.ts`，消除 common 对 snippet contribution 的依赖。 |
| `completion/languageCompletionWire.ts` | 补全编解码归现有 `common/services/editorWorkerWire.ts`，复用坐标和基础值校验。 |
| `workspaceSymbols.ts` | 提供者契约归 `common/languages.ts`；搜索聚合归 `workbench/contrib/search/common/search.ts`，删除无状态服务包装和没有调用方的 resolve 方法。 |
| `syntax/syntaxItemDelta.ts`、`syntax/syntaxWireResult.ts` | 只有语法编解码入口使用，最终合入 `common/services/editorWorkerWire.ts`；增量算法及结果编解码成为私有实现，不再跨文件导出。 |
| `languageWorkerWireProtocol.ts` | 消息生成、解码和协议校验合入唯一传输实现 `common/services/languageWorkerWire.ts`；外部仅保留 codec 和已确认结果基线契约。 |
| `languageResults.ts` | 诊断类型及边界校验归 `common/languages.ts`，诊断结果存储工厂归模型结果存储；token 与增量数据直接引用 `tokens/languageTokens.ts`、`services/semanticTokensDto.ts`，删除转导出。 |
| `languageRequestCoordinator.ts`、`languageResultStore.ts` | 分别归 `common/model/languageRequestCoordinator.ts`、`common/model/languageResultStore.ts`；保留模型版本、请求取消、结果接受和销毁语义。 |
| `languageWorkerWire.ts` | 归 `common/services/languageWorkerWire.ts`，拥有消息传输、镜像同步和已确认结果基线。 |
| `syntax/syntaxService.ts` | 公共语法契约归 `common/languages.ts`；模型调度与结果状态归 `common/model/syntaxService.ts`；提供者执行和 token 缓存归 `common/services/editorWebWorker.ts`。 |
| `syntax/syntaxWire.ts` | 语法编解码归 `common/services/editorWorkerWire.ts`，与编辑请求共享基础 DTO 校验。 |

通信层续批修复：语法增量比较遗漏 token 的嵌入语言、括号标记和显示属性，导致文本未变时沿用旧结果。新增测试先复现失败，再补全比较；增量添加/移除属性、随机编辑、远距离编辑、错误基线、取消和镜像同步共 4 份定向单测（30 项）通过。4 项 Chromium 场景通过，增强后的真实 TextMate Worker 主题场景再跑通过，验证相同文本与 token 类型下颜色及字体更新。Stanza/Renderer 构建通过；仅保留既有 Playwright 颜色环境变量提示。本批收拢 Ash 通信实现，没有将其标为 VS Code 标准协议。

当时保留的四个 Ash 专用实现是 `common/model/languageRequestCoordinator.ts`、`common/model/languageResultStore.ts`、`common/model/syntaxService.ts` 和 `common/services/languageWorkerWire.ts`。这些文件分别持有独立的请求、模型结果、语法调度和传输生命周期，该历史结论已由上方 common 清理重新审查，不作为永久保留依据。

收尾验证：Editor 全量单测 228/228 文件通过；Workbench 语言、诊断和 TextMate 定向 8/8 文件（37 项）通过；54 项 Chromium 场景通过。基础校验去重后复跑 4 份单测和 3 项浏览器场景通过；Stanza/Renderer 构建、目录对照、旧引用检查及结构审计通过。复用现有请求取消、过期结果、销毁、镜像恢复和增量属性回归，未新增重复测试。保留既有 JSDOM Canvas 与 Playwright 颜色环境提示，无新增构建 warning。

续批验证：15 份定向单测文件（100 项）、9 项 Chromium 场景、Stanza/Renderer 构建通过。新增回归覆盖无效 snippet 不影响其他提供者，以及取消搜索后不发布迟到结果。浏览器场景覆盖补全选择、snippet 导航/撤销和 TextMate Worker 目录同步及重启。

TextMate 同批删除 `textMateSyntaxModule.ts`，客户端改名为 `textMateSyntaxWorkerClient.ts`。现有目录/主题传输测试使用直接注册路径；新增 Playwright 回归从真实浏览器 Worker 验证首次高亮、主题更新、语法更新和重启后恢复。定向单元测试 10 份（98 项）、Playwright 4 项、Stanza 类型检查及 Stanza/Renderer 构建通过。


> 本表记录 2026-08-30 对 `ash-ts/src/ash/editor` 生产 TypeScript 文件的扫描结果。分层依据为 VS Code 的 [Source Code Organization](https://github.com/microsoft/vscode/wiki/Source-Code-Organization) 和仓库内 `vscode-api-alignment` skill。

## 逐文件行为审查（2026-09-15）

本次清点得到 530 个非测试 TypeScript 文件：common 254、browser 120、contrib 144、standalone 6、顶层 6。下表记录本轮实际阅读的 40 个文件及其结论；“已检查”只代表表述的行为已检查，不代表全部 API 或边界已完成。其余 490 个文件的本轮全量静态检查见下一节；静态扫描与逐行行为审查分开记录。

本批生产修改限定在 UTF-16 格式化、worker 值替换和语言请求有效性三条调用链，保持现有模型、worker 和 contribution 的职责。新增模型语言快照字段由请求工厂统一创建，Workbench JSON 提供者测试同步使用该工厂。

| 文件（相对 editor） | 本轮结论 |
| --- | --- |
| `common/core/text/textLength.ts` | 已修复：UTF-16 列数把 emoji 计为两个代码单元。 |
| `common/core/edits/textEdit.ts` | 已修复：最小编辑不从代理项对中间截断。 |
| `common/services/editorWebWorker.ts` | 已修复：行末字符参与值替换；空选区递增整个数字。 |
| `common/languages/languageFeatureRequest.ts` | 已修复：检查模型销毁与请求开始时的模型语言；请求语言参数独立保留。 |
| `common/core/text/positionToOffset.ts` | 已检查坐标转换入口与依赖。 |
| `common/core/text/positionToOffsetImpl.ts` | 已检查偏移转换；CRLF 内部偏移的调用约束待进一步核对。 |
| `common/core/text/abstractText.ts` | 已检查范围取值和坐标转换。 |
| `common/core/edits/arrayEdit.ts` | 已读实现；未确认当前生产调用链，不改动。 |
| `common/core/edits/edit.ts` | 已检查编辑排序、归一化与合并。 |
| `common/core/edits/lengthEdit.ts` | 已检查长度映射及模型调用点。 |
| `common/core/edits/stringEdit.ts` | 已检查字符串偏移编辑；其 UTF-16 偏移语义不等同于模型位置校正。 |
| `common/core/edits/lineEdit.ts` | 已检查行编辑转换；大数组展开的实际规模待核对。 |
| `common/model/mirrorTextModel.ts` | 已读实现；未确认当前生产调用链，不改动。 |
| `common/model/prefixSumComputer.ts` | 已检查前缀和与边界查询。 |
| `common/model/textBufferSnapshot.ts` | 已检查快照读取与切片边界。 |
| `common/model/textBufferFactory.ts` | 已检查缓冲区创建入口。 |
| `common/model/textModelLargeFile.ts` | 已检查大文件阈值。 |
| `common/model/indentationGuesser.ts` | 已检查缩进样本与推断流程。 |
| `common/model/historyCoalescing.ts` | 已检查历史合并条件。 |
| `common/model/trackedRange.ts` | 已检查编辑和 EOL 变化后的范围追踪。 |
| `common/model/textModelPart.ts` | 已读生命周期实现；实际继承链待核对。 |
| `common/model/utils.ts` | 已检查缩进列计算。 |
| `common/model/tokens/semanticTokensTextModelPart.ts` | 已检查语义 token 调度与协调器调用。 |
| `common/commands/replaceCommand.ts` | 已检查替换范围与选区恢复。 |
| `common/commands/surroundSelectionCommand.ts` | 已检查包裹操作；普通包裹类的生产装配待核对。 |
| `common/commands/trimTrailingWhitespaceCommand.ts` | 已检查保存调用链；token 偏移边界仍待行为复现，不计为已修复。 |
| `common/commands/shiftCommand.ts` | 已检查缩进操作；重复字符串缓存规模待核对。 |
| `common/languages/languageResultStore.ts` | 已检查版本与重入处理；语言切换的调用方清理仍待完整核对。 |
| `contrib/hover/common/hover.ts` | 已检查请求和异步结果校验，消费本轮公共修复。 |
| `contrib/gotoSymbol/common/languageNavigation.ts` | 已检查请求和结果校验；新增语言切换、模型销毁回归。 |
| `contrib/documentSymbols/common/languageDocumentSymbols.ts` | 已检查请求和异步结果校验，消费本轮公共修复。 |
| `contrib/smartSelect/common/selectionRanges.ts` | 已检查请求和异步结果校验，消费本轮公共修复。 |
| `contrib/folding/common/languageFoldingRanges.ts` | 已检查请求和异步结果校验，消费本轮公共修复。 |
| `contrib/parameterHints/common/languageParameterHints.ts` | 2026-09-21 已迁入 `contrib/parameterHints/browser/parameterHints.ts`；旧服务退出，关闭同时取消排队任务和在途请求。 |
| `contrib/codeAction/common/languageCodeActions.ts`（已退出） | 原提供者与原始对象归属已迁入 `CodeActionController`；无 resolver 不串用其他提供者，查询与解析共用快照和取消信号。 |
| `contrib/links/common/languageLinks.ts` | 已检查请求和异步结果校验，消费本轮公共修复。 |
| `contrib/rename/common/languageRename.ts` | 2026-09-21 已迁入 `contrib/rename/browser/rename.ts`；原服务退出，准备和提交沿用同一快照及取消信号。 |
| `contrib/inlineCompletions/browser/model/provideInlineCompletions.ts` | 已检查提供者请求和异步结果校验，消费本轮公共修复。 |
| `contrib/inlayHints/common/languageInlayHints.ts` | 已检查请求和异步结果校验，消费本轮公共修复。 |
| `contrib/colorPicker/common/languageColors.ts` | 已修复：提供者异常返回后检查版本、语言与存活状态，3 项回归先失败后通过。 |

## 剩余文件全量静态检查（2026-09-15）

覆盖上表之外的全部 **490 个生产 TypeScript 文件**：common 226、browser 120、contrib 132、standalone 6、顶层 6。扫描解析了每个文件的完整语法树，提取静态/动态导入、Worker URL、导出、await、catch 和资源操作，并反查生产和测试引用。随后人工追踪下表明确标注的风险文件。**这完成了全量静态检查，不等同于 490 个文件逐行语义审查完成；未标注人工追踪的文件仅有静态证据。**

全量结果：530 个生产文件均能解析，相对 TypeScript 导入均能定位；未发现 Editor 对 Workbench/code/sessions 的反向导入，或 common 对 browser/node 实现的导入。4 个 common 文件仍引用 contribution 契约，见下表。62 个文件包含 await。引用数包含类型引用，不等于运行时可达性；测试引用数也不等于行为覆盖率。

本轮复现后修复 10 个实现文件：代码操作、重命名、参数提示、调用/类型层级、颜色展示、折叠区间、词语正则、MARK 标题正则、缩进列计算、Unicode 高亮。颜色展示文件已在首批 40 个文件中，因此本表中新增修复记录为 9 项。未复现的风险和缺少生产调用的端口保留为待验证，不做推测性改动。

剩余文件中的人工检查/修复记录为 **166/490**；另外 **324** 个文件目前仅有静态扫描证据。

### 后续修复：括号删除与代码操作归属

- `bracketEditing.ts`：一个光标命中括号时，其他非空选区不再被清空，选区方向和撤销仍由现有命令执行器维护。
- 原 `languageCodeActions.ts` 的请求逻辑已迁入 `CodeActionController`：菜单条目直接保存原提供者和原始 action，原提供者没有 resolver 时不会调用其他提供者；旧弱引用关联随服务一起退出，对外 action 格式保持不变。
- 两份定向测试修复前合计 4 项失败，修复后 6 项全部通过；7 项 Playwright 回归通过。Stanza 和 Renderer 正常构建通过，无新增构建 warning。保留既有 JSDOM Canvas 与颜色环境提示。

### 后续修复：公共服务职责收敛

用户确认修复 `common/services` 审查清单。资源持久化、诊断和显示数据按实际调用链调整，不将文件数量或上游名称当作完成标准。

| 原路径或职责 | 当前归属 |
| --- | --- |
| `textModelResourceService.ts`、`textResourceStore.ts`、`retainedModelUndoRedoHistory.ts` | `workbench/services/textmodelResolver/common`；工作副本由 Pane 持有，富文本控件仅接收模型。 |
| `languageTokenStylingResolver.ts` | 解析函数合入 `semanticTokensProviderStyling.ts`。 |
| `resolvedSemanticTokens.ts`、`resolvedSemanticTokensService.ts` | 类型归 `tokens/languageTokens.ts`，逐行缓存归 `tokens/languageTokenLineIndex.ts`，由 `TokenizationTextModelPart` 创建和释放。 |
| `languageDiagnosticsService.ts` | 模型调度成为 `textModel.ts` 私有实现；模型诊断契约归 `languages/languageResults.ts`；工作区枚举归 Workbench 诊断服务。 |
| `editorWorkerProtocol.ts`、`editorWorkerRequestExecutor.ts`、`editorWorkerWire.ts` | 通用消息仍经 `LanguageWorkerWireClient/Server`；计算集中到 `editorWebWorker.ts`，`editorWebWorkerMain.ts` 是唯一启动入口，`editorWorkerWire.ts` 只保留编辑请求编解码与边界校验。资源级 Worker 完整 API 仍未对齐。 |
| `contrib/collaboration/common/protocol.ts` | 协作消息类型合入 `common/services/documentCollaborationService.ts`，公共契约不再依赖 contribution。房间输入、邀请、成员角色和凭证契约归 Workbench；工具栏归 `workbench/contrib/documentEditor`，Pane 负责房间打开、切换取消和成员请求。Editor 控制器只处理文档同步与远端选区。 |

下方全量表保留原审查时的路径与引用数；上表说明本次迁移后的归属。

2026-09-21 Worker 生命周期续修：`LanguageRequestCoordinator` 在模型关闭时取消请求并释放 Worker；调用方取消或同通道请求被替代时，不再等待忽略取消信号的提供者，迟到结果按 discarded 结算。Worker 创建期间模型关闭也会释放刚创建的实例。27 项调度/传输单测、3 项 Chromium 格式化/保存/切换文件场景及 Stanza 构建通过。资源级 Worker 服务尚未完成：Workbench 文件模型与 Standalone 模型仍由不同注册入口创建，当前通道仍按单模型维护镜像；本次没有增加不完整的 `IEditorWorkerService`。

本批定向验证：14 份单测文件分批通过，覆盖工作副本、关闭后撤销历史、诊断、语义 token、协作与 Worker；新增迟到房间连接释放、非法 Worker 坐标与 EOL 回归。7 项 Chromium 场景通过，协作迁移最终再跑 4 项通过。Renderer 类型检查、Renderer/Stanza 生产构建、结构审计和 diff 检查通过。结构审计仍记录 7 份未触及的 CSS 历史债务；本次没有新增构建 warning，Playwright 保留颜色环境变量提示。

### 待继续追踪的主要风险

- 链接、层级展开：功能卸载和异步返回交错时的 DOM/请求清理仍需复现。行内提示已在 2026-09-21 的控制器收敛批次验证并修复。
- 富文本图片粘贴：读取图片期间正文或选区变化后可能恢复旧选区，尚未执行真实图片解码回归。
- 字体缓存的多窗口过期已在 2026-09-22 验证并修复；GPU 样式缓存中 undefined 与 false/0 的区分仍需专门场景验证。
- 原审查中的 collaboration 公共协议依赖已修复；其他 common 文件的 contribution 依赖仍按各自调用链处理。

<details>
<summary>展开 490 个文件的检查记录</summary>

路径相对 `editor/`。引用列为“直接生产引用文件数 / 直接测试引用文件数”；不含外部使用者，也不能用零引用断定文件应删除。

| 文件 | 引用 | 检查证据与状态 |
| --- | --- | --- |
| `browser/config/charWidthReader.ts` | 1 / 1 | 2026-09-22：字符宽度使用布局像素；真实编辑器在宿主 0.75/1.5 倍 transform 下重新测量，代表字符宽度保持一致。 |
| `browser/config/domFontInfo.ts` | 7 / 1 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `browser/config/editorConfiguration.ts` | 2 / 3 | 2026-09-22：构造注入窗口无障碍服务，统一计算编辑器 on/off/auto 优先级；能力检测读取容器窗口。模型挂载提供长行特征，ViewModel 在编辑、折叠、换行与 tabSize 变化后提供最新行数；验证行号宽度、缩略图 fit/fill 和读屏长行换行。 |
| `browser/config/elementSizeObserver.ts` | 1 / 0 | 2026-09-22：尺寸事件发布前登记帧任务，使监听器内停止观察可以清理当前任务；补充同一回调中停止并重启自动布局的回归。 |
| `browser/config/fontMeasurements.ts` | 2 / 1 | 2026-09-22：Workbench 启动恢复并预热字体，保存状态时写入 application/machine 存储。只恢复过旧读数时序列化返回 undefined，保留已有存储；重新测量后只保存可靠读数。校验持久化记录的版本与字段，按窗口失效并取消关闭窗口的任务；覆盖刷新、定期保存和关闭后的释放。 |
| `browser/config/migrateOptions.ts` | 2 / 1 | 2026-09-22：布尔旧设置生成的嵌套对象归各次迁移独享；显式 allowCodeShifting 优先于旧 codeShifting。验证不同编辑器互不污染及新设置优先级。 |
| `browser/config/tabFocus.ts` | 2 / 1 | 人工检查：Tab 焦点模式切换与事件发布。 |
| `browser/controller/dragScrolling.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/controller/editContext/clipboardUtils.ts` | 10 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/controller/editContext/editContext.ts` | 7 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/controller/editContext/native/debugEditContext.ts` | 0 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 未发现直接生产导入，保留并核对装配。 |
| `browser/controller/editContext/native/editContextFactory.ts` | 2 / 1 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `browser/controller/editContext/native/nativeEditContext.ts` | 3 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/controller/editContext/native/nativeEditContextRegistry.ts` | 2 / 1 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `browser/controller/editContext/native/nativeEditContextUtils.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/controller/editContext/native/screenReaderContentRich.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/controller/editContext/native/screenReaderContentSimple.ts` | 2 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/controller/editContext/native/screenReaderSupport.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/controller/editContext/native/screenReaderUtils.ts` | 3 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/controller/editContext/screenReaderUtils.ts` | 2 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/controller/editContext/textArea/textAreaEditContext.ts` | 3 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/controller/editContext/textArea/textAreaEditContextInput.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/controller/editContext/textArea/textAreaEditContextRegistry.ts` | 1 / 1 | 人工检查：owner id 重复检查和注册撤销；同一实例重复注册是否允许由调用方约束。 |
| `browser/controller/editContext/textArea/textAreaEditContextState.ts` | 2 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/controller/mouseHandler.ts` | 3 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/controller/mouseTarget.ts` | 3 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/controller/pointerHandler.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/coreCommands.ts` | 5 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/dataTransfer.ts` | 1 / 0 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `browser/editorBrowser.ts` | 78 / 20 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/editorDom.ts` | 6 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/editorExtensions.ts` | 57 / 16 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/gpu/atlas/atlas.ts` | 4 / 0 | 人工检查：公开数据/服务契约及依赖方向，无独立可释放状态。 |
| `browser/gpu/atlas/textureAtlas.ts` | 3 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/gpu/atlas/textureAtlasPage.ts` | 3 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/gpu/atlas/textureAtlasShelfAllocator.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/gpu/atlas/textureAtlasSlabAllocator.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/gpu/bufferDirtyTracker.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/gpu/contentSegmenter.ts` | 3 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/gpu/css/decorationCssRuleExtractor.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/gpu/css/decorationStyleCache.ts` | 3 / 2 | 人工追踪：缓存键合并 undefined 与 false/0 的语义，待 GPU 样式场景验证。 |
| `browser/gpu/gpu.ts` | 5 / 0 | 人工检查：公开数据/渲染契约和依赖方向，无独立可释放状态。 |
| `browser/gpu/gpuDisposable.ts` | 5 / 0 | 人工检查：设备、buffer、texture 返回可释放句柄；初始 buffer 写入抛错时的资源释放待验证。 |
| `browser/gpu/gpuUtils.ts` | 8 / 0 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `browser/gpu/objectCollectionBuffer.ts` | 2 / 2 | 人工追踪：扩容、删除搬移、脏区和条目释放。 |
| `browser/gpu/raster/glyphRasterizer.ts` | 5 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/gpu/raster/raster.ts` | 7 / 0 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `browser/gpu/rectangleRenderer.ts` | 2 / 2 | 人工追踪：设备就绪后检查销毁状态；资源归入持有者。 |
| `browser/gpu/rectangleRenderer.wgsl.ts` | 1 / 0 | 人工检查：shader binding、滚动/视口坐标到裁剪坐标变换；零尺寸防护由 renderer 入口负责。 |
| `browser/gpu/renderStrategy/baseRenderStrategy.ts` | 2 / 0 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `browser/gpu/renderStrategy/fullFileRenderStrategy.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/gpu/renderStrategy/fullFileRenderStrategy.wgsl.ts` | 2 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/gpu/renderStrategy/viewportRenderStrategy.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/gpu/taskQueue.ts` | 1 / 0 | 人工追踪：队列清理与窗口任务；销毁后重入需结合调用方继续验证。 |
| `browser/gpu/viewGpuContext.ts` | 9 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/observableCodeEditor.ts` | 2 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/services/abstractCodeEditorService.ts` | 1 / 2 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `browser/services/bulkEditService.ts` | 4 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/services/codeEditorService.ts` | 14 / 7 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/services/contribution.ts` | 3 / 6 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/services/editorWorkerService.ts` | 8 / 3 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `browser/services/inlineCompletionsService.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/services/markerDecorations.ts` | 1 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `browser/services/openerService.ts` | 1 / 1 | 人工追踪：外部 URI 解析结果释放缺失；现有装配创建实例，实际 open 调用链待确认。 |
| `browser/services/renameSymbolTrackerService.ts` | 1 / 1 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `browser/stableEditorScroll.ts` | 2 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/triggerInlineEditCommandsRegistry.ts` | 2 / 2 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `browser/view.ts` | 38 / 6 | 2026-09-22：布局配置通知进入已有渲染调度，避免显示行与光标事件尚未发布完成时提前绘制；真实浏览器验证折叠、取消换行不发生光标行号越界。其他职责未作逐行行为结论。 |
| `browser/view/domLineBreaksComputer.ts` | 1 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/view/dynamicViewOverlay.ts` | 9 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `browser/view/renderingContext.ts` | 36 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/view/viewController.ts` | 9 / 5 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/view/viewLayer.ts` | 6 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/view/viewOverlays.ts` | 1 / 0 | 人工追踪：HTML 来自动态装饰渲染器；仍需逐类核对渲染字符串来源。 |
| `browser/view/viewPart.ts` | 19 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/view/viewUserInputEvents.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/viewParts/blockDecorations/blockDecorations.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/viewParts/contentWidgets/contentWidgets.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/currentLineHighlight/currentLineHighlight.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/decorations/decorations.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/editorScrollbar/editorScrollbar.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/glyphMargin/glyphMargin.ts` | 3 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/gpuMark/gpuMark.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/indentGuides/indentGuides.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/lineNumbers/lineNumbers.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/linesDecorations/linesDecorations.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/margin/margin.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/viewParts/marginDecorations/marginDecorations.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/minimap/minimap.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/minimap/minimapCharRenderer.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/viewParts/minimap/minimapCharRendererFactory.ts` | 0 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 未发现直接生产导入，保留并核对装配。 |
| `browser/viewParts/minimap/minimapCharSheet.ts` | 2 / 1 | 人工检查：字符码 128 可返回表外索引；反查仅到未接入生产的字形 renderer/factory，暂未确认可达渲染链，未修改。 |
| `browser/viewParts/minimap/minimapPreBaked.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/viewParts/overlayWidgets/overlayWidgets.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/overviewRuler/decorationsOverviewRuler.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/overviewRuler/overviewRuler.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/rulers/rulers.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/rulersGpu/rulersGpu.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/scrollDecoration/scrollDecoration.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/selections/selections.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/viewCursors/viewCursor.ts` | 2 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/viewParts/viewCursors/viewCursors.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/viewLines/domReadingContext.ts` | 3 / 2 | 人工检查：一次上下文内缓存 DOM 测量和缩放，零 offsetWidth 避免除零。 |
| `browser/viewParts/viewLines/rangeUtil.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/viewLines/viewLine.ts` | 10 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/viewLines/viewLineOptions.ts` | 10 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/viewParts/viewLines/viewLines.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/viewLinesGpu/viewLinesGpu.ts` | 2 / 0 | 人工追踪：设备就绪后检查销毁状态；重复 init 的调用约束待核对。 |
| `browser/viewParts/viewZones/viewZones.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/viewParts/whitespace/whitespace.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/widget/codeEditor/codeEditorContributions.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/widget/codeEditor/codeEditorWidget.ts` | 9 / 25 | 2026-09-22：挂载模型时更新长行特征与模型行数，卸载或挂载失败时清除模型相关配置输入；验证模型替换、读屏策略与显式关闭换行。其他职责未作逐行行为结论。 |
| `browser/widget/codeEditor/embeddedCodeEditorWidget.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/widget/diffEditor/diffEditorRows.ts` | 2 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/widget/diffEditor/diffEditorWidget.ts` | 3 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/widget/diffEditor/features/overviewRulerFeature.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/widget/documentOutlineNavigator.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/widget/multiDiffEditor/multiDiffEditorWidget.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `browser/widget/richTextEditor/htmlDocumentFragment.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `browser/widget/richTextEditor/richTextEditorWidget.ts` | 5 / 0 | 人工追踪：图片解码后恢复旧选区，版本与选区变化场景待验证。 |
| `common/commands/documentCommands.ts` | 2 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/config/diffEditor.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/config/editorConfiguration.ts` | 9 / 4 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `common/config/editorConfigurationSchema.ts` | 2 / 1 | 静态语法与依赖已扫描；含异步路径；未作逐行行为结论。 |
| `common/config/editorOptions.ts` | 94 / 25 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/config/editorZoom.ts` | 3 / 3 | 人工检查：有限值校验、上下界裁剪及仅变化时发布事件。 |
| `common/config/fontInfo.ts` | 12 / 8 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/config/fontInfoFromSettings.ts` | 3 / 2 | 人工检查：原始字体设置经过各 EditorOption 校验，统一由 BareFontInfo 创建。 |
| `common/coordinatesConverter.ts` | 9 / 6 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/core/2d/dimension.ts` | 15 / 0 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `common/core/2d/point.ts` | 2 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/core/2d/rect.ts` | 0 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 未发现直接生产导入，保留并核对装配。 |
| `common/core/2d/size.ts` | 1 / 0 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `common/core/characterClassifier.ts` | 2 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/core/cursorColumns.ts` | 12 / 1 | 人工检查：UTF-16、字素与制表位坐标转换；未发现本轮可复现缺陷。 |
| `common/core/documentPosition.ts` | 1 / 1 | 人工检查：文档位置解析、节点坐标与偏移边界；未发现本轮可复现缺陷。 |
| `common/core/documentSelection.ts` | 20 / 6 | 人工检查：文本/节点/全选描述与位置比较；运行时未知 kind 的拒绝位置待追踪。 |
| `common/core/editOperation.ts` | 10 / 0 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `common/core/misc/eolCounter.ts` | 3 / 0 | 人工检查：CR、LF、CRLF 计数和首尾行 UTF-16 长度；空文本返回值一致。 |
| `common/core/misc/indentation.ts` | 6 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/core/misc/rgba.ts` | 4 / 1 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/core/misc/textModelDefaults.ts` | 3 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/core/position.ts` | 171 / 137 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/core/range.ts` | 181 / 116 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/core/ranges/columnRange.ts` | 1 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/core/ranges/lineRange.ts` | 4 / 1 | 人工检查：行范围交并和集合排序；构造输入是否已合并由调用方契约决定。 |
| `common/core/ranges/offsetRange.ts` | 15 / 2 | 人工检查：半开范围；clipCyclic 对负整数周期可能返回 endExclusive，目前没有生产调用，未改动。 |
| `common/core/ranges/rangeMapping.ts` | 0 / 1 | 人工检查：有序映射查找与 TextLength 偏移；目前没有直接生产引用，未改动公开端口。 |
| `common/core/ranges/rangeSingleLine.ts` | 0 / 1 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/core/selection.ts` | 77 / 69 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/core/stringBuilder.ts` | 3 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/core/textChange.ts` | 50 / 9 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/core/textSegmentation.ts` | 7 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/core/wordCharacterClassifier.ts` | 5 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/core/wordHelper.ts` | 7 / 1 | 已修复：忽略零长度匹配并按 Unicode 字符推进正则游标，避免词语查询卡死；独立进程复现、g/gu/gv 回归及真实模型浏览器测试通过。 |
| `common/cursor/cursor.ts` | 5 / 13 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/cursor/cursorAtomicMoveOperations.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/cursor/cursorCollection.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/cursor/cursorColumnSelection.ts` | 1 / 1 | 人工检查：列选择按 UTF-16 列号裁剪；混合 Tab/宽字符时的可视矩形语义需真实交互验证。 |
| `common/cursor/cursorContext.ts` | 3 / 2 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/cursor/cursorDeleteOperations.ts` | 3 / 5 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/cursor/cursorMoveCommands.ts` | 4 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/cursor/cursorMoveOperations.ts` | 5 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/cursor/cursorTypeEditOperations.ts` | 3 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/cursor/cursorTypeOperations.ts` | 3 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/cursor/cursorWordOperations.ts` | 2 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/cursor/oneCursor.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/cursorCommon.ts` | 15 / 17 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/cursorEvents.ts` | 14 / 10 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/diff/diffComputationService.ts` | 6 / 5 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `common/diff/diffModel.ts` | 9 / 3 | 人工追踪：两侧版本及请求代次校验；源模型先销毁的异常路径待验证。 |
| `common/diff/lineDiff.ts` | 12 / 5 | 人工检查：公开数据/渲染契约和依赖方向，无独立可释放状态。 |
| `common/editorCommon.ts` | 51 / 9 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/editorContextKeys.ts` | 3 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/editorTheme.ts` | 3 / 2 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `common/encodedTokenAttributes.ts` | 19 / 6 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/inputMode.ts` | 3 / 1 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/languageFeatureRegistry.ts` | 24 / 10 | 人工追踪：注册撤销、独占提供者、排序和候选缓存；缓存未包含模型同步资格，尺寸阈值变化场景待验证。 |
| `common/languageSelector.ts` | 4 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages.ts` | 54 / 10 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/autoIndent.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/completion/languageCompletionCatalogWire.ts` | 2 / 2 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `common/languages/completion/languageCompletionProviderModuleWire.ts` | 2 / 1 | 人工检查：模块通信协议标识与版本、客户端/服务端参数一致，资源交给共同 wire owner。 |
| `common/languages/completion/languageCompletionProviderModules.ts` | 3 / 2 | 人工检查：提供者模块复用共同 registry/host，协议与目录规范化无独立状态。 |
| `common/languages/completion/languageCompletionProviders.ts` | 20 / 15 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/completion/languageCompletionResolveWire.ts` | 2 / 1 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `common/languages/completion/languageCompletionService.ts` | 8 / 9 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `common/languages/completion/languageCompletionWire.ts` | 2 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/completion/languageCompletions.ts` | 16 / 9 | 结构问题：common 引用 contribution 的 snippetParser。 |
| `common/languages/completion/languageWordCompletionProvider.ts` | 2 / 3 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/defaultDocumentColorsComputer.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/enterAction.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/language.ts` | 14 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/languageConfiguration.ts` | 19 / 3 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/languageConfigurationRegistry.ts` | 39 / 8 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/languageId.ts` | 9 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/languages/languageProviderModuleWire.ts` | 2 / 0 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `common/languages/languageProviderModules.ts` | 5 / 0 | 人工追踪：串行激活、加载后存活与模块身份检查。 |
| `common/languages/languageRegistry.ts` | 6 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/languageRequestCoordinator.ts` | 14 / 14 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `common/languages/languageResults.ts` | 21 / 14 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/languageWorkerWire.ts` | 17 / 7 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `common/languages/languageWorkerWireProtocol.ts` | 2 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/languageWorkspaceEdit.ts` | 17 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/supports.ts` | 5 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/supports/characterPair.ts` | 2 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/supports/electricCharacter.ts` | 2 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/supports/indentRules.ts` | 3 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/supports/indentationLineProcessor.ts` | 2 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/supports/inplaceReplaceSupport.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/supports/languageBracketsConfiguration.ts` | 6 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/supports/onEnter.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/supports/richEditBrackets.ts` | 4 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/syntax/syntaxItemDelta.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/syntax/syntaxModuleWorkerClient.ts` | 2 / 1 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `common/languages/syntax/syntaxProviderModuleWire.ts` | 3 / 2 | 人工检查：模块通信协议标识与版本、客户端/服务端参数一致，资源交给共同 wire owner。 |
| `common/languages/syntax/syntaxProviderModules.ts` | 5 / 3 | 人工检查：提供者模块复用共同 registry/host，协议与目录规范化无独立状态。 |
| `common/languages/syntax/syntaxProviders.ts` | 16 / 8 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/languages/syntax/syntaxService.ts` | 15 / 10 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `common/languages/syntax/syntaxWire.ts` | 3 / 5 | 人工检查：请求 record/string 和语言参数校验；两类 lane 复用确认版本的结果协议。 |
| `common/languages/syntax/syntaxWireResult.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/languages/workspaceSymbols.ts` | 8 / 3 | 人工追踪：resolve 选择首个提供者；未找到当前生产 resolve 调用，不计为用户可见故障。 |
| `common/model.ts` | 111 / 21 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsImpl.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/ast.ts` | 7 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/beforeEditPositionMapper.ts` | 3 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/bracketPairsTree.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/brackets.ts` | 2 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/combineTextEditInfos.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/concat23Trees.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/length.ts` | 8 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/nodeReader.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/parser.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/smallImmutableSet.ts` | 5 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/bracketPairsTextModelPart/bracketPairsTree/tokenizer.ts` | 4 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/decorationCollection.ts` | 20 / 11 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/document.ts` | 32 / 4 | 人工追踪：不可变节点、结构共享、插入/删除/替换及重复 id 检测；外部树的 schema 验证由调用边界负责。 |
| `common/model/documentDecoration.ts` | 3 / 2 | 人工追踪：装饰 id 唯一性、不可变集合及事务选区映射；未发现本轮可复现缺陷。 |
| `common/model/documentFragment.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/documentHistory.ts` | 3 / 0 | 人工追踪：撤销重做分支、历史合并顺序、容量限制与 rebase；未发现本轮可复现缺陷。 |
| `common/model/documentOutline.ts` | 4 / 1 | 人工追踪：标题栈、层级规范化、标题文字与图片替代文本；未发现本轮可复现缺陷。 |
| `common/model/documentPlugin.ts` | 6 / 2 | 人工检查：插件 key、状态/事务/装饰回调契约与描述符校验；实际执行原子性由 TextModel 持有。 |
| `common/model/documentSchema.ts` | 27 / 10 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/documentSerialization.ts` | 11 / 6 | 人工追踪：版本 envelope、节点/marks 解码与 schema 校验；深层递归和特殊属性名边界待验证。 |
| `common/model/documentText.ts` | 2 / 1 | 人工追踪：纯文本换行、同块/跨块选择与图片替代文本；跨容器选择返回 undefined 的能力边界保留。 |
| `common/model/documentTransaction.ts` | 14 / 6 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/documentTransactionSerialization.ts` | 3 / 3 | 人工追踪：step/selection 解码和元数据 JSON 编码；对象输入的元数据规范化及特殊键往返待验证。 |
| `common/model/editStack.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/guidesTextModelPart.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/lineDocument.ts` | 4 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/lineDocumentProjection.ts` | 2 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/pieceTreeTextBuffer/pieceTreeBase.ts` | 2 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/pieceTreeTextBuffer/pieceTreeTextBuffer.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/pieceTreeTextBuffer/pieceTreeTextBufferBuilder.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/pieceTreeTextBuffer/rbTreeBase.ts` | 2 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/textModel.ts` | 106 / 163 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/textModelBlockState.ts` | 3 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/model/textModelSearch.ts` | 4 / 2 | 人工追踪：正则空匹配推进、Unicode 代理对、查找数量上限与行内/多行分支；未发现本轮可复现缺陷。 |
| `common/model/tokens/annotations.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/model/tokens/tokenizationTextModelPart.ts` | 1 / 0 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `common/modelLineProjectionData.ts` | 8 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/services/completionsEnablement.ts` | 3 / 1 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/services/documentCollaborationService.ts` | 8 / 3 | 结构问题：common 引用 contribution 的协议契约。 |
| `common/services/editorBaseApi.ts` | 1 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/services/editorWebWorkerMain.ts` | 1 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/services/editorWorkerProtocol.ts` | 3 / 1 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `common/services/editorWorkerWire.ts` | 2 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/services/findSectionHeaders.ts` | 1 / 1 | 已修复：MARK 表达式的前瞻空匹配显式推进游标，后续有效标题仍能返回；独立进程复现，真实 TextModel 回归通过。 |
| `common/services/languageDiagnosticsService.ts` | 12 / 2 | 人工检查：公开数据/渲染契约和依赖方向，无独立可释放状态。 |
| `common/services/languageFeatures.ts` | 28 / 5 | 结构问题：共享注册表引用 contribution 的语言契约。 |
| `common/services/languageFeaturesService.ts` | 2 / 9 | 结构问题：共享注册表实现引用 contribution 的语言契约。 |
| `common/services/languageService.ts` | 5 / 7 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/services/languageTokenStylingResolver.ts` | 2 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/services/markerDecorations.ts` | 5 / 0 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `common/services/markerDecorationsService.ts` | 2 / 1 | 人工追踪：模型引用计数、抑制范围、重入和销毁清理。 |
| `common/services/model.ts` | 4 / 0 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `common/services/modelService.ts` | 1 / 1 | 人工追踪：模型创建/注销、资源唯一性、配置失效、文本/EOL 更新及历史恢复；关闭模型缓存随服务释放的清理待验证。 |
| `common/services/resolvedSemanticTokens.ts` | 10 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/services/resolvedSemanticTokensService.ts` | 1 / 2 | 人工追踪：缓存失效、语义层合并、服务持有源监听。 |
| `common/services/resolverService.ts` | 1 / 1 | 人工检查：公开数据/服务契约及依赖方向，无独立可释放状态。 |
| `common/services/retainedModelUndoRedoHistory.ts` | 1 / 1 | 人工追踪：按模型数及文本量限制缓存，恢复时消费快照。 |
| `common/services/semanticTokensDto.ts` | 3 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/services/semanticTokensProviderStyling.ts` | 2 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/services/semanticTokensStyling.ts` | 2 / 0 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `common/services/semanticTokensStylingService.ts` | 1 / 0 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `common/services/textModelResourceService.ts` | 10 / 4 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/services/textModelSync/textModelSync.impl.ts` | 1 / 1 | 人工追踪：版本、范围、换行校验后提交镜像。 |
| `common/services/textModelSync/textModelSync.protocol.ts` | 9 / 0 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `common/services/textResourceConfiguration.ts` | 2 / 1 | 人工检查：资源 EOL 服务契约，无独立运行时状态。 |
| `common/services/textResourceStore.ts` | 5 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/services/treeViewsDnd.ts` | 1 / 1 | 人工检查：拖拽 transfer 按 id 存取并消费后删除；拖拽取消未消费的清理路径待验证。 |
| `common/services/treeViewsDndService.ts` | 1 / 1 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/services/unicodeTextModelHighlighter.ts` | 5 / 0 | 已修复：按物理换行分行，CRLF 不再作为不可见字符报告；真实 worker 回归先失败后通过，并验证下一行字符坐标。 |
| `common/standalone/standaloneEnums.ts` | 1 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/textModelBracketPairs.ts` | 4 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/textModelEditSource.ts` | 11 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/textModelEvents.ts` | 16 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/textModelGuides.ts` | 5 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/tokenizationRegistry.ts` | 1 / 1 | 人工追踪：异步工厂替换和销毁后的注册门禁。 |
| `common/tokenizationTextModelPart.ts` | 3 / 1 | 人工检查：公开数据/服务契约及依赖方向，无独立可释放状态。 |
| `common/tokens/common.ts` | 1 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `common/tokens/languageTokenLineIndex.ts` | 2 / 3 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/tokens/languageTokens.ts` | 12 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/tokens/lineTokens.ts` | 13 / 4 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/tokens/sparseMultilineTokens.ts` | 3 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/tokens/sparseTokensStore.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewEventHandler.ts` | 13 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewEvents.ts` | 42 / 6 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewLayout/lineDecorations.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/viewLayout/lineHeights.ts` | 2 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/viewLayout/linePart.ts` | 1 / 0 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `common/viewLayout/linesLayout.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewLayout/viewLayout.ts` | 3 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/viewLayout/viewLineRenderer.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/viewLayout/viewLinesViewportData.ts` | 14 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel.ts` | 31 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel/editorViewportContracts.ts` | 12 / 1 | 人工检查：公开数据/服务契约及依赖方向，无独立可释放状态。 |
| `common/viewModel/glyphLanesModel.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel/inlineDecorations.ts` | 9 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel/minimapTokensColorTracker.ts` | 2 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/viewModel/modelLineProjection.ts` | 14 / 4 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/viewModel/monospaceLineBreaksComputer.ts` | 1 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/viewModel/overviewZoneManager.ts` | 2 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel/pointerHitTest.ts` | 1 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel/rangeGeometry.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel/screenReaderSimpleModel.ts` | 2 / 0 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `common/viewModel/textMeasurer.ts` | 11 / 25 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `common/viewModel/viewContext.ts` | 45 / 7 | 人工检查：复用 viewModel 的布局/事件 owner，不另建缓存；主题更新由 EditorTheme 承接。 |
| `common/viewModel/viewModelDecoration.ts` | 5 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel/viewModelDecorations.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel/viewModelImpl.ts` | 1 / 2 | 2026-09-22：显示行变化回写配置；编辑后在对外内容事件前更新模型行数和显示行数。验证编辑/撤销跨行号位数、折叠/换行/tabSize 变化下的缩略图比例。其他职责未作逐行行为结论。 |
| `common/viewModel/viewModelLines.ts` | 2 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `common/viewModel/visualCursorNavigation.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel/visualRangeGeometry.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModel/visualSelectionGeometry.ts` | 2 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `common/viewModelEventDispatcher.ts` | 4 / 10 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/academic/browser/nodeViews.ts` | 1 / 1 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `contrib/academic/common/schema.ts` | 2 / 3 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/anchorSelect/browser/anchorSelect.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/bracketMatching/browser/bracketColorizationPresentation.ts` | 1 / 1 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `contrib/bracketMatching/browser/bracketMatching.contribution.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/bracketMatching/browser/bracketMatching.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/bracketMatching/common/bracketEditing.ts` | 1 / 1 | 已修复：未命中括号的选区返回空命令，复用执行器跟踪选区；正反向选区、快捷键/正式 action 和撤销回归通过。 |
| `contrib/bracketMatching/common/bracketNavigation.ts` | 1 / 1 | 人工检查：多光标括号匹配、跳转/选择与无变化时复用选区。 |
| `contrib/callHierarchy/browser/languageHierarchy.contribution.ts` | 1 / 0 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/callHierarchy/browser/languageHierarchyController.ts` | 1 / 0 | 人工追踪：关闭 Peek 后 expand 返回仍访问旧 DOM，待场景验证。 |
| `contrib/callHierarchy/common/languageHierarchy.ts` | 7 / 1 | 已复现并修复：后续查询绑定准备阶段的版本及语言。 |
| `contrib/caretOperations/browser/transpose.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/citation/browser/nodeViews.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/citation/browser/toolbarAction.ts` | 1 / 1 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `contrib/citation/common/citationCommands.ts` | 1 / 1 | 人工检查：schema 能力检查、引用节点创建和书目插入点；空标签保留有效段落。 |
| `contrib/citation/common/references.ts` | 2 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/citation/common/schema.ts` | 3 / 0 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `contrib/clipboard/browser/clipboard.ts` | 1 / 2 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/codeAction/browser/codeActionContributions.ts` | 1 / 0 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/codeAction/browser/codeActionController.ts` | 1 / 1 | 已复现并修复：销毁时取消请求。 |
| `contrib/codelens/browser/codeLensCache.ts` | 2 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/codelens/browser/codelens.ts` | 3 / 1 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/codelens/browser/codelensController.ts` | 1 / 1 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/codelens/browser/codelensWidget.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/collaboration/browser/collaborationContribution.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/collaboration/common/controller.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/collaboration/common/envelopeSerialization.ts` | 0 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 未发现直接生产导入，保留并核对装配。 |
| `contrib/collaboration/common/protocol.ts` | 6 / 3 | 人工检查：有序协作 envelope 契约；被 common 服务反向引用的归属问题保留。 |
| `contrib/collaboration/common/rebase.ts` | 2 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/collaboration/common/synchronizer.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/colorPicker/browser/colorDetector.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/colorPicker/browser/colorPickerController.ts` | 1 / 1 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/colorPicker/browser/colorPickerModel.ts` | 2 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/colorPicker/browser/editorColorPickerDialog.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/comment/browser/blockCommentCommand.ts` | 2 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/comment/browser/comment.ts` | 1 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/comment/browser/lineCommentCommand.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/contextmenu/browser/contextmenu.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/cursorUndo/browser/cursorUndo.ts` | 1 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/diffEditorBreadcrumbs/browser/diffEditorBreadcrumbs.ts` | 1 / 0 | 人工检查：根节点移除、模型监听释放、节点自有 click 监听；大量变更逐行生成按钮的成本待测。 |
| `contrib/documentEditor.contribution.ts` | 1 / 1 | 人工检查：仅 document 模式安装格式与协作贡献，句柄交给 context 的 setter owner。 |
| `contrib/dropOrPasteInto/browser/copyPasteContribution.ts` | 1 / 1 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/dropOrPasteInto/browser/copyPasteController.ts` | 1 / 2 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/dropOrPasteInto/browser/dropIntoEditorContribution.ts` | 1 / 1 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/dropOrPasteInto/browser/dropIntoEditorController.ts` | 1 / 0 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/dropOrPasteInto/browser/textFileTransfer.ts` | 2 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/editorState/browser/editorState.ts` | 4 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/editorState/browser/editorStateController.ts` | 1 / 0 | 人工检查：焦点/选区/滚动监听均注册释放；创建时已有焦点与滚动状态的同步待验证。 |
| `contrib/editorState/browser/keybindingCancellation.ts` | 1 / 1 | 人工检查：WeakMap 请求栈、Escape 仅取消最新请求及编辑器销毁取消；父 token 已取消时的同步清理需专门回归。 |
| `contrib/editorState/common/editorInteractionState.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/find/browser/findController.ts` | 1 / 4 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/find/common/textSearchCommands.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/folding/browser/folding.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/folding/browser/foldingDecorations.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/folding/browser/foldingModel.ts` | 5 / 3 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/folding/browser/foldingRanges.ts` | 4 / 4 | 已复现并修复：祖先范围交叉校验。 |
| `contrib/folding/browser/hiddenRangeModel.ts` | 1 / 2 | 人工检查：合并已排序折叠区间，折叠/正文事件监听释放；消费本轮折叠交叉校验修复。 |
| `contrib/folding/browser/indentRangeProvider.ts` | 1 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/folding/browser/syntaxRangeProvider.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/fontZoom/browser/fontZoom.ts` | 1 / 1 | 人工检查：三个正式命令委托 EditorZoom，增减和复位共享同一状态。 |
| `contrib/format/browser/format.ts` | 3 / 4 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/format/browser/formatActions.ts` | 1 / 1 | 静态语法与依赖已扫描；含异步路径；未作逐行行为结论。 |
| `contrib/format/browser/formattingEdit.ts` | 1 / 0 | 人工检查：只读/空编辑拒绝、末次 EOL、撤销边界和滚动恢复；消费本轮格式化回归。 |
| `contrib/formatting/browser/formattingContribution.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/gotoError/browser/gotoError.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/gotoError/common/diagnosticDecorations.ts` | 1 / 3 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/gotoSymbol/browser/gotoSymbol.contribution.ts` | 1 / 0 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/gotoSymbol/browser/gotoSymbolController.ts` | 1 / 0 | 人工追踪：取消请求后渲染门禁、列表监听清理。 |
| `contrib/gotoSymbol/browser/languageNavigation.contribution.ts` | 1 / 0 | 人工检查：贡献安装条件与服务/控制器装配；具体生命周期见对应实现。 |
| `contrib/gotoSymbol/browser/languageNavigationController.ts` | 1 / 0 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/gotoSymbol/common/languageDocumentSymbolSearch.ts` | 2 / 0 | 人工检查：持有并释放文档符号服务，符号展开和名称排序；异步时效由提供者服务及 controller 负责。 |
| `contrib/hover/browser/diagnosticHoverController.ts` | 0 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 未发现直接生产导入，保留并核对装配。 |
| `contrib/hover/browser/hoverContribution.ts` | 1 / 0 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/hover/browser/hoverController.ts` | 1 / 0 | 人工追踪：延时、请求和 DOM 同步释放。 |
| `contrib/inPlaceReplace/browser/inPlaceReplace.ts` | 1 / 1 | 人工追踪：worker 结果和选区复核；模型/功能卸载交错待验证。 |
| `contrib/indentation/browser/indentation.ts` | 1 / 1 | 人工追踪：转换命令遍历正文缩进、生成 edits 并恢复 tracked selection；混合缩进回归通过。 |
| `contrib/indentation/common/indentUtils.ts` | 2 / 1 | 已修复：Tab 推进至下一制表位，混合缩进转换保持文字对齐；真实缩进命令与选区回归先失败后通过。 |
| `contrib/indentation/common/indentation.ts` | 1 / 1 | 人工追踪：重缩进规则、首行列宽与输出 edit 的调用链；消费同批 Tab 列宽修复。 |
| `contrib/inlayHints/browser/inlayHintsController.ts` | 1 / 0 | 2026-09-21 已验证并修复：控制器释放清理节点、计时器和请求；真实浏览器覆盖功能卸载与迟到响应。 |
| `contrib/inlineCompletions/browser/controller/inlineCompletionsController.ts` | 1 / 1 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/inlineCompletions/common/inlineCompletions.ts` | 6 / 1 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `contrib/inlineProgress/browser/inlineProgress.ts` | 2 / 1 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/languageAnalysis/browser/languageAnalysis.contribution.ts` | 1 / 0 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/lineSelection/browser/lineSelection.ts` | 1 / 1 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `contrib/linesOperations/browser/copyLinesCommand.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/linesOperations/browser/linesOperations.ts` | 1 / 7 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/linesOperations/browser/moveLinesCommand.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/linesOperations/browser/sortLinesCommand.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/linkedEditing/browser/linkedEditing.ts` | 1 / 1 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/links/browser/linksController.ts` | 1 / 0 | 人工追踪：dispose 未调用 clear，待卸载时的请求及 class 清理验证。 |
| `contrib/message/browser/messageController.ts` | 2 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/middleScroll/browser/middleScroll.contribution.ts` | 1 / 1 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/middleScroll/browser/middleScrollController.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/multicursor/browser/multicursor.ts` | 1 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/multicursor/common/occurrenceSelection.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/parameterHints/browser/parameterHints.ts` | 1 / 1 | 2026-09-21 已迁回对应入口并接通触发、关闭、前后切换命令；取消、动态配置、循环边界、节点复用和焦点均由真实浏览器验证。 |
| `contrib/peekView/browser/editorPeekViewWidget.ts` | 3 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/placeholderText/browser/placeholderText.contribution.ts` | 2 / 1 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/placeholderText/browser/placeholderTextContribution.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/quickAccess/browser/quickAccessController.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/quickAccess/common/gotoLocation.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/readOnlyMessage/browser/contribution.ts` | 1 / 1 | 人工检查：贡献安装条件与服务/控制器装配；具体生命周期见对应实现。 |
| `contrib/rename/browser/rename.ts` | 1 / 1 | 2026-09-21 原控制器迁回准确入口；重复提交、取消及焦点离开的同事件循环竞态均已通过真实浏览器验证。 |
| `contrib/sectionHeaders/browser/sectionHeaders.contribution.ts` | 1 / 0 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/sectionHeaders/browser/sectionHeadersController.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/smartSelect/browser/smartSelectController.ts` | 1 / 0 | 人工追踪：展开前版本/选区复核；异常返回路径仍待验证。 |
| `contrib/smartSelect/common/smartSelectionExpansion.ts` | 1 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/snippet/browser/snippetSession.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/snippet/common/snippetParser.ts` | 4 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/snippet/common/snippetTransform.ts` | 2 / 1 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `contrib/stickyScroll/browser/stickyScrollContribution.ts` | 1 / 0 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/stickyScroll/browser/stickyScrollController.ts` | 1 / 0 | 已接入 Provider、Widget 和标准命令；节点复用、布局焦点、点击选区及请求失效有行为测试，完整上游交互仍待补齐。 |
| `contrib/suggest/browser/suggestController.ts` | 2 / 3 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/suggest/browser/suggestModel.ts` | 3 / 4 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/suggest/browser/suggestWidget.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/symbolIcons/browser/symbolIcons.contribution.ts` | 1 / 0 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/symbolIcons/browser/symbolIcons.ts` | 1 / 0 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/textEditorCapabilities.ts` | 7 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `contrib/toggleTabFocusMode/browser/toggleTabFocusMode.ts` | 1 / 0 | 人工检查：正式 action/keybinding 切换 TabFocus 并发布无障碍提示。 |
| `contrib/tokenization/browser/tokenization.contribution.ts` | 1 / 0 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/unicodeHighlighter/browser/unicodeHighlighter.contribution.ts` | 1 / 1 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/unicodeHighlighter/browser/unicodeHighlighterController.ts` | 1 / 0 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/unicodeHighlighter/common/unicodeHighlights.ts` | 2 / 1 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `contrib/unusualLineTerminators/browser/unusualLineTerminators.contribution.ts` | 1 / 0 | 人工检查：贡献注册入口、安装条件与服务/控制器归属；功能实现结论见对应文件。 |
| `contrib/unusualLineTerminators/browser/unusualLineTerminatorsController.ts` | 1 / 0 | 人工检查：依模型版本更新装饰，监听由 controller 释放，装饰集合归贡献 scope。 |
| `contrib/unusualLineTerminators/common/unusualLineTerminatorRanges.ts` | 1 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `contrib/wordHighlighter/browser/highlightDecorations.ts` | 1 / 0 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `contrib/wordHighlighter/browser/textualHighlightProvider.ts` | 1 / 2 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `contrib/wordHighlighter/browser/wordHighlighter.contribution.ts` | 1 / 1 | 静态语法与依赖已扫描；含异步路径、含资源/集合操作；未作逐行行为结论。 |
| `contrib/wordWrap/browser/wordWrapController.ts` | 1 / 1 | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `contrib/zoneWidget/browser/zoneWidget.ts` | 1 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `editor.academic.all.ts` | 1 / 1 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `editor.all.ts` | 2 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `editor.api.ts` | 1 / 2 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `editor.code.all.ts` | 1 / 4 | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `editor.main.ts` | 0 / 3 | 公开构建入口，已核对 editor.main 与 standalone 使用。 |
| `editor.worker.start.ts` | 4 / 1 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `standalone/browser/namedEditorThemeService.ts` | 1 / 1 | 人工追踪：强制颜色监听配对释放，主题切换复用已有 owner。 |
| `standalone/browser/standaloneCodeEditor.ts` | 2 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `standalone/browser/standaloneEditor.ts` | 1 / 0 | 静态语法与依赖已扫描；含资源/集合操作；未作逐行行为结论。 |
| `standalone/browser/standaloneLanguages.ts` | 1 / 0 | 静态语法与依赖已扫描；未作逐行行为结论。 |
| `standalone/browser/standaloneServices.ts` | 3 / 2 | 人工追踪：服务装配、覆盖及作用域释放。 |
| `standalone/common/namedEditorTheme.ts` | 4 / 0 | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |

</details>

## 当前结论

- 本轮验证：295 项 Playwright 浏览器测试通过；包含正则修复的 238/238 个 Editor 及相关 Workbench 单测文件通过，随后新增的缩进与 CRLF 回归连同所属两份测试文件共 19 项通过。三份 Editor 架构测试已在本轮执行并通过；最终 Stanza 和 Renderer 正常构建通过，未新增构建 warning。浏览器验证包含功能销毁取消、排队任务销毁和空匹配词语查询。保留既有 CSS 债务及测试环境 Canvas/颜色提示。全量静态检查已完成，逐文件人工行为审查仍未覆盖全部 490 个文件，不能把本次结果表述为全部 Editor 问题已经修完。

- 复制、剪切、粘贴成批统一命令目标选择：正文聚焦时操作正文，其他文本输入框聚焦时交给 DOM 命令，从外部按钮调用时恢复最近使用的编辑器焦点。只读正文允许复制，阻止剪切与粘贴。新增 50 项浏览器用例，覆盖三个命令的目标、服务读写、DOM 分发、撤销，以及外部发起的异步请求在选区、焦点、只读、组合输入、Escape、模型切换和销毁后取消；整组 82 项定向回归通过。

- 公共全选命令区分正文、普通文本输入框和活动编辑器：从外部按钮调用时选中最近使用的编辑器全文，查找框聚焦时只选中输入框文本，只读状态允许选择。两种输入模式均先复现外部调用与查找框全选无效，再从命令注册表入口验证正文选区、另一编辑器选区和输入框选区。

- 公共撤销与重做命令在 `coreCommands.ts` 绑定现有模型历史，`default:undo`、`default:redo` 共用相同实现。命令遵守实时只读状态；从外部按钮调用时作用于最近使用的编辑器，焦点位于查找等文本输入框时不修改正文。两种输入模式均先复现公共撤销无效，再通过注册表入口验证正式命令与别名、撤销与重做、只读切换和多编辑器目标。

- 查找与替换输入框的公共撤销、重做交给浏览器编辑历史处理，正文只读状态不阻止输入框自己的编辑。8 项新增浏览器回归通过真实键盘输入建立历史，以键盘撤销结果校验正式命令和别名；浏览器如何合并连续输入不由编辑器另建记录或假定。

- 公共 API 不再在模块求值时注册格式化选择策略；默认策略由 `StandaloneServiceCollection` 创建并持有，服务释放时注销，恢复宿主先前的策略。架构测试先暴露了入口职责混合，服务生命周期回归覆盖创建前后和释放后的选择结果。

- 编辑器焦点与命令目标按整条链路修正：`CodeEditorWidget` 在稳定根节点跟踪整体焦点，输入适配器只报告文本焦点；查找与替换输入之间移动不会发出整体失焦。上下文键与 `ObservableCodeEditor` 消费同一组公共事件。浏览器编辑器服务按最近使用顺序选择活动编辑器，新建未聚焦实例不抢占命令目标，移除后恢复此前使用的实例并释放焦点监听。浏览器回归已先复现从外部按钮执行复制行却修改另一个编辑器的问题。

- 文件拖放的异步提交改由编辑器状态取消机制守护。等待文件解码期间变为只读、文本变化、换模型、销毁或启动新拖放，旧请求均失效；切回可写不会恢复旧请求。进度提示与同一请求一起结束，正常文件拖放仍作为一个可撤销编辑提交。Widget 回归先复现了只读及切回可写后的过期结果问题。

- 修复多光标与 Linked Editing 的快捷键冲突：Linked Editing 使用 Ctrl/Cmd+Shift+F2，不再在捕获阶段吞掉 Ctrl/Cmd+Shift+L。浏览器测试覆盖键盘与 Action 混用、选区变化、同时输入和撤销；Linked Editing 测试覆盖 Escape 退出、F2 重新激活及不拦截匹配选择快捷键。

- 多光标输入按整条行为链收敛：上/下添加光标、选中行末添加光标、下一个匹配和全部匹配共用 `multicursor.ts` 的五个 Action。键盘入口直接运行相同 Action，两个仅转发事件的 Controller 退出；光标状态仍由现有 ViewModel 管理，选区高亮保留独立生命周期。匹配辅助操作改用 `ITextModel.findMatches/getOffsetAt/getValueInRange`，不再依赖具体模型实现。未实现的查找会话联动与其他多光标命令不计为完成。

- 诊断导航与多光标注册分别回收到 `gotoError.ts`、`multicursor.ts`，两个独立注册文件退出。诊断装饰、多光标输入和选区高亮继续由原对象承担，注册顺序不变。Suggest 注册现已回收到 `suggestController.ts`，旧注册文件退出；聊天输入框使用已有的 `suggestions: false` 关闭普通补全的自动装配，继续由聊天宿主创建专用控制器。回归测试先复现了聊天框出现两个补全组件，再验证修复后只有一个；此项不代表 Suggest 的全部上游契约已对齐。

- 批量迁移 Code Action、Hover、Sticky Scroll 的注册入口至上游对应路径 `codeActionContributions.ts`、`hoverContribution.ts`、`stickyScrollContribution.ts`。旧路径退出，bundle 保持原来的注册顺序与创建条件；控制器行为和生命周期未改。此项仅完成注册文件落位，不代表三个功能的全部公开 API 已对齐。Middle Scroll 与 Placeholder 的 `.contribution.ts` 是双方已有入口，继续保留。

- 格式化职责回收：按用户指定删除 `contrib/format/browser/formatController.ts`。请求编排、交叠处理和取消归回 `format.ts`；命令、现有键盘入口与保存钩子归回 `formatActions.ts`；`formattingEdit.ts` 继续提交编辑。贡献只注册触发入口，不再返回控制器。Widget 将原本拥有的 `IVersionedEditorWorkerClient` 注册到模型作用域，Action 通过容器取得同一实例，模型解绑时仍由 Widget 释放。`formatEditor` 是当前模型绑定的调用入口，不冒充完整上游调度 API；资源级 worker 缺口仍保留。

- 职责回收验证：旧控制器的 TypeScript 引用清零；62 项定向单测、119 项浏览器回归、Editor 对齐与类型检查、Stanza 和 Renderer 构建通过。覆盖保存模式、当前模型格式化选项、worker 实例复用与解绑释放、无模型命令、快捷键、重复请求取消、语言与模型切换、交叠处理和撤销。保留既有 JSDOM Canvas、颜色环境提示及未触及 CSS 债务。

- 格式化回归修复：先用浏览器测试确认，在选择提供者期间或取得编辑结果前改变模型语言，旧请求仍会写回文本。`FormatController` 现监听模型语言变化，复用现有取消流程；监听随请求释放。该修复不改变公开 API、提供者选择规则或文件归属，也不表示资源级 worker 和格式化器选择界面已经完成。

- 本次验证：新增两项浏览器用例修复前均失败，修复后 119 项浏览器测试通过；Editor 对齐与类型检查、Stanza 和 Renderer 构建通过。仅修改一行实现、两份测试文件及本记录，保留既有颜色环境提示和未触及的 CSS 债务。

- 2026-09-15 格式化提供者选择契约：在同路径 `format.ts` 补齐 `FormattingKind`、`FormattingMode`、`IFormattingEditProviderSelector` 和 `FormattingConflicts` 的公开契约。后注册的选择策略优先，释放后恢复旧策略；拒绝选择不继续调用旧策略。整文与选区控制器在同一取消范围内先选择再执行，保存格式化传递 `Silent`，手动命令传递 `Explicit`。选中提供者返回空结果或失败时，不再改用另一个提供者。

- 本批修改 10 个文件：选择契约、控制器、Standalone API 注册、Workbench 生命周期注册、四份行为测试和两份现有文档。Standalone 和 Workbench 当前策略均选择排序首位；默认格式化器配置和选择界面仍待补齐，不能据此宣称冲突处理产品功能完成。原签名不完整的 `getDocumentFormattingEditsUntilResult` 在生产调用退出后删除，其标准查询能力仍待资源级 worker 就绪后按真实调用需求实现。其余完整调度函数和 `formatOnType` 自动触发仍待处理，80/41 声明计数不变。

- 选择契约批次验证：57 项定向单测、117 项浏览器测试、Editor 对齐与类型检查、Stanza 和 Renderer 构建通过。覆盖策略优先级与释放、拒绝选择、指定第二个提供者、空结果不换提供者、异常报告、选择期间取消、手动与保存模式传递，以及既有多选区合并和撤销。保留既有 JSDOM Canvas、颜色环境提示及 7 份未触及 CSS 债务，生产构建无新增警告。

- 2026-09-15 选区格式化交叠结果：在现有 `FormatController` 内补齐逐范围结果的冲突合并。已完成的结果与新结果交叠时，合并它们对应的请求范围并重新查询，丢弃被替换的文本和 EOL 指令；每次合并减少一个分组，查询完成前不修改模型。批量提供者仍一次调用；单次响应自身包含非法交叠编辑时，worker 继续拒绝，不把该错误解释成可合并的多个请求。次选区变化也取消合并查询，即使提供者忽略令牌，命令仍结束等待。

- 本批没有新增公开 API 或服务；资源级 worker、格式化调度函数完整签名和提供者冲突选择仍待完成，80/41 声明计数不变。修改限定在现有控制器、六份行为测试及三份职责文档，共 10 个文件。

- 交叠结果批次验证：71 项定向单测、111 项浏览器测试、Editor 对齐与类型检查、Stanza 和 Renderer 构建通过。覆盖连续合并、旧文本与 EOL 丢弃、一次撤销、次选区取消、提供者忽略令牌、worker 非法结果拒绝和后续请求恢复；保留既有 JSDOM Canvas、颜色环境提示及 7 份未触及 CSS 债务，生产构建无新增警告。

- 2026-09-15 选区格式化入口：本批修改 10 个已有文件。`formatActions.ts` 注册 `editor.action.formatSelection` 与 Ctrl/Cmd+K、Ctrl/Cmd+F；`FormatController` 复用现有取消、worker 和编辑提交流程，使用最高优先级范围提供者，空选区按当前行处理，多选区支持批量接口与逐范围查询。选区起点变化也取消请求，所有结果一次提交并可一次撤销。`editorContextKeys.ts` 的两种格式化可用状态由 `CodeEditorWidget` 按提供者注册、注销和模型语言更新。本批没有新建服务或修改 worker 消息协议；现有 worker 实例只绑定一个模型，不能将协议没有资源字段视为当前已存在的跨模型混用缺陷。

- 本批验证：68 项定向单测、109 项浏览器测试、Editor 对齐与类型检查、Stanza 和 Renderer 生产构建、diff 检查通过。覆盖范围批量与逐条调用、空选区按行处理、只读、选区起点变化取消、一次撤销及提供者状态更新。单测仍有既有 JSDOM Canvas 提示，浏览器仍有颜色环境提示；保留未触及的 7 份 CSS 债务，生产构建无新增警告。

- 对齐边界：本批完成命令 ID、快捷键、可用状态与范围提供者调用链；尚未实现提供者冲突选择、返回编辑交叠后的合并重新查询，也未补齐资源级 `IEditorWorkerService` 与格式化调度函数的完整签名。`formatOnType` 自动触发仍待处理，80/41 声明计数不变。

- 2026-09-15 格式化查询与 worker 职责：三类 provider 补齐 `extensionId`，扩展桥接传递运行时扩展身份。新增上游同路径 `ExtensionIdentifier` 和同签名 `getRealAndSyntheticDocumentFormattersOrdered`，按整文优先、范围补充、扩展 ID 忽略大小写去重的规则查询提供者；范围提供者接收完整模型范围。提供者异常报告后继续查询，取消仍结束等待。worker 的消息编码与最小编辑计算保留最后一个 EOL 指令，控制器移除重复补回逻辑。`getDocumentFormattingEditsUntilResult` 返回值已改为 `TextEdit[] | undefined`，但参数仍缺 `IEditorWorkerService`，最小化仍由控制器调用模型绑定 client；该函数不能标为完整对齐。Ash 尚无完整资源级 worker-service 契约与实现，禁止创建同名子集服务掩盖此缺口。整体 80/41 声明计数不变。

- 格式化查询批次验证：23 项定向单测、104 项浏览器回归、对齐与类型检查、Stanza 和桌面 Renderer 构建通过。覆盖扩展去重、提供者失败后继续查询、范围提供者执行整文格式化与撤销、worker 消息往返、纯换行符和混合文本/EOL 编辑。保留既有 7 份 CSS 债务与终端颜色环境提示，构建无新增警告。

- 2026-09-15 输入格式化 provider 契约：新增 `OnTypeFormattingEditProvider`，参数为模型、位置、触发字符、选项和取消令牌，提供者必须声明 `autoFormatTriggerCharacters`。旧 `LanguageFormattingProvider/Request` 退出，三类格式化 registry 与批量注册统一使用独立公共契约；Standalone 测试覆盖触发字符、参数和注册释放。扩展协议未提供触发字符，移除扩展桥接中不完整的输入格式化注册，保留文档与范围格式化。此批未接通 `formatOnType` 自动触发链，选区格式化命令与完整上游调度仍待处理；80/41 声明计数不变。

- 输入格式化契约批次验证：31 项定向单测、103 项浏览器回归、对齐检查、类型检查、Stanza 和桌面 Renderer 构建通过。批量注册的可调用方法检查调整后，31 项定向单测再次通过。保留既有 7 份 CSS 债务和终端颜色环境提示，构建无新增警告。

- 2026-09-15 范围格式化 provider 契约：`DocumentRangeFormattingEditProvider` 归 `common/languages.ts`，registry、Standalone、App Server 和扩展桥接统一使用 `ITextModel + Range + FormattingOptions + CancellationToken`。旧 `provideRangeFormattingEdits` 及范围格式化的独立请求包装退出；App Server 从模型创建快照并拒绝模型变化后的迟到结果。移除 App Server 没有实现却注册的输入格式化 provider，批量注册测试覆盖范围专用 provider 的替换与释放。输入格式化仍保留原有契约，选区格式化命令和完整上游调度语义未在本批实现，80/41 声明计数不变。

- 范围格式化批次验证：26 项定向单测、103 项浏览器回归、对齐与类型检查、Stanza 和桌面 Renderer 构建通过。覆盖范围及选项传递、请求快照、取消、迟到结果和 provider 注册/替换/释放；未新增选区格式化 UI。保留既有 7 份 CSS 债务与颜色环境提示，构建无新增警告。

- 2026-09-15 文档格式化 provider 契约：新增 `common/languages.ts` 的 `DocumentFormattingEditProvider`，文档格式化 registry、Standalone、JSON、App Server 和扩展桥接统一使用 `ITextModel + FormattingOptions + CancellationToken`，结果接受标准 `ProviderResult<TextEdit[]>`。文档格式化不再使用 `LanguageFormattingRequest` 或独立传入的资源/语言 ID，适配器从模型创建传输快照；控制器直接传递当前请求令牌。范围与输入格式化仍使用原有契约，`LanguageFormattingProvider` 已移除文档格式化方法。26 项定向单测、103 项浏览器回归、对齐与类型检查、Stanza 和桌面 Renderer 构建通过；新增覆盖空结果、扩展请求取消及监听释放。完整上游调度签名、范围/输入格式化接口及其他贡献依赖仍待处理，80/41 声明计数不变；保留既有 7 份 CSS 债务与颜色环境提示，构建无新增警告。

- 2026-09-15 格式化职责迁移：公共 `LanguageFormattingOptions/Request/Provider` 迁入 `common/languages.ts`，registry、Standalone、公开导出和 JSON/App Server/扩展适配器同步改用公共 owner。删除 `contrib/format/common/formatCommands.ts` 和 `FormatService`；文档格式化调度由 `contrib/format/browser/format.ts` 的函数承担，取消与结果提交仍由 `FormatController` 负责。原 common 测试迁至 `test/browser/format.test.ts`，宿主测试直接验证提供者与 registry。生产文件为 599 个，同路径 401、仅 Ash 198、仅上游 332，大小写差异为 0。此批完成职责迁移，保留现有 request/AbortSignal 契约；三类标准 provider 签名、范围与输入格式化的编辑器入口及完整上游调度语义仍待处理，80/41 声明计数不变。其他 contribution 的类型反向依赖尚未迁移。

- 本次职责迁移验证：18 项定向单测、103 项浏览器回归、Editor 对齐检查与类型检查、Stanza 和桌面 Renderer 生产构建通过。定向测试覆盖取消、模型释放与版本变化、提供者顺序、请求参数、registry 替换、JSON 和 App Server 适配。既有 7 份 CSS 债务及终端颜色环境提示仍保留；本批未改 CSS，构建无新增警告。

- 2026-09-15 文档方向修正：移除“每个 contribution 从 common 文件暴露 API”、`common/services → contrib/*/common` 和“每个功能构造 model-level service”的要求；区分职责归属与运行环境限制，并在对齐技能中加入公共 registry 的类型依赖检查。当时只修改 10 份文档，代码尚未迁移：`formatCommands.ts` 混合 provider 契约与调度，`ILanguageFeaturesService` 导入 contribution 类型。此前格式化行为测试通过不代表这些职责已对齐，声明计数保持 80/41。后续按公共契约、registry、功能编排与调用方的顺序修正，不按缺失文件数扩大实现。

- 2026-09-15 格式化取消与命令入口：本批修改 11 个文件，新增上游同路径 `contrib/editorState/browser/keybindingCancellation.ts` 和 `contrib/format/browser/formatActions.ts`，并在现有 `editorState.ts` 补齐 `EditorStateCancellationTokenSource`。格式化请求在光标移动、模型变化、只读切换、Escape、重复请求和释放时传递取消信号；提供者忽略信号时，调用方也能结束等待。既有快捷键与标准 `editor.action.formatDocument` Action 共用同一控制器；bundle 显式加载 Action 和贡献注册。文本、光标和滚动仍由既有 owner 管理，无 DOM 或 CSS 改动。10 项定向单测、103 项完整浏览器回归、对齐与类型检查、Stanza 构建及 diff 检查通过；保留既有颜色环境提示和 7 份 CSS 债务。全目录为 599 个生产文件、400 个同路径、199 个仅 Ash、333 个仅上游，大小写差异为 0。完整格式化提供者调度、选区格式化及 `TextModelCancellationTokenSource` 仍未补齐，121 组声明的 80/41 计数不变。

- 本次格式化批次最终验证：100 项完整浏览器测试、Editor 对齐检查（含 Stanza 类型检查）、Stanza 生产构建和 `git diff --check` 通过。验证直接使用真实 Standalone Widget、贡献装配和 Worker；未新增单测。保留既有终端颜色环境提示与 7 份未触及的 CSS 债务，无新增生产构建警告。

- 2026-09-15 格式化调用链补齐：新增上游同路径 `contrib/editorState/browser/editorState.ts` 的 `EditorState` / `CodeEditorStateFlag`，以及 `contrib/format/browser/formattingEdit.ts` 的 `FormattingEdit`。现有 `FormatController` 在提供者和 Worker 返回后核对模型身份、版本与光标，释放后不提交；格式化编辑统一处理只读、撤销边界、滚动恢复及换行符。仅换行符变化也保留，避免被最小编辑计算丢弃。生产文本和选区仍由 TextModel / Widget 持有；未新增 DOM 或 CSS。5 项 Chromium 定向回归覆盖正常格式化、移动光标、切换模型、只读和仅换行符变更，并验证文本及换行符撤销/重做。全目录为 597 个生产文件、398 个同路径、199 个仅 Ash、335 个仅上游，大小写差异为 0；既有 121 组声明的 80/41 计数不变。EditorState 的取消令牌类与完整格式化提供者调度仍未补齐，不能据此宣称整个文件 API 或 Editor 对齐完成。

- 2026-09-15 多光标命令身份修复：交换字符在跳过非空选区或文件起点光标时保留对应命令位置，防止主选区被后续命令覆盖；行注释完成重叠行判断后恢复原选区顺序，防止主光标被换到较早的行。两个问题均先由真实 Widget 与 Chromium 用例复现，再验证选区方向、注释切换和撤销/重做。交换字符批次通过 243/243 个 Editor 单测文件；随后行注释及交换字符共 10 项定向单测、最终 95 项 Chromium 浏览器测试、结构与类型检查及 Stanza 构建通过。此前因生成协议过期导致的聊天类型编译阻塞已解除；文件和 API 台账计数不变。

- 2026-09-15 空末行复制修复：同时向下复制倒数第二行和空末行时，两条命令原先在同一点插入，导致其中一条被冲突检查舍弃。`CopyLinesCommand` 统一在源行起点插入，根据实际插入范围和复制方向恢复选区，不再保存末尾换行状态。12 项定向单测、93 项 Chromium 浏览器测试、结构与类型检查及 Stanza 构建通过；新增浏览器用例先复现少复制一行，再验证选区方向、撤销与重做。完整单测编译被 `workbench/services/chat/browser/chatService.ts` 的 `userAudioAttachment` 类型错误阻塞；定向单测继承仓库原编译选项单独编译并执行通过，不将完整单测记为通过。文件和 API 台账计数不变。

- 2026-09-15 颜色扫描与行命令评审：补齐 `common/languages/defaultDocumentColorsComputer.ts` 的 `IDocumentColorComputerTarget` / `computeDefaultDocumentColors`，将 `languageColors.ts` 中既有 Ash 字面量解析迁入该路径。生产链为 ColorPicker → ColorDetector → ColorService → DefaultDocumentColorProvider → 扫描函数；服务继续负责提供者与请求版本，扫描只消费调用方的文本和坐标。默认提供者改从请求快照计算坐标，并在无匹配时也拒绝已取消请求。复制行改用模型返回的实际插入范围恢复多光标选区；复制、重复选区、移动、排序动作分别隔开撤销记录。全目录现为 595 个生产文件、396 个同路径、199 个仅 Ash、337 个仅上游，大小写差异为 0；121 组声明的 80/41 状态不变，整体 Editor 对齐仍未完成。 验证：16 项定向测试、243/243 个 Editor 单测文件、91 项 Chromium 浏览器测试、完整结构与类型检查、Stanza 生产构建通过；保留既有 JSDOM Canvas 与终端颜色变量提示，生产构建无新增警告。

- 2026-09-15 Editor 文件命名复查：扫描全部 594 个生产文件，395 个与 VS Code 同路径、199 个仅 Ash 存在，大小写不一致为 0。仅 Ash 文件数量不作为命名错误数量。确认 `test/common/languageCompletionService.test.ts` 创建 JSDOM 与真实 CodeEditor，`test/common/cursorInsertion.test.ts` 创建 JSDOM 与 TestView，已按用户确认迁入 `test/browser/`，同步调整浏览器测试工具的相对导入；两个旧路径退出，测试断言保持不变。`test/common/viewport.test.ts` 实测 common ViewLayout，保留 common。`contrib/format` 负责代码格式化，`contrib/formatting` 负责富文档工具栏，两者不能按近似名字合并；后者命名可在工具栏职责范围内另行整理。`common/languages/completion/` 的长前缀文件和 Peek/ColorPicker 的 Editor 前缀需结合公开契约与调用方逐项处理，不作批量字符串改名。本批只迁移两份测试，未改生产代码。验证：9 项定向测试、243/243 个 Editor 单测文件、结构与类型检查及 Stanza 构建通过；既有 JSDOM Canvas 提示仍存在，未新增此类提示。

- 2026-09-15 命名整理（用户已确认）：`contrib/snippet/common/languageCompletionSnippetParser.ts` 改为 `contrib/snippet/common/snippetParser.ts`，作为 Ash 的纯解析模块继续供 common 层使用；导出统一为 `parseSnippet`、`Snippet`、`SnippetOptions`、`SnippetVariableResolver` 等名称，转换函数同步使用 `createSnippetTransform` / `applySnippetTransform`。`contrib/suggest/test/common/suggestModel.test.ts` 移至 `contrib/suggest/test/browser/suggestModel.test.ts`，对应真实 Widget 测试环境。两个旧路径退出，生产调用与测试同步迁移；本次不代表完整 VS Code Snippet API 对齐。验证：243/243 个 Editor 单测文件、86 项浏览器回归、2 个扩展调用方测试文件、结构与类型检查及 Stanza 构建通过。

- 2026-09-15 前置镜像与嵌套选项修复：普通 `$1` 镜像在完整声明解析后读取默认值，选项列表在嵌套合并与前置引用中保持完整；最终输出继续只包含实际存在的选项字段。13 项解析单测、全量 243/243 个 Editor 单测文件、86 项浏览器回归（含 3 项选项切换/撤销/重做测试）、结构与类型检查及 Stanza 构建通过。完整 Suggest/Snippet API 仍待验收。

- 2026-09-15 片段选项修复：选项、镜像与转换结果通过一次 `ICodeEditor.executeEdits` 同步修改，一次撤销即可整体恢复；当前选项从模型文本读取，撤销或重做后继续切换不会使用旧索引。17 项补全会话单测、84 项完整浏览器回归（含 2 项片段键盘测试）、结构检查、类型检查及 Stanza 构建通过。完整 Suggest/Snippet API 仍待验收；后续已按用户的修复请求，在现有 `contrib/snippet/common/snippetParser.ts` 中修复前置转换的首次展开：解析完声明后计算转换文本和最终范围，保持现有解析入口与调用方。11 项解析单测、Editor 全量 243/243 个单测文件、85 项浏览器回归、结构与类型检查及 Stanza 构建通过；该修复不改变完整 API 对齐状态。

- 2026-09-15 补全会话与 View Zone 修复：用户确认将 `contrib/suggest/common/languageCompletionSessionController.ts` 迁入 `contrib/suggest/browser/suggestModel.ts`，将 `contrib/snippet/common/languageCompletionSnippetSession.ts` 迁入 `contrib/snippet/browser/snippetSession.ts`，并删除两个旧文件。生产贡献与聊天输入统一使用 `ICodeEditor`，两个会话不再导入内部光标控制器；模型切换和编辑器释放会取消请求并释放会话。只读补全不再报告接受成功或执行后续命令，片段选项与转换遵守编辑器只读边界，Tab/Shift+Tab 结束前一个占位符的撤销组。View Zone 回调保留区域对象作为 `this`，覆盖折叠隐藏、展开恢复与滚动通知。两个恢复同路径的声明加入待处理表；这批完成依赖迁移与行为修复，不代表完整 Suggest/Snippet API 已对齐。 验证：Editor 全量单测 243/243 个文件通过；模型切换通知修正后，补全会话、聊天输入与架构共 47 项复验通过，最终浏览器 83/83 项、Electron 文件打开/编辑/保存 1 项、聊天输入 1 项、Stanza 与桌面构建通过。完整结构与浏览器检查入口通过；既有 7 份品牌替换式 CSS 仍作为债务记录，本批未改 CSS。

- 2026-09-15 命名与聊天输入评审：移除聊天实现、CSS、命令/技能补全、测试与构建配置文件名中的引擎前缀；注册表单独命名为 `chatInputEditorRegistry.ts`，实现使用 `chatInputEditor.ts`。聊天高度按编辑器末行实际底部计算，并在内容或容器尺寸变化后统一调度布局；命令补全替换完整命令词并保留参数。聊天宿主通过注入的 `ICodeEditorService` 登记/移除编辑器，恢复全局全选。`ObservableCodeEditor` 改接编辑器内容事件，布局通知只更新布局状态，避免清空折行文本时先通知内容、后更新光标导致的渲染越界。验证通过：16 项定向单测、Editor 全量 243/243 个测试文件、81 项浏览器回归、聊天尺寸/全选 Web 与 Electron 各 1 项、Electron 文件打开/编辑/保存 1 项、Stanza 与桌面构建。台账整体仍为 80/39；补全 common 会话及片段的内部光标依赖未在本批迁移。

- 2026-09-15 补全浏览器依赖批次：`SuggestController` 与 `CompletionWidget` 改为通过 `ICodeEditor.getModel/getSelections/getPosition` 读取编辑器状态，普通 contribution 与聊天输入同步传递编辑器对象。两个浏览器类不再引用内部 `CursorsController`；请求刷新重新读取当前选区并处理无模型状态。补全测试改用容器装配的真实 Widget，覆盖触发字符、提交字符、片段导航、撤销与关闭后的普通方向键导航。20 项补全/聊天定向测试、81 项浏览器测试、Electron 打开/编辑/保存 1 项、类型检查与 Stanza/桌面构建通过。common 补全会话与片段仍直接依赖内部光标控制器，View 定位及完整 Suggest API 尚未对齐，80/39 台账计数不变。

- 2026-09-15 输入装配清理：删除从未参与输入执行的语言编辑适配器、Widget 创建链与 contribution 词法上下文注入钩子。输入和回车继续由 `IViewModel.type` 进入 common cursor，`ViewController` 不再直接引用 `CursorsController`；语言分析服务仍由贡献持有并供括号匹配与章节标题使用。新增无贡献 Widget 回归覆盖补括号、成对删除、回车和撤销；全量单测 243/243 个文件、浏览器 81 项、Electron 打开/编辑/保存 1 项、Stanza 与桌面构建通过。结构台账仍为 80/39，贡献上下文其余直接内部依赖尚未完成。

- 2026-09-15 服务装配批次：`CodeEditorWidget` 通过构造注入取得主题、语言配置和语言功能服务，删除 options 中的对应服务字段、自建共享服务分支和空的 Widget 子作用域。Workbench 文件、聊天、提交信息、Embedded 与 Standalone 创建链改用宿主容器；模型挂载作用域继续拥有贡献和局部资源。`CodeEditorPane` 不再转传语言服务，Standalone 同时注入模型与编辑器服务。新增测试验证缺失服务在 Widget 创建前失败、构造器贡献与安装钩子使用同一宿主服务，以及换模型和销毁不释放共享服务。全量 Editor 单测 243/243 个文件、浏览器 81 项、聊天输入 5 项与桌面构建通过；贡献上下文、内部光标接口和其余 Widget API 仍待处理，80/39 台账计数不变。

- 公开接口修复批次保留创建时的 `wordWrap`，把滚动参数和动画查询接到现有 ViewLayout；View 区分自身同步 DOM 位置产生的通知与外部滚动，修复动画被中途取消的问题。`onDidChangeModelContent` 直接使用 ViewModel 的完整事件，旧无参数事件退出；空模型的视图状态与 View Zone 操作遵循空状态契约。Standalone 接口不再继承 Widget 实现类，Workbench 的状态与保存处理改用公开选区接口。73 项相关单测、62 项浏览器测试、结构检查、类型检查及 Renderer 构建通过；强化后的换行几何和外部滚动中断场景单独复验通过。功能上下文及服务装配的整体收拢尚未完成，声明完成计数不变。

- `setSelection` 参数批次补齐 `Range / IRange` 输入，并保留 `Selection / ISelection` 方向、显式事件来源和默认 `api` 来源。Find 的命中导航直接传入范围；测试改用真实 `CodeEditorWidget`，不再用假 Editor 绕过参数入口。Widget 与 Find 共 48 项单测、61 项 Editor 浏览器测试、Stanza 类型检查、结构检查及 Renderer 构建通过。新增回归覆盖范围输入、次光标清理、坐标约束、方向、无效参数、模型分离、键盘替换和撤销；本批未改变整体声明完成计数。
- 2026-09-13 按相对路径扫描非测试 `.ts`、`.tsx`、`.js`、`.css` 生产文件：Ash Editor 597 个，VS Code Editor 733 个；392 个同路径，205 个仅本地，341 个仅上游。
- 首次重扫发现 49 个目录大小写错误，全部来自工作区实际目录 `browser/viewparts` 与上游 `browser/viewParts` 不一致；已做两步大小写重命名，当前大小写错误为 0。
- 账目摘要：当前表格记录 121 组同名声明结构差异，已处理 80 组，剩余 41 组。只有通过文件集合、import owner、生产调用链和生命周期复核的声明才计入已处理；调试工具需明确证明其不进入生产创建链是职责本身。
- 205 个仅本地文件正在逐项分类为“错误承载，迁移并删除”或“Ash 专有”。分类完成前，不再声称不存在 import owner、重复 owner 或错放文件问题。上游存在而本地缺失的文件按原相对路径直接建立，先恢复 API 名称并独立实现逻辑，再把现有 import 迁入该 owner；同路径文件只原地修改。
- 用户已确认仅本地项的处理原则：架构文档明确归属的 Ash 专属能力按既有职责保留；与 VS Code 重叠的职责迁回对应路径。文件删除仍需在每批执行前按准确路径、原因、剩余调用方和 Git 可恢复性单独确认。
- import 集合不同不单独判错：缺少上游能力会自然缺少对应 import，本地真实扩展也会增加 import。只有同一符号从错误 owner 导入才属于路径错误。
- 输入、参数和返回类型一致不代表行为已经一致。剩余项仍需继续核对状态 owner、事件顺序、失效条件、调度阶段、坐标转换、可见副作用、失败语义和释放时机。
- `comment.ts`、`dropIntoEditorController.ts`、`dropIntoEditorContribution.ts` 与 `completionsEnablement.ts` 已有上游同路径 owner；Find contribution ID 为 `editor.contrib.findController`，drop 的 `BeforeFirstInteraction` 阶段已覆盖 `dragover` / `drop`。注释快捷键此前仍通过 `comment.contribution.ts` 使用两个旧 Controller，原先“无外部生产调用”的记录有误。现按用户要求回收重复职责：快捷键与命令共用 `comment.ts` 的 Action，读取当前注释配置，两个 Controller 和独立注册文件退出，测试迁入浏览器真实入口。Find 注册已回到 `findController.ts`，独立注册文件退出，控件及装饰生命周期保持不变。旧 `textDropController.ts` 和直接构造它的测试已删除；实际拖放由 `DropIntoEditorController` 承接，Widget 测试覆盖文本、HTML、文件解码、只读和非文本输入。`ownedCompletionsEnablement.ts`、`selectionSetTracker.ts`、`clipboard.contribution.ts` 和 `languageDiagnosticPresentation.ts` 已删除。
- Controller 初筛覆盖 contrib 下 36 个同名后缀文件：11 个上游同路径、25 个仅 Ash。文件关系不代表可删除性；已回收两个注释 Controller。括号导航、删除和匹配高亮现收敛到 `bracketMatching.ts` 的 `BracketMatchingController`，旧三个 Controller 文件退出；沿用既有模型、括号索引和装饰生命周期，快捷键与标准跳转/删除 Action 共用操作。该类仍通过 Ash contribution 装配，未完成全部上游契约。换行开关仍需核对 View 与编辑器配置的关系；诊断悬浮与异常行分隔符控制器持有 DOM 或装饰更新生命周期，不能按薄转发层直接删除。
- Editor contribution 批次已把 Placeholder、Message、Read-only Message、Cursor Undo 与 Context Menu 接入标准 `registerEditorContribution`；`transpose.ts` 与 `linesOperations.ts` 删除不存在于上游的运行时 contribution，action 直接执行标准 `ICommand`。`editorEditCommand.ts` 与 `editorCommand.ts` 已删除且残留引用为 0。Clipboard 已建立上游同路径 `clipboard.ts`，命令与菜单使用标准 `MultiCommand`，默认 copy/cut/paste 回到 TextArea/Native EditContext；URI-list 与有界文本文件粘贴迁入上游同路径 `CopyPasteController`，贡献统一进入 `registerEditorContribution`，模型配置与安装钩子由 `CodeEditorContributions` 执行。`NativeEditContext.handleWillCopy` / `handleWillPaste` 已接回标准 Clipboard action 调用链。旧 `clipboard.contribution.ts`、`clipboardController.ts` 及直接构造旧控制器的测试已删除；复制、剪切与粘贴不再保留第二套实现。
- 剪贴板行为验收确认 TextArea 与 Native EditContext 的 DOM 复制、剪切和粘贴只由聚焦输入节点处理。`clipboard.ts` 的标准贡献接管 Web Native 输入节点的键盘快捷键，Code bundle 已停止导入旧 capability 注册；多光标元数据、外部换行分发、整行复制保留列位置、关闭空选区复制，以及粘贴撤销均通过两种输入模式的真实 DOM 事件验证。浏览器对 `execCommand('cut')` 报成功却不发事件时，命令改按实际事件决定是否需要写入并删除。命令式剪切与粘贴通过 `EditorStateCancellationTokenSource` 监听模型、内容、选区、失焦、只读切换、组合输入、Escape 和释放；状态恢复也不会让旧结果生效。取消立即结束等待，迟到的系统剪贴板结果不再改动模型，操作监听随完成或取消释放。Standalone 注册唯一的 `IContextKeyService`，标准剪贴板命令可直接执行，并由编辑器建立局部上下文。
- 文件粘贴由 `CopyPasteController` 独占当前请求，复用 `EditorStateCancellationTokenSource` 与 `raceCancellation`。内容、模型、选区、只读状态、组合输入开始、Escape、后一次粘贴或销毁均取消旧请求；选区或可写状态恢复不会使旧结果重新生效。取消立即结束 `finishedPaste()` 的等待，底层文件读取仍可能继续，但结果不再写入。解码失败或超限保留原文，后续粘贴仍可正常执行；这不代表 paste-as provider 等其余上游能力已完成。
- HTML 复制现由 `ViewModel.getRichTextToCopy()` 使用模型已有 token 与颜色表生成；选区、整行和多选区沿用纯文本复制的范围，输出转义文本及可携带的颜色、字形样式。`copyWithSyntaxHighlighting` 控制默认 HTML 输出。HTML-only 粘贴由 `CopyPasteController` 复用拖放使用的 HTML 转纯文本能力，再走标准粘贴命令；转换区分块分隔与内容换行，保留连续 `<br>`、首尾换行及 `<pre>` 内空白，相邻代码块保持分行；纯文本优先、只读限制和撤销保持一致，URI-list 的空记录不再截断 HTML 处理。两种输入模式已覆盖 token 样式、部分选区、整行、多选区、关闭高亮、外部 HTML 和撤销；显式高亮复制已从系统剪贴板读回验证；强制高亮开关仅覆盖同步复制数据生成，在等待系统写入前恢复，写入成功或失败都不影响期间及后续的普通复制。Chromium 将命令 copy 事件送到 `body` 时，由该命令的短期监听使用同一份模型复制数据写入，监听随命令结束释放。旧的私有 MIME、逐选区粘贴模式和控制器专用配置随旧实现退出；当前生产入口使用 `vscode-editor-data`、`emptySelectionClipboard` 与模型换行配置。
- 行布局与软换行批次沿现有 `ViewModelLinesFromProjectedModel → ViewLayout → ViewLines` 生产链验证调整宽度、增量编辑、续行点击和模型坐标；`DOMLineBreaksComputerFactory` 对非等宽字体优先在空白处换行，并让 `wordBreak: keepAll` 避开连续 CJK 文本的优先断点，超宽内容仍按字素边界换行。本批只局部修改已有浏览器测量文件，没有新增投影 owner 或 CSS。
- 可见行复用批次让同路径 `ViewLayer` 与其覆盖行 owner `ViewPartRows` 只调整视口增减的 DOM 子节点，不再在每次滚动时重挂全部行。Chromium 验证重叠行从未脱离文档、节点身份和文字更新保持正确、离屏与编辑器释放均断开旧节点；没有改动 ViewLines 的公开契约或 CSS。
- 光标与 gutter 行为验收沿现有 `ViewModel` 坐标转换和 `ViewLayout` 几何，核对软换行、相对行号、glyph 锚点、焦点、移动与增量编辑。Chromium 场景和既有 owner 测试通过；`ViewCursors`、`LineNumbersOverlay`、`GlyphMarginWidgets` 的生产职责与 DOM/CSS 本批保持不变。
- ViewPart 根节点批次将 `Margin`、`Minimap`、`OverviewRuler`、`ViewCursors` 和 `ViewLines` 的外部 DOM 访问统一到各自上游 `getDomNode()` 入口；内部节点不再额外公开。`Margin` 恢复 `OUTER_CLASS_NAME = 'margin'` 与独立 `glyph-margin` 背景层，沿用 Ash 的滚动和尺寸计算，未修改或复制 CSS。`ViewLines` 的公开成员差异归零，并接通 `ViewModel → ViewRevealRangeRequestEvent → ViewLines` 的纵向与延迟横向 reveal；`CodeEditorWidget.revealRange` 不再绕过事件链直接调用 `View`。View 释放阶段不再由组合输入和 overtype 清理回调触发已释放 Part 的重绘；Widget、Minimap、视区、光标和 ZoneWidget 共 34 项相关测试通过。
- View Zone 批次把 `ViewZones` 的公开成员差异归零，`changeViewZones` 只通过 `ViewModel.changeWhitespace` 改动标准空白区，CodeLens、ZoneWidget 与鼠标抑制链不再使用并行 zone handle 或 ViewLayout zone API。真实 Chromium 验证高度、最小宽度、移除、gutter 横向固定和释放；编辑器根尺寸及 Minimap、OverviewRuler、输入层、scrollbar 的定位回到各自现有 Ash DOM/CSS owner，没有引入 Monaco class 或变量。
- Widget 端口批次把 `ViewContentWidgets` 与 `GlyphMarginWidgets` 的公开成员差异同时归零。Content Widget 构造只接收标准 `ViewContext + FastDomNode`，配置、模型坐标、失效和释放均由 Part 自己读取；`suppressMouseDown` 进入 `MouseHandler` 的真实焦点/默认事件链。Glyph Margin 的 add/layout/remove API 已从 `ICodeEditor → CodeEditorWidget → View → GlyphMarginWidgets` 接通，构造只接收 `ViewContext`，标准模型 decoration 与 caller widget 按 line、lane、z-index 选出 winner。
- Decoration owner 批次恢复了标准 `DecorationsOverlay(ViewContext)`：它只读取 `RenderingContext.getDecorationsInViewport()`，处理整行、普通、collapsed、换行填充、z-index 与逐行片段；`View` 在任一 Part 因模型 decoration 事件需要重绘时统一执行投影。Diagnostics、Color Picker、Debug、Quick Diff、Bracket、Anchor、Selection Highlight、Find、Unicode、异常行终止符与 Word Highlight 均写入标准模型 decoration options，生产 View、Widget 与 Workbench 不再接受或聚合 `DecorationSource`。旧定义只剩无生产调用的仅本地文件，待按删除确认规则处理。
- 标准边栏与块装饰批次把 `Margin`、`LinesDecorationsOverlay` 和 `BlockDecorations` 的构造器、公开成员及布局输入收敛到 `ViewContext + EditorLayoutInfo + RenderingContext`。Folding 与 Symbol Icons 已移除 `DecorationSource` 注册并直接写标准模型 decoration options；真实 Chromium 验证 Rust syntax provider、折叠、符号图标、标准 line/block decoration 以及横向滚动后的固定 gutter。Workbench 文本模型服务在创建 `TextModel` 时设置真实 resource 和语言，显式语言优先，其次 MIME、路径与首行；`CodeEditorPane` 不再另算一份语言。
- Injected Text 批次接通 `TextModel.getLineInjectedText → ViewModelLines → ViewLineData → ViewLine → MouseTarget`。无换行模式不再跳过 injection projection，行 token、inline class、model/view 坐标和 `attachedData` 使用同一 `ModelLineProjectionData`；Color Picker swatch 因此通过标准 before decoration 渲染并从鼠标目标读取 marker，不再按附近坐标猜测颜色。`DynamicCssRules` 的 owner/ref 释放顺序也已闭合，Color Picker、软换行装饰、语义 token、指针命中、ViewModel 与动态 CSS 聚焦测试通过。
- 鼠标目标批次建立 `editorDom.ts` 的标准页面/客户区/编辑器相对坐标和可释放事件工厂，`MouseTargetFactory` 直接生成公开 `IMouseTarget`，不再发布仅本地的中间 target 类型。`MouseHandler(ViewContext, ViewController, IPointerHandlerHelper)` 统一处理指针、拖动、drop、context menu 和选择分发；Folding、Debug 与 Color Picker 均消费编辑器公开鼠标事件，相关 DOM 监听及单次拖动会话由可释放 owner 持有。
- 越界拖选批次把同路径 `dragScrolling.ts` 原地改为 `DragScrolling`、`DragScrollingOperation`、`TopBottomDragScrolling` 与 `LeftRightDragScrolling` owner；`MouseHandler` 只生成标准 `OUTSIDE_EDITOR` target，并按轴启动或停止对应 operation。每帧通过 `ViewLayout` 滚动、同步 render、重新命中边缘位置并使用 `NavigationCommandRevealType.None` 扩选；返回编辑器、pointerup、cancel、blur、布局变化或释放都会清理当前 operation 和动画帧。
- 光标批次先修正 `RenderingContext → IViewLines` 的坐标端口：DOM 与 GPU 行几何统一接收视图行范围，选区、装饰、内容小组件、组合输入和双向文字调用方在边界处明确转换。`ViewCursor` 与 `ViewCursors` 的公开成员差异已归零；`ViewCursors` 只持有光标 DOM、配置和闪烁状态，组合输入范围改由 `CompositionController` 写入标准模型 decoration，再由普通装饰渲染链投影。光标 CSS 使用 Ash 主题变量和动画名，未新增 Monaco 名称。
- 光标状态 owner 批次继续收口 `CursorsController`：文档 `undo` / `redo` 已从该控制器公开面移除，浏览器输入与 26 个相关测试文件直接进入 `TextModel` 历史；自动闭合记录改为控制器内部实现，不再作为测试或跨文件 API。仅测试调用的 `beginComposition → CompositionSession` 平行实现也已退出，组合输入只保留生产 `startComposition → compositionType → endComposition` 链；成员差异由 12 项降至 8 项。剩余 read-only、cursor-only history 与事件入口仍依赖尚未完成的 ViewModel/contribution 迁移，因此本声明继续留在待处理表。
- 输入与选区端口批次继续沿现有生产链收口，而没有按上游缺失文件横向铺开：`View → ViewController → IViewModel` 统一读取和提交选区，TextArea、Native EditContext、ScreenReaderSupport 与 CompositionController 不再直接依赖 `CursorsController`；Anchor Select、In-place Replace、Line Selection、Selection Highlighter 以及 14 个只读写选区的 contribution controller 已改用 `ICodeEditor` 或 `IViewModel`。当前 Editor 生产代码有 16 个文件引用 `CursorsController`，扣除 `cursor.ts` 与 `viewModelImpl.ts` 两个 owner 后还有 14 个外部调用方；剩余文件涉及编辑事务、光标历史、只读事件、仅 Ash 文件或尚未闭合的装配链，本批不强行迁移，也不新增上游外围文件。
- Native 辅助阅读端口批次把 `ScreenReaderSupport` 的公开成员差异从 9 项收敛为 0，并把 `IScreenReaderContent` 收敛为标准的 cut、paste、focus、configuration、content 和 scroll 六个入口：简单内容 owner 直接实现现有分页镜像、DOM 选区监听与映射和滚动行为，富内容 owner 继承这些入口并只覆盖自身 token/bracket DOM 渲染，没有添加只调用 `super` 的包装方法。系统 `selectionchange` 只在内容聚焦期间由当前 simple/rich content 持有，经过 `ViewController.setSelection` 回到唯一 ViewModel owner；内容切换、失焦和释放会同步释放监听，`ScreenReaderSupport` 不再读取内容内部 DOM 选区状态。`EditorConfiguration` 现在是 page size 与 rich/simple 选择的唯一配置 owner，Widget、ViewController 和 EditContext 不再传递第二份构造快照；运行时切换会由一个可替换资源 owner 释放旧内容并保持焦点与当前模型投影。装饰、flush、行、滚动和空白区变化仍由 `NativeEditContext` 自身的 ViewPart 事件决定重绘，再在 `prepareRender` 统一同步内容；构造时强制内容模型、ViewModel 与 Viewport 使用同一 `TextModel`。本批保持 Ash 现有 DOM child 和布局 owner，没有改动 CSS、DOM 层级或上游外围文件。
- Cursor Undo 端口批次把 `CursorStateChangedEvent` 的 primary/secondary selection、旧 selection、模型版本、来源和原因完整投影为标准 `ICodeEditor.onDidChangeCursorPosition` / `onDidChangeCursorSelection`。同路径 `cursorUndo.ts` 只记录同版本 selection 事件并在模型变化时清空有界历史；同路径 `linkedEditing.ts` 改由 `ICodeEditor` 读取 selection 和订阅位置事件，不再直接依赖内部 selection controller。上游已有而本地缺失的 `contrib/cursorUndo/test/browser/cursorUndo.test.ts` 已原路径建立并独立覆盖状态恢复与模型失效。
- Overview Ruler 批次把 `DecorationsOverviewRuler` 的公开成员差异归零：标准光标事件、配置/主题/滚动失效、`prepareRender` 读取阶段和显式释放进入同一 `ViewPart` 生命周期；装饰 lane、光标标记、边框、DPR 与隐藏光标配置由同一 canvas owner 绘制。`editorOverviewRuler.border/background` 已进入 Ash 主题注册表，高对比度边框和透明背景不依赖 Monaco CSS。`EditorScrollbar` 已通过 `SmoothScrollableElement` 连接现有 `Scrollable`，构造接口、DOM/overview ruler 挂载、滚轮与指针委托进入生产调用；显隐、轨道/滑块尺寸、分页点击、滚轮配置和零尺寸焦点由基础控件处理。浏览器验证覆盖这些入口与主题切换，Editor 类型检查和构建通过。箭头配置（双轴启用与尺寸）和 inertialScroll 已接入基础控件：箭头支持点击、长按、键盘与边界禁用，轨道扣除箭头占用；连续像素滚轮输入可衰减续滚，反向输入替换方向，键盘/指针、配置变化、尺寸变化和释放取消续滚。新增 Chromium 回归验证长按释放、运行时移除、焦点、高对比度、边界、续滚衰减与销毁；本批编辑器浏览器测试 20 项、基础滚动条单测 7 项及 Stanza 构建通过。后续设备判断改为记录连续输入与固定步长，在灵敏度和轴映射前分类，并防止边界处同一滚轮事件重复处理。对 VS Code `6a932e0f957` 的 9 组、581 条设备事件，在相同单位下运行双方分类逻辑，分类结果全部一致；未复制上游实现或样本到 Ash。新增独立 Chromium 回归覆盖大幅整数像素输入、固定步长、非整数步长、设备切换及边界重复事件，编辑器浏览器回归 21 项通过，Electron UI 布局 2 项通过，桌面构建通过。更新本地 App Server 打包产物以解决协议版本 5/7 不匹配后，真实文件的 Electron 滚轮、Home/End、滑块拖拽场景通过（1 项）。后续已修复大段文本输入卡住渲染进程的问题：CursorsController 将连续普通字符合并提交，保留空格撤销边界、语言字符拦截与覆盖输入行为；ScreenReaderSupport 在编辑结束后的同步阶段读取最终选区，避免布局变化期间读取旧选区越界。新增长文本替换、撤销重做，以及多光标下批量输入与逐字输入等价性回归；输入相关单测 42 项、编辑器浏览器回归 22 项、真实 Electron 大段替换后保存并继续输入场景 1 项通过，渲染器构建与自动化测试类型检查通过。尚未完成整体 VS Code 同场景滚动曲线与布局运行对照，因此本项继续保留在待处理表，不把分类结果一致计为全部行为对齐。仅本地 `workbench/contrib/debug/browser/debugBreakpointDecorations.ts` 没有生产调用方、本批未修改，也没有被接入该链。
- 滚轮响应后续批次修复 `SmoothScrollableElement` 对连续像素输入误用平滑动画，以及亚像素位移在整数视口中正反方向不一致的问题：设备分类仍在灵敏度之前，普通连续输入立即提交，离散滚轮保留平滑动画；灵敏度计算后将非零位移向远离零的整数取整。Playwright 新增真实编辑器回归覆盖连续输入、双轴亚像素、低灵敏度与离散滚轮动画，修复前首个即时位置断言失败，修复后通过。另将双方现有控件直接构建到临时目录，在同一 Chromium 中执行 6 次输入（12、12、0.2、-0.2、40、40）；将上游 50px 与 Ash 40px 的步长比例归一后，即时位置、目标位置和 160ms 后位置全部一致。本批专用检查（`--test=browser`）通过，含 307 项浏览器回归、Editor 类型检查和结构审计；渲染器构建及真实 Electron 滚轮、键盘和滑块拖拽回归 1 项通过。此证据只覆盖该输入序列，不代表全部设备分类、惯性曲线和布局已经对齐。
- GPU 渲染只保留标准 `ViewportData + ViewLineOptions → cell buffer → atlas storage/texture` 链，旧 `GpuFrame`、逐 glyph vertex frame 和 `IStyled*` 接口已删除。`View` 唯一持有 `ViewGpuContext`，`ViewLines` 自己投影 GPU 行 DOM 状态；`BaseRenderStrategy` 只保留标准抽象和事件生命周期，完整文件与视口策略分别在自身文件编码 cell，不再通过 base 的额外成员共享实现。canvas 继续标记为 `aria-hidden`，颜色由 Ash 主题快照进入共享 atlas；canvas、行层和 gutter 只补充 Ash 自有布局规则，没有复制上游 CSS 或引入 Monaco class。
- Language Features Registry 批次保留现有 provider 请求、版本门禁和 App Server/Extension Host 适配逻辑，只把单一 `formattingProvider` 拆成标准 `documentFormattingEditProvider`、`documentRangeFormattingEditProvider` 与 `onTypeFormattingEditProvider` 三个独立 owner，并把 `parameterHintsProvider`、`semanticTokensProvider` 分别迁为 `signatureHelpProvider`、`documentSemanticTokensProvider`。Standalone、Format/Parameter Hints contribution、ModelService、BrowserTextModelService、Workbench JSON、App Server 与 Extension Host 共 15 个文件已改接，旧字段生产引用为 0；两个同名声明的成员差异分别由 19/20 降至 11/12。paste/drop、range semantic tokens、inline values、evaluatable expression 与 new symbol names 当前没有闭合的生产消费者，未添加空 Registry。

## 处理规则

1. 同名、同职责且本地能力完整时，恢复上游名称、参数、返回值、owner 和调用链。
2. 本地职责与上游同名声明不同，且它确实是 Ash 专有能力时，移出上游 owner 或改成明确的本地名称；不保留别名、包装入口或重复导出。
3. 缺少基础模型、视图上下文或服务契约时，从基础 owner 向调用方逐层实现，不在下游伪造同名接口。
4. `editor` 可以依赖 `base` 和 `platform`；`common` 不能依赖 DOM，`browser` 才能使用 DOM，依赖方向不能反转。

## 已处理的同名契约

| 文件 | 声明 | 结果 |
| --- | --- | --- |
| `browser/controller/editContext/native/debugEditContext.ts` | `DebugEditContext` | 构造入口、状态代理、事件包装、调试开关和边界标记职责与上游一致；该类型只用于手动诊断，明确不进入生产输入创建链，所有标记使用调用方 document 并从无障碍树隐藏，定向测试覆盖状态、事件、开关与清理 |
| `browser/controller/editContext/clipboardUtils.ts` | `IClipboardPasteEvent` | 字段、构造行为和外部数据转换与上游一致；生产调用由 TextArea/Native EditContext 默认消费并保留 `onWillPaste` 拦截点，Observable Editor 继续发布同一事件；浏览器测试覆盖 metadata、外部数据转换和默认粘贴 |
| `browser/controller/editContext/clipboardUtils.ts` | `IClipboardCopyEvent` | 公开成员与上游归零；事件在输入上下文中生成选区文本、来源范围、富文本和内存元数据，TextArea/Native EditContext 在拦截器未处理时写入标准数据并执行剪切；浏览器测试覆盖复制、剪切、多选区、整行和系统剪贴板回退 |
| `browser/controller/editContext/clipboardUtils.ts` | `createClipboardCopyEvent` | 五参数入口与上游一致；由 `ViewContext` 读取配置和选区并负责标准剪贴板数据及元数据写入，旧的无模型事件入口已删除，生产调用只经过两个输入实现 |
| `browser/controller/editContext/textArea/textAreaEditContextInput.ts` | `TextAreaInput` | 标准 `ITextAreaInputHost`、焦点、键盘、type、composition、selection 和 clipboard 事件均由唯一 textarea DOM owner 发布，普通文本与组合替换统一进入 `ITypeData`，系统选区与屏幕阅读器状态仍由同一 owner 映射并释放。失焦后不可取消的 `beforeinput` 不再发出 type，迟到的 `compositionstart` 不重建组合状态，copy/cut/paste 不再读取旧选区或提交编辑；上游 `_initializeFromTest` 没有生产职责，`dispose` 由 `Disposable` 基类继承，不添加空包装；本地 wrapper 方法和 raw before/input 事件服务于现有单 owner，不为形似上游另拆私有 wrapper 类图 |
| `browser/controller/editContext/native/nativeEditContextUtils.ts` | `FocusTracker` | 构造契约恢复日志服务、目标元素和焦点回调三个参数；生产日志依赖从编辑器服务容器经 `CodeEditorWidget` 和 `View` 进入原生输入，Standalone 明确注册空日志实现。测试覆盖焦点、失焦、暂停恢复、Shadow DOM、日志与监听释放 |
| `browser/services/codeEditorService.ts` | `ICodeEditorOpenHandler` | 由 `AbstractCodeEditorService` 按新注册优先顺序调用，首个返回编辑器的处理器终止链路；单项释放只移除对应处理器，测试覆盖继续查找、短路和释放 |
| `browser/services/codeEditorService.ts` | `ICodeEditorService` | 公共成员差异归零；代码与差异编辑器的创建、加入和移除由各 Widget 的真实生命周期触发，打开处理器、资源模型属性、临时模型属性、装饰类型和当前编辑器均由同一浏览器服务提供，Workbench 差异窗格与快速差异视图使用同一服务实例 |
| `browser/services/abstractCodeEditorService.ts` | `AbstractCodeEditorService` | 抽象层只持有跨宿主共享的编辑器注册表、处理器链、资源属性、临时属性和装饰类型；当前编辑器由具体浏览器宿主持有；临时属性按 URI 与模型销毁释放，装饰样式按引用计数和服务生命周期释放，测试覆盖事件顺序、资源身份、父子装饰与释放 |
| `browser/stableEditorScroll.ts` | `StableEditorScrollState`、`StableEditorBottomScrollState` | 参数收敛到 `ICodeEditor`；滚动位置、内容高度、可见范围和行坐标由 `CodeEditorWidget` 持有，CodeLens 在增删 Widget 前后使用同一编辑器恢复顶部或底部锚点，测试覆盖首末可见行、光标相对位置和真实 Widget 几何 |
| `browser/observableCodeEditor.ts` | `observableCodeEditor` | 单参数入口直接接受 `ICodeEditor`，同一编辑器始终返回同一 facade，编辑器销毁时同步释放并移出缓存 |
| `browser/observableCodeEditor.ts` | `ObservableCodeEditor` | 公共成员与上游归零；模型、版本、选区、焦点、组合输入、键入、粘贴、布局、滚动、内容尺寸、装饰和 Widget 均通过 `ICodeEditor` 观察，不再读取 `CodeEditorWidget.view` 或 `viewport`，3 项测试覆盖响应式更新、行坐标、装饰所有权与销毁 |
| `browser/view/viewUserInputEvents.ts` | `ViewUserInputEvents` | 公开回调、构造参数、事件类型和静态目标转换入口与上游一致；鼠标事件由 `MouseHandler` 解析为视图坐标，经 `ViewController` 转发后在此统一转换为模型坐标，Widget 不再另建 DOM 监听链；测试覆盖普通 target、View Zone 嵌套坐标和真实 Widget 事件发布 |
| `browser/controller/mouseHandler.ts` | `MouseHandler` | 构造参数、protected/public 成员和 `ViewEventHandler` 生命周期与上游一致；生产链通过 `EditorMouseEventFactory`、`EditorPointerEventFactory`、`MouseTargetFactory` 和 `IPointerHandlerHelper` 发布标准 `IMouseTarget`，不再生成或二次翻译仅本地 target。鼠标 pointer ID 与 `mousedown` 点击次数由 `PointerHandler` 合并；释放时只发布一次 MouseUp，兼容事件仍能补齐丢失的 `pointerup`。拖动会话、全局监听、捕获与 ViewContext 注销随实例释放；owner 和 Chromium 用例覆盖文本、边栏、View Zone、Widget、Injected Text、drop、Folding、Debug、拖选与释放 |
| `browser/controller/dragScrolling.ts` | `DragScrolling` | 同路径文件保留上游抽象 owner、`start` / `stop` 生命周期及上下/左右 operation 拆分；生产由 `MouseHandler` 根据 `IMouseTargetOutsideEditor` 轴向调用，滚动、同步 render、边缘命中、RTL 行首尾和 `dispatchMouse` 形成闭环。operation 由可替换资源持有，重复位置更新不重建，停止与释放取消后续动画帧；直接生命周期测试和真实 Widget 双轴拖选测试覆盖调用链 |
| `contrib/zoneWidget/browser/zoneWidget.ts` | `ZoneWidget` | 恢复 `IOptions`、`IStyles`、`OverlayWidgetDelegate`、`ZoneWidget` 及其子类扩展点；独立实现通过 `ICodeEditor` 持有模型锚点、视图区、布局、滚动、选区与释放，Peek、Call/Type Hierarchy、跳转结果和 Quick Diff 均传递真实编辑器对象，定向测试覆盖换行锚点、布局、缩放、样式和选区保持 |
| `contrib/wordHighlighter/browser/textualHighlightProvider.ts` | `TextualMultiDocumentHighlightFeature` | 由语言能力服务统一注册单文档与多文档文本高亮 provider；多编辑器共享同一服务时按引用计数持有注册，不再维护重复的模型 target 表，provider 直接使用 `ITextModel.uri` 返回跨文档结果，Word/Selection Highlighter 7 项测试覆盖 Unicode、语义优先、多文件、取消和导航 |
| `common/cursor/cursorColumnSelection.ts` | `ColumnSelection` | 人工检查：列选择按 UTF-16 列号裁剪；混合 Tab/宽字符时的可视矩形语义需真实交互验证。 |
| `common/cursor/cursorMoveOperations.ts` | `MoveOperations` | 公开成员差异归零；17 个标准移动入口直接使用 `CursorConfiguration`、`ICursorSimpleModel` 与 `SingleCursorState`，旧 `navigate` 总入口及全部调用已移除。键盘控制器按命令调用标准入口，删除、输入、转置与行操作使用标准位置 API；定向测试覆盖水平、垂直、可视列余量、原子缩进、空行、行/文档边界以及真实 Widget 连续键盘导航 |
| `common/cursor/cursorMoveCommands.ts` | `CursorMoveCommands`、`CursorMove` | 15 个标准命令入口、参数元数据、方向、单位和解析契约的公开差异归零；实现直接使用真实 `IViewModel`、模型/视图光标状态及坐标转换。键盘、行选择和多光标生产调用统一进入该 owner，指针选区合并与行尾多光标辅助逻辑分别回到 `ViewController` 和 `multicursor.ts`；契约测试锁定公开面，真实 Widget 与 contribution 测试覆盖连续垂直移动、重复 caret 归一化和行选择 |
| `common/cursor/cursorWordOperations.ts` | `WordOperations` | 公开成员差异归零；标准 classifier、移动、删除、词内删除、词段、选词和 `getWordAtPosition` 由同路径 common owner 实现，并同时导出标准 `WordPartOperations`。浏览器双击/拖选、平台词移动和 `beforeinput deleteWord*` 均改接该 API；旧 `getWordSelectionRange`、`getTextWordRanges` 及浏览器自算词边界已移除，common 与真实 Widget 聚焦测试覆盖调用链 |
| `common/cursor/cursorCollection.ts` | `CursorCollection` | 公开成员、primary-first 状态、last-added cursor、tracked marker 生命周期、重叠归一化和 model/view selection 投影与上游职责一致；生产由 `ViewModelImpl → CursorsController` 直接构造并持有，模型 flush 重建 collection，单命令执行先移除 secondary cursors，定向测试覆盖归一化、位置 tie、flush 与释放 |
| `common/cursor/oneCursor.ts` | `Cursor` | 公开成员、model/view 双状态、tracked selection 与折行坐标转换进入 `CursorCollection` 的生产生命周期；marker 缺失或停止跟踪时明确失败，不再返回可能过期的 selection，定向测试覆盖 marker 恢复与释放 |
| `contrib/colorPicker/browser/colorPickerModel.ts` | `ColorPickerModel` | 公共成员、颜色与 presentation 事件、切换和释放生命周期与上游一致；生产由 Color Picker controller 创建并由 dialog 消费 |
| `contrib/folding/browser/foldingDecorations.ts` | `FoldingDecorationProvider` | 公共配置与装饰事务由该 provider 持有；生产链从 Folding Model 经编辑器所有者写入 TextModel，再由标准 line/block/minimap ViewPart 渲染，释放时只清理对应编辑器的装饰；折叠背景、占位符和控制图标颜色由主题 token 持有，测试覆盖配置、所有权、折叠状态和 DOM 输出 |
| `standalone/browser/standaloneEditor.ts` | `createModel`、`getModel`、`getModels`、`setModelLanguage` | 公共模型边界使用 `ITextModel`；`createModel` 委托 `standaloneCodeEditor.ts::createTextModel`，未显式给语言时按 URI 和首行推断，显式语言优先；模型注册、查询、语言事件和释放由 Standalone 测试覆盖 |
| `common/viewLayout/lineHeights.ts` | `CustomLineHeightData` | 构造参数、公开字段和 `fromDecorations` owner 与上游一致；生产由 `ViewModelImpl` 转换模型装饰，再交给 `LinesLayout`，测试覆盖视觉范围转换与配置行高倍率 |
| `common/model/pieceTreeTextBuffer/pieceTreeTextBuffer.ts` | `PieceTreeTextBuffer` | 实现 `common/model.ts` 的 `ITextBuffer` 契约；独立红黑树实现负责 1-based 查询、原子编辑与逆编辑、搜索、内容事件、BOM/EOL、快照和释放；单个码元查询不物化整行，测试覆盖跨 chunk 代理对与树不变量 |
| `common/model/pieceTreeTextBuffer/pieceTreeTextBufferBuilder.ts` | `PieceTreeTextBufferBuilder` | 保持 Builder → Factory 两阶段 owner；跨 chunk 连接 CRLF 与代理对，按主导换行选择 EOL，并把 `finish(false)` 的保留换行语义传给主缓冲区 |
| `common/services/model.ts` | `IModelService` | 人工检查：公开类型、请求参数及依赖方向；此文件不持有运行时资源。 |
| `common/model.ts` | `ITextModel` | 同名成员差异归零；模型统一持有装饰事务和 owner 查询、外部 undo/redo 入口、token/语言配置/字体/行高事件以及 ViewModel 注册生命周期，27 项测试覆盖事务回滚、事件顺序、所有者隔离、历史负载和释放 |
| `common/services/modelService.ts` | `ModelService` | 人工追踪：模型创建/注销、资源唯一性、配置失效、文本/EOL 更新及历史恢复；关闭模型缓存随服务释放的清理待验证。 |
| `common/viewLayout/lineHeights.ts` | `LineHeightsManager` | 由 `LinesLayout` 唯一持有默认行高和自定义行高范围；重叠范围取最大高度，插删行移动或收缩范围，5 项测试覆盖累计高度、范围变更和装饰转换 |
| `common/viewLayout/linesLayout.ts` | `LinesLayout` | 文件只保留行高、纵向几何与空白区职责；视区编排移回 `viewLayout.ts`，生产由布局 owner 调用，3 项直接测试与 11 项布局测试覆盖批处理、坐标、插删行、视图区间和空白区查询 |
| `standalone/browser/standaloneEditor.ts` | `create` | 创建并返回同一个 `StandaloneEditor` 实例；贡献和主题绑定完成后才由代码编辑器服务登记并触发创建事件，回调可立即使用或释放该实例。释放时从服务移除，仅隐式创建的模型随编辑器释放；Standalone 单测与真实 Chromium 输入、注册、DOM 和释放用例覆盖 |
| `standalone/browser/standaloneEditor.ts` | `getEditors` | 直接读取代码编辑器服务持有的 `ICodeEditor` 实例，`onDidCreateEditor` 回调也使用同一公开类型；与 `create` 共享对象身份和释放时机，Standalone 测试覆盖双编辑器登记、共享模型和独立释放 |
| `browser/viewParts/viewLines/viewLineOptions.ts` | `ViewLineOptions` | 公开成员差异归零；从计算后的编辑器配置和主题类型生成不可变行渲染快照，由 `ViewLines` 持有并在配置变化时比较后通知已渲染行；段落方向、制表宽度和 GPU 输入不再错误归入该类型，定向测试覆盖全部快照字段、相等比较与调用链 |
| `browser/gpu/atlas/textureAtlas.ts` | `TextureAtlas` | 删除本地 styled atlas 分支；页面查找、子像素键、空闲预热、清空事件、用量预览和统计统一由标准 atlas owner 持有，生产帧只调用标准 token metadata 入口 |
| `browser/gpu/atlas/textureAtlasPage.ts` | `TextureAtlasPage` | 删除页面 `index` 和 styled glyph API；页面以标准四元缓存键持有 OffscreenCanvas、glyph 顺序、版本与使用区域，页索引由 atlas 数组位置决定 |
| `browser/gpu/atlas/textureAtlasShelfAllocator.ts` | `TextureAtlasShelfAllocator` | 直接实现标准 `ITextureAtlasAllocator`，接收 `IRasterizedGlyph` 并输出不含本地 `advance` 字段的标准 glyph；预览与像素统计由 allocator 持有 |
| `browser/gpu/atlas/textureAtlasSlabAllocator.ts` | `TextureAtlasSlabAllocator` | 直接实现标准 `ITextureAtlasAllocator`，按 OffscreenCanvas 分配标准 glyph 并保留 slab 粒度与溢出语义；不再依赖 styled raster 接口 |
| `browser/gpu/raster/glyphRasterizer.ts` | `GlyphRasterizer` | 构造输入恢复字体大小、字体族、设备像素比和 decoration cache；公开成员、token metadata、颜色表、子像素偏移与复用 glyph 契约归零，atlas 为唯一生产调用方 |
| `browser/gpu/viewGpuContext.ts` | `ViewGpuContext` | 公开成员差异归零；`View` 唯一创建并挂载 `FastDomNode` canvas，`ctx`、共享 `device` / `deviceSync`、共享 atlas、物理尺寸、DPR 与 contentLeft 均由标准 owner 提供，RectangleRenderer 直接消费 observable；主题更新清理共享 decoration/atlas 状态，窗口级 device 在 pagehide 释放。GPU 定向测试覆盖 canvas/ARIA、observable 更新、handler/ResizeObserver 释放和 rectangle/ruler 调用链 |
| `browser/gpu/rectangleRenderer.ts` | `RectangleRenderer` | 公开成员与 `draw(ViewportData)` 契约归零；该 owner 自行清屏、写入布局与滚动 uniform、提交 rectangle pass，并在释放时注销 `ViewContext` 事件监听 |
| `browser/gpu/renderStrategy/baseRenderStrategy.ts` | `BaseRenderStrategy` | 人工检查：已通读入口、公开数据和同步状态变化；未发现本轮可复现缺陷。 |
| `browser/gpu/renderStrategy/fullFileRenderStrategy.ts` | `FullFileRenderStrategy` | 标准 `ViewportData` 更新写入文档行定位的 cell storage buffer，滚动偏移扣除 `bigNumbersDelta`，绘制从对应文档实例起点开始；配置、装饰、token、行映射和行变化统一失效 |
| `browser/gpu/renderStrategy/viewportRenderStrategy.ts` | `ViewportRenderStrategy` | 标准 `ViewportData` 更新写入视口 cell storage buffer，容量按视口增长并通过 `onDidChangeBindGroupEntries` 重建 bind group；滚动与全部视图失效事件接入同一 owner |
| `browser/viewParts/viewLinesGpu/viewLinesGpu.ts` | `ViewLinesGpu` | 构造入口、公开成员与上游归零；生产只消费 `View` 持有的 `ViewGpuContext`，上传 glyph metadata/atlas、调用标准策略并提供 GPU 行几何，不再创建 context、修改兄弟 Part DOM 或公开本地失效入口 |
| `browser/viewParts/viewLines/viewLines.ts` | `ViewLines` | 公开成员差异归零；根节点只通过 `getDomNode()` 暴露，标准 reveal 事件使用未来视口计算纵向位置，并在目标行进入 DOM 后完成横向 reveal。范围与位置几何按标准接收视图坐标，软换行不再被当成模型行；`CodeEditorWidget.revealRange` 已改经 `ViewModel` 发布事件，定向测试覆盖普通、居中滚动和软换行光标/装饰 |
| `browser/viewParts/viewZones/viewZones.ts` | `ViewZones` | 公开成员差异归零；标准 `IViewZoneChangeAccessor` 只在回调生命周期内有效，新增、重排和移除统一进入 `ViewModel.changeWhitespace`。模型到视图坐标、隐藏区、高度、最小宽度、DOM top 回调和鼠标抑制由同一 owner 持有；CodeLens 与 ZoneWidget 只调用编辑器公开 `changeViewZones`。33 项相关单测和真实 Chromium 几何/释放场景通过；零像素/零行高度允许收起，新增两个 Standalone Chromium 用例验证展开、移动、收起、块装饰与光标几何及删除 |
| `browser/viewParts/viewCursors/viewCursor.ts` | `ViewCursor` | 公开成员差异归零；光标样式、宽高和字体从计算配置读取，位置使用视图选区，token 展示在边界转换回模型坐标；完整字素、软换行、双向文本和行尾空光标仍由独立实现渲染 |
| `browser/viewParts/viewCursors/viewCursors.ts` | `ViewCursors` | 公开成员差异归零；只持有配置、焦点、只读、组合输入事件、光标 DOM 和可释放闪烁计时器。组合输入范围由 `CompositionController` 写入标准模型 decoration，不再通过 View 和 ViewCursors 的额外公开入口投影 |
| `browser/view/dynamicViewOverlay.ts` | `DynamicViewOverlay` | 人工检查：已通读短模块的入口、边界及返回值；未发现本轮可复现缺陷。 |
| `browser/viewParts/currentLineHighlight/currentLineHighlight.ts` | `CurrentLineHighlightOverlay` | 公开构造和成员契约归零；正文与边栏覆盖层共享 `ViewContext` 的配置、焦点、选区、换行坐标和释放链，主题系统提供聚焦、失焦及高对比度颜色，组件 CSS 负责状态投影。定向测试覆盖焦点、选区与正文/边栏 class，真实 Chromium 验证自定义主题切换和高对比度边框 |
| `browser/viewParts/rulers/rulers.ts` | `Rulers` | 公开成员差异归零；配置与字体变化从 `ViewContext` 读取，滚动尺寸变化触发重绘，DOM 标尺节点按数量稳定复用并随 Part 释放；CSS 使用 Ash 类名与主题 token，定向测试覆盖配置、几何、颜色、节点复用和释放 |
| `browser/viewParts/rulersGpu/rulersGpu.ts` | `RulersGpu` | 公开成员差异归零；CPU 与 GPU 路径共享同一标尺配置和主题颜色，GPU 矩形按设备像素比与文字起点更新、按数量复用并随 Part 释放，定向测试覆盖配置、主题切换、缓存和释放 |
| `browser/viewParts/blockDecorations/blockDecorations.ts` | `BlockDecorations` | 公开成员差异归零；独立 Part 读取可见装饰并持有稳定块级 DOM，配置、滚动、装饰和 View Zone 事件进入统一渲染链，组件 CSS 使用实际 Ash 类名且不拦截输入；测试覆盖块级几何、节点复用、可访问性属性和布局变化 |
| `browser/viewParts/margin/margin.ts` | `Margin` | 构造器和公开成员与上游一致；只从 `EditorLayoutInfo` 读取 content、glyph、line-number 与 decoration 几何，`View` 不再维护第二份 gutter 测量。Ash 宿主的横向滚动补偿和 CSS 变量由同一布局快照写入，真实 Chromium 验证滚动后 margin 仍固定 |
| `contrib/middleScroll/browser/middleScrollController.ts` | `MiddleScrollController` | 构造入口恢复为 `ICodeEditor`，由标准 editor contribution 注册表在首次交互前安装；滚动只通过编辑器公开位置 API，配置在触发与动画帧读取，窗口监听、动画帧和装饰节点随 contribution 释放，定向测试覆盖首次交互实例化、横纵滚动、键盘/指针结束和无障碍隐藏 |
| `browser/view/viewOverlays.ts` | `ViewOverlays` | 公开成员差异归零；动态 overlay 由同一 `Disposable` 链持有，释放时子层先释放再清除引用，真实 Widget 创建与销毁测试覆盖 DOM 和 Part 生命周期 |
| `browser/viewParts/lineNumbers/lineNumbers.ts` | `LineNumbersOverlay` | 公开成员差异归零；配置、主光标、文本行、滚动、View Zone 和行号装饰事件均进入 margin overlay 失效链，行号配置不再保留构造时快照；真实 Widget 测试覆盖相对行号随光标变化以及运行时关闭行号后的内容和 gutter 几何 |
| `browser/viewParts/selections/selections.ts` | `SelectionsOverlay` | 公开成员差异归零；配置、光标、装饰、文本行、滚动和 View Zone 事件均触发选区几何重算，逐行输出仍只由 `ContentViewOverlays` 持有且释放时清空缓存；真实 Widget 测试覆盖选区变化后的 DOM 投影 |
| `browser/viewParts/whitespace/whitespace.ts` | `WhitespaceOverlay` | 公开成员差异归零；`renderWhitespace` 从计算配置动态读取，selection 模式只在光标变化时失效，配置、装饰、文本行、滚动和 View Zone 变化进入同一覆盖层；真实 Widget 测试覆盖 selection → all 运行时切换和空白字符数量 |
| `browser/viewParts/indentGuides/indentGuides.ts` | `IndentGuidesOverlay` | 公开成员差异归零；模型 guide part 通过 ViewModel 提供缩进深度和活动范围，括号树提供最小缩进列；ViewPart 持有像素几何。配置、光标、装饰、语言、换行、文本、滚动和 View Zone 事件进入同一失效链。主题笔画、空白行、独立颜色池、折叠和输入均有真实 Widget / Chromium 验证 |
| `browser/viewParts/linesDecorations/linesDecorations.ts` | `LinesDecorationsOverlay` | `_getDecorations` 恢复为子类可扩展的 protected owner；生产仍从统一 Decorations overlay 读取可见装饰，装饰视口测试覆盖行侧 lane、软换行和更新投影 |
| `browser/viewParts/marginDecorations/marginDecorations.ts` | `MarginViewLineDecorationsOverlay` | `_getDecorations` 恢复为 protected owner；诊断严重度、边栏 DOM 与 hover 均沿 Decorations → Margin overlay 链投影，现有装饰和诊断 hover 测试覆盖 |
| `browser/viewParts/scrollDecoration/scrollDecoration.ts` | `ScrollDecorationViewPart` | 删除本地公开 `domNode`，恢复 canonical `getDomNode()`；View 和测试均改接该入口，阴影几何、配置变化、ARIA presentation 和释放行为通过定向测试 |
| `browser/viewParts/overviewRuler/decorationsOverviewRuler.ts` | `DecorationsOverviewRuler` | 公开成员差异归零；标准光标、装饰、配置、主题、滚动和 View Zone 事件进入同一失效状态机，`prepareRender` 读取模型 decoration 后由 canvas owner 绘制 lane、光标和主题边框；canvas 保持 `aria-hidden`，29 项配置、主题、几何和投影测试通过 |
| `browser/viewParts/contentWidgets/contentWidgets.ts` | `ViewContentWidgets` | 公开成员差异归零；标准配置、装饰、flush、line mapping、行增删、滚动和 View Zone 事件进入同一 Part 失效链，构造只接收 `ViewContext + FastDomNode`。Content Widget 的测量、定位、overflow root、鼠标抑制和释放由该 owner 持有，真实 Widget API 与 Chromium 几何场景通过 |
| `contrib/codelens/browser/codelensController.ts` | `CodeLensContribution` | 公开成员差异归零且 contribution ID 恢复为 `css.editor.codeLens`；显式 `dispose()` 取消当前请求、清理模型和 Widget 引用，CodeLens provider、缓存、解析、命令与释放 7 项测试通过 |
| `contrib/message/browser/messageController.ts` | `MessageController` | 公开成员差异归零并通过标准 `registerEditorContribution` 延迟创建；消息使用编辑器公开 Widget、光标、模型和鼠标事件，ARIA alert、可见 Context Key、Markdown 链接、blur timer 与释放均由同一实例持有；只读消息调用链测试覆盖显示、关闭和释放 |
| `contrib/placeholderText/browser/placeholderTextContribution.ts` | `PlaceholderTextContribution` | 公开成员差异归零并通过标准 contribution 注册表 eager 创建；占位文本、空模型、配置、字体和布局只从 `ICodeEditor` 与 `observableCodeEditor` 读取，Overlay Widget 随 contribution 释放；真实 Widget 测试覆盖空/非空切换、padding 和 content 几何 |
| `contrib/multicursor/browser/multicursor.ts` | `SelectionHighlighter` | `ID` 与 `dispose()` 恢复且实际拆成 `editor.contrib.selectionHighlighter` owner；释放后清空装饰并移除选区/模型监听，3 项定向测试覆盖文本匹配、策略和释放后不再更新 |
| `browser/widget/codeEditor/codeEditorContributions.ts` | `CodeEditorContributions` | 所有贡献共用注册表、延迟调度、显式读取和释放；配置钩子在 View 创建前运行，安装与 Quick Diff 构造在对应阶段运行。Context Menu 依赖 `ICodeEditor` 和平台菜单服务，Clipboard 默认输入职责属于 EditContext；Widget 测试覆盖模型切换、安装失败后重绘和共享数据的模型作用域注入 |
| `common/cursor/cursorTypeOperations.ts` | `TypeOperations` | 10 个公开入口的成员和签名差异归零；Tab 区分部分选区、跨行选区与纯空白行，每个光标按自身语言配置构造自动闭合命令，组合输入替换局部窗口或选区并把结束结果交回同一组合历史修订。生产调用覆盖 `CursorsController`、`ViewController` 与文本 drop，定向测试覆盖输入、粘贴、缩进、覆盖模式、组合环绕、多光标、语言配置和一次撤销 |

## 尚未补齐的同名契约

下表第一部分保留此前的处理说明，便于追查错误判断；这些结论已经撤回，表内所有声明都需要按对应 owner 切片继续迁移。三个 Render Strategy 的路径已从错误的 `gpu/raster` 修正为上游实际的 `gpu/renderStrategy`。

| 文件 | 声明 | 此前结论（已撤回） |
| --- | --- | --- |
| `browser/controller/editContext/editContext.ts` | `AbstractEditContext` | 已进入 `ViewPart` 生命周期并统一剪贴板事件、输入路由和组合输入状态；键盘输入先由补全等 `onWillKeydown` 消费者处理，再向公共按键事件和导航控制器传递。失焦后的 `beforeinput`、键盘命令和新组合会话不进入模型事务；Widget 与 Chromium 验证正常 Enter/撤销、候选改写一次撤销、Escape/失焦取消和迟到事件拒绝；抽象层其余公开成员差异仍待收敛 |
| `browser/controller/editContext/native/nativeEditContext.ts` | `NativeEditContext` | 已进入 `View` 的 Part 生命周期，接入 `ViewContext`、视图事件、预渲染几何读取、渲染写入、按编辑器 ID 注册及跨 document 重新挂接；`handleWillCopy` / `handleWillPaste` 已由标准 Clipboard action 调用。无生产消费方的本地 `onDidSelect` 已退出；主元素和 IME textarea 的键盘事件都在当前 DOM owner 转为标准 `IKeyboardEvent`，Native `textupdate` 在组合期间转成 `ITypeData` 后进入唯一组合历史；失焦时拒绝迟到的 `textupdate`、`compositionstart` 和 copy/cut/paste，并恢复浏览器文本窗口。内部 `onDidComposition*` 名称保留用于避开 `ViewPart` 渲染生命周期方法，浏览器缓冲区和辅助阅读器的其余成员契约仍待收敛 |
| `browser/controller/editContext/native/screenReaderContentRich.ts` | `RichScreenReaderContent` | 已恢复公开名并由 `ScreenReaderSupport` 实际选择；标准内容入口由简单内容基类继承，富内容类只保留 token/bracket DOM 渲染差异，没有为成员报告添加空转发方法。运行时配置切换会创建当前实现并释放旧内容；构造契约仍待收敛 |
| `browser/controller/editContext/native/screenReaderContentSimple.ts` | `SimpleScreenReaderContent` | 已恢复公开名并实际承担简单无障碍镜像；标准 cut、paste、focus、configuration、content 和 scroll 入口已由生产 `ScreenReaderSupport` 调用。聚焦期间的 `selectionchange` 监听、节流、DOM offset 映射和释放已回到当前内容 owner，再通过 `ViewController.setSelection` 更新唯一 ViewModel 选区；分页、滚动和精确 UTF-16 快照保持原实现。构造依赖已收敛为 FastDomNode、ViewContext、ViewController 与 accessibility service 四个角色，但本地内容 child 与上游输入节点并非同一 DOM owner，因此仍待最终核对 |
| `browser/controller/editContext/native/screenReaderSupport.ts` | `ScreenReaderSupport` | 公开成员名差异已归零；由 `NativeEditContext` 持有，焦点、配置、剪切、粘贴与光标进入标准内容入口，其余 ViewPart 变化直接触发 `prepareRender` 内容同步。`EditorConfiguration` 已成为 page size 与 rich/simple 选择的唯一配置 owner，动态重建由单个可替换资源持有并释放旧内容；Support 不再持有 document selection listener，也不读取内容内部 DOM 选区状态。Ash 现有分页、DOM child 和布局 owner 保持不变，并验证 Context、ViewModel 与 Viewport 共享同一模型。构造签名仍待收敛，因此继续留在待处理表 |
| `browser/controller/editContext/textArea/textAreaEditContext.ts` | `TextAreaEditContext` | 已由 `View` 持有，接入 `ViewContext`、视图事件、渲染阶段、按编辑器 ID 注册、`getTextAreaDomNode` 和真实输入调用链；屏幕阅读器内容只由该 host 计算，系统选区请求通过 `TextAreaInput.onSelectionChangeRequest → ViewController.setSelection` 返回唯一 ViewModel。Clipboard、键盘、type 和 composition 都只中继 `TextAreaInput` 的标准语义事件，不再重复解析 DOM 载荷；内部 composition 接缝继续使用 `onDidComposition*`，因为同名的 `ViewPart.onCompositionStart/onCompositionEnd` 已属于渲染生命周期。文本窗口与其余输入成员契约仍待收敛 |
| `browser/viewParts/overlayWidgets/overlayWidgets.ts` | `ViewOverlayWidgets` | 拥有小组件 DOM、配置驱动的溢出与布局策略、最小内容宽度和生命周期；仅保留本地渲染调度依赖 |
| `browser/view/viewController.ts` | `ViewController` | 已移除 `layout`、焦点、ARIA 和辅助阅读器转发入口，只保留命令、组合输入协调、输入事件桥接和 `dispatchMouse` 选区策略；输入实例仍需从 Controller 构造阶段完全移回 `View` 后，才能继续删除其余错位公开成员 |
| `browser/viewParts/gpuMark/gpuMark.ts` | `GpuMarkOverlay` | 已由 View 接入 MarginViewOverlays，跟随 GPU 能力变化更新标记；样式使用 Ash 警告色，浏览器验证开关字体连字后的标记更新与主题颜色 |
| `browser/viewParts/decorations/decorations.ts` | `DecorationsOverlay` | 构造器、公开成员和标准模型 decoration 渲染职责与上游一致；只从 `RenderingContext` 读取视区 decoration，由 `ContentViewOverlays` 持有，生产 View 不再装配第二套 source overlay |
| `browser/viewParts/editorScrollbar/editorScrollbar.ts` | `EditorScrollbar` | 已恢复公开名并接入 `ViewPart` 事件与释放链 |
| `browser/viewParts/glyphMargin/glyphMargin.ts` | `GlyphMarginWidgets` | 构造只接收 `ViewContext`；共享 `DecorationToRender`、`LineDecorationToRender`、`VisibleLineDecorationsToRender` 与 `DedupOverlay` 供标准 model decoration 和 caller widget 使用，不再读取 browser source |
| `browser/viewParts/minimap/minimap.ts` | `Minimap` | 已恢复公开名并接入 `ViewPart` 事件与释放链 |
| `browser/viewParts/overviewRuler/overviewRuler.ts` | `OverviewRuler` | 已接通标准 `IOverviewRuler`：`CodeEditorWidget.createOverviewRuler → View.createOverviewRuler → OverviewRuler`，canvas、zone manager、layout、DPR/lineHeight 更新及 context 注销均由该 owner 持有 |
| `browser/viewParts/viewLines/viewLine.ts` | `ViewLine` | 类成员名差异归零；单行独立持有 DOM、字符映射、宽度缓存、等宽假设校验和范围测量，调用方不再读取内部文本节点；渲染参数签名仍需随标准 `ViewportData` 输入继续收敛 |
| `browser/widget/diffEditor/diffEditorWidget.ts` | `DiffEditorWidget` | 本地只读虚拟化审阅面板改为 `EditorDiffWidget` |
| `browser/widget/multiDiffEditor/multiDiffEditorWidget.ts` | `MultiDiffEditorWidget` | 本地多文件审阅面板改为 `EditorMultiDiffWidget` |
| `common/services/languageService.ts` | `LanguageService` | 已按上游契约对齐 |
| `common/services/languageFeatures.ts` | `ILanguageFeaturesService` | 本地 provider 集合契约改为 `IEditorLanguageFeaturesService` |
| `common/services/languageFeaturesService.ts` | `LanguageFeaturesService` | 本地 provider registry 改为 `EditorLanguageFeaturesService` |
| `common/viewLayout/viewLayout.ts` | `ViewLayout` | View Zone 的并行 map、`addViewZone` / `changeViewZone` / `removeViewZone` / `getViewZoneLayout` 已删除，标准 whitespace 同时决定纵向空间和最小内容宽度；仍多出 `layout`、`lineCount`、`onDidChange`、`setLineHeight`、`setViewportSize` 及两个零基行坐标入口，需等待 View/Widget 调用方迁完后收敛 |
| `common/cursor/cursorTypeEditOperations.ts` | `TypeWithoutInterceptorsOperation` | 只拥有无拦截输入的编辑构造；结果选区由标准 `ICommand` 收集和 `CursorsController` 事务归一化，不再依赖仅本地编辑命令协议 |
| `common/cursor/cursorTypeEditOperations.ts` | `AutoClosingOvertypeOperation` | 只根据自动闭合来源和当前位置构造覆盖命令；多光标、完整字素和物理行边界由本地行为测试直接验证，不要求复刻上游私有执行阶段 |
| `contrib/colorPicker/browser/colorPickerWidget.ts` | `ColorPickerWidget` | 已回到对应路径并拥有挂载、控件事件和释放；保留 Ash 的颜色模型与展示，构造器和其余上游公开接口仍未全量对齐 |
| `contrib/peekView/browser/peekView.ts` | `PeekViewWidget` | 已回到对应路径并拥有标题、Escape 和关闭事件，导航 / 层级 / Quick Diff 接通释放；Ash 的内容容器与布局接口继续保留，未实现上游全部标题栏能力 |
| `contrib/codeAction/browser/codeActionController.ts` | `CodeActionController` | 同路径贡献负责本地 Code Action 菜单；内容变化只在菜单拥有焦点时恢复所属输入节点，避免共享模型的另一编辑器抢焦点。菜单的其余公开契约仍待 Code Action 分部验收 |
| `contrib/codelens/browser/codelensWidget.ts` | `CodeLensWidget` | 当前已使用 `CodeLensWidget` 名称；其余公开契约仍待按生产调用方逐项验收 |
| `contrib/colorPicker/browser/colorDetector.ts` | `ColorDetector` | 已恢复上游公开名；颜色 provider 结果写入标准 before decoration，动态 class ref 先于 CSS owner 释放，注入 marker 由标准鼠标目标读取 |
| `contrib/find/browser/findController.ts` | `FindController` | 标准查找 / 替换动作及快捷键接通原控件；其余公开契约仍待分部验收 |
| `contrib/folding/browser/folding.ts` | `FoldingController` | 普通、递归、全部、1–7 级及手动范围动作接通原折叠状态；fold / unfold 的层数、方向与指定行参数、命令元数据和参数校验已接通。配置条件、多选区、组合键取消、范围策略与数量上限已验证；公开状态与 provider 契约仍待核对 |
| `contrib/inlayHints/browser/inlayHintsController.ts` | `InlayHintsController` | 请求失效及四种 enabled 模式已接通；完整行内布局与其他展示选项仍待验收 |
| `contrib/inlineCompletions/browser/controller/inlineCompletionsController.ts` | `InlineCompletionsController` | 自动建议开关、只读切换、trigger / commit / hide 命令已接通；完整模型、视图与交互公开契约仍待核对 |
| `contrib/stickyScroll/browser/stickyScrollController.ts` | `StickyScrollController` | 文件职责、来源请求、候选行、命令、语法着色、行号、折叠图标与定义交互已接通；标准定义查询归属、高度事件消费方和上游同场景验证仍待核对，见 Sticky Scroll 记录 |
| `contrib/suggest/browser/suggestController.ts` | `SuggestController` | 标准 `editor.action.triggerSuggest` 与快捷键进入现有请求和会话；其余补全公开契约仍待分部验收 |

### 原待处理项

| 文件 | 声明 | 分类 |
| --- | --- | --- |
| `browser/view.ts` | `View` | 根节点已从仅本地 `element` 迁为标准 `domNode`，40 余个 Editor/Workbench 调用方全部改接；焦点、Widget 焦点、ARIA、辅助阅读器、强制渲染、行宽缓存与 `onWillCopy` / `onWillCut` / `onWillPaste` 已回到该 owner。输入实例当前仍由 Controller 构造回调建立，需继续迁回 `View` 后再计为完成 |
| `browser/widget/codeEditor/codeEditorWidget.ts` | `CodeEditorWidget` | 已接通标准 editor contribution 注册表与滚动、配置 API；`setModel`、`onWillChangeModel`、`onDidChangeModel` 和模型装饰事件沿同一 Widget 的可替换模型资源生效，根 DOM、注册身份、外部 Widget 与装饰集合句柄保持稳定，旧 View/worker/贡献/监听释放。`setValue` 直接进入模型重置，同值写入也发布新版本；Standalone 处理隐式模型所有权，单测及 Chromium 验证共享模型、输入、焦点、事件、空模型、错误恢复与释放。Widget 仍有其他公开成员差异，按对应行为分部继续处理 |
| `common/cursor/cursor.ts` | `CursorsController` | 内部光标入口已收口：只有 cursor.ts 与 ViewModelImpl 引用该类，浏览器、贡献和 Widget 均使用 ICodeEditor / IViewModel。保留 Ash 的模型历史与光标事件实现；其余 8 项成员差异继续单独核对，不为减少差异添加转发方法。 |
| `common/cursor/cursorDeleteOperations.ts` | `DeleteOperations` | 4 个公开入口的成员边界比较为 0，已恢复 `CursorConfiguration`、`Selection[]`、`ICommand`、`EditOperationResult` 和自动闭合范围语义；浏览器删除、语言成对删除与剪贴板剪切均通过 `CursorsController.executeCommands` 进入模型事务，连续同向删除由 `pushUndoStop` 和 `EditOperationType` 控制撤销边界 |
| `common/model/textModel.ts` | `TextModel` | 1.1–1.5 已验收：编辑范围按 UTF-16 边界约束，失败不留半次提交；同值重置推进版本，快照可读，undo/redo 恢复选区；行 ID 预检和普通、结构文档映射已覆盖。创建时的大文件分级尊重设置，整份读取受堆预算限制而快照可继续读取。其余公开成员与私有 owner 仍待随其他分部核对 |

| `contrib/suggest/browser/suggestModel.ts` | `SuggestModel` | 补全会话迁入浏览器层并消费 `ICodeEditor`；模型切换取消请求，只读接受无副作用。完整触发、请求调度与公开事件契约仍需按补全部分验收 |
| `contrib/snippet/browser/snippetSession.ts` | `SnippetSession` | 片段导航、选项和转换经 `ICodeEditor` 执行，Tab/Shift+Tab 保持独立撤销边界；完整片段合并、插入选项与公开契约仍待验收 |

## 当前已验证能力

- 当前 80 项严格完成项均已进入生产调用链并核对 owner 与生命周期，或属于已验证不会进入生产创建链的诊断工具；“类名已改名”“成员数量相同”或“本地实现能工作”都不作为完成依据。
- Standalone 模型创建现在由 `standaloneCodeEditor.ts::createTextModel` 统一决定语言：显式语言优先，否则读取 URI 与第一行；Model Service 仍是模型注册、查询、语言事件和释放 owner。
- Code 模式入口只加载行式编辑 bundle，Academic 模式入口只加载文档格式与协作 bundle；独立浏览器入口验证真实 pane 中的贡献激活、模式隔离和销毁。Academic 工具栏与重复成员操作的监听由贡献持有并释放，销毁后的异步成员结果不再更新 DOM。
- 同一 `CodeEditorWidget` 已支持 `setModel` 切换与 `null` 拆除，`View` 复用 Widget 拥有的稳定根 DOM；每次挂接的 ViewModel、View、worker、输入和贡献由模型资源集合释放。Observable facade 重绑内容与装饰，调用方 Widget 和装饰集合句柄继续可用；Standalone 在切走隐式模型后释放它。完整 Widget 公开成员仍待按视图、输入和宿主行为分别验收。
- `IClipboardPasteEvent`、`ColumnSelection`、`ColorPickerModel` 已分别通过真实输入、鼠标列选和 Color Picker 生产调用链复核。
- `cursorColumns.ts`、`base/common/charCode.ts`、`base/common/uint.ts` 已作为后续 Cursor 迁移的同路径基础能力落地；它们不计入 119 项完成数。
- `ITextModel` 的公开成员、内部历史入口和 ViewModel 生命周期已对齐；`TextModel` 现在唯一持有 decoration range、owner 隔离、模型部件事件与 tokenization/bracket pairs 调度。实现类仍需继续统一私有 owner，因此 `TextModel` 声明本身尚未计入完成数。
- `LineNumbersOverlay`、`SelectionsOverlay`、`WhitespaceOverlay` 与 `IndentGuidesOverlay` 的公开成员差异归零；配置不再由各 Part 保存构造时快照，`CodeEditorWidget` 的标准配置 API 驱动 `EditorConfiguration → ViewModel → ViewContext`，模型 tabSize 与语言配置变化也进入对应视图事件。

## 待处理 owner 顺序

| 顺序 | 所有权切片 | 当前问题 | 闭环条件 |
| --- | --- | --- | --- |
| 1 | Platform 配置与语言身份 | 配置注册表已由标准 `Registry.as(...Extensions.Configuration)` 唯一持有，24 个配置声明、服务与 UI 调用文件不再导入并行 `ConfigurationsRegistry` 单例；配置节点/默认 override、Modes Registry、语言实例 Registry 和语言配置 Registry 仍未形成完整上游链，现有语言配置服务有 28 个生产调用方 | 继续统一标准配置节点和 override，再迁移语言身份和语言配置调用方，删除旧 owner |
| 2 | TextModel parts | `ITextModel` 成员、模型部件事件和 ViewModel 注册链已闭合；实现类仍保留 Ash 文档块、行身份与历史能力，并与上游私有阶段存在差异 | 明确这些 Ash 能力在同一 TextModel 内的长期边界，继续统一基础模型私有 owner，不为私有常量或字段制造同名壳 |
| 3 | ViewModel 与 Cursor | 选区、输入、组合输入与命令均走 ICodeEditor / IViewModel，Widget 内部执行器入口已删除；光标类的其余成员差异仍保留 | 仅在存在实际消费者时补公开契约，保留唯一光标与历史 owner |
| 4 | ViewContext、ViewPart 与 View | 输入实现已经进入 ViewPart；DOM/GPU 行几何、覆盖层和模型事件由现有链统一管理；构造及公开成员仍有上游差异 | 按真实输入、布局和辅助阅读行为验证，避免复制上游私有 DOM 结构 |
| 5 | CodeEditor Widget 与服务 | 模型挂接、贡献释放、动作作用域和 Diff/MultiDiff 入口均已接通；完整 Widget 和服务 API 仍有范围差异 | 随实际调用方补充尚缺公开行为，保留稳定编辑器身份和模型引用归属 |
| 6 | GPU 与 Editor contribution | GPU 绘制与行几何链已接通；Peek、颜色、Rename、Quick Fix 等现有功能链完成本轮修正，其余上游功能未因此自动实现 | 按现有功能的请求、控件和服务 owner 验证；未引入的新能力单独定范围 |

## 历史验证记录

以下为历次批次的原始结果，包含当时失败和已被后续修复的判断。当前统计、构建状态和待处理边界以本文开头及同名契约表为准，不把历史失败当作当前阻塞。

- 文件集合审计：395 个同路径、0 个大小写错误、199 个仅本地、338 个仅上游；Ash 594 个生产文件，VS Code 733 个。该结果只说明路径集合，不说明同路径文件的职责和 API 已一致。
- 121 项账本：80 项已处理、41 项待处理、总计 121 个唯一声明。
- `tsconfig.test.json` 编译通过；`MoveOperations` 的 17 个标准入口通过 12 项定向行为测试，真实 `CodeEditorWidget` 连续向下移动测试证明短行后的可视列余量能够恢复。`tsconfig.json --noEmit` 仍只报既有 Electron、Embedded Editor、BrowserView、Workbench 与 TextMate 基线错误，本批文件无新增类型错误。
- Editor 浏览器测试 TypeScript 已编译通过；GPU Chromium 用例通过，证明 WGSL pipeline、Rectangle clear pass、ViewLinesGpu load pass、编辑与 undo 的真实帧链可用。本批 Widget、pointer、decoration 与 CodeEditorWidget 相关 40 项单测全部通过；Decoration owner 本批另有 25 项聚焦单测通过，真实 Chromium 验证标准 inline、whole-line、collapsed decoration 的非零几何和删除重绘。View Zone 场景精确验证 4 行 × 18px + 500px 空白区高度、1200px 最小宽度及移除后恢复，Widget 场景验证 Content Widget 非零几何、Glyph Widget 跨行迁移、模型 decoration z-index winner 和释放。全量浏览器入口仍有既有 Academic 多行键入、旧 token/语法分析断言和旧 minimap slider 断言，不通过兼容文件恢复退场 API。
- Editor 完整单测运行到 882 项时为 845 项通过、11 项失败；`codeEditorPane.test.js` 挂起约 4 分钟后终止，后续 26 项被取消。失败覆盖 Cursor Undo/Redo、Folding、Join Lines、输入事件次数、占位符几何、字体配置和换行符等既有基线，本批 4 个定向用例均通过。
- 当前行高亮的 Widget 行为测试和主题 token 测试通过；真实 Chromium 验证普通主题下聚焦/失焦背景分别读取对应 token，高对比度主题使用 `1px` 语义边框。Editor 根 DOM 和组件 CSS 已统一使用 `.stanza-editor`，不再依赖上游产品 class，并由架构测试守住该边界。完整设计 token 门禁仍被范围外 `multiDiffEditorPane.css` 使用未注册的 `--ash-widget-background` 阻断，本批新增变量均已注册。
- 本轮 `findController`、canonical comment actions、canonical drop 事件与 controller、completion enablement 共 19 条定向断言通过；`tsconfig.test.json --noEmit` 通过。整份 `codeEditorWidget.test.ts` 仍有既有 placeholder 几何 1px 波动，相关 drop / shared-event 3 条测试按测试名独立通过。
- View overlay、行/边栏装饰、Scroll Decoration、CodeLens、Message 和 Selection Highlighter 本轮共 23 条定向断言通过；成员审计的精确项由 12 增至 19，差异项由 63 降至 56。泄漏审计确认 DOM 监听均走可释放入口，重复 blur timer 改为单实例持有。
- View DOM owner、焦点/ARIA、Suggest、Clipboard、CopyPasteController、CodeLens、Selection/Word Highlight 与 Linked Editing 共 60 条相关断言通过；`tsconfig.test.json --noEmit` 和 Stanza 类型检查通过。文件/API 扫描与账本校验在本批结束时复跑。本批没有修改 CSS。
- 本批 `typecheck:stanza`、`tsconfig.test.json` 和浏览器测试 TypeScript 编译通过；模型 language/resource owner 4 项聚焦测试通过。Chromium 的 Rust syntax/diagnostics/folding/symbols、gutter 顺序与横向滚动固定、标准 line/block decoration 三个场景全部通过。本批没有修改 CSS。
- 鼠标目标批次的 Stanza 类型检查、测试类型检查和测试编译通过；坐标/指针、Widget、Context Menu、Middle Scroll、Color Picker、CodeLens、Folding 与 Debug 共 56 项聚焦测试全部通过。统一检查器当时确认对应账本、文件集合、diff 和生成文件检查通过；CSS ownership 子进程因当前大工作区 diff 超出其默认缓冲区报 `ENOBUFS`，无 diff 的全文件检查确认 55 个 CSS 中不存在上游原样副本或 `monaco-editor` 产品根。本批未修改 CSS。完整 browser 入口当前为 7/15，通过项和失败项继续按既有基线分别处理，失败仍集中在 Academic 多行输入、undo、18/20px 光标断言、旧 diagnostics/minimap/gutter/overview-ruler DOM 断言及 GPU folding marker。
- 本轮光标历史 owner 批次的 `tsconfig.test.json` 与 Stanza 类型检查通过；common、composition、自动闭合和 contribution 聚焦测试 179 项通过。另一个 Suggest Widget 布局断言在本批 undo 调用之前失败（期望 `68px`、实际 `24px`），不通过恢复 `CursorsController.undo/redo` 掩盖。统一成员检查确认 `CursorsController` 只剩 9 项差异；CSS ownership 审计仍因当前大工作区 Git 输出触发 `ENOBUFS`，本批没有修改 CSS。
- Cursor Undo 端口批次的 Stanza 与测试类型检查通过；Cursor Undo、Linked Editing、Message、Inline Completions、Observable Editor 和真实 CodeEditorWidget 共 43 项聚焦测试通过，覆盖完整 cursor event、同版本 undo/redo、模型变化失效和下游事件消费。本批没有新增交互、快捷键、焦点目标或视觉表面，既有 `Ctrl/Cmd+U` 键盘路径保持不变，无需新增 accessibility help 或样式。
- Overview Ruler 批次的 Stanza 与测试 TypeScript 编译通过；成员比较从 3 项差异降为 0，配置、装饰 canvas、标准 zone geometry 和主题共 29 项聚焦测试通过。本批没有修改 CSS；canvas 继续从无障碍树隐藏，没有新增焦点目标、快捷键或可操作控件。包含 User Theme 的扩展定向集合仍有 2 个既有颜色序列化断言失败（旧断言期望十六进制 alpha，当前返回 `rgba()`；序列化后的 `rgba()` 又未被 parser 接受），失败行未在本批修改。
- 本轮 `TypeOperations`、组合会话和模型历史修订共 66 项定向测试通过；覆盖模式组合结束与组合环绕均在一次撤销内恢复原文。CSS ownership 审计工具已能处理当前大工作树，并只报告 9 个未触及的 branding-equivalent 历史债务，没有新增上游品牌引用或本批阻断项。
- 输入与选区端口批次的 Stanza 类型检查和 `tsconfig.test.json` 编译通过。三组精确 Node 运行分别为 17、33、67 项通过，其中 history 的 13 项在两组中重复执行；覆盖 ViewModel owner、Anchor Select、Line Selection、CodeEditorWidget、TextArea/Native EditContext、组合输入、word delete、in-place replace、选区事件和模型历史。真实 Chromium 的公开输入/撤销/保存链及无障碍契约 2 项通过。结构门禁仍为 392 个同路径、0 个大小写错误、205 个仅本地、337 个仅上游；CSS 审计没有新增上游品牌引用或本批等价复制，`CursorsController` 保持 9 项差异并继续留在待处理表。
- Native 辅助阅读端口的 Stanza、测试和浏览器 TypeScript 编译通过；完整 `codeEditorWidget.test.ts` 32 项及 `editorConfiguration.test.ts` 11 项通过。新增用例覆盖简单与富内容分支、内容随模型更新、失焦清理、模型 owner 错配拒绝、simple/rich DOM 选区回写和监听释放，以及 `CodeEditorWidget → View → NativeEditContext → ScreenReaderSupport` 的运行时配置切换和旧 DOM 释放。真实 Chromium 的 WCAG/ARIA 场景 1 项同时验证焦点后的简单内容、simple/rich 系统选区回到公开 editor selection、rich 切换、旧节点释放和切回简单内容；先前公开输入/撤销链 1 项保持通过。成员检查器现在解析 Editor 范围内的继承，并按声明 owner 比较：继承可以满足上游声明，但基类额外成员不会重复算到每个子类，也不需要添加只调用 `super` 的包装方法；脚本与 CSS ownership 共 6 项回归测试通过。结构门禁保持 10 个精确成员项、28 个差异项；CSS ownership 仍为 0 个新增上游品牌引用、0 个本批等价复制，本批没有修改 CSS。
- TextArea 系统选区与剪贴板端口的 Stanza、测试和浏览器 TypeScript 编译通过；`TextAreaInput` / `TextAreaState` 9 项、完整 `codeEditorWidget.test.ts` 43 项和真实 Chromium textarea fallback 2 项通过。用例覆盖 host 屏幕阅读器状态、方向无关 offset 映射、LF 投影返回 CRLF 模型、聚焦期间系统光标回写、composition blur、失焦/dispose 释放，以及 copy/paste/cut 从 DOM 事件到 `TextAreaInput` 语义事件再到模型事务的完整链。`AbstractEditContext`、Native 与 TextArea 的无消费 `onDidSelect` 双轨，TextArea 外层重复 selection/clipboard 映射和额外公开连接入口已退出；`beforeinput/input` 仍承担 Ash 当前 keybinding 缺口，未为成员名强行迁移。结构门禁保持 392 个同路径、0 个大小写错误、205 个仅本地、337 个仅上游，CSS ownership 没有新增上游品牌引用或本批等价复制，本批没有修改 CSS。
- Cursor 组合输入端口批次移除了生产调用方为 0 的 `beginComposition`、`CompositionSession` 与对应私有更新链，测试改为直接经过标准 `startComposition`、`compositionType`、`endComposition`。外部模型修改和 Cursor 释放现在都会结束唯一的 `TextModel` 历史修订，避免后续组合输入被残留 revision 阻塞；组合替换、换行归一化、一次撤销、零历史预算、无修改、外部修改、释放和多光标等 56 项聚焦测试通过。成员审计确认 `CursorsController` 差异由 9 项降至 8 项，本批没有修改 CSS、DOM 或 contribution 文件。
- 键盘、type 与 composition 端口批次把 TextArea 与 Native 两个 DOM owner 的原始 `keydown/keyup` 就地转为 `IKeyboardEvent`，通过标准 `onKeyDown/onKeyUp` 进入公共 Editor 事件；Textarea 普通文本和组合替换、Native 组合 `textupdate` 都通过 `ITypeData` 进入同一个 `CompositionController`，composition lifecycle 则使用标准 data/void 载荷。测试覆盖 TextArea/Native 原始键盘事件身份、释放、公共事件阻止、普通 type 顺序、组合文本内部光标、Native textupdate、decoration 和一次撤销；Stanza、测试 TypeScript 编译及三份聚焦测试共 49 项通过，真实 Chromium textarea fallback 1 项同时验证普通键入、组合内部光标、生命周期 class 和一次撤销。完整浏览器基线为 11/18，7 个失败仍是此前记录的 Academic 多行输入、18/20px 光标、diagnostics/minimap/gutter/overview-ruler 和 GPU folding marker。本批没有修改 CSS、DOM 层级、焦点目标、快捷键或 contribution。
- Platform 配置入口批次保留 Ash 现有解析、持久化和事件实现，只把同路径 `configurationRegistry.ts` 注册到标准 `Registry` 的 `Extensions.Configuration` owner，并让 24 个配置声明、服务、Settings/List/Sash/Workbench 消费文件统一经 `IConfigurationRegistry` 取得同一实例；旧 `ConfigurationsRegistry` 导出与引用均为 0，没有增加包装层或第二份状态。Stanza 与测试 TypeScript 编译通过，配置默认值、更新事件、语言 override、Settings、List、Sash 和 Workbench 共 40 项定向测试通过。完整标准配置节点、默认 override 与语言 Registry 仍留在顺序 1，不把本批计为整个配置系统完成。
- Language Features Registry 批次的 Stanza 与测试 TypeScript 编译通过；Workbench Registry 分离、App Server、Extension Host、语义 token、通用 Registry 和 Standalone 共 31 项相关测试通过，其中 Extension Host 为 5/5，App Server 为 4/8。App Server 剩余 4 项均由测试模型仍为 `plaintext`、却按 `typescript` 查询 Registry 触发，涉及 definition、rename 和权限刷新，不在本批格式化/参数提示/语义 token 改动内。统一结构检查确认成员差异总项由 28 降至 27、旧 Registry 字段引用为 0、没有新增上游品牌引用或等价 CSS，本批未修改 CSS。完整 ModelService 与 BrowserTextModelService 测试仍分别有 1 个 EOL 基线失败和 3 个 undo/EOL 基线失败；Editor 架构入口仍有 10 个已记录的旧文件/owner 断言失败，均未通过恢复旧文件或修改范围外实现规避。
- Selection contribution 批次只迁移已经证明仅需读取、提交或监听选区的 14 个生产 controller：Bracket Match/Navigation、Diagnostics、Symbol/Language Navigation、Format、Parameter Hints、Go to Line、Smart Select、Occurrence/Multi Cursor、Rename、Language Hierarchy 和 Color Picker。它们直接改接现有 `ICodeEditor` 或 `IViewModel`，旧 `CursorsController` import 为 0，选区来源字符串、模型一致性检查和原有快捷键/显示逻辑保留；没有新建文件，没有修改 CSS、DOM、焦点目标或快捷键。Stanza 与测试 TypeScript 检查通过，16 项 controller 定向测试和 39 项 Smart Select、语言跳转、`CodeEditorWidget` 集成测试通过。结构门禁保持 392 个同路径、0 个大小写错误、205 个仅本地、337 个仅上游，账本仍为 80 项已处理、39 项待处理；Editor 内 `CursorsController` 引用由 31 个生产文件降至 17 个，剩余项不在本批伪造兼容入口。
- Selection Highlighter 批次在双方同路径 `contrib/multicursor/browser/multicursor.ts` 原地把选区读取和监听改接 `ICodeEditor`，文本查找与 decoration 生命周期继续由现有模型和 `TextDecorationCollection` 持有；生产装配同步改接 `context.editor`。测试不再手写 Editor 假对象或注入第二份选区 controller，而是通过真实 `CodeEditorWidget` 触发标准选区事件。Stanza、测试 TypeScript 检查和 47 项 Multi Cursor/Selection Highlighter/Widget 测试通过；没有新建文件，也没有修改 CSS、DOM、ARIA、焦点或快捷键。Editor 内 `CursorsController` 引用由 17 个生产文件降至 16 个。Suggest 浏览器文件虽为同路径，但仍被仅 Ash `chatInputEditor.ts` 和补全会话链直接构造，本批保持不动，未添加兼容构造函数或修改仅 Ash 调用方。
- 下一批按上表 owner 顺序推进；只有完成生产调用方迁移、删除旧入口并通过相关测试后，才会从 80 项中继续扣减。

- Browser services 入口核对：通用编辑 Worker 入口迁至上游对应的 `common/services/editorWebWorkerMain.ts`，工厂 URL 与架构入口清单同步更新。语法与单词补全入口按本轮处理方向保留在 Editor：前者运行词法 token 与结构诊断，后者运行文档内单词补全；Workbench 负责 TextMate、扩展和后端提供者的接入。资源级 `EditorWorkerService`、`contribution.ts` 装配职责、Opener 契约归属和行内补全共享服务仍未完成，不能将本次路径修正记作整个目录已对齐。
- 验证：`build:stanza`（含 common 与 Stanza 类型检查）、4 项启动器/Worker wire 单测、1 项 Chromium 格式化与撤销测试、结构审计及 `git diff --check` 通过。浏览器测试确认实际创建 `editorWebWorkerMain` Worker。结构审计仍报告范围外对齐差异；Playwright 有环境变量 `NO_COLOR`/`FORCE_COLOR` 冲突提示，生产构建无 warning。

- 行内补全服务装配：`browser/services/inlineCompletionsService.ts` 增加同名服务标识，Standalone 与 Workbench 各自在宿主容器注册共享实例。控制器经 `createInstance` 构造注入，不再自行创建和释放暂停服务；暂停事件取消当前请求并隐藏建议，单个编辑器关闭不影响共享暂停状态。
- 本批验证：63 项行内补全/CodeEditorWidget 单测、1 项 Chromium 多编辑器暂停与恢复测试、Stanza 与 Renderer 生产构建通过；覆盖必需服务缺失、命令重触发、接受与撤销、跨编辑器暂停和关闭后的共享状态。现有 JSDOM Canvas 提示与 Playwright 颜色环境变量提示仍存在，生产构建无 warning。服务装配不代表完整上游暂停命令、存储与遥测行为已完成；`contribution.ts`、资源级 Worker 和 Opener 契约仍待处理。

- 编辑器服务归属迁移：`contribution.ts` 中的 `BrowserCodeEditorService` 迁至上游对应的 `standalone/browser/standaloneCodeEditorService.ts`，保留最近活动编辑器和监听器的原有逻辑。Workbench 在自己的容器创建 `workbench/services/editor/browser/codeEditorService.ts`，通过活动窗格的 `getControl()` 定位准确编辑器；移除 `browserEditorPart.ts` 的模块级服务实例，普通窗格与差异窗格使用同一宿主服务。既有 Ash 专属窗格仍承担原职责，仅迁移服务装配。
- 通用 Worker 传输创建归回现有客户端构造入口，Standalone 与 Workbench 复用同一默认 Worker 创建逻辑；模型绑定客户端与资源级 Worker 服务的差异仍未解决。本批没有把 `contribution.ts` 的其余工厂或空注册函数标记为已对齐。
- 本批验证：76 项定向单测通过，涵盖编辑器注册与释放、同模型双编辑器的活动窗格识别、缺失宿主依赖、宿主服务隔离、剪贴板、命令和差异窗格。4 项 Chromium 场景及 Stanza、Renderer 生产构建通过；保留既有 JSDOM Canvas 与 Playwright 颜色环境提示，生产构建无新增 warning。结构检查仍报告其他未完成 API，不能据此宣称目录全部对齐。

- 浏览器 contribution 注册收敛：移除 `createEditorBrowserServices`、`EditorBrowserServices` 和空的 `registerEditorBrowserContributions`。`contribution.ts` 现在在 bundle 装载时注册 eager 诊断装饰；Widget 不再单独创建同一 contribution。每实例诊断源仍作为构造数据传入，必需的 marker 服务由宿主容器解析，模型切换沿 contribution 生命周期释放引用。
- Standalone 直接注册并取得宿主 code-editor 服务，直接装配通用编辑与词法 Worker。原工厂中的 Opener、重命名跟踪实例及单词补全工厂闭包没有生产消费者，已移除创建逻辑；单词补全入口文件保留，未宣称它已接入默认产品调用链。Opener 和资源级 Worker 的完整契约仍未完成，不新增无调用方服务外壳。
- 本批验证：73 项定向单测、5 项 Playwright 场景、Stanza 与 Renderer 生产构建通过。覆盖共享 marker 引用、模型释放、诊断源合并、标记出现/清除、模型切换、格式化和相关编辑器行为。没有新增测试文件，现有行为测试覆盖本次装配迁移；JSDOM Canvas 和 Playwright 颜色环境提示仍存在，生产构建没有新增 warning。

2026-09-15：用户确认删除 `browser/services/syntaxWorkerMain.ts` 和 `browser/services/languageCompletionWorkerMain.ts`。Standalone 词法着色使用 TokenizationRegistry；模型诊断由 ModelLanguageDiagnostics 独立调度；单词补全使用通用 Editor Worker。TextMate Worker 仍由 Workbench 创建。

自建词法体系清理：移除扫描器、词法配置适配、扫描缓存、默认 syntax provider、词法上下文与重复括号索引。括号操作和显示直接使用 `TextModel.bracketPairs`；section headers 和本地折叠读取模型 tokenization。Standalone 不再内置猜测式分词或括号诊断；Workbench TextMate Worker 只激活 grammar 模块。Worker 结果校验与增量传输保留。
模型括号树补充修复：内容变更在通知视图和 token 监听方前先进入括号树；标准内容事件按范围倒序传递多处编辑，保证增量括号更新与删除/撤销一致。
本轮验证：扫描器消费方、syntax wire、模型 tokenization、TextMate、模型/编辑器组件定向单测通过；23 项 Editor 架构检查和 10 项 Chromium 场景通过；`build:stanza`、`build:renderer` 通过。此记录仅表示自建词法链路已收敛，不表示整个 Editor API 对齐完成。

内置语言装配清理：两个 `common/languages/languageBuiltin*` 文件退出，默认语言数据合并到 `standalone/common/builtinLanguages.ts`，由 Standalone 与 Workbench 的装配入口注册。`TextModel` 不再创建内置配置服务；未传入配置的裸模型没有语言规则。Workbench 文件模型使用宿主共享配置并响应注册/撤销，测试专用服务工厂移入测试目录。定向单测、23 项架构检查、9 项 Chromium 场景和 Stanza/Renderer 构建通过。其余自建语言服务、协议和反向契约依赖仍待整理。

Standalone 布局文件补齐：上游同路径 `standalone/browser/standaloneLayoutService.ts` 已由 Ash 独立实现并注册到窗口服务容器。服务从当前编辑器注册表发布主容器、活动容器和布局事件；F1 Quick Input 改读该服务的活动容器，选择框自身的 DOM 与释放仍由原 Controller 拥有。文件集合审计从 448 个同路径增至 449 个，缺失文件减 1。Standalone 单测 31 项通过，真实 Chromium 双编辑器 F1 场景通过，Stanza 生产构建通过。完整浏览器检查这次为 602 项通过，仍有括号着色、括号操作和 GPU 括号字形等失败；暂时断开本批服务注册与 Quick Input 接线后，4 个代表性失败仍原样复现，随后已恢复接线，因此不能将完整检查记为通过。`standaloneGotoSymbolQuickAccess.ts` 等其余缺失文件仍需先闭合各自下层调用链。

Standalone Go to Offset：`editor.action.gotoOffset` 已从命令面板进入现有定位输入框，输入按一基 UTF-16 偏移解析，确认后更新选区、滚动并恢复编辑器焦点；行号模式仍独立工作。动作位于双方同路径的 `standaloneGotoLineQuickAccess.ts`，现有 Ash 定位框继续拥有输入 DOM 和生命周期。中英文标签与输入提示已接入语言目录。定向单测、真实 Chromium 命令场景及 Stanza 生产构建通过。`Colorizer.colorizeModelLine` 仍受模型同步 token 能力限制，未把异步快照伪装为同步实现；其余 Standalone 文件差异仍待逐条闭合调用链。

Standalone 符号选择文件补齐：`standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.ts` 接管 `editor.action.quickOutline`、当前编辑器的文档符号请求和 Quick Pick 跳转。原仅 Ash 的 `gotoSymbolController.ts`、`gotoSymbol.contribution.ts` 与 `gotoSymbol.css` 已在生产入口和测试迁完后删除，共享 `DocumentSymbolService` 保留。Quick Pick 增加可设置的无障碍名称与失焦事件；关闭时只在焦点仍处于选择框内才恢复此前焦点，避免抢走另一个编辑器的焦点。文件集合检查现为 450 个同路径、0 个大小写错误，CSS 检查无新增上游品牌引用。Stanza/Renderer 生产构建、类型检查、Quick Input 与本地化各 6 项单测和 11 项相关 Chromium 场景通过；架构测试 23 项通过、1 项旧断言失败，该断言仍要求当前基线已不存在的 `contrib/smartSelect/common/selectionRanges.ts`。临时移除该断言后，同一测试又停在旧的 `colorPickerWidget.ts` 布局断言，因此恢复原断言，本批不改这组范围外检查。Code 产品的浏览器 smoke 场景在启动前因本机缺少 Go 命令而止于 `spawnSync go ENOENT`，未执行到 Playwright。
