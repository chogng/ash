# Renderer UI 样式所有权规范

> 本文是 Ash Desktop Renderer 中组件、组合控件与 Workbench Part 样式边界的 canonical 文档。
> 修改 browser UI 时同时遵守 scoped [`browser-ui.instructions.md`](../.github/instructions/browser-ui.instructions.md)；该 instruction 只保留任务期规则，详细 ownership 仍由本文唯一拥有。
> 主题值与 token 注册仍以 [`design-tokens.md`](design-tokens.md) 为准；Desktop 的跨进程和产品所有权仍以 [`ash-desktop-architecture.md`](ash-desktop-architecture.md) 为准。
> Pane-like Part 的标题层级、槽位、命名和 Composite 生命周期以 [`workbench-pane-composite-design.md`](workbench-pane-composite-design.md) 为准。
> Command、MenuId、Context Key 与菜单型 Toolbar 的组合语义以 [`menu-system.md`](menu-system.md) 为准；本文只拥有它们最终投影到控件后的视觉边界。

## 快速理解

每一种视觉规则只能有一个 owner。调用方选择组件、传入语义状态或选择公开的 presentation variant；调用方不得通过深层 selector 重写被调用组件的内部 item、hover、active、focus 或 disabled 样式。

判断 owner 时使用下面的顺序：

1. 状态由哪个控件定义，状态视觉就由哪个控件拥有。
2. DOM 由哪个控件创建，内部结构样式就由哪个控件拥有。
3. Part 只拥有区域布局、边界、背景和直接子组件的外部尺寸。
4. 颜色和尺寸值来自 design token；token 不拥有 selector、状态机或 DOM 结构。
5. 同一组件需要不同外观时，增加有名字的 presentation variant，不在 host CSS 中穿透覆盖。

| 想修改什么 | 样式所有者 | 正确做法 |
| --- | --- | --- |
| 组件内部间距和交互状态 | 创建该 DOM 和状态的组件 | 修改组件自己的样式 |
| Workbench 区域布局和边界 | 对应 Part | 只修改直接托管区域的外部盒子 |
| 同一组件的另一种正式外观 | 组件公开的展示变体 | 增加有名字的变体 |
| 主题颜色或标准尺寸 | Design Token | 修改语义 token，不修改 selector |
| 某个业务动作的显隐 | Command/Menu/Context Key | 不用 CSS 猜业务状态 |

## 分层所有权

| 层级 | 当前代表 | 必须负责 | 禁止负责 |
| --- | --- | --- | --- |
| Primitive | `Button`、`ActionBar`、`ToolBar`、`TabList`、`PaneView` | 通用 DOM、键盘行为、ARIA、基础布局和 primitive 自身状态 | Workbench 区域语义、Panel/Sidebar 特例 |
| Composed control | `CompositeBar`、Editor/Chat tabs control、`MenubarControl` | 领域内 item 几何、presentation variant、hover/active/selected 视觉 | Part 的位置、区域背景和网格尺寸 |
| Part | `TitlebarPart`、`PanelPart`、`SidebarPart` | Part 根节点、标题区/内容区布局、边框、背景、直接子组件占位 | 深入修改组件内部 `.ash-action-bar`、`.ash-tab`、`.ash-button` 状态 |
| Contribution/View | `TerminalViewPane`、Explorer、Search、Chat | 自有内容、命令、View 内部交互和私有子控件 | Workbench Part 的全局布局或其他 View 的皮肤 |
| Theme | color/size registries 与 CSS custom properties | 视觉值、别名、主题覆盖和快照投影 | selector、DOM、active/hover 判定 |

文件位置不是所有权的唯一证据，root class 和构造者才是。Part 私有子控件可以与 Part CSS 共置，但 selector 必须以该私有子控件的 root class 开始，不能借 Part root 任意穿透共享组件。

编辑器分组的常驻边界由 `EditorPart` 选择语义颜色，`Grid` 传递给各层 `SplitView`，再由相邻 pane 的边缘绘制。`Sash` 只负责拖动命中区及悬停、焦点反馈；即使边界不可拖动，也应保留分组的视觉边界。

