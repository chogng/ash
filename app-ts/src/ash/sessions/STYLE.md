# 三层样式边界

Ash 的样式分为三层：IDE、Agent Window（Sessions）、Agent Window 内的独立页面。三层分别定义自己的外观；共用控件、主题服务或处在同一个窗口中，不代表必须使用同一套样式。

本文规定样式的适用范围与隔离要求。[Sessions 设计规范](../../../../.agents/skills/sessions-design-philosophy/SKILL.md)仍负责 Sessions 的视觉尺度、交互和可访问性要求；本文不重复定义这些数值，也不代表所有现有界面已经符合要求。

## 每层负责什么

| 层级 | 适用范围 | 样式由谁决定 | 不得扩散到 |
| --- | --- | --- | --- |
| 第一层：IDE | 常规 Workbench 的窗口、导航、编辑与工具界面 | IDE 的设计规范和所属组件 | Agent Window 及其页面 |
| 第二层：Agent Window（Sessions） | Sessions 的窗口框架、标题栏、页面导航、账户入口，以及窗口通用界面 | Sessions 设计规范与 Sessions 所属组件 | IDE；已有专属外观的页面组件 |
| 第三层：独立页面 | Design 等页面自身的内容、工具和页面所属浮层 | 页面在 Sessions 规范内明确规定的专属样式 | 窗口框架、其他页面和 IDE |

这是样式的适用层级，不是 TypeScript 模块依赖层级，也不是 CSS 加载顺序。IDE 与 Agent Window 是两个独立产品界面；Agent Window 不自动继承 IDE 的视觉规则。页面沿用 Sessions 适用的通用要求，同时可以明确规定自己的背景、颜色、密度和控件外观。

同一个控件在不同层出现，可以有不同的外观。修改前先确认它属于哪一层、是否已有页面专属规则，再决定使用哪套样式。不能以“统一风格”为由抹掉已经明确设计的差异。

## 页面规则如何生效

- 页面明确规定的样式，只对该页面拥有的组件生效；没有专属规定的部分采用 Sessions 规则。可访问性、键盘操作和生命周期要求始终适用。
- 当前打开的页面不决定整个窗口的皮肤。打开 Design 后，标题栏、账户菜单和窗口操作仍属于第二层；切换到其他页面后，也不能残留 Design 的外观。
- 样式归属按组件用途和拥有方判断，不按文件目录或 DOM 挂载位置判断。页面所属菜单即使挂在窗口根节点下，仍属于第三层。
- 共享控件负责结构、交互状态与生命周期。调用方通过控件提供的外观变体、主题变量或专属样式标识选择外观，不能修改共享默认值来实现单个页面的设计。
- 颜色使用所属层或页面的语义 token。页面专属值在页面范围内消费，不改写 IDE 或整个 Sessions 窗口的主题值。
- 窗口通用 CSS 必须限定到 Sessions 窗口；页面 CSS 必须限定到页面组件或其专属浮层。不得用不带页面标识的全局菜单选择器实现页面样式。

## Design 黑色菜单是有意设计

**Design 的右键菜单使用黑色背景，这是页面专属要求，不能推广为整个 Agent Window 的菜单规则。** 普通浅色和深色主题都保留这个黑色表面；高对比度主题遵守 Sessions 的可读性与明确轮廓要求。

| 菜单 | 所属层 | 外观要求 |
| --- | --- | --- |
| IDE 右键菜单 | 第一层 | 使用 IDE 菜单样式 |
| Sessions 账户、窗口与通用右键菜单 | 第二层 | 使用 Sessions 菜单样式，不套用 Design 黑色背景 |
| Design 画布右键菜单、Design 工具下拉菜单 | 第三层：Design | 使用 Design 专属黑色表面和配套前景色 |
| Agent Window 其他页面的菜单 | 第三层：对应页面 | 遵守该页面明确的要求；没有专属规定时采用 Sessions 菜单样式 |

Design 菜单的现有样式入口：

- [designEditorWidget.ts](contrib/creator/browser/widget/designEditorWidget.ts)为画布右键菜单指定 `ash-design-menu`。
- [designToolsWidget.ts](contrib/creator/browser/widget/designToolsWidget.ts)为工具菜单指定同一标识，并注册 `sessions.design.chromeBackground` 和 `sessions.design.chromeForeground`。普通主题的背景值为 `#181818`，表达这里所说的黑色表面。
- [designToolsWidget.css](contrib/creator/browser/widget/designToolsWidget.css)只在带有 Design 菜单标识的浮层上消费专属主题变量。菜单位于共享浮层容器中，因此不能依赖它是画布 DOM 的后代。

这些入口用于定位当前实现，不替代上面的设计要求。复用菜单服务不要求复用菜单颜色；新增 Design 菜单时保留页面标识，新增其他菜单时不能复制 Design 的标识或颜色。

## 修改与验证

修改样式前，在改动说明中写清所属层、目标组件和需要保留的页面差异。只有多个页面确实需要同一条规则时，才把它放到 Sessions 通用样式中；IDE 与 Sessions 共用实现时，仍分别选择外观。

涉及实现的修改使用 Playwright 验证 Browser 与 Electron 的实际交互，通过 DOM、计算样式、焦点和可访问属性检查：

1. 目标组件应用了所属层或页面的样式。
2. 同类组件在 IDE、Sessions 通用界面及其他页面中保留各自外观。
3. 菜单在鼠标右键与键盘打开时外观一致；关闭后恢复正确焦点。
4. 在 Design 与其他页面之间切换并反复打开菜单，页面样式不残留、不串用。
5. 普通浅色、深色与高对比度主题下，文字、悬停、选中、禁用和键盘焦点清楚可辨。

仅修改本文时，检查 Markdown 结构、链接和与设计规范及实现的表述一致性；文档检查不能作为界面行为已经通过验证的证据。
