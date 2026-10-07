# Preferences 与 Settings 的职责

> 适用范围：Ash TypeScript Workbench 的偏好入口和编辑页面。配置数据的存储边界见 [Browser foundation 的配置架构](browser-foundation.md#configuration-architecture)。

**Preferences 是偏好入口范围，Settings 是其中一种内容。** 当前 Ash 的图形设置、用户设置 JSONC、快捷键图形编辑器和快捷键 JSONC 分别打开。配置读取与持久化已有共享链路，但这不表示 Preferences 的公开契约和页面组织已经与 VS Code 对齐。设置接入的目标约束见 [Settings 接入与渲染边界](../src/ash/workbench/contrib/preferences/README.md)。

| 职责          | 当前做法                                                                                                                                                                                                                              | 不负责                         |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| 偏好入口      | [`IPreferencesService`](../src/ash/workbench/services/preferences/common/preferences.ts) / [`PreferencesService`](../src/ash/workbench/services/preferences/browser/preferencesService.ts) 根据调用的方法打开对应资源                 | 绘制设置项或保存配置值         |
| 图形设置页    | [`SettingsEditor`](../src/ash/workbench/contrib/preferences/browser/settingsEditor.ts) 显示搜索、分类和设置控件；[`settingsLayout.ts`](../src/ash/workbench/contrib/preferences/browser/settingsLayout.ts) 决定已注册设置放在哪个分类 | 保存配置源或管理普通文本模型   |
| 用户设置 JSON | 普通文本编辑器打开 `ash-settings:/user/settings.json`；[`SettingsFileSystemProvider`](../src/ash/workbench/contrib/preferences/common/settingsFilesystemProvider.ts) 读写当前用户设置源                                               | 在图形设置页内部维护另一份配置 |
| 键盘快捷键    | [`KeyboardShortcutsEditor`](../src/ash/workbench/contrib/preferences/browser/keyboardShortcutsEditor.ts) 使用自己的输入和模型；快捷键资源独立于普通配置键值                                                                           | 充当设置页的子页面             |

## 设置内容与渲染

功能模块注册配置项，分类布局引用 setting ID，由 Preferences 统一建模和渲染。账号状态与管理操作通过数据契约接入。功能模块不得提供设置页 DOM、widget 或渲染回调；完整职责约束和旧接口迁移边界见 [Settings 接入与渲染边界](../src/ash/workbench/contrib/preferences/README.md)。

GitHub 设置页显示复用 Codex 登录和 Ash 的 GitHub 账号，检查指定仓库的访问权限，并链接官方 Connector 与自动审查管理页。Ash 的仓库访问成功不代表官方 Connector 已获授权。PR 页面使用 GitHub 账号发布 `@codex review` 请求，刷新及分页读取 PR 评论和审查讨论；发送结果不确定时，确认 GitHub 上的结果前不能再次提交。

## 打开路径

[`preferencesActions.ts`](../src/ash/workbench/contrib/preferences/browser/preferencesActions.ts) 注册四个打开命令。调用方通过 `IPreferencesService` 选择内容，服务再把相应的 `EditorInput` 交给 Workbench `EditorService`。`openSettings(target?: string)` 的字符串表示分类或区段，不是 `ConfigurationTarget`：

| 调用                                  | 打开的内容                                                  | 呈现位置     |
| ------------------------------------- | ----------------------------------------------------------- | ------------ |
| `openSettings()`                      | `SettingsEditor`，由 `preferences.contribution.ts` 直接注册 | 模态编辑器组 |
| `openUserSettings()`                  | 当前用户设置的 JSONC 资源，由普通文本编辑器处理             | 普通编辑器组 |
| `openGlobalKeybindingSettings(false)` | `KeyboardShortcutsEditor`，独立注册                         | 普通编辑器组 |
| `openGlobalKeybindingSettings(true)`  | 当前 profile 的 `keybindings.json` JSONC 资源               | 普通编辑器组 |

图形设置页从 Configuration Registry 取得可编辑设置，经 `SettingsEditorModel` 和 `settingsLayout.ts` 组成页面，再由设置控件读写配置服务。JSON 路径经 `SettingsFileSystemProvider` 读写同一份用户设置源。两种设置入口共享配置数据，不共享页面容器。

“常规 → 显示语言”提供界面语言下拉框，列出内置语言和已安装语言包。设置页与“配置显示语言”命令共用语言服务，保存当前用户的 `workbench.locale`；重置设置会清除语言偏好。语言包列表变化时，下拉选项同步更新。设置搜索支持 `language`、`locale` 和“语言”。

配置注册表驱动的设置项菜单提供“在 JSON 中编辑”，复杂键值控件同时提供直接按钮。设置页调用 `openUserSettings({ target: USER_LOCAL, revealSetting: { key, edit: true } })`。Preferences 服务取得编辑器共享的文件模型，在现有 JSONC 中定位顶层键；缺失键以注册默认值插入未保存的模型，保留注释、尾随逗号和其他键。普通编辑器打开固定标签，选择对应值并取得焦点。已有脏模型复用，插入支持撤销，不在打开入口中保存。使用自有 binding 的设置不提供此入口。

保存沿普通文本编辑器 → TextFileService → SettingsFileSystemProvider → ConfigurationResourceService → 配置 API 写入同一份用户配置。配置变更事件驱动主题和编辑器立即刷新；保存使用模型读取时的修订号，真实外部修改会进入现有保存冲突处理。无效 JSONC 或注册值被拒绝，已生效配置保持原值，未保存文本仍留在编辑器。当前只支持 `USER` 与 `USER_LOCAL`，工作区和远程用户目标尚未实现。Electron 持久化到当前 profile 的 `settings.json`，Web 持久化到现有 IndexedDB 配置存储。

代码名也按职责区分：`preferencesActions.ts`、`PreferencesService` 负责跨页面入口；`settingsEditorInput.ts`、`settingsModels.ts`、`settingsSearch.ts`、`settingsWidgets.ts` 和 `settingsRenderers.ts` 只处理设置内容。快捷键编辑器保留独立名称和模型。

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

## 与 VS Code 的对照与待处理项

2026-10-07 对照本地 `../vscode` 的 `e7bc1cca4bc` 检查了 `workbench/services/preferences` 和 `workbench/contrib/preferences` 的生产文件、注册入口、配置 owner 和相关测试。以下是实现现状与差异，不是批量新增文件或照搬上游实现的计划。

| 范围     | VS Code                                                                                                                                            | Ash 当前状态与影响                                                                                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 页面组织 | `openPreferences()` 打开已注册的 `PreferencesEditor`；pane registry 负责页签、共享搜索与子页面生命周期。`openSettings(options)` 另有图形/JSON 路径 | `SettingsEditor` 直接打开到模态组。没有对应容器和 pane registry；这是实际差异，不能断言上游容器没有职责或必然多余                                                                                    |
| 打开契约 | `IOpenSettingsOptions` 包含配置目标、query、JSON 选择、folder URI、焦点与编辑器组等选项                                                            | `openSettings()` 仅接受区段字符串；`openUserSettings()` 仅支持用户目标和顶层键定位。配置目标、搜索条件与区段定位尚未形成同一公开契约                                                                 |
| 配置目标 | Application、Local User、Remote User、Workspace、Folder 及语言设置入口                                                                             | 当前持久化写入限于 `USER`/`USER_LOCAL`；用户 JSONC 支持合法的语言覆盖块。资源级写入、远程和工作区目标未实现，不能把枚举或空配置层当作能力完成                                                        |
| 设置目录 | 配置 schema 进入设置模型；模型支持变更事件，渲染根据目标与配置状态更新                                                                             | `DefaultSettings` 只收集声明了 `.setting` 元数据的键；设置模型在创建时固定。布局未匹配到任一此类键会抛错。适用于当前静态目录，尚不是动态配置贡献链路                                                 |
| 搜索     | 支持配置状态、语言、扩展等语义过滤                                                                                                                 | 当前 `SettingsSearchQuery` 支持普通文本和 `@id:`；`@modified`、`@lang:` 等会被当作普通文本。不能声明支持上游全部过滤条件                                                                             |
| 领域内容 | 配置系统保持配置语义，各领域保留业务状态                                                                                                           | GitHub 已使用领域数据模型和共享 `SettingsSectionRenderer`；Models、Hooks、Skills 等仍以 `SettingsContent` 接入控件。Workbench 与 Sessions 共享部分 renderer 和内容实现，但 Sessions 仍手工组织设置项 |

### 已修复缺陷

- **显式默认值可以从图形界面重置。** 配置 binding 通过 `inspect().userLocalValue` 判断是否存在用户覆盖；即使保存的标量或结构化值等于默认值，Reset 仍可用，执行后删除对应键并保留 JSONC 注释和其他设置。`SettingValueBinding.isDefault()` 是可选的，自有领域 binding 可提供自己的默认状态判断；未提供时保留原有值比较语义。显示语言与更新策略的配置 binding 也使用显式覆盖判断。该判断对应当前实际支持的用户配置目标，新增其他目标时须同步读取和重置目标。
- **设置操作与状态文案已接入 NLS。** More actions、Reset、Copy Setting ID、搜索筛选菜单、保存状态及其无障碍标签、数字范围校验和操作失败的兜底文案使用 `ash.settings` 文案。中文回归覆盖菜单、保存中状态、输入禁用与恢复、校验反馈；后端或用户提供的错误信息保持原文。

### 文件职责的对应关系

| 当前 Ash 文件                                                                                        | VS Code 对应职责                                                                    | 审查结论                                                               |
| ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `services/preferences/common/settingsEditorInput.ts`、`settingsModels.ts`                            | `preferencesEditorInput.ts`、`preferencesModels.ts`                                 | 路径与公开契约存在差异；不能把所有差异都解释成内容命名选择             |
| `contrib/preferences/browser/settingsEditor.ts`                                                      | `settingsEditor2.ts`；另有 `preferencesEditor.ts` 与 `preferencesEditorRegistry.ts` | 图形设置和偏好容器分别核对实际调用链，不能只补同名外壳                 |
| `settingsRenderers.ts`、`settingsSearch.ts`                                                          | `preferencesRenderers.ts`、`preferencesSearch.ts`                                   | 渲染与搜索能力尚未完全对齐                                             |
| `keyboardShortcutsEditor.ts`、`keyboardShortcutsEditor.contribution.ts` 及 CSS                       | `keybindingsEditor.ts`、`keybindingsEditorContribution.ts` 及 CSS                   | 当前快捷键编辑器已有独立生产入口；名称和契约迁移须连同调用方、测试处理 |
| `settingsSectionRenderer.ts`、`networkSettingsContent.ts`、`agentCapabilitiesSettings.ts` 及自有样式 | 无同路径文件                                                                        | Ash 特有的数据呈现与管理内容；本次仅记录，不改名、移动或删除           |

配置源仍由配置 owner 管理。对齐页面与 API 时，不应将密钥、账号授权、模型发现、Hook 执行或临时 UI 状态改存为普通设置，也不应建立另一套持久化服务。

### 本次验证范围

初次审查时，27 个 Preferences 定向单元测试通过，并以实际 `WorkbenchConfigurationService → configurationSettingBinding → SettingModel` 链路复现了显式默认值的 Reset 缺陷。[Settings JSON Playwright 测试](../test/smoke/areas/windows/settings-json.spec.ts) 的 JSON 定位、保存与中文标签流程，以及无效值与保存冲突流程，在 Browser UI 和 Electron UI 各通过一次；当时 Web 和 Desktop 构建成功。

修复后，Preferences 与 Sessions 配置相关的 34 个定向单元测试通过，新增覆盖显式标量和结构化默认值的重置、JSONC 保留、自有 binding、中文操作和保存状态。新增英文与中文 Browser UI 回归通过，验证重置菜单资格、键盘操作、焦点恢复、筛选菜单和 JSONC 保留；使用开发服务器运行当前源码。Renderer 类型检查和本地化完整性检查通过。当前 Desktop 构建被工作区并行协议改动产生的 `app-server-protocol` 包阻塞：500135 字节超过 500000 字节上限，因此新增 Electron 回归尚未运行。以上验证不表示已经完成上游运行时验证或全部能力对齐。
