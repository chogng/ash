# Preferences、Settings 与 Configuration

> 适用范围：Ash TypeScript Workbench 的偏好入口和编辑页面。配置数据的存储边界见 [Browser foundation 的配置架构](browser-foundation.md#configuration-architecture)。

**Preferences 是偏好入口范围，Settings 是其中一种内容。** 当前 Ash 的图形设置、用户设置 JSONC、快捷键图形编辑器和快捷键 JSONC 分别打开。配置读取与持久化已有共享链路，但这不表示 Preferences 的公开契约和页面组织已经与 VS Code 对齐。设置接入的目标约束见 [Settings 接入与渲染边界](../src/ash/workbench/contrib/preferences/README.md)。

| 职责          | 当前做法                                                                                                                                                                                                                              | 不负责                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 偏好入口      | [`IPreferencesService`](../src/ash/workbench/services/preferences/common/preferences.ts) / [`PreferencesService`](../src/ash/workbench/services/preferences/browser/preferencesService.ts) 根据调用的方法打开对应资源                 | 绘制设置项或保存配置值         |
| 图形设置页    | [`SettingsEditor`](../src/ash/workbench/contrib/preferences/browser/settingsEditor.ts) 显示搜索、分类和设置控件；[`settingsLayout.ts`](../src/ash/workbench/contrib/preferences/browser/settingsLayout.ts) 决定已注册设置放在哪个分类 | 保存配置源或管理普通文本模型   |
| 用户设置 JSON | 普通文本编辑器打开当前 profile 的真实 `settings.json`；通用 `IFileService` 负责读写                                                                                                                                                   | 在图形设置页内部维护另一份配置 |
| 键盘快捷键    | [`KeybindingsEditor`](../src/ash/workbench/contrib/preferences/browser/keybindingsEditor.ts) 通过输入取得模型；快捷键资源独立于普通配置键值                                                                                           | 充当设置页的子页面             |

## 设置内容与渲染

功能模块注册配置项，分类布局引用 setting ID，由 Preferences 统一建模和渲染。账号状态与管理操作通过数据契约接入。功能模块不得提供设置页 DOM、widget 或渲染回调；完整职责约束和旧接口迁移边界见 [Settings 接入与渲染边界](../src/ash/workbench/contrib/preferences/README.md)。

工具目录和工具集由 [`ILanguageModelToolsService`](../src/ash/workbench/contrib/chat/common/tools/languageModelToolsService.ts) 提供，在 `chat.shared.contribution.ts` 注册，并由 Workbench 与 Sessions 的共享入口加载。对应的 `browser/tools/languageModelToolsService.ts` 将 App Server DTO 转换为可整体替换的只读快照；消费者先 `refresh()`，再使用 `getAllToolsIncludingDisabled()`、可观察 `toolSets` 和引用查询。并发刷新共享一次读取；断线、连接代次变化和释放会阻止旧结果进入快照。该服务不提供工具注册、启用或执行入口。

Skill 补全和聊天引用使用 `getFullReferenceNames()`、`getFullReferenceName()` 与 `getToolByFullReferenceName()`，工具集通过 `IToolSet.getTools()` 返回同一快照中的工具对象。来源组的引用名由来源类别与编码后的来源 ID 组成，空来源 ID 使用保留段 `@`，避免和后端工具名冲突；MCP 工具集使用 `/*`，外部工具引用带来源组前缀。后端工具 ID 保留为解析别名，工具选择和执行仍传后端 ID。Skill 的 `allowed-tools` 保持目录提示语义，不由前端授予权限。来源、权限和暴露方式是 Ash 元数据，尚未伪装为 VS Code 的完整 `ToolDataSource`。当前 `agent/capabilities/read` 没有模型参数或目录版本，未添加模型筛选。

后端在 `EnvToolPorts.replace` 成功安装且目录内容变化后，通过已有 `UpdateBroker` 和连接通知队列发送 `agent/tools/changed`。事件只到达同一 Environment 的连接，参数为空，不携带工具状态或版本。MCP 的工具列表变化、配置与插件重建、动态或扩展工具变化均复用这个安装入口；前端不依赖可能早于重建完成的配置通知。`LanguageModelToolsService` 收到通知后重新读取已使用的目录，在替换快照后触发 `onDidChangeTools`；读取期间收到多次通知，会合并为后续读取，旧结果不进入快照。已打开的工具引用与配置选择器订阅该事件，保留搜索、当前仍存在的选项和未提交的禁用选择；关闭释放订阅，连接失效清空列表，恢复连接后重读。

设置和 MCP 详情消费同一工具领域契约。Ash 专属的沙箱准备诊断和目录授权可读性保留在 [`IAgentCapabilitiesService`](../src/ash/platform/agentCapabilities/common/agentCapabilitiesService.ts)，目录授权数据仍归 `IWorkspaceTrustApi`。Preferences 的工具页与沙箱页分别读取所属服务，页面继续由 Preferences 呈现。

GitHub 设置页显示复用 Codex 登录和 Ash 的 GitHub 账号，检查指定仓库的访问权限，并链接官方 Connector 与自动审查管理页。Ash 的仓库访问成功不代表官方 Connector 已获授权。PR 页面使用 GitHub 账号发布 `@codex review` 请求，刷新及分页读取 PR 评论和审查讨论；发送结果不确定时，确认 GitHub 上的结果前不能再次提交。

## 打开路径

[`preferencesActions.ts`](../src/ash/workbench/contrib/preferences/browser/preferencesActions.ts) 注册四个打开命令。调用方通过 `IPreferencesService` 选择内容，服务再把相应的 `EditorInput` 交给 Workbench `EditorService`。`openSettings(options?: IOpenSettingsOptions)` 在 Workbench 和 Sessions 接受同一图形打开契约：`query` 指定搜索，`section` 指定 Ash 分类或区段，`jsonEditor` 选择 JSONC，`target` 只接受 `USER`/`USER_LOCAL`。未知选项、错误参数类型及未实现的配置目标在改变现有页面前被拒绝：

| 调用                                     | 打开的内容                                                  | 呈现位置     |
| ---------------------------------------- | ----------------------------------------------------------- | ------------ |
| `openSettings()`                         | `SettingsEditor`，由 `preferences.contribution.ts` 直接注册 | 模态编辑器组 |
| `openUserSettings({ jsonEditor: true })` | 当前用户设置的 JSONC 资源，由普通文本编辑器处理             | 普通编辑器组 |
| `openGlobalKeybindingSettings(false)`    | `KeybindingsEditor`，由 `preferences.contribution.ts` 注册  | 普通编辑器组 |
| `openGlobalKeybindingSettings(true)`     | 当前 profile 的 `keybindings.json` JSONC 资源               | 普通编辑器组 |

`workbench.action.openSettings` 命令接受查询字符串或上述选项对象，例如 `"editor.fontFamily"` 或 `{ "query": "@modified" }`；现有区段入口使用 `{ section: "models" }`。Workbench Preferences 服务持有固定资源输入；当前 pane 注册打开选项委托，清空输入或销毁时释放委托。查询直接进入该页面的搜索框，复用已打开页面时更新筛选并聚焦搜索；显式空查询清除筛选。未传 query 时保留页面原有搜索状态，区段定位仍清除筛选并显示对应区段。普通搜索同时匹配设置 ID 和说明，可继续编辑结果并沿原有配置链保存。关闭后搜索值随页面释放，配置值按既有持久化资源恢复。JSONC 的键定位继续使用 `openUserSettings({ jsonEditor: true, revealSetting: ... })`，不把图形查询作为 JSON 写入。

图形设置页从 Configuration Registry 取得可编辑设置，经 `SettingsEditorModel` 和 `settingsLayout.ts` 组成页面，再由设置控件读写配置服务。JSON 路径直接经通用文件服务读写同一 profile 的设置文件。两种设置入口共享配置数据，不共享页面容器。

“常规 → 显示语言”提供界面语言下拉框，列出内置语言和已安装语言包。设置页与“配置显示语言”命令共用语言服务，保存当前用户的 `workbench.locale`；重置设置会清除语言偏好。语言包列表变化时，下拉选项同步更新。设置搜索支持 `language`、`locale` 和“语言”。

配置注册表驱动、没有自有 binding 的设置项菜单还提供“复制设置为 JSON”。它复制可粘贴到 settings.json 对象内的 `"设置键": JSON值` 片段，不附带外层花括号。执行时重新读取当前本地用户配置值；没有用户值时使用当前窗口默认值，保留 false、0 和空字符串。对象与数组使用标准 JSON 序列化和两空格缩进，字符串自动转义。操作本身不保存配置；粘贴后的保存沿下述既有链路持久化。当前图形页面没有其他配置目标或语言覆盖筛选，因此本操作不复制这些范围的值。剪贴板失败沿现有设置状态反馈。

Sessions 设置项菜单使用对话框内的 ContextView，以便在模态设置页中接收键盘焦点。菜单与服务随对话框关闭释放；取消或执行菜单动作后，焦点回到对应的“更多操作”按钮。

Workbench 和 Sessions 图形设置共用 `@modified` 筛选：输入该标记，或在“筛选设置”中选择“已修改”，显示当前本地用户设置中存在覆盖值的设置。它可与文本和 `@id:` 组合使用；显式保存默认值、false、0 或空字符串仍算已修改。只存在于语言覆盖块中的值不算基础设置的覆盖，服务状态行也不进入结果。结果读取配置服务已接受的状态，成功保存、外部写入或重置立即更新；待完成或失败的保存保留原结果。Workbench 目录读取同一过滤结果；重置最后一个结果后，内容和目录同时显示空结果。关闭设置页释放监听，重新打开或重载后按同一持久化资源恢复。清除筛选条件保留普通搜索文本，不会修改配置。

配置注册表驱动、没有自有 binding 的设置行显示“已配置”标记，判断依据是当前本地用户覆盖是否存在；显式保存默认值仍显示标记，语言覆盖块不会标记基础设置。设置行通过单一无障碍说明提供同样信息，标记不进入 Tab 顺序。鼠标悬停说明复用现有 Hover 控件与该设置页的 ContextView，按 `workbench.hover.delay` 的当前值延迟显示；移除覆盖或销毁设置页会关闭悬停。外部配置保存立即更新状态；重置失败保留实际已保存的标记。样式复用现有主题颜色，不新增配置状态 owner。

配置注册表驱动的设置项菜单提供“在 JSON 中编辑”，复杂键值控件同时提供直接按钮。设置页调用 `openUserSettings({ jsonEditor: true, target: USER_LOCAL, revealSetting: { key, edit: true } })`。Preferences 服务取得编辑器共享的文件模型，在现有 JSONC 中定位顶层键；缺失键以注册默认值插入未保存的模型，保留注释、尾随逗号和其他键。普通编辑器打开固定标签，选择对应值并取得焦点。已有脏模型复用，插入支持撤销，不在打开入口中保存。使用自有 binding 的设置不提供此入口。

保存沿普通文本编辑器 → TextFileService／文本模型 save participant → 通用 `IFileService` → Disk／IndexedDB provider 写入当前 profile 的 `settings.json`。注册值 validator 属于 Preferences，通用文件 provider 不解释配置语义；非法值保留脏草稿和最后有效配置。文件 revision 与工作副本负责冲突和脏文件保护。配置服务的 Workspace／Folder 读写已接入，图形 Preferences 的打开目标仍只接受 `USER`／`USER_LOCAL`；两者是不同层的支持范围。Web 使用通用 IndexedDB 文件 provider，旧配置数据库只做一次性迁移。

代码名也按职责区分：`preferencesActions.ts`、`PreferencesService` 负责跨页面入口；`settingsEditorInput.ts`、`settingsModels.ts`、`settingsSearch.ts`、`settingsWidgets.ts` 和 `settingsRenderers.ts` 只处理设置内容。快捷键编辑器保留独立名称和模型。

快捷键图形编辑器的录制框按输入顺序收集最多四段组合键，复用现有 parser 和 resolver 的四段上限。打开已有绑定时先显示已保存值，首个录制组合键替换它；录满四段后，第五段开始新序列，并显示和朗读提示。在录制框中，裸 Enter 保存，裸 Escape 清空，再按一次取消；Tab 和 Shift+Tab 移动焦点。带修饰键的 Enter/Escape 可以录制；裸 Enter、Escape、Tab 及 Shift+Tab 绑定需在 JSON 编辑器中编辑。重复 keydown、IME 组合输入和纯修饰键不计为一段。保存期间禁用录制、条件、行操作和取消按钮，失败保留草稿并允许重试；取消后返回原行操作，原行已被替换时返回搜索框；保存完成后在焦点仍属于当前页面时聚焦搜索框，避免文件监听替换原行时丢失焦点。清空 input 或销毁 pane 后，保存结束不再向已退休的草稿反馈状态；隐藏页面或焦点已移到其他编辑器时不恢复焦点，也不阻止用户关闭编辑器。

录制草稿仅由 `KeybindingsEditor` 持有，保存和移除通过既有 `IKeybindingEditingService →` 当前 profile 的共享 JSONC 文件模型，保留注释、参数与其他绑定。`KeybindingsEditorInput` 创建并持有唯一 `KeybindingsEditorModel`，模型只管理行与服务监听；搜索值由各 pane 的搜索框持有，分屏共享模型时分别筛选。打开请求和每个 pane 分别保留输入引用，最后一个引用释放时，输入释放模型；重复打开、打开失败和取消不会遗留模型监听。恢复的普通资源输入在编辑器入口重建为相同输入类型。Ash 的 Editor Part 当前释放 pane，不自动释放传入的输入，因此引用规则位于 Preferences 内，不修改公共编辑器契约。文件系统 owner 负责持久化：Web 使用 `IndexedDBFileSystemProvider` 保存 `ash-userdata:/user/keybindings.json`；Electron 使用 `FileUserDataProvider`，经既有主进程文件通道写入当前 profile 的 `keybindings.json`。快捷键不经过 Settings 的配置键值 API，也不新增 AppServer 接口。

在保存一致性修复已进入 main 的基线 `2cc6ab4e` 上，recorder 13 项单元测试、严格 Web 7 项与 Electron 6 项通过；正常 Web/Desktop 构建、Automation 类型、格式与样式检查通过。真实 AppServer 验收读回当前 profile，覆盖两段与四段保存、JSONC 和参数保留、立即重载后的文本一致性与完整组合恰好执行一次、脏 JSON 失败重试，以及中文控制说明、Tab 焦点和第五段提示。pending-close 在真实 IndexedDB 事务或 Main 原子文件发布处暂停，关闭快捷键页后，完成或拒绝写入均不修改已销毁的 pane、不抢焦点；失败后重试写入实际文件。单元测试还覆盖保存等待期间 clearInput、隐藏、销毁和焦点转移各自的成功与失败路径。

早期 Web 严格重载失败由 editor/backup owner 修复：实际文件已有新值，但旧恢复备份曾被重新载入编辑器。历史失败证据保留；修复后原 recorder 场景与全程不打开 recorder 的对照均通过，未增加保存后等待备份删除，也未放宽文本断言。Web 备份仍由 `IndexedDbWorkingCopyBackupService` 持有，不经过 Rust backup RPC。此轮运行验证限定于 macOS Web/Electron Workbench，Windows 与 Linux 尚未运行；Web 保留 11 条、Electron 保留 9 条既有 Session catalog 与 syntax document 关闭期 console 错误，Electron 数量与类型和旧基线一致，所有场景的 page/forbidden errors 为 0。

样式也跟随创建页面的代码：[`settingsEditor.css`](../src/ash/workbench/contrib/preferences/browser/media/settingsEditor.css) 负责页面布局和状态提示，[`settingsTree.css`](../src/ash/workbench/contrib/preferences/browser/media/settingsTree.css) 负责分类树布局，[`settingsWidgets.css`](../src/ash/workbench/contrib/preferences/browser/media/settingsWidgets.css) 负责设置搜索框和设置项控件。

## Models 设置

以下描述当前行为与实现。`ModelSettingsContent` 和功能模块创建设置 widget 的接入属于尚未迁移的旧实现，不能作为新页面的架构范例；迁移须遵守 [Settings 接入与渲染边界](../src/ash/workbench/contrib/preferences/README.md) 并保留这些行为。

Workbench 和 Sessions 共用 `ModelSettingsContent`。模型目录按供应商排列，同一供应商内按发布时间从新到旧排列；默认收起为每家供应商的首个模型，`viewall models` 展开或收起完整列表。当前显示的列表将已开启模型排在前面，两组内部保持目录原序；关闭后回到未开启组中的原有位置，与开启先后无关。列表顶部的模型搜索框按名称和 `provider/model` ID 搜索整个目录，搜索结果使用同一排序规则，清空搜索后恢复展开状态；API key 区域不参与这个局部搜索。键盘切换开关后，保存完成时焦点留在同一个模型上。

`ModelCatalogConfiguration` 拥有模型开关的界面默认值：只开启 GPT-6.1 Sol、GPT-6 Astra、GPT-6 Luna、Claude Opus 5.5、Claude Sonnet 5.5 和 Grok 4.7。其他内置、后续新增及自定义模型默认关闭。手动修改由配置服务写入同一份用户设置，模型选择器通过 `ILanguageModelsService` 使用这些开关。

`models.hidden` 保存偏离默认值的选择。已有 `{ provider, model }` 条目继续表示关闭，新增 `{ provider, model, visible: true }` 条目表示开启默认关闭的模型；`visible` 仅接受布尔值。恢复某个模型的默认值时移除对应条目，不保存另一份模型目录。

模型管理文件参考 VS Code 的职责分工：

| 文件                                                                   | 职责                                                                   |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `workbench/contrib/chat/common/languageModels.ts`                      | 模型服务契约与实现；目录加载、供应商发现和测试操作，两个窗口各一个实例 |
| `workbench/contrib/chat/common/languageModelsConfiguration.ts`         | JSONC 设置声明、六个默认开启模型、模型开关数据格式                     |
| `workbench/contrib/chat/browser/languageModelsConfigurationService.ts` | 模型开关、默认模型及上一次选择的保存与事件                             |
| `workbench/contrib/chat/browser/chatManagement/chatModelsViewModel.ts` | 当前供应商的发现列表、手动声明、批量测试进度                           |
| `workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts`    | 供应商表单、模型表格、键盘操作与行内编辑                               |
| `workbench/contrib/chat/browser/modelSettingsContent.ts`               | 将模型管理接入两个窗口的设置树                                         |

API key 输入框失焦即保存，清空即移除；成功保存不弹通知，失败显示输入框错误并进入通知服务。密钥由后端 secret store 保存，界面只用掩码表示已配置状态。

`Test models` 测试当前表格全部模型，与启用开关无关；表格为空时先发现模型。`Refresh models` 重新发现，保留手动配置和启用选择。发现成功的空列表、尚未发现、发现失败是不同状态，失败保留之前成功的列表。批量测试逐行更新结果，最后只发一条汇总通知；橙点表示未通过，绿点表示通过，同时提供文字状态。探测通过不证明 1M 上下文可用。

`Add model` 添加 Model ID、上下文 token 数、可选上游 Model ID 与 1M 预设。上游 ID 映射只解析一次，由 Rust 在真正发送请求时使用；配置、开关和上下文绑定界面 ID。行内可编辑上下文和映射，也可删除手动声明；删除发现模型的手动上下文声明后，端点模型仍在表格中并关闭启用开关。Rust 的 models-manager 拥有发现与缓存，model-provider 拥有 HTTP 发现、分页和探测，成功发现的自定义模型进入聊天选择器。ChatService 只保留聊天、线程和 Advisor 配置操作。

## Configuration 的存储与配置层

UI 的 `settings.json` 由 TypeScript 配置系统解释；Rust `config.toml` 由后端配置领域解释，其宿主编辑入口不属于通用设置模型。设置读写沿 profile 的真实资源 → 通用文件 provider → 文件失效通知 → `UserSettings`／不可变 `ConfigurationModel` → Workbench、Sessions 和 Main 消费。配置专用 IPC、revision envelope、虚拟设置 provider 和浏览器旧持久化链已退出生产装配。

Main、听写和计量网络消费者读取 `IConfigurationService`。Preferences 首次打开缺失的设置文件时，以不覆盖方式创建普通 JSONC，竞争创建保留另一窗口内容。JSON 编辑取得编辑器共享的文件模型；定位或插入注册默认值只修改未保存模型，支持撤销，不在打开入口保存。外部非法 JSONC 保留最后有效快照；内容 revision 归文件服务，配置层不保存另一份文件版本。

| 负责方                                                        | 职责                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| platform `configurationModels.ts`／`ConfigurationModelParser` | 值树、语言覆盖、模型合并与不可变快照；Workbench 复用 `parseRaw`               |
| platform `configurationService.ts`／`UserSettings`            | 单资源读取、文件失效和父目录提示；Windows 比较按文件系统大小写规则            |
| Workbench `configurationService.ts`                           | 组合各配置层，resource／folder 解析、inspection、keys、写入目标与资源定向事件 |
| Workbench `configuration.ts`                                  | Workspace／Folder 的 JSONC 源文本、watch、条件写入和切换生命周期              |
| Sessions `configurationService.ts`                            | 消费动态 registry 的窗口默认值和只读规则，不缓存第二套元数据                  |
| profile／通用文件 provider／工作副本                          | 设置资源身份、存储、revision、脏模型、save／revert 与外部冲突                 |

多根 Workspace 读工作区文件的 `settings` 对象；Folder 读所属根的 `.vscode/settings.json`；单目录窗口把后者解释为 Workspace 层。默认 → 用户 → Workspace → Folder 的普通值先组合，再应用语言覆盖，Policy 最后覆盖。单语言覆盖优先于组合语言覆盖；对象按成员合并，数组整体替换。保存的旧事件和快照不随后续更新改变。

Workspace 排除 application／machine 设置，Folder 进一步排除 window 设置；Sessions 固定值在用户、Workspace、Folder 和语言覆盖中均被过滤。动态贡献的注册、撤回和重注册即时重建默认值与只读规则。写入只修改目标属性，保留其他字段和注释；无显式目标时选已有最高层，删除时遍历已有层。脏工作副本先经原 owner save／revert；文件 revision 拒绝并发冲突。切换工作区立即撤回旧 watcher 和写入信号，迟到读取不能进入新选择。

## Policy 来源

Policy 的定义注册、值校验、最高优先级、写入限制和撤回均进入现有配置链。非法更新保留同一 setting／policy 身份的上次有效值；明确删除才撤回。系统来源和窗口组合来源分别归各自作用域的一个 policy service。

| 系统    | Desktop Main 的来源                                   |
| ------- | ----------------------------------------------------- |
| Windows | `HKLM\SOFTWARE\Policies\Ash`，DWORD 0／1 对应 boolean |
| macOS   | `/Library/Managed Preferences/com.ash.desktop.plist`  |
| Linux   | `/etc/ash/policies.json`                              |

Windows／macOS 的进程级 `SystemPolicyService` 每 2 秒检查变化，命令有 timeout、输出上限、退出取消及隐藏窗口；Linux 走文件 watcher。Workbench／Sessions 通过只读 `PolicyChannelClient` 消费 Main 的值，IPC 不开放任意路径或策略写入。策略定义不能在窗口间改变既有类型。`DesktopUpdateChannel` 映射 `update.policy` 的 `latest`／`stable`／`never`。

账户来源沿 primary grant → `IGitHubService.readManagedSettings(accountId)` → 可取消 App Server 请求 → `github/account/managedSettings` → 该账户的 GitHub client → `/copilot_internal/managed_settings`。协议只收账户及 operation ID，不收凭据或自定义 URL。HTTP 404／空对象撤回；权限、网络和非法输入保留同一账户的最后有效快照。登录切换取消旧请求，退出清空，迟到结果不能恢复旧账户策略；当前账户每分钟刷新。

`AccountPolicyService` 只解释 registry 声明的映射。`ChatDefaultModel` 将顶层 `model` 或旧 `permissions.model` 映射到 `chat.defaultModel`；顶层非空字符串优先，空白视为缺省。实际选择仍由模型目录和聊天偏好服务负责。`ChatAIDisabled` 仅为系统策略，不伪造 Copilot 字段。`MultiplexPolicyService` 组合系统优先、账户其次；映射函数留在 renderer，Main 只传类型声明和策略值。

## 页面与公开契约的边界

Ash 当前 `SettingsEditor` 直接在模态组打开，没有把上游 Preferences 容器、pane registry 和全部公开 API 视为已实现。Preferences 支持 query／section、本地用户目标、JSON 选择和键定位；folder、焦点模式、编辑器组选项等仍需实际调用链。配置服务已支持 Workspace／Folder 不等于这些图形入口已齐全。

`SettingsSearchQuery` 支持普通文本、ID、`@id:` 和 `@modified`；其他过滤条件不宣称兼容。显式保存默认标量或对象仍是用户覆盖，Reset 删除对应键并保留其他 JSONC；自有 binding 可提供 `isDefault()`。设置操作、状态、无障碍标签和失败文案使用 NLS，英文／中文已有回归。

`DefaultSettings` 收集产品和扩展 schema；registry 变化更新目录，扩展名称来自本地化 manifest。移除扩展保留已保存值。图形页、目录、控件继续归 Preferences；密钥、账号授权、模型发现和 Hook 执行保留各自领域 owner。剩余任务见 [Configuration / Preferences TODO](../TODO.md#configuration--preferences--todo)。

## 已有验证与限制

配置文件迁移曾覆盖 44 个单测文件约 977 项；最终提交前定向运行覆盖 159 个不同用例。旧链清理后模型、文件 IPC、Sessions、Settings JSONC 和层级边界 47 项通过；真实 Chromium 的旧 IndexedDB 迁移 6 项通过，覆盖冲突、非法输入、中断重试及无旧数据。Main、Renderer、生成协议、unit／browser／automation 源码类型检查及前端构建按原批次通过。英文／中文配置及本地化初始化有测试覆盖。

Workspace／Folder／Policy 的定向 74 项覆盖 precedence、inspection、作用域、JSONC、切换与迟到读取、冲突和脏保护。系统与账户来源 12 项、GitHub HTTP 2 项、账户只读／取消协议 1 项通过，包括真实 Windows 固定路径只读探测。macOS／Linux 真实 OS 来源和真实登录账户尚未验收。

端到端 smoke 的辅助 live 选区位置和 Appearance `ash-dark` 选项错误仍未闭合，影响外部更新、非法保存、脏草稿与冲突场景的最终 diagnostics。准备阶段还曾有 App Server 文件访问 API 编译阻塞；这些不能记为通过，也不能由更早的 Settings JSON Browser／Electron smoke 通过记录代替。后续以 TODO 的复核和完整重跑为准，本文不声称当前 HEAD 或全部上游契约通过。
