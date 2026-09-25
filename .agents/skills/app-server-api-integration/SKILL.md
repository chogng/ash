---
name: app-server-api-integration
description: Expand a Rust app-server into the desktop product business backend while preserving the TypeScript editor platform. Use for backend ownership decisions, TypeScript host replacement, renderer protocol clients, Main relays, generated bidirectional protocol, domain adapters, integration lifecycle, cancellation, conflict gating, and exact file placement. Do not use for standalone daemon or CLI startup defects, or to move UI, editor models, or extension runtime into Rust.
---

# App-server API 对接

目标是保留 TypeScript 编辑器前端与桌面平台，把 Rust app-server 扩展成产品业务后端。应由后端长期拥有的业务状态、执行、资源和后台能力迁入 Rust；编辑器模型、扩展运行时、Workbench UI 和 Electron 平台能力留在前端。前端公共接口继续按领域组织，renderer 通过领域 adapter 使用 app-server；生成协议只存在于 adapter 和 protocol client 边界。

本 skill 只约束桌面前后端接入和迁移。单独修复 `ash-app-server-daemon` 的进程管理、CLI 启动或版本更新缺陷时，按对应 owner 与测试规范处理，不套用下面的跨端迁移门禁和完成标准。

## 目标产品边界

- Rust 后端默认拥有 Agent、Thread、Turn、Item、Project、Environment、账户会话、模型 catalog 与调用状态、审批与权限、command/process/resource、Agent 发起的 Git/repository/worktree 操作，以及跨窗口存活的搜索、索引、监听、远程连接和恢复。
- TypeScript 编辑器平台继续拥有 text model、working copy、dirty buffer、undo/diff、Workbench contribution、扩展运行时、SCM/Terminal 的前端 contract、设置、主题、布局、快捷键、可访问性和窗口交互。
- Main 保留 Electron 与操作系统能力，但压缩为进程启动、窗口生命周期、连接 acquisition、透明 relay 和少量 typed host channel；它不成为业务后端。
- 通用文件服务、交互式 Terminal 执行层、SCM 执行层和语言服务只有在形成稳定跨进程 contract、不会复制 editor/extension state、且收益明确时才迁入 Rust；不因语言偏好或目录对称迁移。
- Rust 侧按领域 crate 隔离能力与依赖；`../app-server/` 只负责 connection、typed dispatch 和跨领域 orchestration，不能成为装下所有业务实现的单体 crate。

完整迁移判断、保留边界和条件能力见 [连接与所有权](references/connection-architecture.md)。

## 最终调用链

```text
renderer contribution
  → 前端领域 service
  → 该领域的 app-server adapter
  → renderer protocol client
  → renderer MessagePort transport
  → Main transparent relay
  → renderer 专属 backend connection
  → 一个共享 app-server process
  → Rust typed dispatch 与领域能力
```

这条链路直接替换旧 Host 的线上协议和 TypeScript 后端运行层。不得让 Rust 重写旧 Host 协议，不得保留双后端入口，也不得把 Main 变成新的 TypeScript 后端。

## 核心所有权

- 现有前端领域 service 继续拥有公共契约、状态、事件、错误、取消和释放语义；UI 不导入生成 DTO。
- 对应领域的 `browser/` 或 `electron-browser/` adapter 机械转换前后端类型，不拥有 Rust 持久状态。
- `src/platform/agentHost/browser/appServerProtocolClient.ts` 拥有每个 renderer 的初始化、请求配对、notification、server request、connection 代次和关闭。
- `src/platform/agentHost/electron-browser/appServerMessagePortTransport.ts` 只把 MessagePort frame 转换为 protocol transport。
- `src/platform/agentHost/electron-main/electronAgentHostStarter.ts` 拥有共享进程的启动、停止、可执行文件解析和 renderer connection acquisition。
- `src/platform/agentHost/electron-main/appServerConnectionRelay.ts` 为每个 renderer 创建独立 backend connection，并透明转发 frame；它不解析 JSON-RPC。
- `src/platform/agentHost/common/appServerProtocol/generated/` 是 renderer 可导入的机械生成物，不能留在 `node/` owner 下，也不能手改。
- `build/app-server/generate-protocol.mjs` 与 `build/app-server/check-protocol-sync.ts` 固定后端版本、生成协议并做逐字节同步检查。
- `../app-server-protocol/` 是 method、params、response、notification、server request、错误结构和 decoder 的唯一协议 owner；`../app-server/` 拥有 connection、typed dispatch 和跨领域 orchestration；对应 Rust 领域 crate 拥有领域行为与持久状态。

只有 backend Thread 进入 Agents Window 时，才在 `src/sessions/` 增加 Provider adapter。Sessions 是条件消费者，不是通用 app-server API，也不是 process、Project 或 connection owner。

## 不变量

