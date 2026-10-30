# chatManagement 公开契约与生产调用链核对

初次核对日期：2026-10-23；设置页承载边界与生产链更新：2026-10-30。参照为本地 `../vscode/src/vs/workbench/contrib/chat/browser/chatManagement`，初次提交 `c2968900dcf`；2026-10-30 复核提交 `6c21985de644ff819d69e5fbdd6c0a476e37d427`。上游用于核对职责、公开名称和可观察场景；Ash 保留自己的模型服务、编辑器宿主、DOM 和持久化契约。

本次修正的根因是 owner 错位：原 `ChatModelsViewModel` 实际管理单个供应商的探测表格，目录状态却存在 `ChatModelsWidget` 内。现将供应商探测状态迁回 `ModelProviderSettingsRenderer` 的私有 `ProviderModelsViewModel`，由真正的目录 `ChatModelsViewModel` 提供查询、供应商分组、折叠、选中项和可见性操作。没有为同一职责保留新旧公开入口。

## 已确认的产品承载边界

模型管理由 Ash 的 Workbench 与 Sessions 设置页承载，这是用户明确确认的产品选择。共享的 `ChatModelsWidget`、`ChatModelsViewModel` 和模型服务继续按公开职责及可观察行为核对；不将“独立页面已移除”算作共享能力对齐完成，也不为文件数量恢复独立 Editor 或无调用方的占位 API。

上游的 `chatManagementEditor.ts`、`chatManagementEditorInput.ts` 及专用页面 CSS、pane / serializer / 清空搜索命令注册属于不采用的页面载体。Ash 的替代调用方是现有 `ModelSettingsRenderer` 和 Preferences 服务；Settings 拥有导航与外层滚动，Widget 拥有概览、完整列表及其交互。旧模型标签使用 working set 既有的未知输入类型跳过机制，不迁移模型配置。

## 生效调用链

- Chat 选择器的 Add Models → `ICommandService.executeCommand(MANAGE_CHAT_COMMAND_ID)` → `chatManagement.contribution.ts` → `IPreferencesService.openSettings({ section: 'models', query: '', sectionQuery, jsonEditor: false, focusSearch: true })` → Workbench / Sessions 的 Models 设置 → `ModelSettingsRenderer` → `ChatModelsWidget` → `ChatModelsViewModel` → `ILanguageModelsService`。
- 目录读取、供应商名称和动态失效来自模型服务。ViewModel 只持有当前窗口的目录投影、查询、分组折叠和选中项，不另存模型目录或可见性配置。
- 单模型开关 → `toggleModelHidden` → `setModelsHidden` → `ILanguageModelsService.setModelVisible` → 原 `ILanguageModelsConfigurationService`。供应商开关通过 `getModelsForGroup` 使用连接 ID 限定范围，不按显示名称合并，也不只修改当前搜索结果。
- Preferences → `ModelSettingsRenderer` → 同一个 Widget / 目录 ViewModel；设置页默认展示首模型概览，展开后提供分组、组开关、折叠与筛选建议。可见行按已开启和目录原序排序，完整列表在各连接内应用同一排序。返回概览或修改设置页全局搜索时展开分组，避免匹配内容被旧折叠状态隐藏。
- 供应商表单 → 私有 `ProviderModelsViewModel` → 原模型服务的发现、配置保存和探测操作；凭据仍由原 secret store 保存。
- 编辑器 working set → 通用恢复过程跳过已移除的 `workbench.input.modelsManagement` 输入；不保留独立管理 pane、输入 serializer 或第二份模型状态。

模型开关保留原生 Space 激活，Hover 使用焦点监听呈现说明，不注册会抢走 Enter / Space 的键盘处理器。分组开关的宽度只作用于分组行，避免通用模型开关样式挤掉供应商名称和展开按钮。

## 已接入的公开端口

