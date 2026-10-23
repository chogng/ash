# Workbench 装配与文档贡献

> 本文描述当前实现。Agent Window 的文档工作区与 Code IDE 边界见 [目标设计](design/work-code-workbench.md)，公开产品线见 [产品线说明](product-lines.md)。

Ash Desktop 当前只有 Code 工作台。Academy 是独立安装的文档编辑扩展，可在同一窗口打开文档与论文；用户不需要切换工作台或重载窗口。工作台拥有编辑器宿主和后端连接；Academy 的实现由扩展包独立提供。

## 装配与所有权

| 入口或服务                                  | 负责什么                                                         |
| ------------------------------------------- | ---------------------------------------------------------------- |
| `code/common/application.ts` 与两端产品入口 | 固定产品标题与 Sessions 页面；入口向 Workbench 传入标题          |
| `workbench/workbench.common.main.ts`        | 装配代码、文档宿主及工作台工具；Academy 由扩展注册接入           |
| `editor.all.ts`                             | 装配客户端内置 Code 编辑贡献；不装配 Academy 实现                |
| `workbench/contrib/documentEditor`          | 承载扩展提供的文档视图，接入工作副本、保存、协作与视图生命周期   |
| `extensions/academy`                        | Academy 文档内容类型、扩展名、schema、引用、节点视图及工具栏配置 |
| `DocumentEditorTextModelService`            | 按规范化资源地址共享一个模型及工作副本，最后一个视图关闭时释放   |

`DocumentEditorPane` 是 Workbench 的通用承载适配器，负责资源引用、保存、备份、取消和扩展停用；实际富文档编辑表面是 `extensions/academy/browser/widget/richTextEditor/richTextEditorWidget.ts`。宿主不解释段落、引用、分页或图片节点，也不直接导入 Academy 的实现。

Browser 与 Electron 各保留一个 Workbench 启动入口，只加载 Code。标题由产品入口提供，构建与启动没有模式注册表。两端产品入口在本地化完成后加载各自 Workbench 入口并直接调用启动函数；共同贡献由 `workbench.common.main.ts` 装配，不再经单项模式 loader。工作台不提供运行时模式切换服务、宿主切换回调或切换 IPC。通用代码编辑器排除已注册的结构化文档，文档编辑器按相同配置完成匹配与实例化。Academy 匹配 `.ash-academy`、`.ash-paper` 或其内容类型。

`TextModel` 是内容、版本与撤销的唯一来源。多个论文视图共享编辑内容、脏状态、保存修订和备份身份；关闭一个视图不销毁其他视图。结构化文件只接受版本化文档格式，损坏 JSON 或纯文本不会被隐式当成论文正文。普通文档、论文和频道笔记由 Academy 注册，宿主通过已注册契约完成转换。

## 旧窗口与存储迁移

| 旧数据                                                           | 当前处理                                                                            |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| profile 的 `settings.json` 中旧 `workbench.mode`                 | 不再注册或读取该配置，不改写用户 JSONC；其他配置继续生效                            |
| 旧 `ash-workbench-mode` URL 参数或 `ASH_WORKBENCH_MODE` 环境变量 | 不参与构建或启动；新生成的页面链接不携带模式参数                                    |
| `windowSession` 的旧 `modeId`                                    | 窗口状态 owner 读取原工作区，之后只保存窗口种类与工作区                             |
| Main v1 存储与浏览器的 `code` 命名空间                           | 存储服务按 scope 与 id 合并；冲突沿用当前值，旧值只补齐缺失键；原始数据留在迁移备份 |
| working-copy 备份                                                | 继续使用原工作区身份与 Academy 内容类型，不复制备份数据库                           |

存储身份只有 application、profile、workspace 作用域及各自 id，不再传递 `applicationId`。Main 写入 v2 格式前保存 `workbench-state.json.v1`；浏览器将原始文档存为 `ash.storage.v1.<旧身份>.<作用域及 id>`，写入 `ash.storage.<作用域及 id>` 后清除旧键。备份只供检查，不参与后续恢复；中断的迁移可以重试。已有偏好与状态不被覆盖。旧 `configuration.json` 到 `settings.json` 的 profile 迁移仍由现有配置迁移负责，不再执行模式值转换。

开发与测试直接打开已安装扩展支持的文档文件，不存在独立文档工作台模式。旧 Code 存储只在迁移时读取并归档。

## 窗口与状态

Workbench、独立编辑器窗口和 Code Sessions 使用共享应用身份及用户数据根。主窗口注册 `workbench/services/title/browser/titleService.ts` 的 `ITitleService`；`BrowserTitleService` 拥有共享 `WindowTitle` 和标题栏，通过 `getPart(container)` 返回同一窗口的标题栏。Electron 的标题栏创建入口位于 `services/title/electron-browser/titleService.ts`，继续使用现有窗口控件和系统菜单实现。

主窗口与辅助窗口的标题分别读取自己的 EditorPart 活动组，根据文件标签、未保存状态、工作区、配置和 ContextKey 更新。`window.title` 定义模板，`window.titleSeparator` 定义条件分隔符，配置由既有 profile/workspace `settings.json` 保存。`registerWindowTitleVariable` 注册变量名与 ContextKey 的映射；值变化即时更新所有窗口标题。

标题服务通过 `createAuxiliaryTitlebarPart` 创建并登记辅助标题栏，窗口关闭时释放标题监听并移除登记。辅助窗口布局预留标题栏和状态栏高度。环境属性通过 `updateProperties` 传播；调试会话暂停且应用失焦时，调试贡献设置红点前缀。Electron Main 读取桌面进程权限，并校验打包清单中的安装文件；构建流程在打包目录写入 `package.json.checksums`，覆盖 `dist/` 与 `resources/`。完整性结果由 `IIntegrityService` 返回，实际不一致时进入现有通知中心。开发运行没有发布校验清单，`isPure` 保持未定义。此检查用于发现安装文件变化，不代替操作系统签名；Rust App Server 的权限和安装状态独立于桌面应用。

Code Sessions 保持独立页面。Workbench 通过 Titlebar action 请求打开 Agents 窗口；Main 持有窗口创建、复用与关闭，Sessions 使用自己的会话状态。`sessions` 可以复用 `workbench` 能力，`workbench` 不反向导入 `sessions`。详情见 [Sessions 说明](../src/ash/sessions/README.md)。

## 构建与验证

统一 Renderer 输出在 `.build/desktop/renderer/ash`，包含 Workbench 与 Code Sessions 入口。Academy 的客户端实现独立编译和加载，不随工作台 Renderer 打包。

验证覆盖文档类型匹配、共享模型与释放、保存冲突、旧配置忽略与存储迁移、浏览器富文档输入以及 Electron 实际文件打开和保存。Academy 的 profile、视图、转换及 DOCX 测试位于 `extensions/academy/test/browser/`。宿主目录只保留通用工作台交互测试。分页、段落、引用等无障碍帮助由扩展提供；宿主只补充保存、转换和焦点恢复操作。用户流程使用 Playwright 的内容、焦点和持久状态断言。
