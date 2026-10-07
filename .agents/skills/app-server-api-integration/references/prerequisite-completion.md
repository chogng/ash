# 对接前置能力补全

本文件拥有 app-server 对接前置缺口的计划设计与完成条件。[源码证据](source-evidence.md) 只记录当前已实现能力和当前限制；本文件说明限制应由哪一侧、哪些文件和哪些测试消除。实施时若目标源码与这里的前提冲突，执行主 skill 的冲突门禁，不另选备用方案。

## 快速理解

正确补全顺序是先建立一个进程服务多 renderer 的正式连接能力，再让协议生成器产出完整的编译期和运行时契约，最后稳定产品实际依赖的领域 API。前端 adapter 只能在这些边界完成后接入。

| 当前缺口 | 完成 owner | 完成结果 |
| --- | --- | --- |
| 多 renderer 只能依赖单路或实验 transport | `../app-server-transport/` 与进程启动层 | 一个进程提供 loopback WebSocket listener，每个 renderer 对应一条独立、鉴权的 connection |
| Main 无法可靠取得随机端口 | transport 启动信息与 Main starter | app-server 在专用 bootstrap 输出一条生成类型的启动记录；Main 不解析 stderr 文本 |
| TypeScript 只有 request union | `../app-server-protocol/src/export.rs` | 生成 request、notification、server request map，并包含每个 request 的 response type |
| `unknown` frame 没有运行时验证 | 同一协议生成器 | 生成 envelope、params、result、error、notification 和 server request decoder |
| frontend 与 backend 版本关系未固定 | 打包、生成与 initialize owner | 本地 binary 与生成物使用同一固定版本；独立升级场景先定义兼容协商 |
| 产品依赖实验 Project/Environment | 对应协议注册、DTO、processor 与 fixture | 只稳定真实调用方需要的方法和字段；稳定生成物不要求 `experimentalApi` |
| 领域失败只能匹配 message | 协议错误 data 与 processor | 稳定 numeric code 加 tagged data，adapter 不解析英文 message |
| server request 可能广播或落到错误窗口 | app-server outgoing owner | 每个 server request 只路由到一个明确 connection，并由同 connection 回复 |
| 用户取消与 Promise 取消混淆 | 具体领域协议 | 只有稳定 operation/resource ID 和 cancel method 的操作才承诺结束后端工作 |

## 完成顺序

1. 完成正式本地多 connection transport、鉴权与机器可读启动握手。
2. 完成协议 method map、运行时 decoder、生成 fixture 和生成物一致性检查。
3. 固定本地打包版本与远程独立升级的兼容契约。
4. 稳定本次产品实际使用的实验 method、字段、notification 和错误语义。
5. 固定 server request connection owner 与领域取消语义。
6. 最后实现 renderer protocol client、领域 adapter 和可选 Sessions Provider。

后一步不得用手写映射、类型断言、共享 connection 或实验 capability 绕过前一步。

## 正式本地多 connection transport

桌面接入固定使用 loopback WebSocket 作为 Main 与 app-server 之间的正式 transport。app-server 只绑定 `127.0.0.1:0` 或 `[::1]:0`，Main 为每次进程启动生成高熵 token，只把 SHA-256 digest 交给子进程，并在每条 WebSocket upgrade 上提交原 token。renderer 不取得 endpoint 或 token，只取得专属 MessagePort。

Main 启动参数表达以下事实：

```text
--listen ws://127.0.0.1:0
--ws-auth capability-token
--ws-token-sha256 <digest>
--emit-listen-info stdout-json
```

参数名以实际 CLI owner 为准；若现有 CLI 命名冲突，停下询问用户，不能解析现有 banner 代替正式启动契约。

app-server 绑定成功后在 stdout 输出且只输出一条 UTF-8 JSONL 启动记录，然后 flush：

```json
{"kind":"app-server-listen-info","version":1,"endpoint":"ws://127.0.0.1:43127"}
```

启动记录不含 token、PID、用户目录或其他秘密。stderr 只用于诊断，Main 不匹配 banner、端口文本或日志顺序。绑定失败、记录无效、记录重复、超时或子进程提前退出都使 starter 失败并清理进程。