| 文件及公开契约                                                                                                                      | Ash 生产调用方与可观察结果                                                                                                                                                          |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chatModelsViewModel.ts`: `ChatModelsViewModel` 构造、`refresh`                                                                     | Widget 通过 DI 创建目录 owner；模型服务的变更触发刷新。较旧、已释放的读取不能覆盖新结果。供应商凭据读取不会阻塞模型目录显示。                                                       |
| `onDidChange`, `IViewModelChangeEvent`, `viewModelEntries`                                                                          | Widget 消费投影变更；事件的 `at` / `removed` / `added` 可重放得到同一条目列表。                                                                                                     |
| `filter`, `shouldRefilter`                                                                                                          | 搜索框和 Widget 的 `render` 使用同一投影。名称、模型 ID、供应商 ID、带引号的供应商名称、多个供应商 OR，以及明确声明的 vision 能力均经过此端口。                                     |
| `ILanguageModelProvider`, `ILanguageModel`, `ILanguageModelEntry`, `ILanguageModelProviderEntry`, `IStatusEntry`, `IViewModelEntry` | Widget 的行、分组、错误状态和显隐操作使用这些类型。模型内容仍是 Ash 的 `ModelCatalogEntry`，不会捏造 VS Code 扩展元数据。                                                           |
| `MODEL_ENTRY_TEMPLATE_ID`, `VENDOR_ENTRY_TEMPLATE_ID`, `isLanguageModelProviderEntry`, `isStatusEntry`                              | 返回条目的类别标识和类型判定；Widget 按真实条目类型渲染模型、分组与状态。                                                                                                           |
| `getVendors`, `getConfiguredVendors`, `SEARCH_SUGGESTIONS`                                                                          | 搜索建议使用已知连接与供应商名称；设置页的分组和空目录判断来自同一目录 owner。未知 tools / agent 能力不作为已知能力建议。                                                           |
| `getModelsForGroup`, `toggleGroupHidden`                                                                                            | 供应商开关操作该连接的真实模型集合；相同显示名称的两个连接保持隔离。                                                                                                                |
| `toggleModelHidden`, `setModelsHidden`                                                                                              | 单行、跨供应商多选和整组开关落到原可见性服务。Ash 存储是异步的，因此返回 `Promise<void>`，错误回到控件并显示反馈，没有模仿上游 `void` 返回值吞掉失败。                              |
| `toggleCollapsed`, `collapseAll`, `expandAll`                                                                                       | 供应商按钮和 Collapse All 控制目录条目；Ash 的 `expandAll` 由概览切换和设置全局搜索触发，原子清除分组折叠。局部新搜索也展开匹配分组，搜索期间仍可折叠。                             |
| `selectedEntry`                                                                                                                     | 行焦点写入当前选择；刷新重新绑定同 ID 的新条目，移除或折叠后不持有退休条目。                                                                                                        |
| `getManageModelsProviderLabel`                                                                                                      | 模型说明使用真实连接所属分组名称。                                                                                                                                                  |
| `chatModelsWidget.ts`: `element`, `render`                                                                                          | 两个窗口的设置树挂载同一 Widget；设置页拥有外层滚动，Widget 不再保留独立编辑器的尺寸 API 或内部滚动样式。                                                                           |
| `focusSearch`, `search`, `clearSearch`                                                                                              | 筛选建议和 Escape 操作真实模型搜索框并恢复焦点；管理命令的原始查询通过 Preferences 的 `sectionQuery` 交给模型搜索，全局设置查询保持为空，保留 `@provider:` 和 `@capability:` 语义。 |
| `onDidChangeItemCount`, `itemCount`, `hasResults`                                                                                   | Settings Renderer 订阅变更并读取 `hasResults` 保留折叠后的匹配供应商；供应商和状态行不计为模型。数量通知由 Widget 内部发送。                                                        |
| `getModelHoverContent`                                                                                                              | 行的 managed hover 使用实际渲染的安全 Markdown，包含已提供的名称、ID、供应商、说明和上下文。Hover 内容与行一起释放。                                                                |
| `chatManagement.contribution.ts`: 管理命令注册                                                                                      | `chat.shared.contribution.ts` 是唯一装载入口。管理命令验证外部查询参数，直接打开图形 Models 设置；无参调用清空全局及模型筛选，返回 `Promise<void>`。                                |

## 2026-10-30 共享能力修复

- 模型命令使用分区搜索，两个设置宿主保留原始筛选词；全局设置搜索和模型搜索仍由各自 owner 负责。`@provider:` 对连接 ID、供应商 ID、显示名称和组名称做不区分大小写的精确匹配，多个供应商为 OR，避免前缀相同的连接互相命中。
- 模型名称和 ID 支持连续文本、词首及驼峰首字母匹配；名称高亮使用原字符串 UTF-16 范围。输入 `@` 提供受支持的能力和实际连接建议，方向键选择、Enter 插入、Escape 先关闭建议再清空搜索。
- Widget 拥有临时多选集合，提供范围选择、选择全部可见结果、显示/隐藏；切换搜索或折叠后移除不可见选项。焦点选择仍由 ViewModel 的 `selectedEntry` 管理。
- 模型显示由开关及批量显隐操作统一管理，Chat Input 选择器按目录原序列出可见模型；不再提供 Pin 或独立置顶偏好。旧 `models.pinned` 记录不再读取或写入，不映射为可见性，保留已有开关选择。
- 自定义供应商删除经确认后走 `removeCustomModelProvider` → `IAgentModelsService.removeCustomProvider` → 既有 `provider/remove`，后端仍拥有供应商配置和密钥删除。UI 等待进行中的凭据保存完成，再删除供应商；清理该连接的本地可见性偏好，两个窗口通过已有模型变更刷新卡片。内置供应商不提供删除操作。

## 2026-10-30 元数据契约闭合

`model/list` 现在传递独立的 tools / agent_mode 三态、实际 provider / connection 身份及目录 provenance，并投影计价服务的已发布参考价。前端 adapter 转成领域类型，Models 的筛选、悬停说明和无障碍视图消费这些事实；元数据单独变化或撤回也触发目录通知。管理行不展示能力标签，完整能力、来源、三态和价格通过悬停说明与无障碍视图按需查看。旧目录缺少新增字段时保留未知，不从工具调用推断 Agent 能力。已有工具能力不再在适配器中丢失。

价格复用 `model-accounting` 的不可变价目表，保留货币、服务等级、区域、输入区间和版本／核对日期，仅适用于匹配的公开 API 连接。订阅与自定义端点不继承这些金额，也不转换成 Copilot credits；空价格是未知。磁盘恢复的模型事实标成已保存的供应商目录，不再声称实时读取。多 provider 对照和字段归属见通用模型声明规范第 12 节。

## 不能以同名空接口代替的上游契约

下列项目已核对，保留为明确的契约差异，不宣称已实现，也不通过无调用方声明消除差异：

| 上游契约                                                                                                                     | Ash 当前依据及边界                                                                                                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setSessionType`（ViewModel、Widget、Editor）及 harness 专属源过滤                                                           | 当前 Ash 模型目录没有 harness / session-type 来源字段，生产消费者共享同一模型目录。不会根据供应商名称猜测来源，也不新增忽略参数的空方法。需要来源契约及真实消费者后才能接入。                                     |
| `groupBy`, `onDidChangeGrouping`, `ChatModelGroup`、通用 group 条目、`ILanguageModelEntriesGroup`、`GROUP_ENTRY_TEMPLATE_ID` | 本次参照版本的 `ChatModelGroup` 也只有 `Vendor`，没有实际的多模式选择器，不能将这些声明计为缺失的用户能力。Ash 已有供应商分组；不添加永远不变的 setter / event 或无消费者的载体类型。                             |
| 扩展专属 `sourcePresentation` 与受信图标注册                                                                                 | 已提供后端实际模型厂商、连接和元数据 provenance。它不等于 VS Code 的扩展来源注册表，不由同名厂商认领受信扩展身份或图标。                                                                                          |
| `editTools` 等供应商特有能力                                                                                                 | tools / agent 及 toolCalling / agentMode 别名已接通，只接受明确 supported；具体编辑工具分类尚无目录事实，不从通用工具能力推断。                                                                                   |
| Copilot credits、账户折扣和专有计费权益                                                                                      | 已显示带版本的公开 API 货币参考价；Ash 没有 Copilot credits 或对应权益事实，不把 USD 等货币数值当作 credits。                                                                                                     |
| `buildAddModelsDropdownActions`、Copilot 登录 / 启用与扩展配置动作                                                           | Ash 没有上游 configurable-vendor / harness 扩展配置契约，也没有 Copilot 扩展产品宿主。实际入口为直接打开 Models 设置的管理命令，供应商配置通过原表单和服务完成；不导出无调用方的同名 dropdown helper。            |
| Open Language Models JSON 及 `configureLanguageModels`                                                                       | Ash 的界面模型选择存于 Settings JSON，自定义供应商与凭据由后端配置和 secret store 持有，没有一个对应上游 `languageModels.json` 的共同配置 owner。管理页进入现有设置，不能用只含显隐设置的 JSON 冒充完整模型配置。 |

