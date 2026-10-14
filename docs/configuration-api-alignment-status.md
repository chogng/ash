# Configuration 职责对齐

## 当前边界

TypeScript 的 `settings.json` 由配置系统解释。后端的 `config.toml` 继续由 Rust 配置领域解释；打开该文件的宿主入口不属于通用设置模型。

本地参照为 `../vscode/src/vs`。公开路径、契约和行为用于确认职责，Ash 实现独立编写。

## 当前迁移：文件资源与配置传输

用户已要求迁回剩余 IPC／持久化职责并清理多余实现。设置修改与 JSON 编辑 → profile 的 `settingsResource` → 现有 `IFileService` → Disk／IndexedDB provider → 文件失效通知 → `UserSettings`／配置模型 → Workbench、Sessions 和 Main 消费。唯一持久化 owner 为通用文件 provider；配置服务仅拥有解释后的快照。资源格式保持普通 JSONC，作用域仍为已有用户设置和语言覆盖；保留另一切片已完成的 Workspace／Folder／Policy 语义，此次仅迁移文件与传输职责。浏览器旧数据库只用于一次性迁移，成功后退出，不保留双写或常驻 fallback。

准入路径（双方都有的文件仅修改本链相关 hunk；现有用户改动已保存基线）：

- 模型、解析与读取 owner：`src/ash/platform/configuration/common/configurationModels.ts`（双方都有）；`src/ash/platform/configuration/common/configurationService.ts`（仅 VS Code，Main 的单资源配置服务）；`src/ash/platform/configuration/common/configurationRegistry.ts`（双方都有，覆盖键契约）。
- 编辑与 GUI 配置 owner：`src/ash/workbench/services/configuration/browser/configurationService.ts`、`src/ash/sessions/services/configuration/browser/configurationService.ts`（双方都有）；`src/ash/workbench/services/configuration/common/jsonEditing.ts`、`src/ash/workbench/services/configuration/common/jsonEditingService.ts`（仅 VS Code，语法感知 JSON 编辑与条件保存）。
- profile 路径与编辑器资源：`src/ash/platform/userDataProfile/common/userDataProfile.ts`、`src/ash/workbench/services/userDataProfile/browser/userDataProfileService.ts`、`src/ash/workbench/services/preferences/common/settingsEditorInput.ts`、`src/ash/workbench/contrib/preferences/common/preferencesContribution.ts`、`src/ash/workbench/services/preferences/browser/preferencesService.ts`（双方都有，设置资源改为真实 profile 文件）。
- 产品装配与早期语言：`src/ash/code/electron-main/app.ts`、`src/ash/workbench/browser/workbench.ts`、`src/ash/workbench/browser/web.api.ts`、`src/ash/workbench/browser/web.factory.ts`、`src/ash/workbench/electron-browser/desktop.main.ts`、`src/ash/workbench/electron-browser/rendererApi.ts`、`src/ash/platform/native/common/rendererApi.ts`、`src/ash/platform/native/common/nativeHost.ts`、`src/ash/sessions/browser/workbench.ts`、`src/ash/sessions/browser/web.main.ts`、`src/ash/sessions/electron-browser/sessions.main.ts`、`src/ash/workbench/services/localization/browser/localizationBootstrap.ts`、`src/ash/platform/profile/node/localProfile.ts`（现有生产调用方，退出配置专用传输，保留原宿主和连接身份）。
- 领域消费者：`src/ash/platform/dictation/browser/appServerDictationService.ts`、`src/ash/platform/dictation/common/dictationConfiguration.ts`、`src/ash/platform/meteredConnection/electron-main/meteredConnectionMainService.ts`、`src/ash/sessions/browser/chatViewPane.ts`（现有消费者，读取配置领域契约，编辑使用真实文件）。
- 退出候选：`src/ash/platform/configuration/common/configurationIpc.ts`、`src/ash/platform/configuration/common/configurationResourceService.ts`、`src/ash/platform/configuration/electron-browser/configurationApi.ts`、`src/ash/platform/configuration/electron-main/configurationMainService.ts`、`src/ash/platform/configuration/browser/indexedDbConfigurationApi.ts`、`src/ash/workbench/contrib/preferences/common/settingsFilesystemProvider.ts`（前五个仅 Ash；Preferences provider 虽有上游同路径，但本地承担的用户设置虚拟写入并非上游职责；待生产调用归零并完成验证后清理）。`src/ash/platform/configuration/electron-main/userConfigurationIpc.ts` 仅调整后端编辑通道常量的归属，继续承担已存在的 `config.toml` 宿主能力。

