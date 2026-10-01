# Sessions 共用布局

Code 的目标布局由 Titlebar、Activity Bar、Sidebar、Sessions 和 Auxiliary Bar 五个 Part 组成。Chat 与 Code 页面共用窗口布局和会话分屏机制，各页面保留自己的会话选择、草稿与界面实例。其他页面按自己的内容需求使用这些区域。

本文件单独说明这套布局的职责、状态和扩展边界。它以当前五个 Part 的产品决定为基础；不把 VS Code 的 Editor、Panel 或手机布局视为 Code 的待补区域。`src/ash/sessions/` 下既有文档在本次改动中保持原样，其中描述的其他布局需要分别核对实现状态。

## 职责与文件

| 负责方 | 文件 | 契约 |
| --- | --- | --- |
| 窗口装配 | [Workbench](../../src/ash/sessions/browser/workbench.ts) | 创建服务与 Parts，装配页面内容，管理窗口生命周期 |
| 窗口布局 | 同文件中的 `SessionsWorkbenchLayout` | 唯一负责容器尺寸、五个 Part 的 Grid、显隐、拖动、边界留白与窗口布局存储 |
| 共用区域身份与默认尺寸 | [layoutConstants.ts](../../src/ash/sessions/common/layoutConstants.ts) | 提供当前产品的区域集合与默认宽度，不拥有可变状态 |
| 外观几何政策 | [layoutPolicy.ts](../../src/ash/sessions/browser/layoutPolicy.ts) | 提供 modern／flat 的窗口边界尺度，不判断页面身份 |
| 会话分屏几何 | [sessionGridLayout.ts](../../src/ash/sessions/browser/parts/sessionGridLayout.ts) | 保存和恢复分栏宽度、更新排列、保持未受影响的尺寸和活动内容焦点，不创建或销毁会话组件 |
| 页面内容与组件生命周期 | [SessionsChatView](../../src/ash/sessions/browser/parts/sessionsChatView.ts)、[SessionsPart](../../src/ash/sessions/browser/parts/sessionsPart.ts) | 管理 retained ChatWidget、内容更新、草稿和页面显示 |
| 页面选择与会话身份 | [SessionsService](../../src/ash/sessions/services/sessions/browser/sessionsService.ts) | 保存和恢复每页的可见会话、顺序和活动身份；维护窗口内导航历史 |

Sessions 可以使用 Workbench 和更低层的机制，Workbench 不依赖 Sessions。模式入口负责内容和可用能力，不能另建一套窗口尺寸监听、拖动或布局存储。通用 Grid 和 Part 不读取产品页面。

## 布局与生命周期

窗口先创建并注册 `IAgentWorkbenchLayoutService`，浮层与 Quick Input 取得同一个容器布局服务。Parts 完成创建后，通过 `createWorkbenchLayout` 一次性接入 Grid。服务由窗口实例化容器创建，存储是必需的构造依赖。

一次窗口布局依次完成 Grid、Parts 和内部内容，再发布容器布局完成事件。事件订阅者读取到的是已经完成的区域尺寸。拖动使用 Grid 自身的布局链；显隐和外观变化也经过同一入口。

Parts 声明自身尺寸约束，窗口布局分配区域空间。Sidebar 与 Auxiliary Bar 保持用户宽度，Sessions 吸收窗口及区域显隐引起的空间变化。会话分栏使用独立 Grid，新分栏切分相邻区域，保留不受影响的分栏尺寸。分栏身份变化或内容更新不重建保留的 ChatWidget。

modern／flat 的边界留白由窗口布局计算，CSS 负责表面外观。区域宽度包含布局边界，内容布局接收扣除留白后的尺寸。

## 显隐与存储

用户选择和页面可用性是两个状态。实际显示需要同时满足用户选择显示和当前页面使用该区域。

当前 Chat 与 Code 使用 Sidebar 和 Auxiliary Bar；Collaboration 和 Library 暂时隐藏两者。页面通过 `setPartAvailable` 请求区域可用性，不把这种隐藏写成用户关闭。用户主动关闭区域后，页面切换不能重新打开它。