验证覆盖原始命令筛选、精确供应商匹配、词首及驼峰高亮、搜索补全、多选显隐、可见性持久化与选择器目录顺序、供应商确认删除和凭据清理、目录过滤与事件重放、同名供应商隔离、单行和整组显隐、折叠和选中项、失败及异步退休、供应商表单原行为、真实命令及 Chat 选择器直达设置、退休标签跳过恢复、两个设置宿主的分组与筛选、中文无障碍内容、焦点恢复与高对比度键盘路径。实际运行结果以本次任务报告为准，不将静态 API 清单作为行为验证。

## 2026-10-30 管理行为复核

复核参照本地 VS Code `6c21985de644ff819d69e5fbdd6c0a476e37d427` 的生产调用方、公开服务契约和已有测试。下表记录实施前的缺口与边界，后续实现状态见本节末。

| 优先级         | 值得补齐的行为                                                         | VS Code 的可观察行为及证据                                                                                                                    | Ash 当前依据、owner 与实施边界                                                                                                                                                                                                                                                                                        |
| -------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 高             | 从目录直达对应供应商或模型配置                                         | `chatModelsWidget.ts` 的供应商和单模型操作提供 Manage、Configure，以及更新密钥、添加模型、重命名等组操作；`ILanguageModelsService` 承接配置。 | Ash 的目录供应商行只有展开和显隐，模型行只有选择和显隐；配置表单在同一设置页下方，需自行寻找。可由 Preferences 宿主定位现有连接卡片或模型编辑器，Widget 只发起语义操作，不访问其他组件的私有 DOM。已有表单和服务继续拥有编辑、保存及凭据。                                                                            |
| 高             | 在管理目录里调整已有单模型偏好                                         | 上游 `getModelConfigurationActions` 将已有配置 schema 转成当前值、默认项和可用项受限的菜单，目录行和单行菜单都有入口。                        | Ash 已通过 Chat 选择器调用 `setModelPreferences` 保存加速、长上下文偏好，管理目录没有入口。适合复用该领域契约，只呈现当前连接实际提供的选项。推理深度在当前选择器还涉及聊天选择，应保留其原有作用域，不能顺手改成全局偏好。                                                                                           |
| 高，需先补契约 | 在对应供应商下显示目录加载或刷新失败，即使没有模型也保留该供应商的状态 | 上游目录组可同时持有模型与 `status`；`chatModelsViewModel.test.ts` 验证 Ollama 的 fetch failed 状态与其他厂商模型并存。                       | Ash 的目录 ViewModel 只有一个全局 failure，供应商组从已有模型推导；自定义供应商表单已有发现错误、空结果和重试反馈，但未接入统一目录。共享后端已有 freshness、warnings 和刷新错误，当前 `model/list` 只带模型和 scope 身份，需先投影有来源、按连接限定的状态，再由目录消费。不能以已存密钥或一次模型测试替代目录状态。 |
| 中             | 行菜单、上下文批量操作和键盘范围选择                                   | 上游表格菜单复用当前选中项，按选择状态提供显隐、置顶和配置；标准列表命令支持 Shift+方向键扩选及 Ctrl/Cmd+A。                                  | Ash 已有复选框、Shift 点击、全选按钮、上下方向键导航和批量操作，不缺多选本身；缺少行菜单、键盘扩选和列表内全选快捷键。应继续由 Widget 拥有临时选中集合，菜单复用现有服务操作；搜索框中的全选仍应选择文本。未选择时可收起无可用动作的批量按钮，选择后再提供操作。                                                      |
| 中，改动较小   | 点击能力提示切换筛选条件                                               | 上游 Tools、Vision 按钮触发 `onDidClickCapability`，通过 `toggleFilter` 保留其他查询并切换对应能力条件。                                      | Ash 使用能力查询、建议和搜索筛选按钮提供能力筛选；模型行不再展示 Tools、Image input 等能力按钮，保持模型名称和显隐操作清晰。                                                                                                                                                                                          |

