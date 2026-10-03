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

Browser 与 Electron 各保留一个 Workbench 启动入口，只加载 Code。模式定义仍由中央注册表拥有，loader 使用完整的类型映射；未知模式明确报错。通用代码编辑器排除已注册的结构化文档，文档编辑器按相同配置完成匹配与实例化。Academic 匹配 `.ash-academic`、`.ash-paper` 或其内容类型。

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

Workbench、独立编辑器窗口和 Code Sessions 使用共享应用身份及用户数据根。窗口标题由各自的 `WindowTitle` 根据当前文件、未保存状态、工作区和 Code 产品名称更新，监听随窗口释放。

Code Sessions 保持独立页面。Workbench 通过 Titlebar action 请求打开 Agents 窗口；Main 持有窗口创建、复用与关闭，Sessions 使用自己的会话状态。`sessions` 可以复用 `workbench` 能力，`workbench` 不反向导入 `sessions`。详情见 [Sessions 说明](../app-ts/src/ash/sessions/README.md)。

## 构建与验证

统一 Renderer 输出在 `.build/app-ts/renderer/ash`，包含 Workbench 与 Code Sessions 入口。Academic 不再拥有独立模式入口或 `editor.academic.all.ts`。

验证覆盖文档类型匹配、共享模型与释放、保存冲突、旧配置与存储迁移、浏览器富文档输入以及 Electron 实际文件打开和保存。用户流程使用 Playwright 的内容、焦点和持久状态断言。
