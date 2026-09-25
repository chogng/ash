# MenuId 与 UI Action 组合系统

> 本文是 Ash Desktop Renderer 中 Command、MenuId、Context Key、MenuService 与菜单型
> Toolbar 组合关系的 canonical 文档。
> Renderer 组件和 CSS 状态所有权以 [`ui-styling-ownership.md`](ui-styling-ownership.md)
> 为准；Desktop 的进程与产品边界以
> [`ash-desktop-architecture.md`](ash-desktop-architecture.md) 为准。

## 快速理解

`MenuId` 是一个稳定的 **UI action 贡献位置标识**。功能模块注册 Command，并声明该
Command 要出现在哪些 `MenuId` 中；Titlebar、Editor、Chat 或 Menubar 等 host 只消费自己
拥有的 `MenuId`，不直接依赖提供 action 的功能模块。

```text
Action2 / registerAction2
  ├─→ CommandsRegistry：注册可执行行为
  ├─→ MenusRegistry(MenuId)：注册 UI 位置
  └─→ KeybindingsRegistry：注册可选快捷键

MenusRegistry + ContextKeyService
  → MenuService
  → 分组后的 MenuItemAction / SubmenuItemAction
  → MenuWorkbenchToolBar
  → WorkbenchToolBar
  → ToolBar / Menu
  → CommandService.executeCommand()
```

Menu 系统解决的是 **action 的跨模块发现、条件投影、排序和呈现组合**，不是任意模块之间
相互调用的总线。真正执行功能的是 Command；真正决定 CSS 视觉的是控件及其 presentation。

| 读者的问题 | 应该查看的概念 | 它负责什么 |
| --- | --- | --- |
| 点击后做什么 | Command | 执行业务行为 |
| 动作出现在哪里 | `MenuId` | 标识稳定贡献位置 |
| 什么时候显示或可用 | Context Key | 投影当前上下文条件 |
| 如何分组和排序 | Menu contribution | 声明组合关系 |
| 最终长什么样 | Toolbar、Menu 和组件样式 | 渲染与交互视觉 |

## 核心概念与所有权

| 层 | 当前实现 | 负责 | 不负责 |
| --- | --- | --- | --- |
| Command | `CommandsRegistry`、`ICommandService` | 命令 ID、执行入口、依赖服务访问 | UI 出现位置、排序和样式 |
| Action 声明 | `Action2`、`registerAction2()` | 把一个内建 action 的 command、menu、keybinding、F1 声明集中注册 | host 布局和 DOM |
| 位置标识 | `MenuId` | 标识一个稳定的 action 贡献槽位 | 菜单实例、DOM ID、业务服务定位 |
| 静态注册表 | `MenusRegistry` | 保存 `MenuId → contribution[]`，提供注册和释放事件 | 判断当前 context、执行命令 |
| 条件状态 | `IContextKeyService` | 提供 visibility、enablement、checked 等规则的输入 | 业务权限和最终执行校验 |
| 菜单契约 | `platform/actions/common/actions.ts` 中的 `IMenu`、`IMenuService`、`IMenuChangeEvent` | 定义菜单查询、变化事件和服务注入入口 | 具体解析流程 |
| 解析层 | `platform/actions/common/menuService.ts` 中的 `MenuService` | 按 context 过滤、排序、分组、解析 submenu，并生成 runtime action | 控件布局和视觉样式 |
| Runtime action | `MenuItemAction`、`SubmenuItemAction` | 暴露 label、icon、enabled、checked，并桥接到 `CommandService` | Command 的业务实现 |
| Base 呈现 | `ToolBar` | primary/secondary 排列、More Actions、键盘与 DOM | platform action 类型、MenuId |
| Workbench 适配 | `WorkbenchToolBar` | 接受调用方提供的 actions，并把 platform menu action 适配为 base action view item | 自动查询 MenuId |
| Menu 驱动 | `MenuWorkbenchToolBar` | 消费一个 `MenuId`、监听 Menu/Context 变化并更新 `WorkbenchToolBar` | Command 业务实现、host 布局 |
| 菜单呈现 | Menubar control、popup `Menu` | 把 action 呈现为 `menubar/menu/menuitem` | Toolbar 语义 |
| Host | Titlebar、Editor、Chat 等 | 选择要消费的 `MenuId`，拥有区域布局 | 直接 import 其他功能模块来收集 action |

一句话记忆：

