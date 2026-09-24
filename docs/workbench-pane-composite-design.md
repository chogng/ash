# Workbench Pane Composite 设计规范

> 本文是 Ash Desktop Browser Workbench 中 pane-like Part 的结构、槽位、命名和状态投影的 canonical 文档。
> Renderer 控件与 CSS 状态所有权以 [`ui-styling-ownership.md`](ui-styling-ownership.md) 为准；Command、MenuId 与 Context Key 组合以 [`menu-system.md`](menu-system.md) 为准；Workbench 整体拓扑和持久化边界以 [`ash-desktop-architecture.md`](ash-desktop-architecture.md) 为准。

## 快速理解

除 Editor 外，承载 View Container 的 Workbench 区域统一使用 `PaneCompositePart` 架构。统一的是标题槽位、`CompositeBar`、标题动作槽位和 retained `PaneComposite` 生命周期；各 Part 只提供区域约束和明确的展示选择。

| 需求 | Owner | 正确入口 |
| --- | --- | --- |
| Part 在 Workbench 中的位置、尺寸和显隐 | `WorkbenchLayout` | 布局状态与 Part 可见性 API |
| 标题左侧的 View Container 选择 | `PaneCompositePart` 托管的 `CompositeBar` | `compositeBarPresentation`、`compositeBarVisible`、`compositeBarContainerFilter` |
| 标题右侧的菜单动作 | `PaneCompositePart` 标题动作槽位 | `titleActions` + `MenuId` |
| 当前 View 的内容与标题投影 | retained `PaneComposite` / View | `contentElement`、原子 `partTitleProjection` |
| action 的业务显隐和 checked 状态 | Command、Menu、Context Key | 条件菜单项与稳定 `.checked` 状态投影 |
| hover、focus、选中态和内部 item 几何 | 创建对应 DOM 的控件 | 控件 CSS 或公开 presentation variant |

关键约束：一个选项必须以它配置的 owner 和语义槽位命名。Part 标题右侧的 toolbar 必须叫 `titleActions`，不能因为它与 `CompositeBar` 相邻就叫 `compositeBarActions`。

## 1. 适用范围

本文适用于 `SidebarPart`、`AuxiliarybarPart`、`Agent Sidebar` 和 `PanelPart`。它们都是某个 `ViewContainerLocation` 的 pane-like host。Editor 使用 editor-group 专用架构，不套用本文的 Composite 生命周期。

本文不重新定义：

- CSS selector、交互状态与 design token 的所有权；这些由 `ui-styling-ownership.md` 负责。
- Command、Menu、Context Key 的注册与求值；这些由 `menu-system.md` 负责。
- Grid、sash、窗口边缘留白和布局持久化；这些由 `WorkbenchLayout` 及 Desktop 架构负责。

## 2. Canonical 层级

```text
PaneCompositePart
├─ titleElement (.ash-pane-composite-title)
│  ├─ titleContentElement
│  │  └─ CompositeBar 或 partTitleProjection.content
│  └─ titleActionsSlotElement
│     ├─ viewTitleActionsElement ← partTitleProjection.actions
│     └─ partTitleActionsElement ← Part 级 MenuWorkbenchToolBar
└─ contentElement
   └─ retained PaneComposite
      └─ ViewPane
```

`PaneCompositePart` 创建标题的左右槽位并持有 Composite 生命周期。`CompositeBar` 只负责把可用 View Container 投影为可切换 item。`MenuWorkbenchToolBar` 只负责把指定 `MenuId` 投影到标题右侧。`PaneComposite` 负责当前 container 的 pane、内容和 view-owned title control。

