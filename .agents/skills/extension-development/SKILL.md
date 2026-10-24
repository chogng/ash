---
name: extension-development
description: Develop or change Ash extensions through the public SDK, from package and runtime selection to implementation, packaging and self-hosted validation. Use for extension features, isolated views, native host bridges and SDK gaps blocking a real extension. For architecture-only decisions use extension-architecture; not for installing or using existing extensions.
---

# 扩展开发

把用户功能交付为可运行、可停用的扩展。作者接口与视图规则以 [TS SDK 开发约定](../../../sdk/typescript/README.md#extension-development) 为准；包来源、运行时与业务归属以[扩展架构文档](../../../docs/editor-extensions.md)为准。只读当前任务涉及的章节，不把目标能力当作已实现能力。

## 先选落点与真实调用链

检查目标包的 manifest、入口、注册、现有消费者和测试。新增包先选相同执行形态的实例，不能只因界面相似就复制它的宿主接入。

| 当前实现形态 | 作者入口与起点 |
| --- | --- |
| 普通 TS/JS 扩展 | [`@ash/sdk`](../../../sdk/typescript/README.md)、[`inspect`](../../../examples/extensions/inspect/README.md)；依照包声明与授权选择宿主 |
| 可信 Browser 扩展及其隔离视图 | 同一个 TS SDK；[`Snapshot`](../../../extensions/snapshot/README.md) 是图像 Provider 的实例，不是通用 Webview 或第三方沙箱承诺 |
| 独立 Rust Provider | [`sdk/rust`](../../../sdk/rust/README.md)；使用公开能力契约和现有监管入口 |
| 已准入的 Rust 编辑器客户端 | [独立开发 SDK](../../../sdk/docs/development.md)；`ash:editor/*` 只适用于该客户端契约，不能拿来替代普通扩展 SDK |

在实现前梳理“用户动作 → 扩展调用 → 已有 SDK 能力 → 宿主 owner → 可观察结果”，说明能力缺口与拟修改层即可，不生成阶段记录。变更业务归属、Provider scope、认证或抽取核心功能时使用 [extension-architecture](../extension-architecture/SKILL.md) 决定 owner。

## SDK 足够就直接开发，缺少时补完整调用链

1. 对照公开类型、目标宿主的实际实现和真实消费者，确认方法、事件、权限与生命周期都可用。类型存在、manifest 声明、另一宿主的实现或内部服务可调用，都不能单独证明当前扩展可用。
2. 按 [SDK 能力开放原则](../../../docs/editor-extensions.md#sdk-能力开放原则) 判断缺口。扩展可自行完成的交互留在包内；不要为绕过 SDK 把整个功能移进 `src`，或添加内部导入、任意 IPC 和旧实现回退。
3. 确需开放能力时，同次完成真实调用者、公开类型/文档、现有 owner 的适配、边界校验与相关验证；有版本兼容影响时同步处理。类型通过而宿主不支持，不算完成。只扩展有调用者的操作，不顺手铺通用窗口、文件或授权框架。
4. 在跨进程/隔离视图边界显式构造契约字段。不要把内部配置、语言包或服务对象整体展开进消息；接收端可能严格拒绝额外字段。错误、取消与结果语义沿现有契约传播。

## 有界面或原生能力时

按 SDK 的 [Extension development](../../../sdk/typescript/README.md#extension-development) 约定分配界面和宿主机制。界面设计使用 [design-philosophy](../design-philosophy/SKILL.md) 与 [accessibility](../accessibility/SKILL.md)；主题和布局分别使用 [ux-theming](../ux-theming/SKILL.md)、[ux-css-layout](../ux-css-layout/SKILL.md)，通过公开主题数据应用到包内，不引入宿主私有 CSS。

Snapshot 的权限引导是具体参照：扩展拥有卡片、步骤、翻译和键盘替代操作；宿主拥有独立窗口、当前应用身份、原生拖动和系统权限查询。需要 Electron 不能成为把这些业务界面放进宿主的理由；也不能承诺把自定义控件插入系统设置。图像 Provider 的阶段性动作契约见 [SDK](../../../sdk/typescript/README.md)，不要把它泛化为所有扩展都可调用的原生窗口接口。

新增图标、字体、脚本等资源时，同时检查包的资源声明、编译输出和产品分发中的实际文件。开发目录能读取资源不证明打包后可读。清理逻辑覆盖交互关闭和 Provider 退役；有跨窗口监听、Blob URL、计时器或在途请求时按 [memory-leak-audit](../memory-leak-audit/SKILL.md) 检查其生命周期。

## 构建和验证实际被加载的包

优先使用既有工具，按变更范围选择入口：

| 目标 | 当前入口 |
| --- | --- |
| 独立 TS 作者包 | 包自己的构建与类型检查；保持 `@ash/sdk` 为外部依赖，参照 `inspect` |
| 同仓 Browser 包与资源快照 | `pnpm prepare:extensions`；检查输出中的目标包、资源和诊断。编译器拒绝越过包边界的导入时，修正依赖或公开契约，不放宽规则 |
| 扩展宿主 TS 接入 | `pnpm typecheck:extensions`，并按改动检查 Main/Renderer。确认目标包源码是否被所选 tsconfig 覆盖；宿主类型检查不能代替包自己的类型检查 |
| 包内单元与交互回归 | 按 [unit-tests](../unit-tests/SKILL.md) 选择 `extensions/<包>/test/` 中真实测试；`test:extensions` 是宿主契约套件，不是所有扩展包测试 |
| 独立 Rust Provider/编辑器客户端 | [Rust 开发](../rust-development/SKILL.md)及对应 SDK 的 build/check/debug 路径；不要为普通 TS 包要求 Rust 工具链 |
| Desktop 用户流程 | 用 Ash 自身验证；一次性原生/交互场景按 [validate-ui-scenario](../validate-ui-scenario/SKILL.md)，持久回归按 [smoke-tests](../smoke-tests/SKILL.md) |

Desktop 的前端产物和选中的后端 runtime 包可能携带不同代的扩展资源。更改随产品分发的扩展后，刷新实际运行入口需要的包：完整 `pnpm scenario <场景.cjs>` 已包含 `prepare:backend`、Desktop 构建与场景编译；直接运行已编译场景前，先确认这些产物都对应当前源码。只重编前端、修改源码或重开窗口不能证明扩展已更新。怀疑旧资源时检查实际加载的包路径、摘要或资源内容，再通过 `pnpm prepare:backend` 等所属入口刷新，不改测试断言来迁就旧包。

验证重点由行为决定：

- 新增 SDK/原生接入：成功结果、拒绝或不支持、取消、注册释放/停用后的旧调用失效；共享状态再覆盖相应多窗口行为。只有类型检查或全部替身调用不能证明真实宿主可用。
- 新增独立窗口/视图：首次打开、关闭与再次打开、键盘完成流程、焦点恢复和资源释放。真实窗口焦点的运行选项见场景技能；不要用隐藏窗口的结果声称验证了原生键盘焦点。
- 界面变化：验证至少一个非默认语言，以及受影响的浅色、深色、高对比和键盘焦点状态；复用已有场景，不为每次小改运行整仓回归。
- 系统权限等外部动作：可以在测试边界替身危险或不适合自动操作的部分，但明确区分已验证的扩展请求、宿主原生调用和未执行的系统操作。拖动发起不等于实际投放成功，打开设置也不等于已授权。

交付说明扩展实现、必要的 SDK/宿主增量、实际验证和剩余限制。已有通过结果仍覆盖当前输入时复用；新改动、失败或未解决疑点才扩大或重跑验证。仅修改技能/文档时检查格式、链接和命令出处，不自动启动 Desktop 或重编 Rust。