验证使用现有配置、Settings JSONC、Sessions、语言初始化、dictation、metered connection、profile 迁移测试的对应准确路径；测试中旧传输 fixture 同批迁为真实通用文件 provider。新增同路径测试仅用于真实输入边界、文件冲突、外部无效输入保留快照、重启和旧浏览器数据迁移。最终复查旧 imports、通道注册、虚拟设置 scheme 与订阅释放。

## 文件迁移的当前结果

生产入口已退出配置专用通道、revision envelope 和虚拟设置 provider。Main、听写与计量网络消费者使用 `IConfigurationService`；设置编辑器直接使用 profile 设置文件。首次打开不存在的设置文件时，Preferences 独占创建普通 JSONC 文件，竞争创建保留另一窗口的内容。JSON 编辑保存通过 Preferences 的文本模型 save participant 调用注册 validator，非法值保留脏草稿；通用文件 provider 不解释配置语义。用户设置写入也遵守现有工作副本的脏文件保护。

`UserSettings` 处理文件失效与父目录提示，Windows 文件比较遵守文件系统大小写规则。配置层保留最后有效快照，存储层持有不透明的内容 revision。宿主策略与窗口组合策略分属父子作用域，各作用域仅注册一个策略服务。

验证：44 个受影响单测文件覆盖约 977 项用例；扩大回归中发现的 fixture DI 依赖和对象语言合并断言已修复，失败的 6 个文件及 Settings JSON 共 367 项用例定向重跑通过。最终配置文件／Preferences JSON 15 项用例再次通过。真实 Chromium 的旧数据库迁移 6 项通过。Renderer、Main 类型检查及前端构建通过。英文／中文配置与本地化初始化仍有单测覆盖。

端到端 smoke 尚未全部通过：程序设置选区后，编辑器辅助 live 文本仍报告旧位置；Appearance 下拉框报告 `Unknown select option 'ash-dark'`。外部文件更新用例已完成读写、跨窗口重载和配置标记断言，在末尾 diagnostics 断言被该 Appearance 错误阻断。Electron 的非法设置保存、脏草稿保护和实际文件冲突场景也走到用例结束，fixture 的错误检查仍被相同 Appearance 错误阻断。完整 smoke 准备还遇到当前 Rust App Server 的接口编译错误，单独前端构建成功。未把这些验证失败记为通过。

以下 7 个文件在当前活动生产链中均为 0 调用方，均为 Git tracked，可恢复。配置目录的 6 个候选上游无同路径文件；Preferences 的 `settingsFilesystemProvider.ts` 有上游同路径，但上游只提供只读 schema／默认设置资源，本地整个实现却是用户设置虚拟读写。本地没有 schema／默认设置虚拟文件的生产调用链，删除该错误实现后不保留占位模块。前 6 个是已退出的专用传输／持久化实现，最后一个旧通道测试已被 `platform/configuration/test/common/configurationService.test.ts` 的真实通用文件 IPC 场景接替。文件尚未删除，等待准确路径确认：

- `src/ash/platform/configuration/common/configurationIpc.ts`
- `src/ash/platform/configuration/common/configurationResourceService.ts`
- `src/ash/platform/configuration/electron-browser/configurationApi.ts`
- `src/ash/platform/configuration/electron-main/configurationMainService.ts`
- `src/ash/platform/configuration/browser/indexedDbConfigurationApi.ts`
- `src/ash/workbench/contrib/preferences/common/settingsFilesystemProvider.ts`
- `src/ash/platform/configuration/test/electron-main/configurationMainService.test.ts`

## 此前切片记录（包含迁移前状态）

### 设置模型与配置层

