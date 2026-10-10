# 实现流程

本文件用于新增、修改或 review 一项完整 API。`<domain>` 和 `<action>` 必须替换成真实领域词；只创建具有独立职责和真实调用方的文件。

## 0. 执行冲突门禁

修改前批量核对前端参考路径、后端协议与 transport、目标仓库 owner、全部生产调用方和用户已有 diff。发现主 skill 定义的任一冲突后立即停止写入，只继续只读收集完整清单，然后向用户报告准确路径、符号、两种行为、影响范围和需要决定的边界。

重点先检查：

- backend 是否有跨 macOS、Linux、Windows 的正式多 connection 本地 transport；
- Project、Environment 或所需字段是否仍为实验 API；
- 生成器是否提供 method map 与运行时 decoder；
- 旧 Host protocol、TypeScript Host runtime 和 Main protocol routing 是否仍在生产调用链；
- 当前领域 identity、process owner 或用户改动是否与最终 owner 冲突。

缺口已有 [前置能力补全](prerequisite-completion.md) 定义且用户已授权修改对应后端范围时，先完成该前置能力再继续前端；后端不在授权范围、目标源码否定计划前提或需要改变公开兼容边界时，必须等待用户决定。禁止创建桥接文件、保留双入口、手写缺失协议，或继续实施依赖未决定冲突的步骤。

## 1. 固定迁移边界与领域身份

先用 [连接与所有权](connection-architecture.md) 区分核心机制、可选扩展 Provider 与客户端交互，再决定后台接入与状态 scope。跨 renderer 或长期存活、稳定可序列化 contract、无 editor/Electron 对象依赖用于判断后台执行；这些条件不要求服务商业务进入核心。TS/JS 与 Rust 扩展的执行位置、宿主及完整边界见 [扩展架构](../../extension-architecture/SKILL.md)。

然后列出本次 API 的前端对象、后端对象与稳定 identity。文件、账户、配置、模型、skills、Project、Thread、process 等对象分别由自己的领域 service 表达，不能为了接入 app-server 改叫 Session。

每个对象至少确定：

| 项目 | 必须确定 |
| --- | --- |
| 前端对象 | 哪个现有 service 或 contribution 是调用方 |
| 后端对象 | 哪个核心领域服务或扩展 Provider 唯一决定并保存状态 |
| 迁移收益 | 持久化、并发、IO、安全、恢复或多产品复用中的哪一项真实成立 |
| 前端保留状态 | 哪些 editor、extension、Workbench 或 Electron 状态不能跨协议复制 |
| 稳定 identity | ID、URI、path、resource ID 或复合 key |
| 生命周期 | 创建、更新、销毁、connection close 与 process exit |
| 事件 | 初始 snapshot、增量 notification 与无缺口规则 |

只有 backend Thread 要进入 Agents Window 时，才额外固定 Provider、Workspace、Session 与 Chat 的映射：Session 使用 `providerId + resource`，committed resource 承载 Thread identity，draft 通过 replacement lifecycle 切换为 committed facade。若设计要求另存随机 frontend Session ID → backend Thread ID 映射，先证明 resource 不能承载 Thread identity；否则拒绝该映射。

## 2. 固定前端领域契约

先找到现有调用方所属领域，把 contract 留在该领域；没有现成 owner 时才按依赖方向创建最小 service：

```text
src/platform/<domain>/common/
src/workbench/services/<domain>/common/
```

app-server adapter 与具体运行环境放在同一领域的 browser 或 electron-browser 层：

```text
src/platform/<domain>/browser/<domain>AppServerAdapter.ts
src/workbench/services/<domain>/electron-browser/<domain>AppServerAdapter.ts
```

只有 Thread 要进入 Agents Window 时，才使用：

```text
src/sessions/services/sessions/common/
src/sessions/contrib/providers/agentHost/browser/
```

契约必须明确 input、result、领域错误、observable/event、初始 snapshot、capability、取消和 dispose；涉及 draft Session 时再增加 replacement。前端领域名按用户行为命名，不复用线上 method。领域 interface 不导入生成 DTO、transport state、request ID 或 error envelope。

## 3. 固定 process 与 connection

默认拓扑必须写成：

```text
一个 app-server process
  → 多个 renderer
  → 每个 renderer 一条独立 backend connection
  → 每个 renderer 一个 protocol client
```

实现前回答：

- Main 在何时启动和停止共享 process；
- 每个 renderer 如何以 nonce 取得自己的 MessagePort；
- Main relay 如何为 MessagePort 打开独立 backend connection；
- renderer 关闭时哪些资源只随该 connection 释放；
- process 退出如何关闭全部 connection；
- backend transport 如何保证跨平台、多 connection、背压和身份校验。