新增／编辑／删除手工模型、上下文声明与 upstream 映射、供应商重命名、密钥保存、测试及刷新，在 Ash 的 `ModelProviderSettingsRenderer` 及其测试中已有对应行为，不再列为待补。新聊天通过共享模型服务恢复 Chat Input 上次选择，Auto 意图由 UI profile 状态保存；不再提供独立的默认聊天模型设置。

建议先做目录配置捷径和已有模型偏好，再补供应商状态；行菜单／键盘多选可作为后续体验补齐。Copilot 专属登录、credits、harness 分流、受信扩展来源注册及完整 Language Models JSON 仍不列入本次管理能力的实施建议。

### 本轮已接入的管理行为

共享目录已接入供应商／自定义模型配置定位、长上下文与加速菜单、按连接显示目录状态、行菜单与键盘多选；能力筛选通过搜索及筛选建议提供。配置导航由 Preferences 宿主负责，菜单复用原有模型服务；Widget 只保存当前查询、临时选择与请求进度。推理深度继续使用聊天作用域，计费与参考价格保留原归属。

`ModelContextCatalog` 捕获 `models-manager` 的连接快照，App Server 在既有 `model/list` 响应中投影 `catalog_statuses`：provider、connection、freshness 和问题分类。只暴露稳定分类，不暴露原始网络错误、端点和凭据。生成协议及 decoder 后，平台 adapter 转成领域类型，`LanguageModelsService` 持有目录快照并在状态单独变化、撤回和作用域失效时通知消费者；ViewModel 将状态放回对应分组。旧响应缺少状态时保持未知，TUI 构造样例同步补齐默认值而不新增 TUI 管理行为。

真实宿主验证发现并修正了嵌入列表的快捷键竞争及菜单层级：模型行用自己的 context key 将全选和菜单快捷键交回 DOM 处理，搜索输入保留文本选择；Workbench 的模型菜单使用 Settings pane 的 context-view scope，Sessions 的模型 renderer 使用模态内容 scope。菜单和子菜单随设置实例释放，关闭菜单恢复发起控件，导航后保留新目标的焦点。

定向验证覆盖字段兼容与状态脱敏、状态单独变化／撤回、空目录及折叠保留、查询隔离、配置定位、支持选项写入、键盘范围选择／全选、能力筛选不误触显隐、两个窗口的菜单与子菜单、失败目录保留及刷新恢复。具体通过数量、重试与运行边界以本轮任务结果为准。
