# Sessions 共用布局

Sessions 复用 Workbench 的 Part、编辑器和 ViewContainer 基座。Creator 聚合各贡献的创作入口；Library 是统一的分类文件和素材仓库，其分类、收藏、集合和搜索属于库内浏览状态。各功能向 Sessions 布局服务提供容器 ID 和中央内容，窗口布局负责共享宿主的尺寸与显隐。DesktopLayoutController 负责会话文档恢复及 Editor／Details 行为。窗口始终保留 SessionsPart，用于 Agent 对话和会话分屏。

本文概括边界。完整契约见 [LAYOUT.md](../../src/ash/sessions/LAYOUT.md)，会话工作集和入口存储见 [LAYOUT_CONTROLLER.md](../../src/ash/sessions/LAYOUT_CONTROLLER.md)。

## 职责与目录

| 负责方 | 文件 | 契约 |
| --- | --- | --- |
| 窗口装配 | [workbench.ts](../../src/ash/sessions/browser/workbench.ts) | 创建服务、保留 Parts，管理窗口生命周期 |
| 桌面布局 | [desktopWorkbench.ts](../../src/ash/sessions/browser/desktopWorkbench.ts) | 拥有窗口 Grid、Part 位置、显隐映射、尺寸和存储 |
| 入口布局 | [sessionsLayoutService.ts](../../src/ash/sessions/contrib/layout/browser/sessionsLayoutService.ts) | 接收功能提供的容器和中央内容，串行打开并保存布局偏好，不按产品名字分支 |
| 会话文档与详情 | [desktopLayoutController.ts](../../src/ash/sessions/contrib/layout/browser/desktopLayoutController.ts) | 恢复会话工作集，管理 Editor／Details 操作 |
| 对话区域 | [parts/sessions/](../../src/ash/sessions/browser/parts/sessions/) | SessionsPart、SessionsChatView、SessionGridLayout 及其 media；保留 ChatWidget、草稿和分屏几何 |
| 编辑区域 | [parts/editor/](../../src/ash/sessions/browser/parts/editor/) | 复用 Workbench EditorPart，保留产品页面编辑组；会话文档组独立恢复 |
| 底部工具 | [parts/panel/](../../src/ash/sessions/browser/parts/panel/) | 使用共享 PanelPart 和工具 ViewContainer |
| 左侧区域 | [parts/sidebar/](../../src/ash/sessions/browser/parts/sidebar/) | 使用共享 SidebarPart，挂载会话、团队、Library、Creator 的 ViewContainer |
| 会话身份 | [sessionsService.ts](../../src/ash/sessions/services/sessions/browser/sessionsService.ts) | 窗口唯一的活动会话、可见排列和导航历史 |

每个 Part 按文件夹归属，其组件和样式跟随所属 Part。模式页面放在 contrib，由 EditorInput / EditorPane 或 ViewPane 注册提供内容；页面名不产生新的窗口 Part。Workbench 和更低层不依赖 Sessions。

## 中间区域与模式

| 模式 | 左侧 | 中间 | 右侧 |
| --- | --- | --- | --- |
| Chat | 会话 ViewContainer | SessionsPart | 按该模式的显隐偏好 |
| Code | 会话 ViewContainer | SessionsPart 与文档 EditorPart | Files / Changes，按活动文档选择 |
| Collaboration | 团队 ViewContainer | SessionsPart | 按该模式的显隐偏好 |
| Library | 分类 ViewContainer | LibraryEditorPane | 素材详情 ViewContainer |
| Creator 画布 | Layers ViewContainer | CreatorEditorPane 保留的工作空间 | Shape properties ViewContainer |
| Creator 首页 / Make | Creator 导航 ViewContainer | CreatorEditorPane | 默认收起属性 |

Sidebar 在每种桌面模式中都可用。用户显隐偏好按入口保存。Code 的 Panel 在其他模式不可用，回到 Code 恢复原显隐及工具视图。聚焦 Code 内的对话不改变模式；激活已打开的产品标签时恢复其对应的入口布局。

## 状态与生命周期

窗口布局负责 Part 宽度、Grid 和实际尺寸。会话分屏由 SessionsPart 的独立 Grid 管理；文档编辑组仍使用 Workbench 编辑组能力。模式切换保留这些实例，不创建另一份会话选择、文档或选区。

会话工作集只保存和恢复文档编辑组，产品页面编辑组排除在外且保持存活。隐藏编辑内容、收起整个 Code 侧面区域和切换模式都保留普通标签与未保存文档。实际关闭、文件替换和窗口退出继续检查保存、放弃或取消。

CreatorPage 拥有工作空间实例，文档内容和工作副本仍由各模式的原有服务拥有。LibraryService 拥有共享的可观察浏览状态；LibraryEditorPane、分类 View 和详情 View 分别创建并管理自己的界面。容器与 View 在 contribution 中注册，不依赖编辑器先创建。各区域隐藏时释放自己持有的预览资源，返回时保留搜索、视图模式和选择。

窗口布局按顺序完成 Grid、Parts 和内部内容，再通知容器布局完成。隐藏区域保留 Grid 缓存尺寸。窗口关闭等待布局切换、会话工作集和草稿保存结束，再释放 Parts 和存储。

## 验证

相关单测覆盖 Part 装配、布局尺寸、会话草稿、分屏保留和工作集恢复时保留产品编辑组。Playwright 的 [sessions-layout.spec.ts](../../test/smoke/areas/sessions/sessions-layout.spec.ts)、[sessions-navigation.spec.ts](../../test/smoke/areas/sessions/sessions-navigation.spec.ts) 和 Creator / Library / Code 场景覆盖真实切换、编辑器标签、键盘帮助、DOM 实例、未保存文档、窗口 resize 和 reload。Web、Electron UI 和连接 App Server 的 Electron 使用同一语义流程。
