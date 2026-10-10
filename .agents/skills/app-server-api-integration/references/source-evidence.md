# 源码证据

本文件只用于维护本 skill、核对依据或处理其他 reference 未覆盖的边界。路径采用中性根：前端参考源码根以下写作 `src/`，后端参考 crate 使用 `../app-server*`；前端源码中原有的具体 backend 目录统一写作 `<backend>`。这些路径证明职责与行为，不要求复制实现，也不表示目标仓库已具备对应文件。

## 前端 renderer、Main 与 Host runtime

| 路径 | 已验证结论 |
| --- | --- |
| `src/platform/agentHost/electron-browser/localAgentHostService.ts` | renderer 创建旧 Host protocol client，拥有 initialize、pending、notification、reconnect，并通过 nonce 取得 MessagePort。 |
| `src/platform/agentHost/browser/agentHostProtocolClient.ts` | 每个 client 独立拥有 request allocator、pending map、message classification、state subscription 与 close；这些职责不在 Main。 |
| `src/platform/agentHost/electron-main/electronAgentHostStarter.ts` | Main 启动一个 utility process；每个 renderer connection 请求调用一次 process `connect()`，再把独立 MessagePort 交给对应窗口。Main 不替 renderer 配对线上 request。 |
| `src/workbench/services/agentHost/electron-browser/agentHostService.ts` | renderer Workbench service 在不同 Host location 之间选择并注册统一前端 service；产品 UI 依赖 service，不依赖 process starter。 |
| `src/platform/agentHost/node/agentHostMain.ts` | 当前启动目标是 TypeScript Host runtime。最终架构必须让这个运行时退出 desktop 生产调用链，而不是让 Rust 实现它的旧协议。 |

这些源码固定了可复用的前端形状：共享 Host process、per-renderer MessagePort、renderer protocol client、Workbench 领域 service。本设计复用 owner 和连接形状，但用 app-server protocol client 与 Rust process 替换旧 Host protocol client 和 TypeScript Host runtime。

## 当前 app-server client 与生成物

| 路径 | 已验证结论 |
| --- | --- |
| `src/platform/agentHost/node/<backend>/<backend>AppServerClient.ts` | 当前 app-server client 位于 TypeScript Host runtime 内，通过单路 JSONL stdio 拥有 request ID、pending、notification 与 server request handler；它不在 renderer。 |
| `src/platform/agentHost/node/<backend>/protocol/generated/` | TypeScript bindings 由固定 backend binary 的 `app-server generate-ts` 生成并提交，目录 README 明确禁止手改。 |
| `build/<backend>/generate-protocol.mjs` | 生成脚本校验 binary 版本、清理旧生成物、重写模块后缀并格式化输出。 |
| `build/<backend>/check-protocol-sync.ts` | CI 在临时目录重新生成并逐字节比较，避免手改和版本漂移。 |

当前生成目录位于 `node/` 是因为当前消费者是 TypeScript Host runtime。本设计把 protocol client 移到 renderer 后，最终生成物必须迁到 `src/platform/agentHost/common/appServerProtocol/generated/`；不能让 browser/electron-browser 依赖 `node/` owner，也不能保留两份生成物。

当前 client 从生成 request union 推导 method 与 params，但调用方自行传 response 泛型；它对 `JSON.parse` 结果使用类型断言，生成物没有完整 method → params → response map，也没有运行时 decoder。本设计不能复制这两个缺口。

## Thread UI 的条件证据

仅当 backend Thread 需要进入 Agents Window 时使用以下证据：

| 路径 | 已验证结论 |
| --- | --- |
| `src/sessions/SESSIONS.md` | Provider-neutral services 聚合 Provider；`ISession.workspace` 表示 Session 操作的 Workspace；Provider 拥有 backend state、resource URI、恢复和认证的适配。 |
| `src/sessions/services/sessions/common/sessionsProvider.ts` | `ISessionsProvider` 封装一个执行环境，拥有 Workspace discovery、Session creation/listing 和 picker contribution；一个 Provider 可服务多个 Session type。 |
| `src/sessions/services/sessions/common/session.ts` | canonical Session ID 由 `providerId + resourceUri` 的唯一 helper 生成；消费者比较 resource identity。 |
| `src/sessions/contrib/providers/agentHost/browser/baseAgentHostSessionsProvider.ts` | committed adapter 从 backend raw ID 构造 provider resource 与 canonical Session ID；draft 提交后使用独立 replacement lifecycle 切换 committed facade。 |
| `src/sessions/contrib/providers/agentHost/AGENT_HOST_SESSIONS_PROVIDER.md` | Provider cache 拥有 facade identity；catalog event 表达 membership，observable 表达 mutable state。 |

Sessions 是 Thread UI 的 adapter，不是 app-server 所有 API 的统一入口。Project 也不是 Session Host。

## 后端 transport 与初始化

| 路径 | 已验证结论 |
| --- | --- |
| `../app-server/README.md` | 默认 stdio 是单路 JSONL；WebSocket 标记为 experimental/unsupported；Unix socket 用 WebSocket upgrade，面向本地 control-plane client。每条 connection 独立执行 `initialize` → `initialized`。 |
| `../app-server/src/main.rs` | CLI 接受 `stdio://`、`unix://`、`ws://IP:PORT` 和 `off`；WebSocket auth 参数由 transport 层提供。 |
| `../app-server-transport/src/transport/stdio.rs` | stdio 直接读取进程 stdin 并写 stdout，只形成一条进程级 connection。 |
| `../app-server-transport/src/transport/unix_socket.rs` | Unix socket 能接受多个本地 connection，但不提供 Windows 对等 endpoint，因此不能单独完成三平台 desktop contract。 |
| `../app-server-transport/src/transport/websocket.rs` | listener 为每个 upgrade 分配独立 connection、reader、writer 和有界 queue；当前只在 stderr 打印面向人的 endpoint/readyz 信息，`start_websocket_acceptor` 只返回 accept task。 |
| `../app-server-transport/src/transport/auth.rs` | WebSocket 已支持 capability token hash；非 loopback listener 没有 auth 时被拒绝。 |
| `../app-server/src/request_processors/initialize_processor.rs` | initialize 是 per-connection 门禁，重复 initialize 和未初始化 request 会被拒绝。 |