`start_websocket_acceptor` 需要返回包含实际 endpoint 与 accept task 的 typed started-listener，而不是只返回 task。`AppServerListenInfo` 在 `../app-server-protocol/src/listen_info.rs` 拥有启动记录的版本与序列化，并由同一 generator 产出 TypeScript 类型和 decoder；`../app-server/src/main.rs` 只能在 listener 成功绑定后写出该记录。

后端文件位置：

```text
../app-server-transport/src/transport/websocket.rs
../app-server-transport/src/transport/auth.rs
../app-server-transport/src/lib.rs
../app-server-protocol/src/listen_info.rs
../app-server/src/main.rs
../app-server/src/lib.rs
../app-server/README.md
```

前端文件位置：

```text
src/platform/agentHost/electron-main/electronAgentHostStarter.ts
src/platform/agentHost/electron-main/appServerConnectionRelay.ts
src/platform/agentHost/electron-browser/appServerMessagePortTransport.ts
src/platform/agentHost/electron-browser/localAgentHostService.ts
```

starter 读取并运行时验证启动记录，保存 endpoint 与进程代次。每个 renderer 使用一次性 nonce 请求 connection；relay 为该请求新建一条 WebSocket connection，通过 Authorization header 完成鉴权，再把 WebSocket frame 与 MessagePort frame 一一转发。relay 不解析线上 JSON-RPC，不复用 WebSocket，不缓存领域状态。

以下条件全部满足后才能把 WebSocket 从实验 transport 改为正式桌面 transport：

- README 不再把 loopback、token-authenticated 的桌面用法标记为 unsupported；非 loopback listener 仍按其独立安全策略处理。
- macOS、Linux、Windows 都验证随机端口、IPv4 loopback、token 成功与失败、启动超时和 process cleanup。
- 两个以上 connection 可以独立 initialize、使用相同 request ID、接收各自 response，并单独关闭。
- inbound 与 outbound queue 有界；慢 connection 只关闭自身，不阻塞其他 connection。
- process exit 关闭全部 relay；renderer close 只关闭自己的 WebSocket 与 MessagePort。
- endpoint 与 token 不进入 renderer、日志、错误 message 或持久化文件。

## 生成完整 TypeScript 协议

`../app-server-protocol/src/protocol/common.rs` 的 typed registry 继续是 method、params、response、notification、server request 和实验状态的唯一 owner。`../app-server-protocol/src/export.rs` 必须直接消费该 registry 生成映射，不能解析已经生成的 TypeScript union，也不能维护第二份 method 清单。

稳定输出至少包含：

```text
.build/protocol/typescript/AppServerRequestMap.ts
.build/protocol/typescript/AppServerNotificationMap.ts
.build/protocol/typescript/AppServerServerRequestMap.ts
.build/protocol/typescript/AppServerProtocolDecoder.ts
.build/protocol/typescript/AppServerListenInfo.ts
.build/protocol/typescript/index.ts
```

生成映射表达：

```ts
export interface AppServerRequestMap {
	'<domain>/<action>': {
		params: DomainActionParams;
		response: DomainActionResponse;
	};
}

export interface AppServerNotificationMap {
	'<domain>/<event>': DomainEventParams;
}

export interface AppServerServerRequestMap {
	'<domain>/<hostAction>': {
		params: DomainHostActionParams;
		response: DomainHostActionResponse;
	};
}
```

`AppServerProtocolDecoder.ts` 是生成物，不导入前端领域 service。它至少导出启动记录 decoder、基础 envelope decoder、notification decoder、server request decoder，以及按 request method 解码 result 的函数。response envelope 没有 method，因此 renderer protocol client 在 pending entry 中保存生成 map 的 method，并用该 method 选择 result decoder。

运行时 decoder 必须验证 required 字段、tagged union、数组、对象、可空与可选字段、request ID、method membership 以及未知字段策略。它可以由生成器编译 JSON Schema 为 TypeScript 校验代码，但具体字段、tag 和 method 不能手写进 frontend。当前 generator 无法覆盖协议使用的 schema 子集时先扩展 generator；若扩展需要新增依赖或改变公开 schema 行为且没有用户决定，再执行冲突门禁。不能只验证 envelope 后对 params/result 使用 `as`。

