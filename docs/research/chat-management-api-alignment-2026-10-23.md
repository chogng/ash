# chatManagement 公开契约与生产调用链核对

核对日期：2026-10-23。参照为本地 `../vscode/src/vs/workbench/contrib/chat/browser/chatManagement`，提交 `c2968900dcf`。上游用于核对职责、公开名称和可观察场景；Ash 保留自己的模型服务、编辑器宿主、DOM 和持久化契约。

本次修正的根因是 owner 错位：原 `ChatModelsViewModel` 实际管理单个供应商的探测表格，目录状态却存在 `ChatModelsWidget` 内。现将供应商探测状态迁回 `ModelProviderSettingsRenderer` 的私有 `ProviderModelsViewModel`，由真正的目录 `ChatModelsViewModel` 提供查询、供应商分组、折叠、选中项和可见性操作。没有为同一职责保留新旧公开入口。

## 生效调用链

- Chat 选择器的 Add Models → `ICommandService.executeCommand(MANAGE_CHAT_COMMAND_ID)` → `chatManagement.contribution.ts` → `IEditorService.openEditor(ModelsManagementEditorInput)` → `ModelsManagementEditor` → `ChatModelsWidget` → `ChatModelsViewModel` → `ILanguageModelsService`。
- 目录读取、供应商名称和动态失效来自模型服务。ViewModel 只持有当前窗口的目录投影、查询、分组折叠和选中项，不另存模型目录或可见性配置。
- 单模型开关 → `toggleModelHidden` → `setModelsHidden` → `ILanguageModelsService.setModelVisible` → 原 `ILanguageModelsConfigurationService`。供应商开关通过 `getModelsForGroup` 使用连接 ID 限定范围，不按显示名称合并，也不只修改当前搜索结果。
- Preferences → `ModelSettingsRenderer` → 同一个 Widget / 目录 ViewModel；`compact` 只是设置页的首模型、展开和全局搜索呈现规则。
- 供应商表单 → 私有 `ProviderModelsViewModel` → 原模型服务的发现、配置保存和探测操作；凭据仍由原 secret store 保存。
- 编辑器 working set → `EditorInputSerializers` 的专用注册 → `ModelsManagementEditorInput`，恢复图标、资源身份和 `Singleton`，避免恢复成普通资源后跨组复制。

实际桌面链还验证了两处宿主约束：`EditorPanes` 会先在隐藏容器内调用 `layout`，管理编辑器在显示后重新测量可用视口；模型开关保留原生 Space 激活，Hover 使用焦点监听呈现说明，不注册会抢走 Enter / Space 的键盘处理器。分组开关的宽度只作用于分组行，避免通用模型开关样式挤掉供应商名称和展开按钮。

## 已接入的公开端口

| 文件及公开契约                                                                                                                      | Ash 生产调用方与可观察结果                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `chatModelsViewModel.ts`: `ChatModelsViewModel` 构造、`refresh`                                                                     | Widget 通过 DI 创建目录 owner；模型服务的变更触发刷新。较旧、已释放的读取不能覆盖新结果。供应商凭据读取不会阻塞模型目录显示。                   |
| `onDidChange`, `IViewModelChangeEvent`, `viewModelEntries`                                                                          | Widget 消费投影变更；事件的 `at` / `removed` / `added` 可重放得到同一条目列表。                                                                 |
| `filter`, `shouldRefilter`                                                                                                          | 搜索框和 Widget 的 `render` 使用同一投影。名称、模型 ID、供应商 ID、带引号的供应商名称、多个供应商 OR，以及明确声明的 vision 能力均经过此端口。 |
| `ILanguageModelProvider`, `ILanguageModel`, `ILanguageModelEntry`, `ILanguageModelProviderEntry`, `IStatusEntry`, `IViewModelEntry` | Widget 的行、分组、错误状态和显隐操作使用这些类型。模型内容仍是 Ash 的 `ModelCatalogEntry`，不会捏造 VS Code 扩展元数据。                       |
| `MODEL_ENTRY_TEMPLATE_ID`, `VENDOR_ENTRY_TEMPLATE_ID`, `isLanguageModelProviderEntry`, `isStatusEntry`                              | 返回条目的类别标识和类型判定；Widget 按真实条目类型渲染模型、分组与状态。                                                                       |
| `getVendors`, `getConfiguredVendors`, `SEARCH_SUGGESTIONS`                                                                          | 搜索建议使用已知连接与供应商名称；设置页的分组和空目录判断来自同一目录 owner。未知 tools / agent 能力不作为已知能力建议。                       |
| `getModelsForGroup`, `toggleGroupHidden`                                                                                            | 供应商开关操作该连接的真实模型集合；相同显示名称的两个连接保持隔离。                                                                            |
| `toggleModelHidden`, `setModelsHidden`                                                                                              | 单行及整组开关落到原可见性服务。Ash 存储是异步的，因此返回 `Promise<void>`，错误回到控件并显示反馈，没有模仿上游 `void` 返回值吞掉失败。        |
| `toggleCollapsed`, `collapseAll`                                                                                                    | 供应商按钮和 Collapse All 实际控制目录条目；新搜索展开匹配分组，搜索期间仍可折叠。                                                              |
| `selectedEntry`                                                                                                                     | 行焦点写入当前选择；刷新重新绑定同 ID 的新条目，移除或折叠后不持有退休条目。                                                                    |
| `getManageModelsProviderLabel`                                                                                                      | 模型说明使用真实连接所属分组名称。                                                                                                              |
| `chatModelsWidget.ts`: `element`, `render`, `layout`                                                                                | 管理编辑器提供实际可用视口，Widget 拥有该视口的滚动；设置页继续使用其外层滚动 owner。没有复制上游表格布局实现。                                 |
| `focusSearch`, `search`, `clearSearch`                                                                                              | 命令、编辑器和 Escape 操作真实搜索框，搜索恢复焦点。                                                                                            |
| `onDidChangeItemCount`, `itemCount`, `fireItemCount`                                                                                | 编辑器订阅并显式重放数量，显示当前可见模型数；供应商和状态行不计为模型。                                                                        |
| `getModelHoverContent`                                                                                                              | 行的 managed hover 使用实际渲染的安全 Markdown，包含已提供的名称、ID、供应商、说明和上下文。Hover 内容与行一起释放。                            |
| `chatManagementEditor.ts`: `ID`, `setInput`, `layout`, `focus`, `clearInput`, `search`, `clearSearch`                               | 由注册的 EditorPane 创建和调用；遵守 Ash 的 `AbortSignal` / 资源输入契约，隐藏与释放后不恢复退休控件的焦点。                                    |
| `chatManagementEditorInput.ts`: `ID`, `typeId`, `getName`, `getIcon`, `capabilities`, 继承的 `matches`                              | Editor Part、标签和 serializer 使用同一输入身份；`Singleton` 阻止跨分组创建第二个管理 pane，恢复后也保持该行为。                                |
| `chatManagement.contribution.ts`: 管理命令、清空搜索命令、pane 与 serializer 注册                                                   | `chat.shared.contribution.ts` 是唯一装载入口。管理命令验证外部查询参数，返回对应管理 pane；不再把任意当前 active pane 当作打开结果。            |