### Workbench 外观贡献

`workbench/contrib/modernUI` 是 Workbench 外观方案的集中覆盖层。它只在 `.modern-ui` 存在时覆盖已有稳定 class，不创建 Part DOM，也不接管交互状态。

- Part 和组件 CSS 定义 Flat 基线；Modern UI 的圆角、边框和外观差异放在 `browser/media`。
- 网格间距、Sash 命中区域和 TabList 展示能力仍由各自组件实现，Modern UI 只选择这些公开能力。
- 其他 contribution 不得借这个例外修改 Workbench Part；新增全局外观方案必须拥有独立根 class 和独立 media 目录。

## Retained DOM 写入所有权

`FastDomNode` 是 retained DOM 的局部样式写缓存，不是 `HTMLElement` 的替代接口。创建稳定节点的组件同时创建并保留唯一 wrapper；允许宿主投影根节点几何时，组件传递这个 wrapper，不得让宿主重新包装同一节点。wrapper 从构造时开始拥有其缓存属性，不读取 DOM 猜测初值；同一属性之后只能继续通过这个 wrapper 修改。文本、子树、`hidden`、tab order 和 ARIA 仍由具体组件直接拥有，不进入样式缓存。

`domNode` 保持公开，用于事件、测量、attributes、挂载和未缓存的样式。已经缓存的属性不得通过 `domNode.style`、对应 attribute 或其他别名绕过 wrapper；class 增删使用缓存感知的 `toggleClassName`。`setTextContent` 只用于子内容不再由其他代码分别维护的 retained leaf，容器节点继续由其 DOM owner 管理 children。

临时创建并立即替换的 DOM 不使用 `FastDomNode`。wrapper 不进入全局 registry，也不单独拥有 disposal；它与创建或接管该稳定节点的组件保持相同生命周期。

## 当前控件的准确职责

| 控件 | 当前职责 | 状态视觉 owner |
| --- | --- | --- |
| `ActionBar` | action 排列、方向键导航、roving tabindex、item shell；可显式启用 toggled 高亮上下文 | 不自动决定业务 selected/checked 视觉；Workbench 全局皮肤统一提供横向 action hover |
| `Button` | button DOM、focus-visible、disabled，以及 `.checked` 与 `aria-pressed` 的并行状态投影 | 不默认提供 hover 背景；hover 与 checked 的具体皮肤由 presentation context 决定 |
| `Switch` | track/thumb 结构、on/off、hover、focus、pressed、disabled 的内部 presentation | 宿主只提供状态与命名变体，不穿透覆盖内部 track/thumb |
| `ContextView` | 浮层挂载、锚点定位、视口内翻转和裁剪，以及通用浮层外壳 | 下拉框、提示、选择器和菜单各自的内容结构与交互状态 |
| `ToolBar` | primary/secondary action 编排、22px icon action 尺寸、More Actions、可选 toggled 高亮 | Button 负责状态投影；所在 presentation context 决定 hover 皮肤 |
| `DropdownWithPrimaryActionViewItem` | primary 与 dropdown 的组合 DOM、连续几何、内部键盘导航 | Workbench 全局 ActionBar 皮肤为整个 split action 提供 hover；产品只提供 actions 和 menu 数据 |
| `WorkbenchToolBar` | 把 platform action representation 适配到 base `ToolBar`；actions 仍由调用方提供 | 横向 action hover 归 Workbench 全局皮肤，其余视觉仍归 base `ToolBar`/`Button` |
| `MenuWorkbenchToolBar` | 从 `MenuId` 解析并刷新 `WorkbenchToolBar` actions | Menu 来源不改变 toolbar ARIA 与视觉 owner |
| `TabList` | `tablist/tab` ARIA、`aria-selected`、激活回调、`.checked` 状态投影，以及标准 tab 的选中背景 | `tablist.css` |
| `CompositeBar` | View Container 切换，以及 `icon`/`label` 两种 presentation | presentation 专属的几何与前景色；不重定义标准 tab 选中背景 |
| `PaneComposite` | `tabpanel`、pane 生命周期、pane header presentation | `views.css` |
| `PaneCompositePart` | 32px title control、CompositeBar/自有标题与 title actions 的左右槽位 | `paneCompositePart.css` 只拥有外层布局 |
| `TitlebarPart` | 左区、应用菜单、标题和右区的窗口级布局 | 通用 toolbar/button 状态不归 Titlebar |

