# Settings 接入与渲染边界

功能模块注册配置项，Preferences 根据配置数据统一建模和渲染。功能模块不得为设置页提供 DOM、widget 或渲染回调。此规则适用于 Workbench 和 Sessions 的设置入口，包括普通配置、账号状态、管理操作和复杂设置区域。

本文是设置接入的职责约束。现有实现尚未全部符合这些约束；未迁移的实现不能作为新增接入的范例。偏好入口、JSON 编辑与存储路径见 [Preferences 与 Settings 的职责](../../../../../docs/preferences-and-settings.md)。

该文档的 [VS Code 对照与待处理项](../../../../../docs/preferences-and-settings.md#与-vs-code-的对照与待处理项) 维护当前能力差异和已确认缺陷。本文维护接入规则，不重复保存上游文件清单或把目标架构描述成已有实现。

## 职责归属

| 所有者                            | 负责的内容                                                                                     |
| --------------------------------- | ---------------------------------------------------------------------------------------------- |
| 功能模块                          | 注册配置项及其语义；提供领域状态、数据变更事件和操作；消费配置并执行功能                       |
| Configuration Registry / 配置服务 | 配置定义、默认值、值校验、配置读取和写入；沿既有配置源持久化                                   |
| Preferences                       | 将注册配置和领域数据组成设置模型；统一搜索、分类、导航、控件、布局、主题、键盘与无障碍交互     |
| Workbench / Sessions 宿主         | 打开和关闭设置入口、提供窗口与导航上下文、管理页面生命周期；复用 Preferences 的模型和 renderer |

Preferences 拥有设置页的呈现模型，不接管领域业务状态。配置值、账号授权、远端状态和密钥仍由各自的服务持有，不能在页面中再保存一份独立的真值。

## 普通配置：注册 schema，布局引用 setting ID

1. 功能模块在所属的配置注册入口声明稳定的 setting ID、类型、默认值、校验、作用域及可翻译的名称与说明。注册定义是配置语义的唯一来源。
2. Preferences 的分类布局引用已注册的 setting ID，指定分组与顺序。布局不重复声明默认值或业务校验，也不携带页面 DOM。
3. Preferences 从注册表解析配置定义，结合配置服务中的值构造设置项模型，再由共享 renderer 选择控件。功能模块不手工构造开关、输入框或设置行。
4. 用户修改经配置服务写入既有配置源，功能模块订阅配置变化并应用行为。重置恢复注册默认值；图形设置与 JSON 编辑使用同一份配置数据。

例如，一个布尔配置的接入链路是：功能模块注册配置 → 布局引用 setting ID → Preferences 构造布尔设置模型并渲染开关 → 配置服务保存 → 功能模块应用新值。功能模块无需提供一张设置页面。

主要入口是 [Configuration Registry](../../../platform/configuration/common/configurationRegistry.ts)、[Settings 模型](../../services/preferences/common/settingsModels.ts)、[分类布局](browser/settingsLayout.ts) 和 [设置 renderer](browser/settingsRenderers.ts)。普通配置不得绕过这条链路，另造一套仅在图形页面中可用的读写与渲染机制。

## 非配置内容：提供数据和操作

账号登录状态、仓库访问检查、临时输入和外部管理操作不是持久化配置。不要为了让它们出现在设置页而编造 setting ID，也不要把密钥或远端权限状态写入普通用户设置。

功能模块通过数据契约提供稳定的字段标识、文字、值、选项、可用状态、变更事件和领域操作。操作可以调用所属服务，但不得接收 DOM 容器或负责创建控件。Preferences 将这些数据纳入设置模型，统一处理搜索、控件更新、焦点、错误呈现和无障碍交互。

当前 [SettingsSectionModel](browser/settingsTreeModels.ts) 与 [SettingsSectionRenderer](browser/settingsSectionRenderer.ts) 提供了非配置内容的数据和渲染分离路径。它们是当前接入入口，不表示全部旧页面已经迁移，也不要求为每个功能重新发明一套字段协议。数据契约的扩展应由具体需求驱动，并保持在 Preferences 的呈现边界内。

## 禁止把页面实现穿过接入边界

功能模块向 Preferences 提供的配置或数据契约不得包含：

- `HTMLElement`、`domNode`、`titleDomNode` 等页面节点。
- widget 实例、DOM 容器参数、创建 DOM 的工厂或 `render(container)` 回调。
- 设置页专用的 CSS 类名、布局指令或由功能模块维护的控件生命周期。
- 表面上名为 Model、实际仍持有或返回设置页 DOM 的对象。

需要表格、列表或更复杂的编辑控件时，先确定领域数据与操作，再扩展 Preferences 的模型和共享 renderer。renderer 在 Preferences 内部可以创建 DOM、复用基础控件并拥有对应 CSS；它不能把领域模块提供的完整页面挂进设置树。

仅把 `*SettingsContent` 改名为 `*SettingsModel`，或把功能页面包进一个通用容器，都没有修复职责边界。判断标准是功能模块是否只提供配置、数据与操作，页面是否由 Preferences 建模并渲染。

## 生命周期与两个设置宿主

Workbench 与 Sessions 复用同一配置定义、领域数据契约和 Preferences renderer，不分别实现同一设置区域的页面。每个宿主可以拥有自己的页面实例；共享的是契约与实现，不是跨窗口共享 DOM。

Preferences 负责页面控件、监听、焦点与其他 UI 资源的释放。页面可见性和销毁通过数据契约通知领域模型；领域模型负责相应读取任务的取消、请求资源的释放和迟到结果失效。账号或目标变化后，旧结果不能更新新的状态。隐藏页面是否停止其他正在执行的领域操作，按该操作的既有契约决定，不能由 renderer 擅自改变。

配置何时生效、是否需要重载以及失败如何反馈，由配置或领域契约说明。Preferences 负责呈现这些信息，不在控件中复制领域规则。

## 当前迁移债务

现有 `SettingsContent` / `SettingsContentItem` 和 `titleDomNode` 允许接入 DOM，部分设置区域还由功能模块创建 widget。这些是需要迁移的旧接口，不是本规则的例外。新增接入不得沿用；修改相关区域时应将配置注册、领域数据和 Preferences 渲染的职责拆清。

GitHub 已通过 `GitHubSettingsModel` 和共享 `SettingsSectionRenderer` 分离领域数据与页面。Models、Advisor、Skills、Hooks、Language Server、Dictation 等仍有功能模块的页面实现；Sessions 也仍手工组装部分 `ISetting`。复用旧 widget 不等于已经复用注册表驱动的模型和统一 renderer。迁移状态须按真实生产链路判断。

迁移应保留原有行为、配置源、搜索、焦点与无障碍能力，同时迁移调用方和对应验证。不能只换文件名、删掉已有覆盖，或再引入一套并行配置存储。本文记录目标职责；本次文档变更没有完成这些旧实现的迁移。

## 接入核对

- 配置注册已进入实际产品加载链路，布局引用的 setting ID 能在注册表中解析，默认值、校验和作用域只有一个来源。
- 功能模块的设置接入只提供配置、数据与操作，不传入 DOM、widget、CSS 或渲染回调。
- Preferences 统一处理搜索、分类、修改、重置和配置错误；非配置状态与操作也参与适用的导航和交互。
- Workbench 与 Sessions 复用同一模型和 renderer；验证相关入口，而非只验证局部控件。
- 代码变更按对应范围验证 Web 与 Electron 的实际行为，包括键盘、焦点、无障碍帮助和非默认语言；涉及异步状态时验证隐藏、销毁及账号或目标变化后的结果失效。