| 层级 | 拥有 | 不拥有 |
| --- | --- | --- |
| `WorkbenchLayout` | Part 拓扑、尺寸、可见性、sash、持久化 | Part 内部标题和 action item |
| `PaneCompositePart` | 标题左右槽位、Composite 激活与 retained 生命周期 | 业务 action 的可见条件、控件内部 hover 状态 |
| `CompositeBar` | container item、激活、overflow、`icon`/`label` presentation | 标题右侧菜单动作、Part 边框和背景 |
| `MenuWorkbenchToolBar` | 从 `MenuId` 解析 action 并投影到 toolbar | action 业务状态的权威来源、Part 几何 |
| `PaneComposite` / View | 当前 View 内容、pane 生命周期、私有标题内容 | Workbench 全局布局、其他 Part 的样式 |
| Contribution | container、view、command 和 menu 声明 | 直接移动 Part DOM 或操作 Grid |

## 3. 命名契约

命名必须表达“谁拥有这个输入”和“它改变哪个语义”，不能描述偶然的视觉邻接关系。

| 名称 | 准确语义 |
| --- | --- |
| `titleActions` | 配置 Part 标题右侧的 menu-backed toolbar |
| `titleActionsSlotElement` | `PaneCompositePart` 创建的标题右侧动作宿主槽位 |
| `compositeBarPresentation` | 选择 `CompositeBar` 的公开展示变体 |
| `compositeBarVisible` | 控制整个 `CompositeBar` 是否参与标题布局 |
| `compositeBarContainerFilter` | Part 对其子 `CompositeBar.containerFilter` 的显式配置 |
| `containerFilter` | `CompositeBar` 内部选择哪些 container 生成 item |
| `partTitleProjection` | 当前 View/Composite 原子提供的 `{ content, actions }` 标题投影 |

以下命名和调用方式禁止新增：

- ❌ 用 `compositeBarActions` 表示标题右侧 toolbar。它不是 `CompositeBar` 的子结构。
- ❌ 用 `sidebarActions`、`agentActions` 等 host 名称掩盖实际槽位语义。
- ❌ 用 `showHeader` 之类含糊布尔值同时控制 title、bar、item 或 pane header。
- ❌ 让 contribution 根据 DOM 层级查找并迁移 action item。

当父层只是把配置转发给明确的子组件时，父层选项应保留子组件命名空间，例如 `compositeBarContainerFilter`；进入 `CompositeBarOptions` 后收敛为 `containerFilter`。这样调用点和实现点都能看出配置边界。

## 4. 状态与显隐契约

下面的状态彼此独立，不能由一个布尔值或 CSS selector 代替：

| 状态 | 判定 owner | DOM/CSS 投影 |
| --- | --- | --- |
| Part 是否可见 | `WorkbenchLayout` | Part 进入或退出布局 |
| 标题是否存在 | `PaneCompositePart` | 标题在有 CompositeBar、自有标题内容或标题动作时保留 |
| `CompositeBar` 是否可见 | `PaneCompositePart` | `compositeBarVisible` 投影到 bar root 的 `hidden` |
| container 是否生成 item | `CompositeBar` | `containerFilter` 参与 items 计算 |
| 哪个 Composite 激活 | `PaneCompositePart` / `IViewsService` | `CompositeBar` active item 与 retained content 同步 |
| menu action 是否可见 | `MenuService` + Context Key | toolbar 刷新对应 action |
| action 是否 checked | command/action model | `.checked` 与 ARIA 并行投影 |

同一 toggle action 需要在 Part 收起和展开时出现于不同标题区域时，优先注册两个固定 menu 槽位，并以互斥 Context Key 控制显隐。槽位位置保持稳定，action 不在 DOM host 之间迁移，因此不会引入 presentation drift。

## 5. 标题槽位

`titleContentElement` 与 `titleActionsSlotElement` 是 `PaneCompositePart` 创建的同级槽位。当前 View 通过一次 `partTitleProjection` 同时提供左侧 `content` 和右侧 `actions`，两者必定来自同一个 View；前者替换 `CompositeBar` 的视觉，后者进入 `viewTitleActionsElement`。Part 级 `titleActions` 独立进入 `partTitleActionsElement`，与 View actions 并列且不互相覆盖。当前 View 的上下文动作必须进入其所属的固定标题槽位，不得在 View、CompositeBar 或窗口标题栏之间迁移 DOM。

