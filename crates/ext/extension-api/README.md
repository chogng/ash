# Extension API

本 crate 定义 Ash Agent 核心与功能扩展之间的 Rust 接口。Goal、Skills、Memory 等功能通过贡献接口接入上下文准备、工具执行和生命周期；Core 保留 Thread/Turn 的权威状态、事实提交和最终执行授权，App Server 负责产品组合。

当前实现是进程内 Rust trait、注册表和作用域状态，不负责扩展包安装、进程启动或系统隔离，也不是独立 Rust 扩展的公开 runtime SDK。TS/JS 与独立 Rust 程序的目标边界、Provider 状态和客户端消费由 [扩展架构](../../../docs/editor-extensions.md#0-确定的产品方向) 维护。迁移可选能力时复用贡献语义，但不把进程内注册成功当作独立 Provider 已完成。

## 提供哪些接入点

| 接口 | 职责 |
| --- | --- |
| `TurnInputContributor` | 为一次模型调用提供带来源、信任层级和保留策略的提示片段；Core 负责优先级、预算和最终组装。 |
| `ContextContributor` | 在 Turn 首次模型调用时收集带 revision 的临时证据，作为不可信用户上下文处理。 |
| `SkillActivationContributor` | 在 Core 接受新 Turn 前，将 Skill 选择解析为绑定具体内容的激活快照。 |
| `ReadOnlyToolContributor` / `CapabilityToolContributor` | 提供只读工具或声明所需权限的工具；宿主通过统一工具策略检查和路由。 |
| `LifecycleObserver` / `ToolLifecycleContributor` / `McpLifecycleContributor` | 观察已提交的 Thread、工具事实或 MCP 目录变化，更新扩展自己的状态和缓存。 |
| `IdleContributor` / `ContinuationContributor` | 唤醒领域调度器、规划后续 Turn 和恢复待执行工作；Turn 接纳与模型执行仍归核心 owner。 |
| `ApprovalReviewContributor` | 对准备好的 action 返回审核评估；只有 ActionPolicy 可以将评估转为执行授权。 |
| `ItemContributor` / `ExtensionItemStore` | 为已授权 Thread 提供结果展示，并保留有界的近期结果，不替代持久历史。 |

## 如何接入

功能 crate 实现所需贡献接口，宿主通过 `ExtensionRegistryBuilder` 注册，再调用 `build()` 得到 `ExtensionRegistry`。Core 和宿主在对应执行阶段调用 registry，具体领域读取、同意检查和业务策略由贡献实现拥有。

带扩展身份的注册在重复时替换原位置的贡献，保持顺序；Skill 激活贡献按注册顺序追加，审核器单独配置。通过 `from_registry()` 重新组合时，共享同一份 `ExtensionState`，不会复制范围状态。

`ExtensionState` 按 Session、Thread、Turn 保存类型化临时状态。Turn 结束、Thread 归档和 Session 删除清理对应范围及其子范围；领域持久数据由各领域存储拥有。生命周期回调不能重新进入 Core 提交锁或否决已提交事实；续跑在提交锁之外通过 Thread owner 的原子接纳接口创建工作。

## 阅读入口

- [贡献接口](src/contributors.rs)：Skill 激活、提示片段和工具权限声明。
- [上下文证据](src/context.rs)与[提示片段](src/fragment.rs)：来源、revision、信任层级和保留语义。
- [生命周期接口](src/lifecycle.rs)：事实通知、审核和续跑约束。
- [注册表](src/registry.rs)与[作用域状态](src/state.rs)：注册、组合、调用和清理。

完整职责与接口见 [Agent 扩展](../../docs/extensions.md)，上下文预算与信任层级见 [Core Context](../../../docs/core-context.md)。
