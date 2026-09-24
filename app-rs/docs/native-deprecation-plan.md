# Native UI 兼容边界与渐进式弃用计划

> 状态：当前迁移计划。`app` 产品宿主已经迁移到 `app-rs/`；本文只拥有 Rust UI split boundary
> 与兼容 API 的弃用阶段和删除条件；`zui`
> 的具体 API 契约见 [`app-rs/zui/README.md`](../zui/README.md)，app 的源码路径和
> 产品接入义务见 [`app-rs/README.md`](../README.md)。完整产品根迁移见
> [`app-migration-plan.md`](app-migration-plan.md)。

## 快速理解

`app` 产品宿主不会整体弃用；它现在由 `app-rs/` 承载。要逐步弃用的是迁移前留下的 Rust UI
split scene/interaction boundary，以及重复定义通用 UI runtime 的兼容入口。通用机制归 `zui`，可复用
组件归 `ash-ui-components` 或对应领域 crate，app 只保留产品适配。

| 读者关心的对象 | 当前 canonical owner | Native 状态 | 下一步 |
| --- | --- | --- | --- |
| Element、layout、ComputedElement、scene、inspection | `zui` | 委托 | 禁止在 Native 复制几何或检查树 |
| interaction、focus、capture、失效等级 | `zui` | 委托 | 产品事件只映射为 `UiIntent` 和失效请求 |
| animation、deadline、retained fragment lifecycle | `zui` | 委托；Native 已持有 `RetainedRuntime` 并接入 Shell cleanup | 新产品 fragment 必须显式选择即时 unmount 或 exit spec；禁止 Native 自建 runtime |
| Button、Tree、List、Diff 等通用组件 | `ash-ui-components` / 领域 crate | 委托 | Native 只提供状态投影和 action adapter |
| 窗口、平台事件、App Server、文件/Git/Session 状态 | `app` | ✅ 保留 | 不迁入 `zui` |
| Shell/Composer/Inspector 的产品组合 | `app` | ✅ 保留 | 通过 `UiFrame` 组合 |
| `ShellPresentation` 的 frame ownership | `app` | ✅ 已完成 | 继续保持单一 `UiFrame<InteractionFrame>` owner |
| `UiScene::draw_component_with_interaction`、`UiFrame::parts_mut`、`UiFrame::into_parts` | `zui` 旧兼容 API | ✅ 已删除 | 禁止重新引入平行输出入口 |

这里的弃用阶段已经结束：旧 split composition API 不再可调用。本文保留它作为迁移记录；以后如果
出现同名 API、平行 `UiScene`/`InteractionFrame` 字段或第二个 frame owner，应视为架构回退，而不是
兼容需求。

## 边界原则

- `zui` 拥有后端无关的 frame、layout、paint、inspection、interaction、animation、deadline 和 retained
  lifecycle 契约；这些能力不能因为 Native 接入方便而在 Native 再实现一份。
- `ash-ui-components` 和领域 crate 拥有可复用组件的内部几何、状态投影和交互节点；Workbench Part 只组合它们，
  不用深层选择器或重复 hit-test 覆盖组件内部规则。
- Native 拥有产品状态、平台事件适配、App Server/文件/Git/Session 映射、command 执行和具体产品
  Part/Overlay 的组合。它可以保存可丢弃的 presentation state，但不拥有通用 UI runtime。
- renderer 只消费 `UiScene`；它不接触 interaction、accessibility、产品 command 或 retained owner。
- `zui` 的兼容入口只兼容输出形状，不兼容第二套组件组合、检查树或交互注册路径。

## 当前迁移状态

通用能力已经收回 `zui`：`ComponentContext`/`UiFrame` 统一组件组合，`FrameScheduler` 统一失效，
`AnimationRegistry` 和 `RetainedRuntime` 统一时间与跨帧生命周期。Files、SCM、浮层、编辑器和大多数
app overlay 已经通过共享组合生成 inspection 与 interaction。