frontend 不从 sibling checkout 运行时导入生成物。`build/protocol/generate.ts` 运行固定版本的打包 backend generator，直接写入 `.build/protocol/typescript/`；`build/protocol/generate.py` 在临时目录用同一固定版本重新生成并逐字节比较。生成物可以提交，但只能由生成任务更新；手改、遗漏文件、版本不匹配或重新生成有 diff 都使构建失败。

生成 owner 与测试位置：

```text
../app-server-protocol/src/export.rs
../app-server-protocol/src/listen_info.rs
../app-server-protocol/src/precomputed_exports.rs
../app-server-protocol/src/precomputed_exports_tests.rs
../app-server-protocol/src/schema_fixtures.rs
../app-server-protocol/src/schema_fixtures_tests.rs
.build/protocol/typescript/
.build/protocol/json/
build/protocol/generate.ts
build/protocol/generate.py
.build/protocol/typescript/
```

生成测试必须覆盖：

- 每个稳定 request method 恰好出现在 request map，并绑定注册点声明的 params/response。
- 每个稳定 notification 和 server request 恰好出现在对应 map。
- 实验 method 不进入稳定 map；实验输出开启后才进入实验生成物。
- 每种 envelope 至少有一组有效 fixture 和缺字段、错 tag、错 result、未知 method 等无效 fixture。
- 启动记录 decoder 拒绝未知 kind、未知 version、非 loopback endpoint、缺字段和多余安全敏感字段。
- 预计算生成物与当前 registry 完全一致，生成后工作树无 diff。
- `index.ts` 只导出生成文件，不引入 frontend adapter。
- frontend 生成物与固定版本 backend 重新生成的文件集合和内容完全一致。

## 版本与初始化兼容契约

打包的本地 frontend 与 app-server 采用锁步版本：生成脚本、依赖清单和打包任务固定同一个 backend binary 版本，Main 只启动这份受控 executable。协议同步检查用这份 binary 重新生成并逐字节比较，因此本地运行时不再发明第二套协议版本字段。

每条 connection 仍必须执行现有 `initialize` → `initialized`，校验 response shape、预期 server identity 和本 renderer 真正实现的 capabilities。缺少必需 capability 时不进入 Ready；user agent 只用于诊断。

如果产品需要连接能够独立升级的远程或用户自备 backend，现有锁步假设不成立。此时立即停下来询问用户选择：固定远端 binary 版本，还是授权修改 `../app-server-protocol/src/protocol/v1.rs`、`../app-server/src/request_processors/initialize_processor.rs` 和生成器，增加明确的兼容范围协商及矩阵测试。没有决定前不能按字段存在性猜版本，也不能静默忽略未知 method。

## 稳定产品依赖的实验 API

生产 adapter 不开启 `experimentalApi` 来取得必需能力。先列出真实调用方需要的 method、字段和 notification，只稳定这组闭包依赖；未使用的实验 API 保持实验状态。

Project 接入通常需要同时稳定：

```text
project/list
project/read
project/create
project/import
project/update
project/move
project/delete
project/changed
thread/project/updated
thread/start.projectId
thread/metadata/update.projectId
```

Environment 仅在产品存在真实选择、状态或远程执行调用方时稳定对应的 `environment/*`、Thread/Turn selection 字段和 connection notification。Agents Window 只展示本地 Thread 时不得为了完整表面能力稳定 Environment。

修改位置：

```text
../app-server-protocol/src/protocol/common.rs
../app-server-protocol/src/protocol/v2/project.rs
../app-server-protocol/src/protocol/v2/environment.rs
../app-server-protocol/src/protocol/v2/thread.rs
../app-server/src/request_processors/projects.rs
../app-server/src/request_processors/environment_processor.rs
../app-server/src/request_processors/thread_processor.rs
../app-server/README.md
```

稳定前必须证明 method 名称、ID、幂等、持久化、分页、notification、错误、兼容和删除语义已经固定。移除实验标记后同步更新稳定 TypeScript/JSON Schema、预计算生成物、README 和双端 fixture。存在尚未决定的用户行为时停下询问用户，不通过 capability gate 把未决定行为发布为稳定契约。

## 结构化领域错误