| 问题 | 去哪里找 |
| --- | --- |
| 点击后做什么？ | Command |
| 出现在哪里？ | MenuId placement |
| 何时出现、可用或选中？ | Context Key expression |
| 如何排序和组成 submenu？ | Menu contribution + MenuService |
| 渲染成什么控件？ | Toolbar / Menubar host |
| hover、checked、focus 长什么样？ | 对应控件 CSS 与 presentation |

## MenuId 到底是什么

`MenuId` 的值只表示一个逻辑位置。例如：

- `MenuId.TitleBarLeft`：Titlebar 左侧 action 槽位。
- `MenuId.TitleBar`：Titlebar 右侧 action 槽位。
- `MenuId.EditorTitle`：Editor title action 槽位。
- `MenuId.ChatTitle`：Chat title action 槽位。
- `MenuId.TerminalTitle`：Terminal View title action 槽位。
- `MenuId.MenubarViewMenu`：应用菜单 View 下的 contribution 槽位。
- `MenuId.CommandPalette`：Command Palette 的 action 集合。

同一个 Command 可以贡献到多个 `MenuId`。例如 Toggle Panel 同时贡献到
`MenuId.TitleBar` 与 `MenuId.MenubarViewMenu`，并通过 `f1: true` 进入 Command Palette。
这些 UI 入口最终执行同一个 Command，不复制业务实现。

`MenuId` 不是：

- ❌ 一个已经创建好的菜单或 Toolbar。
- ❌ DOM element ID 或 CSS selector。
- ❌ 服务定位器、模块 RPC 或通用 event bus。
- ❌ 权限边界；隐藏或禁用 action 不能替代 Command 执行时的业务校验。
- ❌ action 的选中态样式 owner。

内建的公共槽位应优先使用 `MenuId` 上已有的静态实例。需要新增共享槽位时，定义一次明确
导出的 canonical 实例；跨模块按字符串取得同一槽位时使用 `MenuId.for(identifier)`。
不要在多个模块里重复 `new MenuId("same.id")`：构造器会拒绝重复 ID。

## 注册操作（Action）

内建、静态加载的功能优先使用 `Action2`。一个声明可以统一注册 Command、一个或多个
Menu placement、快捷键和 Command Palette 入口：

```ts
import { Action2, MenuId, registerAction2 } from "../../../../platform/actions/common/actions.js";
import type { ServicesAccessor } from "../../../../platform/instantiation/common/instantiation.js";
import { PanelVisibleContext } from "../../../common/contextkeys.js";
import { IWorkbenchLayoutService } from "../../../services/layout/browser/layoutService.js";

registerAction2(class TogglePanelAction extends Action2 {
  constructor() {
    super({
      id: "workbench.action.togglePanel",
      title: "Show Panel",
      toggled: {
        condition: PanelVisibleContext.isEqualTo(true),
        title: "Hide Panel",
      },
      menu: [
        { id: MenuId.TitleBar, group: "navigation", order: 9 },
        { id: MenuId.MenubarViewMenu, group: "2_appearance", order: 11 },
      ],
      f1: true,
    });
  }

  override run(accessor: ServicesAccessor): void {
    const layout = accessor.get(IWorkbenchLayoutService);
    if (layout.isPartVisible("panel")) layout.hidePart("panel");
    else layout.showPart("panel");
  }
});
```

`keybinding` 可以声明一项，也可以声明多项各自拥有 `when`、参数、来源和优先级的独立规则；同一规则的等价备用按键继续使用 `secondary`。不要为了让不同上下文共享一个 Command 而复制 Action 类。

静态 contribution module 可以让该注册随当前 JavaScript realm 存活。动态功能必须保存并
释放 `registerAction2()` 返回的 `IDisposable`。如果任一步注册失败，
`registerAction2()` 会释放此前已完成的注册，不留下半注册状态。
同一个 action 的多个 Menu placement 与 F1 入口会一次写入 Registry；Menu 的监听者在
注册和释放时各收到一次完整的变化事件。

### 动态添加位置

Command 已经存在，只需要动态改变 UI 位置时，可以直接使用 `MenusRegistry`：

```ts
const registration = MenusRegistry.appendMenuItem(MenuId.EditorTitle, {
  command: {
    id: "editor.action.preview",
    title: "Open Preview",
  },
  when: EditorHasPreviewContext,
  group: "navigation",
  order: 20,
});

// contribution 生命周期结束时
registration.dispose();
```