`ShellPresentation` 已把 `UiScene` 与 `InteractionFrame` 收拢到同一个 `UiFrame<InteractionFrame>`；
accessibility projection 仍是宿主消费的语义快照，不是第二个 frame owner。组件组合统一通过
`UiFrame::draw_component`、`ComponentContext::draw_component` 或 `ComponentContext::with_component` 完成，旧
split composition adapter 已删除。`RetainedRuntime` 的 fragment removed-ID cleanup 和 `AnimationBinding` 已接入
Shell；当前 Language Server switch 使用即时 unmount，SCM fold height 使用 retained scalar + full rebuild，迁移
主路径没有遗留的 framework 兼容入口。未来新增退出动画或产品属性时，必须沿同一 zui contract 接入，不得通过恢复旧 API 解决。

## 分阶段发布

### 阶段一：建立迁移信号（已完成）

- 将 split scene/interaction 入口迁移到 `UiFrame`，清零调用后删除旧入口；
- 在 app README 和迁移计划中明确：`app` 是产品宿主，不是通用 UI framework；
- 继续禁止组件级 `register_interactions`、Native 自有 animation timer 和重复 layout/inspection 树；
- 保持现有 targeted tests 通过，弃用告警本身不作为错误。

### 阶段二：统一 Shell frame 所有者（已完成）

- 让 `ShellPresentation` 内部持有 `UiFrame<InteractionFrame>`，并由它独占 frame owner；
- overlay、inspector 和 retained fragment rebuild 都从同一个 frame owner 派生 scene、interaction 和
  semantics snapshot；
- renderer 继续只接收 `UiScene` 投影，避免把 GPU 边界扩大；
- 清零 `app` 生产代码中的 `draw_component_with_interaction` 调用并删除 API。

### 阶段三：统一 fragment cleanup（已完成框架接线）

- [x] 消费 `RetainedRuntimeAdvanceReport::fragment().removed_ids` 时，在同一个 cleanup 路径移除 scene fragment、
  interaction checkpoint 和 semantics；
- [x] 让 exit animation 只保留仍在 retained presentation 中的节点，禁止 inspector 或 hit-test ghost node；
- [x] 将 cleanup、deadline 和 redraw invalidation 固定为 deterministic clock 测试；当前产品 fragment 已明确即时
  unmount，未来启用 exit retention 时必须同时提交产品状态与动画规格。

### 阶段四：删除兼容入口（已完成）

只有以下条件同时满足，才删除 deprecated API 和 split host adapter：

- Native 与领域组件生产代码不再调用 `draw_component_with_interaction`，旧 API 已删除；
- `UiFrame::parts_mut` 和 `into_parts` 已删除；
- Shell 的 scene、interaction、inspection/accessibility snapshot 来自同一帧组合；
- shell、overlay、Files、SCM、editor 和 retained lifecycle targeted tests 已覆盖共享身份、bounds、parent、
  可见范围和时间推进；
- `zui` README、app README、渲染架构文档和本计划已同步到当前 owner。

## 识别架构漂移

以下改动应被视为 Native 继续拥有 framework 机制的信号，并在 review 中阻断或要求迁移说明：

- 在 Native 新增通用 `Rect`/layout 计算、inspection metadata 或基于 paint primitive 反推控件树；
- 在 Native 为 hover、focus、动画、fragment exit 或 deadline 安装独立 timer/registry；
- 一个组件同时拥有 `compose`/`interaction_node` 和手写第二次 interaction registration；
- 为了适配一个产品 Part，给 `zui` 增加产品 identity、文件/Git/Session 类型或反向依赖；
- 用 host-specific deep selector 覆盖 `ash-ui-components` 组件内部的 selected、hover、active、focus 或 disabled 样式。

这些规则不要求 Native 变薄到没有产品逻辑；它们要求“产品决定什么”和“框架如何表达/调度”保持可定位的
边界。