由此可得：一个进程服务多个 renderer 的实现基础存在，但正式跨平台本地 transport 和机器可读启动记录仍未完成。不能用 stdio、单平台 socket、stderr banner、每窗口进程或 Main protocol multiplex 代替。

## 后端协议、领域与双向 request

| 路径 | 已验证结论 |
| --- | --- |
| `../app-server-protocol/src/protocol/common.rs` | 一个注册点绑定 client request 的 method、params、response 和实验状态，也注册 server notification 与 server request；Project 与 Environment method 当前仍为实验 API。 |
| `../app-server-protocol/src/export.rs` | exporter 生成 request/notification union 和分散 response 类型，但当前没有完整 TypeScript response map 与运行时 decoder。 |
| `../app-server-protocol/src/precomputed_exports.rs` | binary 使用预计算的稳定/实验 schema 输出；修改 generator 时必须同步 fixture 与预计算 export。 |
| `../app-server-protocol/src/protocol/v2/project.rs` | Project 是后端 catalog object，拥有稳定 ID、roots、metadata、position 和持久化生命周期。 |
| `../app-server-protocol/src/protocol/v2/thread.rs` | `thread/start` 的 `projectId` 与 `environments` 是独立实验字段；Thread 同时拥有自己的 ID、cwd、Turn 和 durable metadata。 |
| `../app-server-protocol/src/protocol/v2/environment.rs` | Environment 使用独立 ID 和状态，不包含 Project identity。 |
| `../app-server/src/request_serialization.rs` | 后端按协议 scope 串行化 request；connection-scoped resource 必须包含 connection identity。 |
| `../app-server/src/outgoing_message.rs` | client request response 已用 `ConnectionRequestId` 绑定 connection；但 server request callback 仍只按全局 `RequestId` 保存，通用 request 可 broadcast，Thread-scoped request 可发送给多个 connection。 |
| `../app-server/src/fs_watch.rs` | watch 以 `(connection_id, watch_id)` 隔离；重复 ID 被拒绝，unwatch 与 connection close 清理资源。 |

server notification 可以广播，approval、用户输入等 server request 必须先补成唯一 connection owner。Thread subscription 不能自动获得交互 ownership。

## 对最终架构的直接影响

本节前面的源码证据只证明 Host 替换、连接拓扑和当前后端协议能力。把 Rust app-server 扩展成完整产品业务后端是目标设计，必须按领域逐项补协议与实现，不能把尚未存在的账户、模型、Project、Environment、Git/repository、搜索、索引、SCM、Terminal 或恢复能力描述为当前已实现。

- 复用 `src/platform/agentHost/` 的前端 owner、per-renderer MessagePort 和 `localAgentHostService` 入口；不创建并列 `src/platform/appServer/` 根目录。
- renderer 新建 `appServerProtocolClient.ts`，Main 只保留 `electronAgentHostStarter.ts` 与透明 relay；Main 不接管 JSON-RPC。
- desktop starter 不再启动 `node/agentHostMain`；旧 Host protocol、TypeScript runtime 和生产注册必须退场。
- 生成物从 `node/<backend>/protocol/generated/` 迁到 `common/appServerProtocol/generated/`，生成器保持固定版本和逐字节 CI 检查。
- 前端每个领域保留自己的 service，adapter 只使用 typed protocol client；Sessions Provider 仅处理 Thread UI。
- Rust app-server 只承担连接、typed dispatch、授权路由与跨领域 orchestration；共享机制在核心领域 crate，可选服务商业务目标由独立扩展 Provider 拥有。这里的旧 Host 源码证据不证明两类扩展运行时或业务拆分已完成，目标边界见 [扩展架构](../../extension-architecture/SKILL.md)。
- editor model、working copy、扩展 API 的客户端对象、Workbench UI 和 Electron 对象不因后端接入而迁入 Rust；TS/JS 扩展宿主与可选 Rust 程序独立于被替换的业务 Host，当前 Node 路径按扩展契约迁移。通用文件、交互式 Terminal、SCM 与语言服务逐项通过职责判定，不能默认并入核心。
- 正式接入前必须补全跨平台多 connection transport、机器可读启动记录、response map、runtime decoder、兼容契约、所需稳定 API、结构化错误和 server request 唯一 connection owner。
- 丢弃 Promise 不构成取消；后端落盘修改仍通过前端 file/working-copy owner 处理 dirty 冲突。

## 重新核对源码的条件

仅在以下情况重新打开对应源码：

- per-renderer MessagePort、Host service 或 Sessions Provider contract 改变；
- 后端改变 stdio、Unix socket、WebSocket 的支持级别，或新增正式跨平台多 connection transport；
- generator 增加 response map、runtime decoder、启动记录或 compatibility contract；
- Project、Environment、Thread assignment 的实验状态或语义变化；
- server request callback 改为 connection-scoped，或 request routing/handoff 语义变化；
- reference 无法回答一个会改变 owner、文件位置或用户可观察行为的问题。

重新核对发现源码、owner、协议或用户改动冲突时，执行主 skill 的冲突门禁。核对后只把稳定结论更新到对应 reference，不复制参考实现或维护逐行源码摘要。
