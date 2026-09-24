---
description: Ash native UI ownership and the ash-rs/native deprecation boundary.
applyTo: "ash-rs/native/**,app-rs/**"
---

# Native UI Ownership Guidelines

`ash-rs/native` is in deprecation migration. Do not add product capability, reusable UI machinery, components, layout algorithms, interaction trees, animation, deadlines, retained lifecycle, registries, timers, or new state owners there.

Route new capability to its long-term owner:

- backend-independent frame, layout, paint, inspection, interaction, animation, invalidation, and retained lifecycle contracts belong in `app-rs/zui`;
- reusable application/window lifecycle, renderer initialization, platform capability, event-loop, and multi-window orchestration belong to the single public `app-rs/zui` crate; its foundation/layout/text/presentation/runtime/application/platform/renderer modules are private implementation boundaries, not sibling crates or alternative entry points;
- reusable UI controls belong in `app-rs/ui-components` (`ash-ui-components`), while Workbench titlebar, tab navigation, interaction identities, and presentation state belong in `app-rs/workbench-ui` (`ash-workbench-ui`); generic layout algorithms remain in `app-rs/zui`;
- file, SCM, editor, terminal, and other domain behavior belongs in its domain crate;
- `app` owns product state mapping, product event meaning, scene construction, and the native product entry point; it consumes platform events and rendering only through public `zui` contracts.

Changes in `ash-rs/native` are limited to compatibility needed to remove or migrate old implementation, thin mapping from platform/product state into canonical lower APIs, and minimal wiring required to keep the existing host running. An exception must name the long-term owner, migration endpoint, and deletion condition.

When modifying existing native files, prefer migrating, deleting, deprecating, or narrowing responsibility. Historical split scene/interaction hosting is debt, not a foundation for new helpers or public abstractions.

## Learnings

* 测试界面前先确认实现技术栈：Web 和 Electron 界面使用 Playwright；`app` 中基于 ZUI/WGPU 的窗口没有 DOM/CDP 接口，不要声称可用 Playwright 连接。此类界面的结构、层级和几何优先通过 `InspectionFrame` 断言，运行产品只用于补充交互验证，不以截图作为调试依据。
* Workbench sidebar浮层菜单沿用已确认的紧凑规格：菜单项宽 140、高 28，菜单项与菜单表面圆角均为 10，ContextMenu 内边距为 6，菜单文字字号为 13、字重为 SemiBold；悬停子菜单移出父项与子菜单区域后收起，并保留跨越两者间隙的连续指针通道。
* Workbench 组合控件要保留产品壳、产品组合与通用控件三层：例如 SidebarHeader 挂 ModeSwitcher，ModeSwitcher 组合 RadioGroup，Radio 复用 Button。尚未落地且已有明确独立归属的功能区域，不要提前塞进 Workbench 的 Pane 模型。