JSON-RPC 保留错误继续使用标准 code。调用方需要区分的领域失败使用一个稳定领域错误 code，并在 `data` 中提供生成的 tagged union；`message` 只用于诊断。

```ts
type AppServerDomainErrorData =
	| { kind: 'notFound'; resource: string; id: string }
	| { kind: 'conflict'; resource: string; expectedRevision?: string; actualRevision?: string }
	| { kind: 'permissionDenied'; operation: string }
	| { kind: 'invalidState'; resource: string; state: string; operation: string };
```

这是 shape 示例；只生成真实 processor 会返回、前端调用方会区分的 variant。新增 variant 先进入 Rust 协议类型，再由 generator 输出；adapter 用 numeric code 与 `data.kind` 映射领域错误。

文件位置：

```text
../app-server-protocol/src/rpc.rs
../app-server-protocol/src/protocol/v2/<domain>.rs
../app-server/src/error_code.rs
../app-server/src/request_processors/request_errors.rs
../app-server/src/request_processors/<domain>_processor.rs
```

测试必须验证 code/data 序列化、每个 variant 的必填字段、未知 variant 的 compatibility error，以及 message 改写不会改变前端分类。

## Server request 的唯一 connection owner

notification 可以按协议广播，server request 不得广播。每个 server request 创建时必须已有且只有一个 `connection_id`：Turn 产生的 approval、输入和工具 request 绑定启动当前 Turn 的 connection；由某个 client request 触发的宿主能力绑定该 client request 的 connection；没有来源 connection 的后台任务不能向任意 renderer 请求交互。

后端修改位置：

```text
../app-server/src/outgoing_message.rs
../app-server/src/thread_state.rs
../app-server/src/request_processors/thread_lifecycle.rs
../app-server/src/connection_cleanup.rs
```

`send_request` 必须改成需要显式 `ConnectionId` 的接口，不能保留 broadcast server request 入口。server request ID 由每条 connection 独立分配，pending callback 使用 `(connection_id, request_id)` 作为 key；只有同 connection 的 response 可以完成它。connection close 立即以稳定错误结束其全部 pending server request，不转移到其他 renderer，也不等待 active window。

Thread catalog subscription 只授予 notification，不授予交互 request ownership。若产品需要把运行中的 Turn 主动交给另一 renderer，必须先增加显式 handoff method、generation 和双方确认；没有该协议时停下询问用户。

测试必须覆盖两个 connection 使用相同 server request ID、错误 connection 回复、owner close、多个 Thread subscriber、同时 approval，以及 notification broadcast 不改变 request owner。

## 领域取消

不增加通用 JSON-RPC cancel。对每个可取消用户行为分别判断：后端是否已有稳定 operation/resource ID、是否有 typed interrupt/stop/unwatch/terminate/cancel method，以及 cancel 与正常完成竞争时的唯一终态。

缺少任一条件时有两种合法结果：调用方不展示“取消后端工作”的能力，或先在 `../app-server-protocol/src/protocol/v2/<domain>.rs` 与注册点增加领域 cancel 契约。不能让 protocol client 的 Promise 接收通用 `CancellationToken`，也不能删除 pending 后丢弃迟到 response。

领域取消测试至少覆盖 cancel-before-start、cancel-after-start、cancel/completion race、重复 cancel、错误 ID、connection close 和 cancel response 后无后续资源事件。

## 完成门禁

前端实现前逐项确认：

| 门禁 | 必须看到的证据 |
| --- | --- |
| transport | 三平台测试、机器可读启动记录、token auth、多 connection 隔离、bounded queue |
| generator | 三张 method map、运行时 decoder、有效/无效 fixture、生成物无 diff |
| initialize | 本地 fixed binary 与生成物一致、capability 校验；独立升级时有已决定的协商与矩阵测试 |
| stable API | 产品所需 method/field/notification 已进入稳定 schema，未依赖 `experimentalApi` |
| errors | 调用方区分的失败都有稳定 code/tagged data |
| server request | 每个 request 有唯一 connection owner，同 connection 回复，close cleanup |
| cancellation | 每个声明可取消的行为都有 ID、typed cancel 与 race 终态 |

任一门禁缺证据时，任务仍处于后端前置能力阶段，不能开始领域 adapter 或宣称前后端已完成对接。