设置修改 → `WorkbenchConfigurationService.updateValue` / JSONC 资源保存 → 现有宿主持久化或 `IFileService` 条件写入 → 已提交快照 → `ConfigurationModel` → 设置读取、inspection、变更通知。Sessions 提供当前注册的窗口默认值和只读规则，共用同一用户设置资源。

Workbench 服务负责配置层的组合和设置写入路由；模型是已规范化配置的不可变快照。Workspace／Folder 的 JSONC 源文本及 watch 生命周期由 `configuration/browser/configuration.ts` 管理，内容 revision 和文件读写由现有 `IFileService` 管理。Policy 来源属于宿主，配置层只读取和校验它。该切片没有 DOM 或布局变化。

本批允许修改的路径：

| 路径                                                                       | 文件关系             | 动作与验证                                                                                                |
| -------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------- |
| `src/ash/platform/configuration/common/configurationModels.ts`             | 仅 VS Code           | 实现已有生产读取链需要的 `ConfigurationModel` 契约：值读取、模型合并、语言覆盖、配置数据快照。            |
| `src/ash/workbench/services/configuration/browser/configurationService.ts` | 双方都有             | 仅迁移配置值和语言覆盖状态；移除原平行值表与独立解析规则。保留当前 JSONC 读写、传输、窗口规则和生命周期。 |
| `src/ash/platform/configuration/test/common/configurationModels.test.ts`   | 仅 VS Code           | 验证模型合并和语言覆盖不会修改输入或既有快照。                                                            |
| `src/ash/platform/configuration/test/common/configuration.test.ts`         | 双方都有             | 从现有保存入口验证语言优先级、结构化设置、inspection 与事件。                                             |
| `docs/configuration-api-alignment-status.md`                               | 仅 Ash，当前审计记录 | 记录职责、已迁移调用链和遗留项。                                                                          |

验证还复用现有 Sessions 双窗口保存、外部重载、revision 冲突、只读规则和英文／中文测试，以及 Settings JSONC 资源和设置控件测试。

## 目录审计与后续归属

审计时 `platform/configuration` 有 10 个生产文件，2 个同路径、8 个仅 Ash；上游有 4 个本地缺失文件。文件数不代表行为完成度。

| 现有文件／职责                                                                      | 处理方向                                                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `common/configuration.ts`、`common/configurationRegistry.ts`                        | 同路径契约和注册 owner；尚未完成整体对齐。                                                  |
| `common/configurationSchema.ts`                                                     | 属性 schema 归 registry，各作用域 schema 的组织和注册归 workbench configuration。           |
| `common/configurationResourceService.ts`                                            | 文件、文本模型与配置编辑基础设施承接资源读写及冲突语义。                                    |
| `common/configurationIpc.ts`                                                        | 配置模型／覆盖键与传输 envelope 分离；逐步退出配置专用传输。                                |
| `electron-browser/configurationApi.ts`、`electron-main/configurationMainService.ts` | 配置专用 IPC 和持久化链，待通用文件服务的实际设置调用链迁入后退出。                         |
| `browser/indexedDbConfigurationApi.ts`                                              | 浏览器持久化归通用 IndexedDB 文件 provider。                                                |
| `common/inMemoryConfigurationService.ts`                                            | 区分 standalone 生产装配和测试；分别对照 standalone service 与 test configuration service。 |
| `electron-main/userConfigurationIpc.ts`                                             | Ash 后端 `config.toml` 编辑入口，无直接上游对应；专属宿主归属尚待决定。                     |

`agentsWindow` 在上游 registry 和 Sessions configuration 中均有对应，不属于仅 Ash 能力。typed parse/serialize、控件描述与 `ashBinding` 仍须逐项核对，不能因同路径而视为已对齐。

## Sessions configuration

`src/ash/sessions/services/configuration` 与上游目录均包含 `browser/configurationService.ts` 和 `test/browser/configurationService.test.ts`，没有缺失文件。生产入口为 `sessions/browser/workbench.ts` 创建的 `ConfigurationService`；Desktop 和 Web 共用这条窗口装配链。

动态贡献注册 → platform configuration registry → Workbench 配置快照重建 → Sessions 窗口默认值和只读规则 → 读取、inspection、语言覆盖及写入限制。Sessions 直接读取当前注册元数据，不再缓存构造时的默认值表和只读键集合；贡献注册验证窗口默认值，撤回及重新注册不会留下旧规则。配置文档、revision、事件与订阅释放仍由现有 Workbench 服务负责。

