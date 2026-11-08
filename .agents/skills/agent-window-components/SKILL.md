---
name: agent-window-components
description: Build, revise, or review visible components in the Ash Agent Window, including shared Workbench controls used there. Use for component selection, composition, visual corrections, and interaction or geometry acceptance.
---

# Agent Window 组件构建

## 先确定页面约定

1. 从真实入口追到组件、所在宿主、现用变体和已有测试。找到 Agent Window 中一个职责相近的生产控件作为参照，核对它的调用参数和最终呈现。组件同名或共用基座时，仍按各自的页面角色判断。
2. 结合用户反馈、视觉参考和 [Agent Window 样式约定](../../../src/ash/sessions/STYLE.md)，写出本次需要验证的结果。新组件先确定区域、槽位及主要状态。修改已有组件时，区分外观、内容布局、锚点关系和交互，列出应保留的行为。页面有专属要求时按该页面判断通用默认值是否适用。
3. 先把意见转成可观察的关系，再选 token。例如「子菜单偏下」要比较首行与触发行的位置。「图标位置不对」要逐种菜单项核对动作图标、标签、快捷键、勾选和展开箭头所在的槽位。

## 选基座与变体

- 查找已有组件、变体和生产调用方。对照其输入、状态、焦点及释放行为，确认哪些可直接复用，哪些由页面组合。修改共享默认值前查所有受影响的宿主，尤其是 IDE 和 Agent Window 使用同一控件时。
- 用组件的实际职责选择实现。例如命令列表检查共享 `Menu`，带查询输入的选择器检查 `ActionWidget`，锚定与浮层生命周期检查 `ContextView`。优先通过现有变体表达页面需求；共享能力确实缺失时，在负责该行为的基座补齐并验证现有调用方。
- 菜单可用两种不同的图标布局。例如需要左侧动作图标与右侧勾选或展开箭头的菜单可用 `leading-with-trailing-check`；命令图标也需要放右侧的菜单可用 `trailing`。从当前页面的行语义选变体。
- 按任务使用 [设计](../design-philosophy/SKILL.md)、[无障碍](../accessibility/SKILL.md)、[布局](../ux-css-layout/SKILL.md) 和 [主题](../ux-theming/SKILL.md) 技能。涉及的业务状态继续由现有模型或服务持有。

## 在真实呈现中验收

- 从正常入口打开控件，在本次构建的 Agent Window 中观察反馈所指的状态。用截图核对呈现，用浏览器几何、计算样式或交互断言验证具体要求。核对时直接测量目标元素，例如可见行、图标和焦点所在控件。
- 按改动选择容易出错的状态。图标布局应覆盖普通动作、已选与未选、展开项，以及本次涉及的子菜单。异步浮层应在占位和内容替换后分别测量；要求首行对齐时比较当前首行与触发行的边界，并区分视口避让导致的位移。若修改会影响窄窗口、深色或高对比主题、不同语言或键盘操作，覆盖相关变体。
- 把可稳定复现的回归放在组件所属测试中。几何和焦点关系用浏览器断言；需要组件截图覆盖时用 [组件 fixtures](../component-fixtures/SKILL.md)；需要确认实际窗口中的入口、组合或交互时用 [UI 场景验证](../validate-ui-scenario/SKILL.md)。结论写明实测范围和缺失的验证。