`PaneCompositePart` 的标题高度为 `32px`；`titleContentElement` 占据左侧弹性空间，`titleActionsSlotElement` 固定在右侧并提供 `4px` 的双侧 inset。当前 View 的 `partTitleProjection.actions` 与 Part 级 menu toolbar 使用独立子槽并列；Part CSS 只拥有这些直接槽位的外框与排列，不得穿透修改其中的 toolbar/button 内部状态。

`CompositeBar` 的 icon presentation item 状态盒为 `24px × 24px`，hover 与 `.checked` 使用同一外框。`CompositeBar` 拥有该 item 几何及 presentation 专属前景色；`TabList` 提供标准 tab 的稳定状态 class、选中背景，以及由 `tabList.itemContentInset` 定义的标准内容左右 inset；非选中 tab 保持透明；`ActionBar` 只在显式启用 toggled 高亮时提供 action 的背景。

## 状态归属矩阵

| 状态 | 判定 owner | 样式 owner | Host 可以做什么 |
| --- | --- | --- | --- |
| `hover` | 原生 pointer 状态 | presentation context；Workbench 横向 ActionBar 由全局 Workbench 皮肤统一处理 | 选择 presentation；不得在具体 Part 或 contribution 中重写内部 action |
| `focus-visible` / `disabled` | 原生交互 primitive | primitive CSS | 选择 primitive；不得重写内部状态 |
| menu 当前项 | `Menu` 统一投射鼠标与键盘焦点为 `.focused` | `menu.css` | 提供 actions；不得用调用方 selector 重建菜单焦点态 |
| tab `selected` / `active` | `TabList` 投影状态 | `TabList` 默认皮肤；有独立语义的组合控件通过自己的 token 覆盖 | 选择 presentation variant，不能复用 ActionBar token |
| toggle `checked` / `pressed` | command/action model | 控件并行投影 `.checked` 与 ARIA；具体 composed control CSS 决定皮肤 | 提供 checked 值或显式启用 toggled 高亮；不得在 Part 中猜状态 |
| Part visible/hidden | Workbench layout | Part/layout CSS | contribution 只能请求命令 |
| theme light/dark/high contrast | Theme service | token snapshot | 组件消费 token，不硬编码主题分支 |

`ActionBar` 是行为与排列基座，不因为它包裹了 item 就自动拥有业务 selected 皮肤。需要通用 toggled 背景时，由调用方显式启用 `highlightToggledItems`，ActionBar 再通过 `.highlight-toggled .checked` selector 应用自己的公开高亮 presentation。

### ActionBar 与 TabList 的选中态边界

`ActionBar` 的 `actionBar.toggledBackground` 只表达“一个 action 在显式 toggled 上下文中被选中”。`TabList` 的 `tabList.activeBackground` 只表达“一个 tab 被选中”；非选中 tab 不设置背景。两者即使当前主题值相同，也必须保持独立 token 和独立 CSS selector；这保证日后主题或交互语义变化时不会产生隐式耦合。

标准 tab 由 `tablist.css` 消费 `tabList.activeBackground` token，并保持非选中项透明。`CompositeBar` 只能追加 `icon`/`label` presentation 的几何、间距和前景色，不能覆盖标准 tab 的选中背景。Chat 这类会话 tab 可以通过 `chat.tabBackground` 定义非选中背景，但必须继承 `TabList` 的选中背景；不得借用 ActionBar token 或通过 Part 深层 selector 改写 TabList。

和 VS Code 一致，ARIA attribute 用于无障碍语义，稳定 class 用于视觉 selector。不要使用 `[aria-pressed="true"]` 或 `[aria-selected="true"]` 作为皮肤 selector。