## 不能以同名空接口代替的上游契约

下列项目已核对，保留为明确的契约差异，不宣称已实现，也不通过无调用方声明消除差异：

| 上游契约                                                                                                                     | Ash 当前依据及边界                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setSessionType`（ViewModel、Widget、Editor）及 harness 专属源过滤                                                           | 当前 Ash 模型目录没有 harness / session-type 来源字段，生产消费者共享同一模型目录。不会根据供应商名称猜测来源，也不新增忽略参数的空方法。需要来源契约及真实消费者后才能接入。                                          |
| `groupBy`, `onDidChangeGrouping`, `ChatModelGroup`、通用 group 条目、`ILanguageModelEntriesGroup`、`GROUP_ENTRY_TEMPLATE_ID` | 当前目录只有按真实连接划分的供应商分组，没有分组模式选择器或第二层目录来源。现有原生 DOM 不需要重建上游表格 renderer；不添加永远不变的 setter / event 或无消费者的载体类型。                                           |
| `sourceId`, `sourcePresentation` 及扩展元数据、搜索高亮匹配范围                                                              | 目录契约提供模型事实与连接标识，未提供上游受信来源 presentation 或扩展身份。条目使用 Ash 原生模型事实；不把同名供应商解释为同一受信来源，不复制上游私有表格结构。                                                      |
| `@capability:tools`, `@capability:agent` 及其别名                                                                            | `ModelCatalogEntry` 有 `inputModalities`，可证明 vision；没有工具调用或 agent 能力事实。未声明的能力保持未知，不能从厂商、型号或 API format 推断。                                                                     |
| `getModelHoverContent` 的 pricing / credits / 各类 cost 字段                                                                 | 当前目录没有价格、计费单位或账户权益信息。只渲染已有事实，不添加虚构价格或空计费字段。                                                                                                                                 |
| `buildAddModelsDropdownActions`、Copilot 登录 / 启用与扩展配置动作                                                           | Ash 没有上游 configurable-vendor / harness 扩展配置契约，也没有 Copilot 扩展产品宿主。实际入口为选择器的管理命令及管理编辑器的 Open Settings，供应商配置仍通过原表单和服务完成；不导出无调用方的同名 dropdown helper。 |
| 输入的 `resource = undefined`, `RequiresModal`, `resolve(): Promise<null>` 及上游 setInput / constructor 参数                | Ash 编辑器要求资源 URI，输入匹配由其公共基类负责；本地 capability 枚举没有 `RequiresModal`，资源输入没有通用 `resolve` 调用链。采用本地宿主真实契约，不添加无调用方的空 `resolve` 或额外 modal 状态。                  |
| Open Language Models JSON 及 `configureLanguageModels`                                                                       | Ash 的界面模型选择存于 Settings JSON，自定义供应商与凭据由后端配置和 secret store 持有，没有一个对应上游 `languageModels.json` 的共同配置 owner。管理页进入现有设置，不能用只含显隐设置的 JSON 冒充完整模型配置。      |

验证覆盖目录过滤与事件重放、同名供应商隔离、单行和整组显隐、折叠和选中项、失败及异步退休、供应商表单原行为、真实命令打开和跨组单例、序列化恢复、中文无障碍内容、Chat 选择器到管理编辑器、实际视口与高对比度键盘路径。实际运行结果以本次任务报告为准，不将静态 API 清单作为行为验证。