这段代码只注册 placement；`editor.action.preview` 仍必须由 Command 系统注册执行入口。
同一 owner 要同时添加多个位置时使用 `appendMenuItems()`。每次注册都有独立的释放身份，
即使复用了同一个 contribution 对象，释放时也只移除对应位置。

### 声明子菜单（Submenu）

Submenu 自己也是一个 `MenuId`，父菜单只贡献一个指向它的入口：

```ts
const RefactorMenu = MenuId.for("EditorRefactor");

const submenuRegistration = MenusRegistry.appendMenuItem(MenuId.EditorTitle, {
  title: "Refactor",
  submenu: RefactorMenu,
  group: "1_modification",
  order: 10,
});

const itemRegistration = MenusRegistry.appendMenuItem(RefactorMenu, {
  command: {
    id: "editor.action.rename",
    title: "Rename Symbol",
  },
  order: 10,
});
```

默认情况下，解析后为空的 submenu 不会出现；调用方显式传入
`preserveEmptySubmenus: true` 时才保留。循环引用会在解析时抛出错误。

## 条件语义

下面几个字段看起来相似，但 owner 和效果不同：

| 字段 | 判断对象 | 当前效果 |
| --- | --- | --- |
| placement `when` | 这个位置 | 条件不满足时，该 action 不出现在这个 `MenuId` 中 |
| command `precondition` | 这个 Command action | action 仍可出现，但 `enabled` 为 `false` |
| command `toggled` | 这个 Command action | 解析为 `checked`，并可替换 checked 时的 title、tooltip、icon |
| keybinding `when` | 这个快捷键入口 | 与 `precondition` 合并后决定快捷键是否匹配 |
| `f1: true` | Command Palette placement | 自动贡献到 `MenuId.CommandPalette`；当前以 `precondition` 作为该 placement 的 `when` |

`when` 和 `precondition` 都只是 UI/输入层规则。Command 不能假设所有调用都来自该 Menu，
仍需在执行路径中维护业务不变量和权限边界。

`toggled` 只生成语义状态。控件会并行投影 `.checked` 与 ARIA 状态；是否高亮以及具体皮肤由
Toolbar/Button 等呈现层负责，详见
[`ui-styling-ownership.md`](ui-styling-ownership.md)。

## 分组与排序

`MenuService` 当前按以下顺序解析 contribution：

1. 用 placement `when` 过滤。
2. 先按 `group` 排序：`navigation` 最前，无 group 最后，其余按名称排序。
3. 同一 group 内按 `order` 升序。
4. `order` 相同时按 title 排序。
5. 递归解析 submenu。

`MenuWorkbenchToolBar` 默认按以下规则呈现 group；host 可以通过 `toolbarOptions` 指定
primary group、内联 submenu 和 primary separator：

| Group | 当前 Toolbar 呈现 |
| --- | --- |
| `navigation` | primary action，直接显示 |
| 其他 group 或无 group | secondary action，以 separator 分组后进入 More Actions |

因此 `group` 既参与稳定排序，也会影响菜单型 Toolbar 的 primary/secondary 布局。不要仅为
得到某种 CSS 外观随意使用 `navigation`；它表达的是主要、直接可达的 action。

## 宿主如何消费 MenuId

Host 只选择槽位，不收集功能模块：

```ts
const toolbar = new MenuWorkbenchToolBar(
  container,
  menuService,
  contextMenuService,
  MenuId.TitleBar,
  { presentation: "inherit-foreground" },
);
```

`MenuWorkbenchToolBar` 会：

1. 通过 `menuService.createMenu(menuId, contextKeyService?)` 创建当前 context 下的可观察视图；Editor group 等拥有 DOM scope 的 host 传入自己的 scoped context service。
2. 调用 `menu.getActions()` 获得分组后的 runtime actions。
3. 将 `navigation` 投影到 primary，其余 group 投影到 secondary。
4. 在 Menu Registry 或 Context Key 变化时重新解析和渲染。
5. 点击 `MenuItemAction` 时通过 `CommandService.executeCommand()` 执行同 ID Command。

Titlebar 因而只依赖 `MenuId.TitleBar`，不需要知道 Toggle Panel 是哪个模块注册的；Panel
模块也不需要取得 Titlebar 实例。MenuId 是二者之间稳定、低耦合的组合边界。

## Toolbar 三层边界

三层按 action 来源和依赖方向拆分，不按视觉拆分；它们最终都保持 `role="toolbar"`：