Menu 的 pointer hover 与键盘导航必须汇入同一个 `focusedEntry`，并在直接 action item 上投射 `.focused`。`menu.css` 只能通过该 class 设置当前项背景；不得同时用 `:hover` 与 `:focus-visible` 驱动两套高亮。`:focus-visible` 只适合表达额外的键盘焦点轮廓。

原生 DOM attribute 同样不作为组件视觉状态 API。组件需要覆盖 author CSS 时，应并行保留原生语义并投影稳定 class，例如 `MenuWorkbenchToolBar` 同时设置 `hidden` 和 `.empty`，CSS 只选择 `.empty`。

需要让选中状态覆盖 hover 时，先写一般 `:hover` 规则，再写同等或更高 specificity 的 `.checked` 规则；不要使用 `:not(.checked):hover` 表达状态优先级。

## 行为身份与视觉身份

行为身份和视觉身份必须使用不同契约：

| 身份 | 表达方式 | 允许用途 | 禁止用途 |
| --- | --- | --- | --- |
| 行为身份 | `IAction.id`、`data-action-id` | TypeScript 路由、动作查找、诊断和测试 | CSS selector、颜色、显隐和布局 |
| 视觉身份 | 组件拥有的稳定 class，例如 `.ash-tab-close-action` | 组件 CSS、交互状态和 presentation | 命令分派、持久化身份和业务查找 |

组合控件定义某个 item 的语义时，也负责把该语义投影为稳定的视觉 class。底层控件可以继续保留行为 ID，但 CSS 不得把 ID 当作公开样式 API：

```css
/* 禁止：行为身份泄漏为视觉契约 */
.ash-tab-actions [data-action-id="ash.tab.close"] {
  visibility: hidden;
}

/* 允许：TabList 投影并拥有视觉身份 */
.ash-tab-close-action {
  visibility: hidden;
}
```

添加视觉 class 不等于需要新的 representation。只有 DOM 结构、交互行为、ARIA 语义或生命周期确实不同，才新增 `ActionViewItem` 等专用表示。仅有颜色、显隐、间距或状态皮肤差异时，由语义 owner 在现有直接托管 shell 上投影 class。只有多个真实消费者需要同一项通用能力时，才扩展 `ActionBar`、`Button` 等基座接口；不要为了单个样式差异增加转发层、模糊选项或具体实现继承。

## Selector 规则

Workbench 的固定横向几何使用物理方向 CSS。仅需左右 inset 时，写作 `padding: 0 <value>`；不要使用 `padding-inline`、`margin-inline` 或其他 `*-inline` logical property。token 仍表达数值，例如 `padding: 0 var(--ash-tab-list-item-content-inset)`。

允许组件修改自己的内部结构：

```css
.ash-composite-bar-label .ash-tab {
  padding: 0 5px;
}
```

允许 Part 修改直接托管组件 root 的外部尺寸或位置：

```css
.ash-panel-title-control > .ash-composite-bar {
  flex: 1 1 auto;
  min-width: 0;
}
```

允许 Part 修改自己的直接内容区：

```css
.ash-workbench-panel > .ash-composite-content {
  overflow: hidden;
}
```

禁止 Part 穿透共享组件内部结构：

```css
/* 禁止 */
.ash-panel-title-control
  .ash-tab-list-scroll-content
  > .ash-action-bar
  > .ash-tab.checked {
  background: var(--some-color);
}
```

如果 host 需要改变 item 的 padding、radius、最小尺寸、hover 或 active 视觉，应回到该组件实现，增加语义明确的 variant。variant 使用枚举或字符串联合表达，不使用含义模糊的布尔参数。

当前示例：

```ts
export type CompositeBarPresentation = "icon" | "label";
```

Sidebar 使用默认 `icon` presentation；Panel 显式选择 `label` presentation。两种 item 的几何及 presentation 专属前景色由 `CompositeBar` 拥有；标准 tab 的选中背景仍归 `TabList`，非选中项透明。`TabList` 同时拥有 tab 完整命中区域（包括 action gap）的光标：静止可点击态统一为 pointer，只有拖拽手势激活后才切换为 grabbing；presentation 和 Part 不得重写 label 光标。

