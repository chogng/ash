# Preferences 与 Settings 的职责

> 适用范围：Ash TypeScript Workbench 的偏好入口和编辑页面。配置数据的存储边界见 [Browser foundation 的配置架构](browser-foundation.md#configuration-architecture)。

**Preferences 是入口范围，Settings 是其中一种内容。** Workbench 的偏好入口负责让用户打开设置、直接编辑用户设置 JSON，以及编辑键盘快捷键。图形设置页、JSON 编辑器和快捷键编辑器各自处理自己的内容；它们不需要共同的 `PreferencesEditor` 页面容器。

| 职责 | 当前做法 | 不负责 |
| --- | --- | --- |
| 偏好入口 | [`IPreferencesService`](../src/ash/workbench/services/preferences/common/preferences.ts) / [`PreferencesService`](../src/ash/workbench/services/preferences/browser/preferencesService.ts) 根据调用的方法打开对应资源 | 绘制设置项或保存配置值 |
| 图形设置页 | [`SettingsEditor`](../src/ash/workbench/contrib/preferences/browser/settingsEditor.ts) 显示搜索、分类和设置控件；[`settingsLayout.ts`](../src/ash/workbench/contrib/preferences/browser/settingsLayout.ts) 决定已注册设置放在哪个分类 | 保存配置源或管理普通文本模型 |
| 用户设置 JSON | 普通文本编辑器打开 `ash-settings:/user/settings.json`；[`SettingsFileSystemProvider`](../src/ash/workbench/contrib/preferences/common/settingsFilesystemProvider.ts) 读写当前用户设置源 | 在图形设置页内部维护另一份配置 |
| 键盘快捷键 | [`KeyboardShortcutsEditor`](../src/ash/workbench/contrib/preferences/browser/keyboardShortcutsEditor.ts) 使用自己的输入和模型；快捷键资源独立于普通配置键值 | 充当设置页的子页面 |

## 打开路径

`preferencesActions.ts` 注册三个命令。调用方通过 `IPreferencesService` 选择要打开的内容，服务再把相应的 `EditorInput` 交给 Workbench `EditorService`：

| 调用 | 打开的内容 | 呈现位置 |
| --- | --- | --- |
| `openSettings()` | `SettingsEditor`，由 `preferences.contribution.ts` 直接注册 | 模态编辑器组 |
| `openUserSettings()` | 当前用户设置的 JSONC 资源，由普通文本编辑器处理 | 普通编辑器组 |
| `openKeybindings()` | `KeyboardShortcutsEditor`，独立注册 | 普通编辑器组 |

图形设置页从 Configuration Registry 取得可编辑设置，经 `SettingsEditorModel` 和 `settingsLayout.ts` 组成页面，再由设置控件读写配置服务。JSON 路径经 `SettingsFileSystemProvider` 读写同一份用户设置源。两种设置入口共享配置数据，不共享页面容器。

“常规 → 显示语言”提供界面语言下拉框，列出内置语言和已安装语言包。设置页与“配置显示语言”命令共用语言服务，保存当前用户的 `workbench.locale`；重置设置会清除语言偏好。语言包列表变化时，下拉选项同步更新。设置搜索支持 `language`、`locale` 和“语言”。

配置注册表驱动的设置项菜单提供“在 JSON 中编辑”，复杂键值控件同时提供直接按钮。设置页调用 `openUserSettings({ target: USER_LOCAL, revealSetting: { key, edit: true } })`。Preferences 服务取得编辑器共享的文件模型，在现有 JSONC 中定位顶层键；缺失键以注册默认值插入未保存的模型，保留注释、尾随逗号和其他键。普通编辑器打开固定标签，选择对应值并取得焦点。已有脏模型复用，插入支持撤销，不在打开入口中保存。使用自有 binding 的设置不提供此入口。

保存沿普通文本编辑器 → TextFileService → SettingsFileSystemProvider → ConfigurationResourceService → 配置 API 写入同一份用户配置。配置变更事件驱动主题和编辑器立即刷新；保存使用模型读取时的修订号，真实外部修改会进入现有保存冲突处理。无效 JSONC 或注册值被拒绝，已生效配置保持原值，未保存文本仍留在编辑器。当前只支持 `USER` 与 `USER_LOCAL`，工作区和远程用户目标尚未实现。Electron 持久化到当前 profile 的 `settings.json`，Web 持久化到现有 IndexedDB 配置存储。

代码名也按职责区分：`preferencesActions.ts`、`PreferencesService` 负责跨页面入口；`settingsEditorInput.ts`、`settingsModels.ts`、`settingsSearch.ts`、`settingsWidgets.ts` 和 `settingsRenderers.ts` 只处理设置内容。快捷键编辑器保留独立名称和模型。

样式也跟随创建页面的代码：[`settingsEditor.css`](../src/ash/workbench/contrib/preferences/browser/media/settingsEditor.css) 负责页面布局和状态提示，[`settingsTree.css`](../src/ash/workbench/contrib/preferences/browser/media/settingsTree.css) 负责分类树布局，[`settingsWidgets.css`](../src/ash/workbench/contrib/preferences/browser/media/settingsWidgets.css) 负责设置搜索框和设置项控件。

## Models 设置

Workbench 和 Sessions 共用 `ModelSettingsContent`。模型按供应商分组，同一供应商内按发布时间从新到旧排列；默认收起为每家供应商的首个模型，`viewall models` 展开或收起完整列表。列表顶部的模型搜索框按名称和 `provider/model` ID 搜索整个目录，清空搜索后恢复展开状态；API key 区域不参与这个局部搜索。

`ModelCatalogConfiguration` 拥有模型开关的界面默认值：只开启 GPT-6.1 Sol、GPT-6 Astra、GPT-6 Luna、Claude Opus 5.5、Claude Sonnet 5.5 和 Grok 4.7。其他内置、后续新增及自定义模型默认关闭。手动修改由配置服务写入同一份用户设置，模型选择器通过 `ILanguageModelsService` 使用这些开关。

`models.hidden` 保存偏离默认值的选择。已有 `{ provider, model }` 条目继续表示关闭，新增 `{ provider, model, visible: true }` 条目表示开启默认关闭的模型；`visible` 仅接受布尔值。恢复某个模型的默认值时移除对应条目，不保存另一份模型目录。

模型管理文件参考 VS Code 的职责分工：

| 文件 | 职责 |
| --- | --- |
| `workbench/contrib/chat/common/languageModels.ts` | 模型目录、供应商操作的界面契约 |
| `workbench/contrib/chat/browser/languageModelsService.ts` | 目录加载、供应商发现和测试接口，两个窗口各一个实例 |
| `workbench/contrib/chat/common/languageModelsConfiguration.ts` | JSONC 设置声明、六个默认开启模型、模型开关数据格式 |
| `workbench/contrib/chat/browser/languageModelsConfigurationService.ts` | 模型开关、默认模型及上一次选择的保存与事件 |
| `workbench/contrib/chat/browser/chatManagement/chatModelsViewModel.ts` | 当前供应商的发现列表、手动声明、批量测试进度 |
| `workbench/contrib/chat/browser/chatManagement/chatModelsWidget.ts` | 供应商表单、模型表格、键盘操作与行内编辑 |
| `workbench/contrib/chat/browser/modelSettingsContent.ts` | 将模型管理接入两个窗口的设置树 |

API key 输入框失焦即保存，清空即移除；成功保存不弹通知，失败显示输入框错误并进入通知服务。密钥由后端 secret store 保存，界面只用掩码表示已配置状态。

`Test models` 测试当前表格全部模型，与启用开关无关；表格为空时先发现模型。`Refresh models` 重新发现，保留手动配置和启用选择。发现成功的空列表、尚未发现、发现失败是不同状态，失败保留之前成功的列表。批量测试逐行更新结果，最后只发一条汇总通知；橙点表示未通过，绿点表示通过，同时提供文字状态。探测通过不证明 1M 上下文可用。

`Add model` 添加 Model ID、上下文 token 数、可选上游 Model ID 与 1M 预设。上游 ID 映射只解析一次，由 Rust 在真正发送请求时使用；配置、开关和上下文绑定界面 ID。行内可编辑上下文和映射，也可删除手动声明；删除发现模型的手动上下文声明后，端点模型仍在表格中并关闭启用开关。Rust 的 models-manager 拥有发现与缓存，model-provider 拥有 HTTP 发现、分页和探测，成功发现的自定义模型进入聊天选择器。ChatService 只保留聊天、线程和 Advisor 配置操作。

## 为什么没有 PreferencesEditor 容器

Workbench 已有编辑器组负责打开、切换和管理不同编辑器。当前三个偏好入口打开的是不同内容：图形设置、JSON 文件和快捷键。再加一层只承载图形设置页的 `PreferencesEditor`，会重复管理页面创建、搜索、布局和生命周期，却没有实际的多页面切换职责。因此 `SettingsEditor` 直接实现编辑器页面契约；偏好范围仍由 `IPreferencesService` 负责。

这一分工不要求所有偏好内容共用一个页面，也不要求所有用户偏好都存成普通设置。新增入口时先确定内容和数据的所有者，再由偏好服务提供确实需要的打开方法。
