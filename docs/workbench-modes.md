# Ash Desktop 工作台与文档贡献

> 本文描述当前实现。未来 Work / Code 设计见 [目标设计](../app-ts/docs/design/work-code-workbench.md)，公开产品线见 [产品线说明](product-lines.md)。

Ash Desktop 当前只有 Code 工作台。Academic 是可在同一窗口打开的论文文档类型；用户不需要切换工作台或重载窗口。代码、差异、论文、Tasks、Testing、Debug、Chat 和 Agents 窗口使用同一安装包与后端。

## 装配与所有权

| 入口或服务 | 负责什么 |
| --- | --- |
| `WorkbenchModeRegistry` | 当前唯一模式 `code` 的名称、存储命名空间与 Sessions 入口 |
| `code/browser/workbench/modes/code.contribution.ts` | 装配代码、通用文档、Academic 配置及工作台工具 |
| `editor.all.ts` | 装配行式与富文档编辑贡献；不注册 Workbench pane |
| `workbench/contrib/documentEditor` | 唯一文档 pane 注册、按文档配置匹配输入、视图与保存交互 |
| `workbench/contrib/academic` | Academic 文档内容类型、扩展名、schema、引用、节点视图及工具栏配置 |
| `editor/contrib/academic` | 论文结构和编辑能力；不决定工作台模式 |
| `DocumentEditorTextModelService` | 按规范化资源地址共享一个模型及工作副本，最后一个视图关闭时释放 |

Browser 与 Electron 各保留一个 Workbench 启动入口，只加载 Code。静态启动信息仍由中央注册表拥有，loader 使用完整的类型映射；未知模式明确报错。工作台不提供运行时模式切换服务、宿主切换回调或切换 IPC。通用代码编辑器排除已注册的结构化文档，文档编辑器按相同配置完成匹配与实例化。Academic 匹配 `.ash-academic`、`.ash-paper` 或其内容类型。

`TextModel` 是内容、版本与撤销的唯一来源。多个论文视图共享编辑内容、脏状态、保存修订和备份身份；关闭一个视图不销毁其他视图。结构化文件只接受版本化文档格式，损坏 JSON 或纯文本不会被隐式当成论文正文。普通文档类型、转换命令和 Work 模式仍属于后续设计。

## 旧 Academic 模式迁移

| 旧数据 | 当前处理 |
| --- | --- |
| profile 的 `settings.json` 中 `workbench.mode: academic` | 启动时用 JSONC 编辑改为 `code`，保留其他配置及注释 |
| 浏览器或 Electron 入口 URL 的 `ash-workbench-mode=academic` | 进入注册表前转换为 `code`，更新 URL 并保留其他参数 |
| Main 持久存储与浏览器存储的 Academic 命名空间 | 按 scope、工作区与 key 补入 Code；同名不同值保留目标值及旧源项，并报告冲突 |
| working-copy 备份 | 继续使用原工作区身份与 Academic 内容类型，不复制备份数据库 |

迁移可以重复执行。写入目标成功后才清除已迁移源项，存在冲突的源项继续保留。已有 Code 偏好与状态不被覆盖。旧 `configuration.json` 到 `settings.json` 的 profile 迁移仍由现有配置迁移负责，Academic 值转换随后执行。

开发与测试不再使用 `ASH_WORKBENCH_MODE=academic`；直接打开论文文件即可。内部模式值只有 `code`。

## 窗口与状态

Workbench、独立编辑器窗口和 Code Sessions 使用共享应用身份及用户数据根。主窗口注册 `workbench/services/title/browser/titleService.ts` 的 `ITitleService`；`BrowserTitleService` 拥有共享 `WindowTitle` 和标题栏，通过 `getPart(container)` 返回同一窗口的标题栏。Electron 的标题栏创建入口位于 `services/title/electron-browser/titleService.ts`，继续使用现有窗口控件和系统菜单实现。

主窗口与辅助窗口的标题分别读取自己的 EditorPart 活动组，根据文件标签、未保存状态、工作区、配置和 ContextKey 更新。`window.title` 定义模板，`window.titleSeparator` 定义条件分隔符，配置由既有 profile/workspace `settings.json` 保存。`registerWindowTitleVariable` 注册变量名与 ContextKey 的映射；值变化即时更新所有窗口标题。

标题服务通过 `createAuxiliaryTitlebarPart` 创建并登记辅助标题栏，窗口关闭时释放标题监听并移除登记。辅助窗口布局预留标题栏和状态栏高度。环境属性通过 `updateProperties` 传播；调试会话暂停且应用失焦时，调试贡献设置红点前缀。Electron Main 读取桌面进程权限，并校验打包清单中的安装文件；构建流程在打包目录写入 `package.json.checksums`，覆盖 `dist/` 与 `resources/`。完整性结果由 `IIntegrityService` 返回，实际不一致时进入现有通知中心。开发运行没有发布校验清单，`isPure` 保持未定义。此检查用于发现安装文件变化，不代替操作系统签名；Rust App Server 的权限和安装状态独立于桌面应用。

Code Sessions 保持独立页面。Workbench 通过 Titlebar action 请求打开 Agents 窗口；Main 持有窗口创建、复用与关闭，Sessions 使用自己的会话状态。`sessions` 可以复用 `workbench` 能力，`workbench` 不反向导入 `sessions`。详情见 [Sessions 说明](../app-ts/src/ash/sessions/README.md)。

## 构建与验证

统一 Renderer 输出在 `.build/app-ts/renderer/ash`，包含 Workbench 与 Code Sessions 入口。Academic 不再拥有独立模式入口或 `editor.academic.all.ts`。

验证覆盖文档类型匹配、共享模型与释放、保存冲突、旧配置与存储迁移、浏览器富文档输入以及 Electron 实际文件打开和保存。用户流程使用 Playwright 的内容、焦点和持久状态断言。