## Panel 规范

Panel 顶部的 Problems、Output、Terminal、Ports 是同一 View Container location 中的互斥目的地，因此语义是 `tablist`，实现为 `CompositeBar`。右侧是当前选中 Panel View 的上下文命令，因此语义是 `toolbar`，实现为 `ToolBar`。

| 区域 | 语义/实现 | 样式 owner |
| --- | --- | --- |
| Problems / Output / Terminal / Ports | `TabList` + `CompositeBar` | 标准 tab 的选中背景归 `tablist.css`；label presentation 归 `compositebar.css` |
| 当前 View 命令 | `WorkbenchToolBar` 或 `MenuWorkbenchToolBar` | action 编排归 toolbar；button 状态归 button |
| 未显示的 Panel 目的地 | `CompositeBar` 自有 overflow button 与菜单 | `CompositeBar` |
| title control 左右布局 | `PanelPart` | `panelpart.css` |
| terminal 实例列表 | Terminal View 内第二级 `TabList` | Terminal contribution/view |
| pane header 是否显示 | `PaneComposite` presentation | `views.css` |

Panel 不拥有 tab 的 active 下划线，也不拥有 active/hover 背景。选中态应填满 `CompositeBar` item 的命中区域；标准背景由 `TabList` 的 token 与 CSS 决定。

当 Panel 目的地超出 `CompositeBar` 可用宽度时，`CompositeBar` 必须在自己的 action row 中、最后一个可见 tab 之后创建独立的 More button，并将未显示的目的地放入该 button 的菜单。不得把这些目的地注入当前 View 的 `WorkbenchToolBar` 或 `MenuWorkbenchToolBar`；View title toolbar 的 More 只承载该 View 自有 Menu 的 secondary actions。

## Titlebar 规范

Titlebar 是 Workbench Part，不是一个巨型 toolbar。它负责窗口拖拽区、左中右区域编排、应用菜单与窗口控件的占位；其中嵌入的 Button、ToolBar、ActionBar 仍保留各自状态所有权，横向 ActionBar 的 hover 由 Workbench 全局皮肤统一提供。

| Titlebar 内容 | Owner | Titlebar 可以负责 | Titlebar 不负责 |
| --- | --- | --- | --- |
| 窗口级网格、拖拽区、左右区域 | `TitlebarPart` | 高度、排列、间距、背景、边界 | 子控件 active/hover 状态 |
| 应用菜单 | `MenubarControl` | Titlebar 只放置其 root | 菜单 item 内部状态 |
| 通用图标命令 | `ToolBar` + `Button` + Workbench 全局 ActionBar 皮肤 | toolbar root 的位置 | action hover、button focus/disabled |
| 窗口控制按钮 | Electron/native integration | 预留布局与主题投影 | 模拟通用 Workbench action 状态 |

Titlebar 可以给直接托管的公共组件 root 设置适配当前背景所需的继承色，但不应改变组件内部状态规则。如果某种前景色必须在不同背景下变化，优先注册语义 token 或公开 presentation，而不是新增深层 selector。

## Token 与 CSS 的边界

Design token 回答“值是什么”，组件 CSS 回答“何时使用这个值”。

```text
Theme registry
  → --ash-tab-list-active-background
  → tablist.css 的 .ash-tab.checked
```

Theme 不判断某个 tab 是否 active，Part 也不选择 active token。`TabList` 在自己的状态 selector 中消费相应 token；`CompositeBar` 只消费其 presentation 所需的 token。

## 字体层级

字体角色由字号与强调程度两个正交 token 组合，不增加 `body1Strong`、`label1Bold` 之类的复合 token。`fontSize.*` 回答文本处于哪个阅读层级；`fontWeight.*` 回答它是否需要强调。这样同一强调语义能在不同字号间保持一致，也避免把 600 或 400 重新写成局部魔法数。