```text
ToolBar
  ↑ 提供 platform action view item 适配
WorkbenchToolBar
  ↑ 提供 MenuId 自动解析与刷新
MenuWorkbenchToolBar
```

| 层 | 调用方式 | 典型用途 |
| --- | --- | --- |
| `ToolBar` | `setActions(primary, secondary)` | base 控件和不应依赖 platform actions 的底层调用方 |
| `WorkbenchToolBar` | `setActions(primary, secondary)` | 调用方已经拥有 actions，但其中可能包含 platform menu actions |
| `MenuWorkbenchToolBar` | 构造时传入 `MenuId` | Host 只拥有贡献槽位，actions 由 MenuService 提供 |

`WorkbenchToolBar` 当前的真实职责是 action representation 适配：调用方可以手工传入
`MenuItemAction`、`SubmenuItemAction` 或普通 `IAction`，它会选择正确的 toolbar view item。
它不自动读取 `MenuId`，也没有复制 VS Code 的 action 隐藏、遥测、配置快捷键或复杂 overflow
策略。以后只有这些能力形成真实共享需求时，才继续加入这一层。

`MenuWorkbenchToolBar` 在此基础上拥有 `IMenu` 生命周期、group 到
primary/secondary 的投影和刷新。它的 `Menu` 表示 action 来源，不表示 ARIA role；常驻
按钮区域仍是 toolbar，只有 More Actions 弹层及应用菜单使用 menu/menuitem。

## 什么时候使用哪一层

| 场景 | 推荐 |
| --- | --- |
| 多个模块会向同一区域贡献 action | 使用 MenuId-backed Toolbar/Menu |
| action 需要随 Context Key 动态出现、禁用或 checked | 使用 MenuId + MenuService |
| 同一 Command 要进入 Titlebar、Menubar、Command Palette 等多个入口 | 使用 `Action2` 的多个 placement |
| Workbench 调用方已经拥有完整 action 列表 | 使用 `WorkbenchToolBar` |
| base 控件内部一次性构造固定 action，且不应依赖 platform actions | 使用 `ToolBar` |
| 只需要程序调用或快捷键，不需要 UI 入口 | 只注册 Command/Keybinding |

选择 Toolbar 时按以下顺序机械判断，不根据外观或所在 Part 猜测：

| 判断 | 是 | 否 |
| --- | --- | --- |
| action 是否来自 `MenuId` / `MenuService`？ | 使用 `MenuWorkbenchToolBar` | 继续判断 |
| 调用方是否已经拥有完整的 primary/secondary action 列表？ | Workbench 产品代码使用 `WorkbenchToolBar` | 先明确 action 的 owner 和来源 |
| 是否是 `src/ash/base` 内部的领域无关控件？ | 可以使用 `ToolBar` | 不得直接构造 base `ToolBar` |

只有 base UI 和 `platform/actions` 中实现标准适配层的代码可以直接依赖 base `ToolBar`。
Workbench Part、View、Contribution 等产品代码必须在 `WorkbenchToolBar` 与
`MenuWorkbenchToolBar` 之间选择。`MenuWorkbenchToolBar` 自己拥有 action 列表；调用方
通过注册 Command、Menu contribution 和更新 Context Key 改变内容，不调用
`setActions()`。

Titlebar、Editor title、Chat title 与 Terminal title 当前都使用
`MenuWorkbenchToolBar`。Terminal 拥有 `MenuId.TerminalTitle`，其 profile、New、Relaunch
与 Kill action 注册为 Command + Menu contribution；profile 使用自定义 action view item
保留原生选择控件，显隐与 enablement 由 Terminal Context Key 投影。

## 生命周期与失败语义

- `MenusRegistry` 是当前 JavaScript realm 内的共享注册表。
- `appendMenuItem()` 与 `registerAction2()` 都返回可释放注册；动态调用方必须与自己的
  生命周期绑定。
- `MenuService.getMenuActions()` 是一次性解析；`createMenu()` 返回可观察、可释放的 `IMenu`。
- `IMenu.onDidChange` 只响应自身及子菜单相关的 Registry 变化、相关 Context Key 变化和
  语言变化。事件分别标记结构、可用状态和选中状态的变化；语言变化时三个标记都为 `false`，
  调用方仍需更新可见文本。
- `getMenuItems()` 返回数组副本，调用方不能借此修改 Registry。
- Submenu 循环会报错；空 submenu 默认丢弃。
- Command 的执行错误由 `CommandService.executeCommand()` 返回的 Promise 向调用方传播。