Main 不能持有 protocol pending、执行 initialize 或替领域调用方选择对象。若 app-server 接入只能通过单路 stdio、实验 transport、Main protocol multiplex 或每窗口 app-server 进程实现，按主 skill 的冲突门禁处理；这不禁止扩展 supervisor 启动既定独立 runtime。

## 4. 选择消息、标识和顺序

按 [协议语义](protocol-semantics.md) 选择 request、notification、显式资源或 server request。

持续资源先设计 client-generated resource ID、start response、notification、terminal、stop response、renderer connection cleanup 和 process cleanup。可取消操作先设计 operation ID 与 typed cancel request。同步写出 serialization scope；没有领域理由时不同 key 并行。

领域 catalog 先定义 snapshot 与 notification 无缺口语义。只有 Thread 进入 Agents Window 时，Session draft commit 才定义 replacement lifecycle；只有后端完整支持 Chat catalog 才启用 multi-chat capability。

## 5. 定义并生成 Rust 协议

领域 DTO 放在：

```text
../app-server-protocol/src/protocol/v2/<domain>.rs
```

统一注册点绑定 method、params、response 和 serialization scope：

```rust
<DomainAction> => "<domain>/<action>" {
    params: v2::<DomainActionParams>,
    serialization: <scope>,
    response: v2::<DomainActionResponse>,
}
```

事件加入 typed server notification registry；Rust 等待宿主回复时加入 typed server request registry。需要前端分类的错误使用稳定 numeric code 与结构化 data。

生成输出由以下目录拥有：

```text
.build/protocol/typescript/
```

生成器必须产出并验证：

- request method → params → response map；
- notification method → params map；
- server request method → params → response map；
- envelope、request ID、错误、初始化和 capability DTO；
- 从 `unknown` 解码 envelope、params、result、notification 与 server request 的运行时 decoder；
- JSON Schema 与有效/无效 fixture。

若生成结果只有 union 和分散 response type，或没有运行时 decoder，停止前端实现并按 [前置能力补全](prerequisite-completion.md) 修改 `../app-server-protocol/src/export.rs` 与实际生成 owner。用户未授权后端修改或生成 owner 与 reference 冲突时再执行冲突门禁。不能在前端手写 map、type guard、重复 DTO 或用类型断言绕过。

前端通过固定后端版本运行生成命令，直接写入 renderer 可导入的最终目录：

```text
build/protocol/generate.ts
build/protocol/generate.py
.build/protocol/typescript/
```

同步检查必须在临时目录重新生成并逐字节比较，不从并列 checkout 复制一个可能与打包 binary 不同的 schema。生成路径从旧 TypeScript Host 的 `node/` 子树迁出后，只保留这一份 committed 生成物。

## 6. 接入 Rust processor 与多 connection transport

领域 processor 放在：

```text
../app-server/src/request_processors/<domain>_processor.rs
```

processor 只接收生成类型、机械转换领域值、授权并调用核心领域服务或有效 Provider，再把结果或稳定错误转成 response。具体业务与长期状态属于唯一领域 owner，通用系统访问和安全存储属于共享服务。可选 Provider 实现不链接进 app-server，broker 不另存业务状态。确有跨请求的 connection-owned 资源时才增加 `../app-server/src/<domain>_resource.rs`，资源 key 至少包含 `(connection_id, resource_id)`；Provider 的共享状态 scope 另外由能力契约决定。

正式本地多 connection transport 由以下目录拥有：

```text
../app-server-transport/src/transport/
../app-server/src/transport.rs
```

transport 只产生 opened/closed/message，使用有界队列并保持每条 connection 独立。它不实现 initialize、Project、Thread 或 renderer routing。缺少 Windows 或其他正式平台实现时，先按 [前置能力补全](prerequisite-completion.md) 完成 loopback WebSocket、token auth 和机器可读启动记录；不能把单平台 endpoint 宣称为完成。

## 7. 实现 renderer protocol client

文件位置：

```text
src/platform/agentHost/common/appServerProtocol/appServerProtocol.ts
.build/protocol/typescript/
src/platform/agentHost/browser/appServerProtocolClient.ts
```

client 消费生成 map，并拥有该 renderer connection 的 request ID、client pending、server pending、initialize、generated decoder、notification listener、server request handler、connection generation 和 close。

```ts
interface IAppServerProtocolClient {
	request<M extends keyof AppServerRequestMap>(
		method: M,
		params: AppServerRequestMap[M]['params'],
	): Promise<AppServerRequestMap[M]['response']>;

	onNotification<M extends keyof AppServerNotificationMap>(
		method: M,
		listener: (params: AppServerNotificationMap[M]) => void,
	): IDisposable;

	registerServerRequestHandler<M extends keyof AppServerServerRequestMap>(
		method: M,
		handler: (params: AppServerServerRequestMap[M]['params']) => Promise<AppServerServerRequestMap[M]['response']>,
	): IDisposable;
}
```