一个 `PaneComposite` 至多允许一个可见 View 提供 `partTitleProjection`；若多个 View 同时提供，运行时立即拒绝该歧义配置，而不会拼接或按顺序挑选不同 View 的标题片段。

标题、toolbar 和 `CompositeBar` 的视觉尺寸、状态 class 与 CSS selector 规则以 [`ui-styling-ownership.md`](ui-styling-ownership.md) 为准。

## 6. 当前 Part 的正式变体

| Part | 标题左槽 | 标题右槽 | 内容生命周期 |
| --- | --- | --- | --- |
| Primary Sidebar | 可见的 icon `CompositeBar` | 按需提供 | retained `PaneComposite` |
| Panel | 可见的 label `CompositeBar` | 当前 Composite 的上下文 actions | retained `PaneComposite` |
| Auxiliary Bar | 隐藏冗余 `CompositeBar`，投影 Chat `partTitleProjection.content` | 投影 Chat `partTitleProjection.actions` | retained `PaneComposite` |
| Agent Sidebar | 保留统一标题/CompositeBar host，但过滤唯一冗余 container item | `MenuId.AgentSidebarTitle` | retained `PaneComposite` |

Agent Sidebar 的空 `CompositeBar` root 仍是统一标题结构的一部分，但不创建 `Agent` action item；“Hide Agent Sidebar” 属于标题右侧 `titleActions`。因此它和 Auxiliary Bar 的 title toolbar 使用相同的 Part 标题槽位。

## 7. 禁止模式

- ❌ 为了让一个 action 看起来对齐，把它注册到窗口 `TitlebarPart`。
- ❌ 在展开/收起时把同一个 action DOM 从 Chat title 搬到 Agent Sidebar title。
- ❌ 在仍需多个 container item 的 Part 中，隐藏整个 `CompositeBar` 来删除其中一个冗余 item。
- ❌ 保留空 toolbar 的布局占位，再由 Part CSS 猜测是否应隐藏。
- ❌ 在 Part CSS 中穿透 `.ash-action-bar`、`.ash-button` 或 `.ash-tab` 调整 hover/checked 视觉。
- ❌ 让 contribution 直接增删 Grid pane 或读写布局尺寸。

## 8. 修改流程

修改 pane-like Part 时按以下顺序检查：

1. 这是 Workbench 拓扑、Part 外框、标题槽位、CompositeBar、toolbar，还是 View 内容的责任？
2. 新输入是否以 owner 和语义槽位命名？
3. 显隐是否拆分为 Part、标题、bar、item、menu action 五类独立状态？
4. 是否能通过 `MenuId` + Context Key 保持固定槽位，而不是迁移 DOM？
5. 是否复用了 `PaneCompositePart` 的 retained Composite 生命周期？
6. CSS 是否停在直接托管子控件的外部盒子，没有穿透共享组件内部？
7. 是否同步更新本规范、Desktop 架构和相关测试？

当前实现的关键入口是：

- `app-ts/src/ash/workbench/browser/parts/paneCompositePart.ts`
- `app-ts/src/ash/workbench/browser/parts/sidebar/sidebarPart.ts`
- `app-ts/src/ash/workbench/browser/parts/auxiliarybar/auxiliarybarPart.ts`
- `app-ts/src/ash/workbench/browser/parts/panel/panelPart.ts`
- `app-ts/src/ash/workbench/browser/parts/compositebar/compositeBar.ts`
- `app-ts/src/ash/workbench/browser/workbench.ts`

相关改动至少运行 Desktop TypeScript 编译，以及 Workbench layout、Chat view、toolbar/action view item 和 UI styling ownership 测试。视觉改动还需要在 Browser Workbench 中验证收起、展开、hover、拖拽与窄宽度 overflow。