| 文本语义 | 字号 token | 字重 token |
| --- | --- | --- |
| 常规正文 | `fontSize.body1` | `fontWeight.regular` |
| 常规标签 / 次级标题 | `fontSize.label1` | `fontWeight.regular` |
| 元数据 | `fontSize.label2` | `fontWeight.regular` |
| 控件 / 导航 / 当前项 | `fontSize.body1` 或 `fontSize.label1` | `fontWeight.medium` |
| 强调正文 / Pane tab | `fontSize.body1` | `fontWeight.semiBold` |
| 强调标题 | 对应 `fontSize.heading*` 或 `fontSize.label1` | `fontWeight.semiBold` |

`TabList` 基座拥有 tab label 的统一强调字重 `fontWeight.semiBold` 与标准高度 `tab.height`（24px）；其 `inset` presentation 统一拥有 Editor 与 Chat 使用的内缩、圆角、截断渐变和 focus 几何，两个组合控件只投影各自的非选中背景 token。`CompositeBar`、Terminal tabs 等组合控件通过 presentation 决定字号、行高和内部间距，并只能调整直接托管的 TabList root 以完成对齐。Part 不得用深层 selector 改写这些字体规则。系统提供 regular（400）、medium（500）与 semiBold（600）三级，不使用 700 弥补层级或间距问题。

新增视觉规则时：

1. 先确认已有语义 token 是否准确。
2. 没有准确 token 时，在实际消费语义的 domain 注册 token。
3. 在拥有状态的组件 CSS 中消费 token。
4. 不为一次 host 覆盖创建位置型 token，例如 `panel-tab-hover-background`；只有产品语义确实不同才拆分。

## 当前实现状态

| 项目 | 状态 |
| --- | --- |
| Panel 一级目的地使用 `CompositeBar`/`TabList` | ✅ |
| Panel 右侧上下文命令使用 `ToolBar` | ✅ |
| `CompositeBar` 提供 `icon` / `label` presentation | ✅ |
| Panel tab 几何与状态已从 `panelpart.css` 移回 `compositebar.css` | ✅ |
| Panel pane header 显示策略由 `PaneComposite` 拥有 | ✅ |
| tab 与 tabpanel 使用 `aria-controls` / `aria-labelledby` 配对 | ✅ |
| Workbench Part CSS 共享交互控件 selector 门禁 | ✅ |
| CSS 禁止使用 ARIA state attribute 作为视觉 selector 的门禁 | ✅ |
| CSS 禁止使用 `data-action-id` 作为视觉 selector 的门禁 | ✅ |
| CSS 禁止通过 `:not(.checked)` 等否定投影状态表达优先级 | ✅ |
| 全仓所有组合控件的深层 selector 自动判定 | 尚未完成 |
| Button 并行投影 `.checked` 与 `aria-pressed`，CSS 不依赖 ARIA selector | ✅ |
| ActionBar/ToolBar 通过 `highlightToggledItems` 选择通用 checked 背景 | ✅ |
| `WorkbenchToolBar` 与 `MenuWorkbenchToolBar` 不改变 base toolbar 样式所有权 | ✅ |
| `MenuWorkbenchToolBar` 以 `.empty` 投影空状态，CSS 不选择 `hidden` attribute | ✅ |

历史 CSS 中可能仍有不符合本规范的穿透 selector。它们是待迁移实现，不构成新的先例；修改相关区域时应就地迁移到 owner 或公开 variant。

## 审查清单

- 这个 selector 的 root class 是否由当前模块创建？
- 这个状态是否由当前模块定义？
- Part 是否只触及子组件 root 的外部尺寸和位置？
- 相同组件的差异是否通过有名字的 presentation 表达？
- 是否错误地把 `ActionBar` 当成所有 action 状态的 owner？
- 是否使用语义 token，而不是硬编码颜色或位置型 token？
- ARIA 状态、逻辑状态和视觉状态是否由同一个控件链路投影？
- selector 是否把 `data-action-id` 等行为身份误当成视觉身份？
- 新增专用 `ActionViewItem` 是否真的改变了 DOM、行为、ARIA 或生命周期，而不只是添加样式 class？
- 对基座的扩展是否已有多个真实消费者，而不是为单个 host 的皮肤差异预留？
- 文档描述的是当前行为，还是尚未实现的计划？