- 一个应用 Host 默认启动一个 app-server process；每个 renderer 使用一条独立 backend connection 和一个 protocol client。Project、Workspace、窗口、领域或 Session 不能成为进程 key。
- 只有同时满足“跨 renderer 或长期存活”“可形成稳定可序列化 contract”“不依赖 editor/Electron 对象身份”的能力才默认迁入 Rust；IO、并发、安全或持久化收益用于排序，不单独构成迁移理由。
- Main 不持有 request ID、pending map、initialize、notification 分类、server request handler 或领域状态。
- protocol client 不暴露 `invoke(method, unknown)`，不允许调用方自行指定 response 泛型；method → params → response、运行时 decoder 都来自生成器。
- 后端拥有 durable Project、Thread、Turn、Item、process/resource 和执行状态；前端只保存领域 facade 与 UI 状态。
- Project、Workspace、Environment、Thread、renderer 和 connection 身份不得合并。Project 不是 Session Host；Workspace 不是 Project catalog；Environment 是执行目标。
- 取消必须映射为已有的 interrupt、stop、unwatch、terminate 或领域 cancel request；丢弃 Promise 不代表后端工作结束。
- renderer connection 关闭只清理该 connection 的 pending、资源和订阅；process 退出使全部 renderer connection 失效。
- 后端写盘仍由前端 file service、working copy 和 text model 处理外部变化及 dirty 冲突；adapter 不建立第二份文件状态。

## 冲突门禁

实施跨端接入前检查两侧源码、目标 owner、公开 API、用户已有改动和协议语义。只有目标行为或 owner 与本 skill 冲突，而且用户目标与现有授权尚未决定取舍时，才停止依赖该决定的写入；继续只读调查，一次性向用户报告准确路径、符号、两种行为、影响范围和需要决定的问题。用户已明确要求修复或改变某个现有行为时，该行为变化本身不构成需要再次确认的冲突。

以下情况必须停下来问用户：

- 目标代码要求 Main 解析或分领域路由 app-server JSON-RPC，而本 skill 要求 renderer protocol client；
- 只能使用单路 stdio、实验 transport、每窗口进程或 Main 共享线上 connection；
- 正式实现依赖实验 method/field，且用户未决定先稳定还是放弃该能力；
- 缺少生成 response map、运行时 decoder、结构化错误、取消、资源终止、兼容或 server request 唯一 connection owner；
- 现有公开 API、身份、生命周期、文件位置或用户改动与最终 owner 冲突，且用户目标尚未决定如何取舍；
- 一个能力同时依赖 Rust 持久状态与前端 editor/extension 对象，且无法确定唯一 owner 或机械 adapter；
- Sessions 映射无法唯一确定 Session、Chat、Thread、Project、Workspace 或 Environment 的关系。

已由 [前置能力补全](references/prerequisite-completion.md) 唯一定义且用户授权修改对应后端范围的缺口，可以先补后端；否则不能自行选边、增加桥接、保留备用路径或继续实施依赖该决定的代码。

## 工作流程

1. 执行冲突门禁，按目标产品边界判断能力应迁入 Rust、留在前端还是需要用户决定；替换 Host 时确认旧协议与 TypeScript runtime 从生产调用链退出。
2. 找到 renderer 调用方真正依赖的领域 service，固定它的契约、状态、事件、错误、取消和释放语义，并让对应 Rust 领域 crate 成为业务与持久状态 owner。
3. 固定共享 process、per-renderer connection、renderer protocol client 和关闭语义。
4. 为每项行为选择 request、notification、显式资源或 server request，并固定身份、顺序与错误。
5. 核对正式 transport、生成 method map、runtime decoder、initialize 兼容、稳定 API 和 server request owner；缺失时先补后端或停下来问用户。
6. 生成协议，在 renderer protocol client 处理线上消息，在领域 adapter 转换契约；Main 只装配 starter 和 relay。
7. 仅当 Thread 进入 Agents Window 时实现 Sessions Provider、draft replacement 和 Chat capability。
8. 验证初始化、运行时解码、请求配对、领域事件、取消、多窗口、dirty file 冲突、连接关闭、背压和生成物同步。

## Reference 路由

| 当前任务 | 必须读取 |
| --- | --- |
| owner、进程、多窗口、connection、迁移边界、Thread/Sessions 映射或文件位置 | [连接与所有权](references/connection-architecture.md) |
| request、notification、资源、取消、错误、顺序或 server request | [协议语义](references/protocol-semantics.md) |
| 新增、修改或 review 一项 API | [实现流程](references/implementation-template.md) |
| transport、生成器、兼容、实验 API、错误或 server request owner 不完整 | [前置能力补全](references/prerequisite-completion.md) |
| 修改本 skill、核对依据，或 reference 无法回答关键边界 | [源码证据](references/source-evidence.md) |

完整实现一项 API 时读取前三份；命中后端缺口时再读取前置能力；只有源码证据列出的重新核对条件成立时才重新读取参考源码。

## 完成标准

完整跨端 API 接入任务的最终答复必须给出：迁入 Rust、保留前端和条件迁移的能力边界；各 Rust 领域 crate 与前端领域 contract 的 owner；退出生产调用链的旧 Host 文件/注册；领域 adapter、renderer protocol client、Main starter/relay、process/connection 拓扑、线上消息、准确文件位置、生成物与 decoder、取消和关闭、dirty file 处理、实际测试，以及仍阻止接入的后端缺口。涉及 Agents Window 时再给出 Provider、Session/Chat/Thread、Project/Workspace/Environment 映射。没有取得冲突决定时不能把跨端接入任务描述为完成。