本次修改范围为 registry 注册元数据、Workbench 默认值和只读判定的受保护入口、Sessions 实现及其同路径测试。原有选项契约保留，没有新增持久化来源或独立配置状态。Sessions、平台配置及扩展贡献的 58 项定向测试通过，覆盖动态注册、重新注册、撤回、输入验证、双窗口文件共享、外部重载、revision 冲突和中文错误提示；四个修改的 TypeScript 文件通过格式检查。

Workspace／Folder 读取、目标推导和 Policy 配置已接入实际窗口装配。WorkBench 与 Sessions 启动都使用已有工作区、文件服务和工作副本 owner，等待配置初始化后完成恢复。工作区选择变化立即撤下旧配置和 watcher，旧读取结果不会进入新选择；写入取消信号随资源释放。

新增及修改职责：

| 路径                                                                              | 文件关系   | 生产调用与职责                                                                                                                       |
| --------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/ash/workbench/services/configuration/browser/configuration.ts`               | 仅 VS Code | Workbench 配置服务消费 `WorkspaceConfiguration`／`FolderConfiguration`，通过文件服务读取、watch 及条件写入 JSONC。                   |
| `src/ash/platform/configuration/common/configurations.ts`                         | 仅 VS Code | Workbench 初始化 `PolicyConfiguration`，注册当前 policy 定义、校验来源值并生成不可变配置快照。                                       |
| `src/ash/platform/policy/common/policy.ts`                                        | 仅 VS Code | 两个窗口通过服务集合提供 `IPolicyService`；没有宿主策略来源时显式注册 `NullPolicyService`。                                          |
| `src/ash/platform/configuration/common/configurationRegistry.ts`                  | 双方都有   | 注册及验证 setting 的 policy 元数据和唯一策略名称；支持动态贡献撤回。                                                                |
| `src/ash/workbench/services/configuration/browser/configurationService.ts`        | 双方都有   | 组合配置层、按资源解析 Folder、语言优先级、最高优先级 Policy、inspection、keys、目标推导、作用域过滤、资源定向事件及脏工作副本保护。 |
| `src/ash/sessions/browser/workbench.ts`、`src/ash/workbench/browser/workbench.ts` | 双方都有   | 接入真实 owner 和初始化等待。                                                                                                        |

多根 Workspace 使用工作区文件的 `settings` 对象，Folder 使用所属目录的 `.vscode/settings.json`；单目录窗口把这个文件解释为 Workspace 层。默认值 → 用户 → Workspace → Folder 的普通值先组合，再应用对应语言覆盖，Policy 最后覆盖。Workspace 排除 application／machine 设置，Folder 进一步排除 window 设置。Sessions 的固定设置在用户、Workspace、Folder 及语言覆盖中均被过滤。

写入修改目标 JSONC 属性，保留工作区文件的其他属性、注释和语言块注释，使用文件服务的内容 revision 拒绝冲突；新文件以不覆盖方式创建。无显式目标时使用已定义的最高层，删除设置时遍历已定义层。脏工作副本默认拒绝写入，显式 save／revert 先通过工作副本 owner 处理。非法外部 JSONC 保留最后有效层并报告错误。

Policy 层已实现注册定义、实时值解析、最高优先级、写入限制及撤回后的继承恢复。非法策略更新报告错误并保留同一设置和策略身份的上次有效值，避免错误输入解除写入限制。Desktop Main 已接入系统来源，Workbench 和 Sessions 都通过只读 `PolicyChannelClient` 消费 Main 的值；Main 的配置服务直接消费同一来源，不再使用空策略服务。

系统来源：Windows 使用 `HKLM\SOFTWARE\Policies\Ash`（DWORD 0／1 映射为 boolean），macOS 使用 `/Library/Managed Preferences/com.ash.desktop.plist`，Linux 使用 `/etc/ash/policies.json`。Windows／macOS 由一个进程级 `SystemPolicyService` 每 2 秒检查变化，命令有 timeout、输出限制、退出取消和隐藏窗口；Linux 使用文件服务 watcher。策略定义不能在窗口间改变既有类型，IPC 不开放策略写入或任意路径。非法来源更新保留上次有效快照；明确删除值或来源文件会撤回策略。`DesktopUpdateChannel` 对应现有 `update.policy`，合法值为 `latest`、`stable`、`never`。

系统文件 → Main IPC → PolicyConfiguration 的定向测试以及 IPC 输入拒绝、初始化通知竞态、读取失败保留、释放、定义注册竞态、实际 Windows 注册表只读验证共 6 项通过。早期全量单测编译曾被配置／profile 迁移中的旧测试接口阻挡，最终全部单测源码已通过类型检查；行为验证采用定向测试，未运行全量单测。macOS／Linux 的真实 OS 来源尚未在对应系统验证。

账户来源已沿 GitHub／Copilot 的实际链接入：账户 owner 的 primary grant → `IGitHubService.readManagedSettings(accountId)` → 已有可取消的 App Server 请求 → `github/account/managedSettings` → 绑定该账户凭据的 GitHub client → `/copilot_internal/managed_settings`。协议只接收账户 ID 和 operation ID，不接收凭据或自定义 URL；读取使用该账户的 SharedRead 调度。HTTP 404 和空对象是明确撤回，权限、网络及非法数据错误保留同一账户的最后有效快照。登录状态变化取消旧请求，退出清空快照，迟到结果不能恢复旧账户策略；当前账户每分钟刷新。其他 provider 的 Rust requirements 仍由后端解释，不进入 UI 配置。

`AccountPolicyService` 只解释 registry 声明的字段及映射。生产 `ChatDefaultModel` 将 managed settings 的 `model`、旧版 `permissions.model` 映射到现有 `chat.defaultModel`；顶层非空字符串优先，空白字段视为缺省，实际模型选择仍由现有目录与新聊天偏好服务处理。`ChatAIDisabled` 仅作为系统策略，不伪造 Copilot 的禁用 AI 字段。`MultiplexPolicyService` 使用系统来源优先、账户来源其次的合成结果，Workbench 和 Sessions 消费同一分层契约。账户映射函数留在 renderer，Main IPC 只传类型声明和策略值。

系统及账户来源共 12 项定向单测通过，包括真实 Windows 固定路径只读探测、IPC 竞态、失败保留、注销取消、首次来源失败后启动和恢复，以及账户模型值穿过真实 registry／配置服务到新聊天消费者的验证。GitHub HTTP 契约的 2 项测试、账户只读和取消协议的 1 项测试通过；`ash-github` 和 `ash-app-server-protocol` 的全目标无警告检查通过。Main、Renderer 和生成协议类型检查通过。App Server 整体检查仍被 `app_tools_operations.rs`、`ide_operations.rs` 中既有的 8 处文件访问 API 错误阻挡（`PathOperation::Read`、`constrained_by`、`path_policy`），未修改该授权领域。尚未用真实登录账户请求远端服务，也未在 macOS／Linux 验证真实系统来源。

平台 `configurationService.ts`、`ConfigurationModelParser` 和 `UserSettings` 承接真实文件读取链；Workbench 的模型构建复用 `ConfigurationModelParser.parseRaw`，不再自行构建值树与语言模型。`configurations.ts` 当前承接已到达的 Policy 读取链；`configurationVariables.ts`、remote、配置缓存默认值与实验覆盖、跨 profile 应用规则及其他公开端口仍未完成。用户配置专用资源及持久化链已退出生产装配，旧文件尚未删除。当前行为完成不代表全部 API 已对齐。

## 已验证结果

Workspace／Folder／Policy 切片：6 个定向测试文件、74 项测试通过，覆盖模型合并、各层 precedence 和 inspection、作用域过滤、目标推导、JSONC 注释、外部重载与非法输入、工作区切换和迟到读取、revision 冲突、脏工作副本、策略初始化竞态、非法策略保留和撤回、动态扩展贡献及设置控件。9 个修改的 TypeScript 文件通过格式检查，`git diff --check` 通过；中文 policy 错误断言和本地化生成检查通过。Renderer 类型检查通过。尚未运行真实窗口 E2E 或系统策略来源验证。

`WorkbenchConfigurationService` 现在保存默认、用户和合并后的不可变模型；原长期维护的有效值表、用户值表、语言值表和覆盖块数组已退出。值读取、inspection、导出的配置数据和事件前后比较使用这些模型。Sessions 通过原继承入口获得同一行为。

单语言覆盖优先于组合语言覆盖，与源文档顺序无关。结构化设置按对象成员合并，数组整体替换。父设置改变后，可以精确查询其子路径是否受到影响；保存下来的旧事件和配置数据不随后续更新改变。原 JSONC 源文本和 revision 仍由现有资源链拥有。

- `pnpm test:unit` 定向选择 configuration models、configuration、in-memory configuration、Main configuration channel、Sessions configuration、Settings JSONC、Settings 控件和文件配置策略：8 个文件、77 项测试通过。覆盖双窗口共享文件、外部修改、保存失败与 revision 冲突、JSONC 注释保留、窗口只读规则，以及现有英文／中文行为。
- `pnpm typecheck:renderer`：3,967 个文件通过；其准备步骤的 common 检查也通过。
- 本批 4 个 TypeScript 文件通过仓库格式检查，`git diff --check` 通过。

本批没有删除文件，也没有迁移底层存储；8 个仅 Ash 生产文件仍在。新增同路径模型是收敛其上层配置语义的前置切片，不以此宣称目录清理完成。

本批补充准入：`src/ash/code/browser/workbench/workbench.ts` 的早期语言读取直接使用 profile 文件；`src/ash/workbench/services/userData/browser/userDataInit.ts`（仅 VS Code 同路径）承接浏览器旧设置的一次性迁移。浏览器真实 IndexedDB 迁移通过现有 `test/integration/browser/files.integration.ts`／`files.integration.spec.ts` 验证，覆盖冲突、非法输入、中断重试及无旧数据。Main 的通用文件 IPC 验证落于对应 `src/ash/platform/configuration/test/common/configurationService.test.ts`。现有 `test/architecture/layer-boundaries.test.ts` 与 `test/smoke/areas/windows/taskbar.spec.ts` 退出旧配置传输契约；架构说明 `docs/browser-foundation.md`、`docs/ash-desktop-architecture.md` 更新持久化 owner。

端到端测试的旧配置通道及旧数据库探针同批迁到真实文件。追加准入为 `test/automation/settings.ts`、`test/automation/menus.ts`，以及 `test/smoke/areas/windows/{display-language,notifications,opener,search,settings,settings-json,themes,trace-settings}.spec.ts`、`test/smoke/areas/sessions/{sessions-customize,sessions-settings,sessions-window}.spec.ts`、`test/smoke/areas/chat/chat-input-editor.spec.ts` 的准确现有路径；改动仅替换配置读写、文件 revision 和可观察保存等待。

## 提交前最终验证

- 同选项定向编译后由 `pnpm test:unit:no-compile --run ...` 执行：配置模型、文件 IPC、Workspace／Folder／Policy、Sessions、Settings JSONC、控件、听写、计费网络、语言和模型偏好共 10 个文件、134 项通过；策略来源另 2 个文件、12 项通过。
- 最终 Policy 初始化错误处理变更后，Sessions 的 16 项回归再次通过；依赖层边界的 13 项通过。定向单测合计覆盖 159 个不同用例。
- `pnpm test:browser:integration:prepared files.integration.spec.ts --project=chromium --grep 'browser settings migration preserves data' --max-failures=1`：真实 Chromium 的 6 个 IndexedDB 迁移场景全部通过，包括无旧库、迁移、等值、冲突、非法数据和中断重试。
- `pnpm exec tsc -p tsconfig.test.json --noEmit --incremental false`、Renderer（3,976 文件）、Main（1,888 文件）、生成协议（1,503 文件）、浏览器集成（3,887 文件）及自动化源码（2,713 文件）类型检查通过。
- 125 个修改的 TypeScript 文件格式检查通过，策略收尾修改的定向格式检查通过，相关 Rust 模块格式检查通过；完整 `server.rs` 格式检查遇到既有 MCP 分发 hunk，未改动该无关格式。`git diff --check` 通过。