transport frame 以 `unknown` 进入 decoder；client 不暴露 raw message、`invoke` 或任意 response 泛型，也不接收通用 `CancellationToken`。

## 8. 实现 Main starter 与透明 relay

文件位置：

```text
src/platform/agentHost/electron-main/electronAgentHostStarter.ts
src/platform/agentHost/electron-main/appServerConnectionRelay.ts
src/platform/agentHost/electron-browser/appServerMessagePortTransport.ts
src/platform/agentHost/electron-browser/localAgentHostService.ts
```

starter 负责 executable resolution、process spawn、restart、shutdown 和致命退出。renderer 使用 nonce 请求 connection；relay 打开独立 backend connection，把专属 MessagePort 交给 renderer，并在任一侧关闭时释放这一对资源。

relay 只转发 frame、执行背压和有限诊断。以下代码出现即表示 owner 漂移：

- 在 Main 解析 JSON 或生成 method；
- 在 Main 分配、重写或复用 protocol request ID；
- 在 Main 执行 initialize、缓存 notification 或处理 server request union；
- 在 Main 根据领域对象、Workspace 或 active window 选 connection；
- 为不同 renderer 复用同一 backend connection。

`localAgentHostService` 在 renderer 取得 transport、创建唯一 protocol client，并把它注入真实领域 adapter。它保留前端 Host service 的公开契约，但不实现旧 Host 线上协议，不拥有 UI 领域状态或 Project 持久化。

## 9. 实现领域 adapter

文件位置：

```text
src/platform/<domain>/browser/<domain>AppServerAdapter.ts
src/workbench/services/<domain>/electron-browser/<domain>AppServerAdapter.ts
```

只选择与现有领域 owner 一致的一条路径，不同时创建两层同义 adapter。领域 adapter：

- 只依赖 protocol client 的 typed contract，不接触 MessagePort、raw envelope 或 Main channel；
- 把前端领域 input 机械转换为生成 params，把生成 response 转为领域 result；
- 把稳定 code/data 转为领域错误；
- 从 snapshot 与 notification 更新 renderer 内的 observable facade；
- 为持续资源创建明确 handle，并把 stop/dispose 路由到后端 owner；
- 不复制后端持久化状态，不把生成 DTO 暴露给普通调用方。

只有 backend Thread 要进入 Agents Window 时，才增加：

```text
src/sessions/contrib/providers/agentHost/browser/appServerSessionsProvider.ts
src/sessions/contrib/providers/agentHost/browser/appServerSessionAdapter.ts
```

此时 Provider 注册稳定 provider ID、label、icon、session types 与 capabilities，从 Thread catalog 建立 Session facade，用 `providerId + resource` 生成 canonical Session ID，把 cwd 与 roots 表达为 Workspace，并在 `thread/start` 后触发 draft replacement。Session adapter 只保存 observable facade 与 backend resource，不复制 transcript 或持久化 Thread。只有后端完整支持时才声明 multi-chat、Project 或 Environment capability。

## 10. Project 与 Environment adapter

Project catalog 先使用已有 Project 领域 service；没有 owner 时才创建 Project-neutral service，并由 app-server adapter 实现。Agents Window 需要 Project 时消费该 service 或其最小 typed contract，Sessions Provider 不是 Project 的通用 owner。不要把生成 Project DTO 变成公共 Workbench contract。

Environment selection 属于开始 Thread、Turn 或相关配置操作。Project roots 不决定 Environment，Environment 状态也不改变 Project identity。生产接入不使用 initialize 的实验 capability 取得必需 API；按 [前置能力补全](prerequisite-completion.md) 只稳定真实调用方需要的闭包依赖。用户明确要求实验接入或稳定范围存在产品语义冲突时停止实现并询问用户。

## 11. 事件、资源与 server request

每个 protocol client 只解析自己 connection 的 notification。对应领域 adapter 把 event 转成 observable 更新；持续资源使用 Promise 创建的 handle，表达 start failure、terminal state 和 stop completion。

renderer 可完成的 server request 由明确的领域 service 或 adapter 注册 typed handler；Thread UI 的交互 request 才由 Sessions Provider 处理。Main 才能完成的能力通过单独 named host channel 调用 Main，channel contract 使用前端领域类型，不能转发 raw `ServerRequest` union。

handler 必须处理未知 method、未注册 owner、窗口关闭、用户取消、超时和 connection close，并对每个 request 恰好回复一次。

## 12. 文件与编辑状态

后端工作区写入不能取代前端 file service、text model 或 working copy。接入前验证文件监听能观察后端落盘修改，并让 dirty model 进入明确的外部变更或保存冲突状态。

如果当前 owner 会静默覆盖 dirty buffer、需要前后端双写，或后端要求直接修改前端内存 model，立即停止并询问用户。不能在 app-server adapter 或 protocol client 中增加文件状态副本。

