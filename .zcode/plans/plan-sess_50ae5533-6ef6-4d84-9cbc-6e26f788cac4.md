# 新增 Design 页面 + 无限画布：实施计划

## 先回答你的两个问题

**1. 是不是 session contrib？—— 不是。**
我查了 `sessions/contrib/<feature>/*.contribution.ts` 的机制：它配合 `SessionsViewRegistry` 往辅助栏（Files、Changes）注册视图，不是活动栏页面的注册点。现有 4 个页面（Chat/Colab/Library/Code）是硬编码的：按钮在 `activityBarPart.ts`，切换路由在 `workbench.ts` 的 `selectActivityPage()`。所以新页面照这个现有模式加，不发明新注册机制（`LAYOUT.md` 提到的 `ICustomViewService` 在代码里不存在，是超前描述）。

**2. 无限画布怎么做？—— 仓库里没有现成的平移/缩放表面，需要自研一个轻量视图**（原理见下节）。可复用的零件：`StandardWheelEvent`（滚轮归一化）、`addDisposableListener` + `setPointerCapture`（拖拽，pdfEditorPane 已有先例）、`h()` DOM 构建。

**图标**：`color-filled` 不存在；你说的应是 `symbol-color-filled`，它和 `symbol-color` 都已在 `productIcons.ts` 注册好（`Lxicon.symbolColor` / `Lxicon.symbolColorFilled`），不用重新生成。正好符合 Sessions 设计规范的导航规则：未选中用线框、选中用实心。

## 架构落点

画布不是会话表面，不放进 `SessionsPage`（那是 chat/code 的草稿与导航状态模型），也不新增网格 Part（`sessions` Part 目前是"永不可隐藏"的必需弹性面，动拓扑代价大且规范不要求）。做法：**画布视图由 `workbench.ts` 创建，作为选项交给 `SessionsPart` 保留并按页切换** —— 与 colab/library "空页面"同一条路，只是内容从空白变成画布。切走再切回，视口状态（缩放/平移）保留。

## 无限画布原理（designCanvasView）

- 视口 `div`（overflow:hidden，点阵网格背景）+ 世界层 `div`（`transform: translate(x,y) scale(s)`，origin 0 0）。世界→屏幕：`screen = world × s + offset`。
- 滚轮（`StandardWheelEvent`，`{passive:false}`）：Ctrl/⌘+滚轮 = 以光标为锚缩放，`s' = clamp(s·e^(−Δy·k))`，`x' = cx − (cx−x)·s'/s`；普通滚轮 = 平移 (Δx, Δy)（触控板双指/捏合都覆盖）。
- 指针拖拽平移：pointerdown 捕获 → move 平移 → up/cancel 释放（pdfEditorPane 先例）。
- 键盘（可操作性硬要求）：方向键平移、`+`/`-` 以中心缩放、`0` 复位。
- 点阵网格：视口 `radial-gradient` 背景点，`background-size`/`background-position` 跟随缩放与平移（CSS 变量驱动）；颜色走主题变量，高对比度可辨。
- 缩放范围钳制（0.2–4）。世界层为空（本次不添加内容、不做持久化——没有可持久化的东西）。

## 改动清单

| 文件 | 改动 |
| --- | --- |
| `sessions/browser/parts/design/designCanvasView.ts`（新）+ `media/designCanvas.css`（新） | 画布视图：DOM、滚轮/指针/键盘交互、transform 状态、`focus()`/`layout()` |
| `sessions/browser/parts/activitybar/activityBarPart.ts` | `SessionsActivityPage` 加 `'design'`；code 之后加按钮（symbol-color 线框/实心）；`selectPage()` 图标表加一行 |
| `sessions/browser/workbench.ts` | 创建画布视图传入 `SessionsPart`；`selectActivityPage` 路由 design（sidebar 不可用、auxbar/editor 不可用）；画布焦点作用域键 + 无障碍帮助对话框注册；更新活动栏帮助文案（432 行，提及新页面） |
| `sessions/browser/parts/sessionsPart.ts` | 选项接收画布视图；`setPage` 接受 `'design'`；`focus()`/`layout()` 路由 |
| `platform/accessibility/browser/accessibleView.ts` | `AccessibleViewProviderId` 加 `DesignCanvas` |
| `workbench/contrib/accessibility/browser/accessibilityConfiguration.ts` | `AccessibilityVerbositySettingId.DesignCanvas` + 属性注册（`...baseVerbosityProperty`） |
| `workbench/services/localization/common/localizationCatalogs.ts` | 英文 + 中文词条：`sessions.activity.design`（Design/设计）、画布区域 aria-label、帮助文案 |
| `sessions/README.md` | 更新页面枚举句（96–97 行附近） |

## 无障碍（按 accessibility skill 硬性清单）

- 画布根节点：`role="region"` + 本地化 `aria-label`，`tabIndex=0`，键盘全可操作。
- 帮助对话框（`AccessibleViewType.Help`）+ 冗长度设置 + 关闭后焦点还原；`when` 用画布容器的 scoped context key（照抄活动栏 420–437 行的先例）。画布暂无可呈现内容，不建 Accessible View（同 find widgets 类别）。
- 活动栏按钮：本地化名称、悬停提示、`aria-current="page"`（现有 Button 流程已覆盖）。

## 测试与验证

1. 单测（JSDOM，沿用 `sessions/test/browser/` 模式）：`activityBarPart.test.ts` 补 design 按钮/选中态；`sessions-part.test.ts` 补 `setPage('design')` 切换与 focus 路由；新增 `designCanvasView.test.ts`（滚轮缩放锚点数学、平移、钳制、transform/CSS 变量输出）。
2. 组件截图 fixture：`designCanvas.fixture.ts`（component-fixtures 规范）。
3. 最小验证：受影响面的 typecheck 脚本 + 定向单测（scripts/test.bat 过滤），不跑全量。
4. Playwright 实际驱动验证：页面打开、滚轮缩放/拖拽平移、键盘操作、普通与紧凑活动栏模式、中文界面词条生效；不通过时截图定位。顺带检查 `sessions-window.spec.ts` 冒烟是否有按钮数量假设需同步。

## 明确不做

- 不做持久化、侧栏、工具栏、图元内容（后续迭代再说，当前画布为空）。
- 不把 design 加入 `SessionsPage` 会话状态模型，不动网格拓扑与布局存储。
- 不新增 Part、不建 contrib 注册机制。