| 状态 | 所有者与保存范围 | 当前实现 |
| --- | --- | --- |
| Sidebar、Auxiliary Bar 宽度与用户显隐 | 窗口布局；Sessions profile storage | 已持久保存与恢复，沿用现有存储键 |
| 页面暂时隐藏区域 | 窗口布局；当前页面运行状态 | 不持久保存；恢复页面内容后重新决定可用性 |
| Chat／Code 的会话顺序与活动选择 | SessionsService；Sessions workspace storage | `sessions.viewState` 保存两个页面的独立排列；未发送会话保存本地身份、标题、工作区、模型与 Agent 选择，已创建会话只保存会话和 Thread 身份 |
| Chat／Code 的分栏宽度 | SessionGridLayout；Sessions workspace storage | `sessions.gridState.chat`、`sessions.gridState.code` 按分栏身份保存宽度；重启时按可用空间恢复比例，并遵守组件尺寸约束 |
| 页面导航历史 | SessionsService；窗口内 | 不持久保存，重启后的历史从恢复的活动选择开始 |
| 输入草稿和附件 | 对应 ChatWidget 与草稿存储；Sessions workspace storage | 每页、每个未发送分栏和 Thread 分开保存，关闭流程等待附件内容解析完成 |

隐藏区域仍保留 Grid 缓存宽度。窗口保存时写入用户显隐选择，避免在临时隐藏页面关闭窗口后丢失布局。关闭时先保存布局，再释放 Grid 和 Parts；存储 flush 继续参加窗口的 shutdown 流程。

排列恢复先等待会话目录初始化，再由 SessionsService 解析会话引用，交给页面创建内容，最后由 SessionGridLayout 恢复宽度。没有足够尺寸的隐藏页面保留待恢复几何，首次显示时再应用。已删除或归档的会话、Thread 不重新打开，剩余分栏使用可用空间。目录加载失败不能证明会话已删除，未解析的会话引用继续保留，本地未发送分栏仍可恢复。启动期间用户已经选择的页面使用其新排列，其他页面继续恢复保存的排列。

未发送草稿使用 `untitled:<id>` 区分分栏，首次发送后改用 Thread 身份，并移除已消费的草稿。用户关闭未发送分栏时删除对应草稿，正在解析附件的旧写入不能重新生成它。旧的页面草稿由第一个未发送分栏迁移一次，目标和源有冲突时明确报错，两者保留。迁移写入与源删除位于同一个 workspace 状态文档，由同一次 flush 提交。正常读写只使用分栏或 Thread 身份。

排列和宽度是有版本的界面状态。读取时校验引用种类、身份、重复分栏、活动索引、工作区选择以及有限正宽度；不合法的数据拒绝加载。它们不进入用户设置，也不改变后端会话或执行状态。窗口仍从 Chat 页面启动，保存的 Code 排列在切换到 Code 时显示。

## 后续模式的接入边界

新页面首先明确 Sidebar、主区域和 Auxiliary Bar 的内容、可用性及初始组合。相同区域关系使用同一布局实现；不同内容不构成另建布局的理由。产品模式、页面选择、外观和设备交互分别管理。

手机交互和新增区域尚未实现。接入这些能力时，需要真实调用方、对应状态所有者和行为测试；不预先添加空的控制器或页面。新增区域关系应同步扩展布局契约，页面仍不接管 Grid 的尺寸计算。

VS Code 的同职责文件用于核对边界和行为。Ash 使用自己的五区域组合、会话状态、DOM 与 Grid 实现；本次补齐的是当前调用链所需的职责，不宣称具备上游全部布局 API。

## 验证

窗口布局单测覆盖五区域组合、显隐与缓存宽度、存储恢复、布局事件时机和服务装配。会话分屏和选择服务单测覆盖独立页面排列、活动选择、首次发送、失效引用、目录不可用、启动期间用户选择、宽度恢复、身份变化保留几何、输入焦点和草稿迁移。

Playwright 的 [sessions-layout.spec.ts](../../test/smoke/areas/sessions/sessions-layout.spec.ts) 从实际 Sessions 入口执行拖动、Chat／Code／其他页面切换、窗口 resize 与 reload，检查区域尺寸、草稿、组件身份和运行错误。既有页面切换测试继续覆盖键盘、附件、导航历史与关闭分栏。Web、Electron UI 和连接 App Server 的 Electron 使用同一语义流程。