## 13. 产品装配

`src/code/electron-main/app.ts` 只创建 starter/relay、绑定应用生命周期并注册 connection acquisition。renderer main entry 注册 `localAgentHostService`、唯一 protocol client 和各领域 adapter；只有 Thread UI 接入时，Sessions entry 才注册 Provider。装配文件不解析 JSON、不转换 DTO、不实现领域 switch，也不保存领域状态。

## 14. 让错误 owner 退场

用户已解决冲突门禁后，同批迁移调用方并移除：

- Main 中的 protocol connection、request pending、initialize 和 method routing；
- 旧 Host protocol client、action/state envelope、TypeScript Host runtime 启动和生产注册；
- 每窗口、每 Project、每 Workspace 或每领域的额外 app-server process；扩展的受监督进程按其 scope 管理，旧业务 Host 退场不代替扩展 runtime 的契约迁移；
- 多余的 frontend ID → backend ID persistence；Thread UI 中尤其禁止随机 Session ID 映射；
- 手写线上 DTO、method constant、response map 与 decoder；
- 绕过领域 service/adapter 的 `invoke`、raw notification 或 universal IPC；
- active window server request routing；
- 旧后端、实验 transport 自动切换、双写与断线重放路径。

## 15. 测试

| 层 | 必测行为 |
| --- | --- |
| protocol generator | method maps、runtime decoders、启动记录、有效/无效 fixture、固定版本逐字节同步、生成物无 diff |
| Rust processor | DTO 转换、领域调用、结构化错误、serialization scope |
| backend transport | token auth、机器可读启动记录、多 connection 隔离、跨平台 endpoint、背压、单 connection close、process close |
| Main starter/relay | 一进程、多 renderer 独立 connection、启动失败清理、透明 frame、窗口 detach、process exit |
| renderer protocol client | fixed backend initialize、capability 校验、unknown decode、双向 ID、request pairing、notification、server request、close |
| server request routing | 唯一 connection owner、connection-scoped callback、错误 connection 回复、owner close、不广播 |
| 领域 adapter | input/result 转换、snapshot/event、领域错误、资源 lifecycle、不泄露生成 DTO |
| Sessions Provider（涉及 Agents Window 时） | canonical Session ID、draft replacement、catalog、capabilities、fork/rollback semantics |
| Project/Environment | backend ownership、assignment notification、稳定 schema；Thread UI 时验证 Workspace 投影 |
| resource | connection 隔离、重复 ID、start failure、stop 后无事件、connection cleanup |
| 文件集成 | clean model reload、dirty model 冲突和保存保护 |
| 双端 | 多窗口同时 initialize、真实 request、catalog notification、cancel/stop、server request、单窗口断开与进程退出 |
| 扩展能力接入（涉及 Provider 时） | 独立扩展宿主/程序、唯一状态 scope、授权拒绝与撤销、按需激活、App/TUI 相同结果与错误、能力未启用时基础核心无具体扩展启动依赖 |

## Review 检查

使用 `rg` 与定向测试确认：

- Main 没有 protocol parser、request ID、pending、initialize、method switch 或领域状态；
- 每个 renderer 只有一个 app-server protocol client 和独立 backend connection；
- 一个 host 默认只有一个 app-server process，Project/Workspace 不启动额外 app-server；扩展进程由 supervisor 按有效授权和声明的 scope 管理；
- Main 只解码生成的启动记录，不解析 stderr banner；endpoint/token 不进入 renderer；
- 普通调用方只经过所属领域 service 与 adapter，不经过通用 Sessions Provider；
- 涉及 Agents Window 时，Session ID 统一来自 provider ID 与 provider-owned resource，且没有 frontend Thread mapping store；
- 涉及 Agents Window 时，Provider、Project、Workspace、Environment、Session、Chat 和 Thread identity 未合并；
- multi-chat capability 仅在 Agents Window 接入且后端有完整 Chat contract 时启用；
- raw JSON 只以 `unknown` 进入 generated decoder；线上 method 只来自生成物；
- frontend 生成物与打包 backend 使用同一固定 binary 版本，initialize response 或 capability 不满足时不进入 Ready；
- 产品必需的 Project 与 Environment API 已进入稳定 schema；未使用的实验 API 没有被前端静默开启；
- server request 不广播、不依赖 active window，Main host call 不接收线上 union；
- 只有协议支持取消的操作才承诺结束后端工作；
- dirty file 冲突经过现有 file/working-copy owner；
- app-server 没有实验 transport、单路 stdio、每窗口 app-server process、旧 owner 或静默重放作为备用路径；扩展 runtime 不借用产品完整连接；
- 没有未经用户决定仍继续实施的源码、owner、协议或用户改动冲突。