## 禁止的耦合方式

- ❌ Titlebar 为了显示 Panel action 而直接 import `TogglePanelAction` 并手工构造按钮。
- ❌ 功能模块直接查询 Titlebar DOM 后插入 action。
- ❌ 只注册 Menu placement，却没有注册相同 ID 的 Command 执行入口。
- ❌ 把 `when` 或 `precondition` 当成安全校验。
- ❌ 用 `MenuId.id` 拼 CSS selector 或作为视觉 variant。
- ❌ 在 host CSS 中根据某个 Command ID 重写通用 Toolbar/Button 的内部 checked 样式。
- ❌ 在多个模块中重复构造同名 `MenuId`。
- ❌ Workbench Part、View 或 Contribution 直接构造 base `ToolBar`，绕过 platform action
  适配。
- ❌ 调用方对 `MenuWorkbenchToolBar` 调用 `setActions()`；它的 actions 只能来自构造时
  指定的 `MenuId`。
- ❌ 因为类名包含 `Menu` 就把常驻 Toolbar 设置为 `role="menu"`；只有弹出的菜单容器和
  菜单项使用 `menu` / `menuitem`。

## 当前实现状态

| 能力 | 状态 |
| --- | --- |
| 一个 Action 统一注册 Command、Menu、Keybinding 和 F1 | ✅ |
| 一个 Command 贡献到多个 MenuId | ✅ |
| Context 驱动 visibility、enablement、checked | ✅ |
| Group/order 排序与递归 Submenu | ✅ |
| Registry 与 Context 变化后刷新 Menu-backed Toolbar | ✅ |
| Submenu 循环检测和空 Submenu 策略 | ✅ |
| `ToolBar → WorkbenchToolBar → MenuWorkbenchToolBar` 分层 | ✅ |
| Terminal title actions 接入 `MenuId.TerminalTitle` | ✅ |
| 只通知受影响 MenuId 和相关 Context Key | ✅ |
| 每个 MenuId 的显式 owner catalog | 尚未完成 |
| 每个 Toolbar 自定义 group 到 primary/secondary 的策略 | ✅ |

### 当前限制

1. `MenuId` 的 owner 目前主要依赖静态定义和命名，没有独立 catalog。新增槽位时必须由
   实际消费它的 host/domain 拥有并导出。
2. `WorkbenchToolBar` 当前只拥有 platform action representation 适配；VS Code 中的 action
   隐藏、配置快捷键、遥测和复杂 overflow 策略尚未实现，不能描述为当前能力。

## 扩展原则

后续扩展 Menu 系统时保持以下不变量：

1. Command 是可执行行为的唯一 canonical ID；Menu placement 不复制实现。
2. MenuId 由消费该位置的 host/domain 拥有，不由某个偶然的首个 contributor 拥有。
3. Base UI 不得反向依赖 Workbench Menu 系统；`platform/actions` 负责把 Workbench
   contribution 适配为 base `IAction`。
4. Context Key 负责 UI 策略投影，不替代业务校验。
5. Group 表达 action 组织语义，不表达 CSS 皮肤。
6. 视觉差异通过控件 presentation 和 token 解决，不污染 MenuId 或 Command。
7. 新增能力必须区分当前实现、已决定但未实现的 proposed work 与潜在方向。
8. `WorkbenchToolBar` 只接收调用方 actions；MenuId 监听与刷新只能由
   `MenuWorkbenchToolBar` 拥有。

## 审查清单

- 这是一个可执行行为，还是一个 UI 位置？
- Command 是否只注册一次，并由所有 UI 入口复用？
- MenuId 是否由消费该位置的 host/domain 拥有？
- Toolbar 的 action 来源是 `MenuId`，还是调用方拥有的 action 列表？
- Workbench 产品代码是否直接构造了 base `ToolBar`？
- 是否错误地对 `MenuWorkbenchToolBar` 调用了 `setActions()`？
- 常驻 action 区域是否保持 `role="toolbar"`，仅弹出菜单使用 `menu` / `menuitem`？
- `when`、`precondition` 与 `toggled` 是否使用了正确语义？
- group 是否表达真实组织关系，`order` 是否只在同组内比较？
- 动态注册是否随 owner 释放？
- Command 执行路径是否仍维护业务不变量和权限校验？
- 样式是否留在对应控件，而不是写进 Menu/Command 层？
- 文档与代码是否明确区分当前能力和后续方向？
