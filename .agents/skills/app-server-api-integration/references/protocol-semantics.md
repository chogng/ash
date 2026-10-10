# 协议语义

本文件规定 renderer protocol client 与 app-server 的消息语义，以及各前端领域 adapter 如何消费这些消息。先写调用方可观察行为，再选择线上消息；不能从现有 method、DTO 或 handler 反推前端接口。Sessions replacement 仅在 Thread 进入 Agents Window 时适用。

## 行为表

每项对接先回答：

| 项目 | 必须明确 |
| --- | --- |
| 前端行为 | 领域 service 调用方要完成什么，返回值和可观察副作用是什么 |
| 后端 owner | 哪个核心领域服务或选定扩展 Provider 校验、决定并保存状态；授权 broker 不复制业务状态 |
| 消息形态 | request、notification、显式资源或 server request |
| 身份 | 当前领域对象、Project、Thread、Turn、Item、Environment、resource 或 command ID |
| connection 归属 | 哪个 renderer connection 发起，server request 和资源事件回到哪条 connection |
| 生命周期 | 谁创建、谁释放，renderer、领域 handle、connection 或 process 关闭时如何结束 |
| 取消 | 停止哪项后端工作，取消和正常完成竞争时哪个终态生效 |
| 顺序 | 哪些动作按稳定 key 串行，哪些允许并行 |
| 错误 | 稳定 code/data 如何转换成前端领域错误 |
| 恢复 | 断线后失败、重读、重订阅，还是由协议明确恢复 |

## 线上 envelope 与分类

每条 renderer connection 独立收发线上消息。线上省略标准 JSON-RPC 版本字段，connection 根据方向和字段分类：

| 方向和字段 | 类型 | renderer protocol client 行为 |
| --- | --- | --- |
| client → server，`id + method + params` | client request | 写入后登记该 connection 的 client pending |
| server → client，`id + result` 或 `id + error` | client response | 只完成同 connection 匹配的 client pending |
| server → client，`method + params` 且无 `id` | server notification | 分派给 typed listener |
| server → client，`id + method + params` | server request | 调用同 renderer 的 typed handler 并回复一次 |
| client → server，`method + params` 且无 `id` | client notification | 只用于协议明确允许的通知，例如 `initialized` |

client request ID 与 server request ID 分属两个方向，且不同 renderer connection 可以使用相同 ID。每个 protocol client 使用独立的 client pending 与 server pending；Main relay 不查看、重写或命名空间化 ID。

未知 response ID、重复 response、无效 envelope 或生成类型解码失败属于 protocol error，不转成领域失败，也不能交给下一个 connection 代次。

## 运行时解码

transport 收到的 frame 先保持 `unknown`，再经过生成 decoder：

1. 校验基础 envelope 和 request ID；
2. 按方向与字段分类消息；
3. 按生成 method registry 解码 params、result 或 error；
4. 只把已解码值交给 pending、listener 或 handler。

decoder 或等价校验器必须与 method map 一起由 `../app-server-protocol/` 生成。手写 type guard、`as GeneratedType`、只检查 method string 或仅依靠 TypeScript union 都会产生第二个协议 owner。生成器缺少 decoder 时先按 [前置能力补全](prerequisite-completion.md) 完成生成器；后端不在授权范围或生成 owner 冲突时执行冲突门禁。

Main relay 只转发 frame 和 close，不执行 `JSON.parse`。领域 service、UI 与普通 contribution 不接收 raw envelope。

## 消息选择

| 前端语义 | 线上消息 | 必须具备 |
| --- | --- | --- |
| 一次性查询或修改 | typed request/response | params、response、稳定错误、必要串行范围 |
| connection 期间的 catalog/state 变化 | typed server notification | identity、触发条件、初始化后的可用范围 |
| watch、process、terminal、search 等持续资源 | start request + resource notification + stop request | client-generated ID、终止信号、connection cleanup |
| Rust 需要宿主返回值 | typed server request/response | request ID、connection owner、typed response、错误与关闭语义 |
| 取消既有工作 | typed interrupt、stop、unwatch、terminate 或 cancel request | 稳定 operation/resource ID |

notification 不用于需要确认成功的命令；request response 不承载无限流；server request 不用“通知 + 另一个 client request”模拟。

## 一次性 request

协议注册点一次绑定 method、params、response 和 serialization scope。renderer protocol client 只能通过生成映射调用：

```ts
interface IAppServerProtocolClient {
	request<M extends keyof AppServerRequestMap>(
		method: M,
		params: AppServerRequestMap[M]['params'],
	): Promise<AppServerRequestMap[M]['response']>;
}
```

`AppServerRequestMap` 必须是生成物。调用方不能传 `unknown` params、自行指定 response 泛型或手写 method string。

request ID 只负责当前 connection 的响应配对。需要幂等、去重或未知结果恢复的修改必须另有 idempotency key、command ID、revision 或稳定对象 ID；不能把 request ID 当作业务身份。

## Project、Thread 与 catalog notification

Project catalog 与 Thread catalog 都由后端拥有。对应领域 adapter 初始化时先取得 snapshot，再订阅 notification；协议必须用以下任一方式消除 snapshot 与事件之间的缺口：

- snapshot response 返回 revision/sequence，并规定续接点；
- 注册 notification 路由早于 snapshot request，client 在 response 前缓存事件；
- 后端明确保证订阅建立和 snapshot 的原子顺序。

`project/changed` 只说明 Project 发生变化时，Project adapter 按 `projectId` 重新读取；它不能凭通知自行构造完整 Project。`thread/project/updated` 更新 Thread facade 的 assignment，但不自动改写 Project roots、Workspace cwd 或 Environment selection。

多 renderer 各自维护同一后端 catalog 的本地 facade。notification 可以到达所有已初始化 connection；这不构成多持久化 owner，因为后端仍是唯一 durable source。前端不得把一个窗口的缓存通过 Main 广播给其他窗口。

Project 或 Environment method 仍为实验协议时，生产 adapter 不静默启用。先按 [前置能力补全](prerequisite-completion.md) 稳定真实调用方需要的 method、field 和 notification 闭包；稳定范围涉及未决定的产品行为时执行冲突门禁。

## Thread 进入 Agents Window 时的 Session replacement

draft Session 在首个 send 前可以没有 backend Thread。`thread/start` 成功后，Provider 用 Thread ID 构造 committed resource，发布 committed facade，并触发单独的 Session replacement lifecycle。catalog change 不能同时承担 replacement 语义。

已提交 Session 的主 Chat 默认与 Session resource 相同。Thread fork 返回新 Thread 时发布新 Session；只有后端提供稳定 Chat catalog 时才把 fork 或 side chat 留在同一 Session。Provider capabilities 必须如实反映当前后端协议，不能根据 UI 期望推断。

## 显式资源

持续资源使用 client-generated resource ID，使 start 发出前就能建立路由和停止目标：

```text
创建 resource ID
  → 在 renderer client 注册 notification route
  → start(resource ID, params)
  → 接收 notification(resource ID, ...)
  → completed/exited 或 stop(resource ID)
  → 删除 route
```

- 后端 key 至少包含 connection ID 和 resource ID，不同 renderer connection 不能相互停止资源。
- 同 connection 的重复 resource ID 返回稳定错误，不能覆盖旧资源。
- stop response 返回前必须保证之后不再发送该资源 notification。
- renderer connection 关闭释放该 connection 创建的全部资源；共享进程继续运行。
- 多个本地 listener 共享同一后端资源时，最后一个 listener dispose 后才发送 stop。
- start 失败、stop 失败、终止 notification 和 connection close 都必须结束前端 handle 并删除 route。

前端 `Event` 没有异步 start rejection、terminal error 或 stop completion 语义，因此不能单独代表完整后端资源。领域 handle 至少包含数据事件、明确终态和异步 stop/dispose；如果前端契约无法表达这些结果，执行冲突门禁。

## 取消

通用 protocol client 的 `request` 不接收 `CancellationToken`。领域 adapter 只按实际协议映射取消：

| 操作 | 正确取消 |
| --- | --- |
| 正在运行的 Turn | 取得 `threadId`/`turnId` 后发送 `turn/interrupt` |
| 已启动的 command/process | 使用稳定 ID 发送 terminate |
| watch | 使用 resource ID 发送 unwatch/stop |
| login | 使用 login ID 发送 login cancel |
| 没有 cancel method 的普通 request | 不承诺停止后端工作；protocol client 继续消费迟到 response |

需要新增取消语义时，协议必须先具备稳定 operation ID 与 typed cancel request，并定义 cancel 与正常完成竞争时的唯一终态。丢弃 Promise、提前删除 pending 或忽略迟到 response 都不构成取消。

## Server request

Rust 需要 approval、用户输入、权限确认或宿主能力时发送 typed server request。它在当前 renderer connection 的 protocol client 上进入 typed handler；每个 request 恰好回复一次成功或错误。

| handler 所需能力 | owner |
| --- | --- |
| renderer 已有的交互与领域 service | 对应领域 adapter；Thread UI 才使用 `src/sessions/contrib/providers/agentHost/browser/` 下的 app-server adapter |
| Main 才拥有的系统、进程或凭据能力 | renderer typed host adapter → 独立 Main named channel |
| Rust 自己可以完成的领域行为 | 不发送 server request，直接调用 Rust 领域能力 |

传给 Main 的 host call 使用前端定义的最小领域契约，不转发线上 `ServerRequest` union。Main 不返回 raw envelope，也不决定 approval 业务结果。

未知 method、handler 未注册、窗口关闭、用户取消、超时和 connection close 返回稳定错误。交互 request 必须按 [前置能力补全](prerequisite-completion.md) 绑定启动当前 Turn 或触发宿主调用的唯一 connection；Thread subscription 只授予 notification。后端若缺少该 identity，这是协议冲突；不能依赖 active window 或广播。

## 顺序与并发

顺序由 Rust 协议的 serialization scope 决定，常见 key 包括 Project、Thread、path、process、watch 和 connection。connection-scoped resource key 包含 backend connection ID；需要跨 connection 共享的 Project catalog 使用真实全局 key。

- 同 key 的修改按协议定义串行。
- 明确允许共享读的 request 可以并行，但不能越过已排队的写。
- 不同 key 默认并行；一个 process 或多个 connection 都不等于全局串行。
- 前端不得增加第二套领域锁修补后端顺序。

## 错误与重试

| 层 | 例子 | owner 行为 |
| --- | --- | --- |
| transport | endpoint 关闭、relay 失败、队列满 | 只关闭受影响 connection 并拒绝其 pending |
| process | 进程退出 | 关闭全部 renderer connection |
| protocol | method 不存在、params 无效、未 initialize | protocol client 解码为 protocol error |
| domain | Project 不存在、状态冲突、权限拒绝 | 对应领域 adapter 转为前端领域错误 |
| decode | response 与生成类型不匹配 | 使该 connection 失效并报告版本或实现错误 |

错误分类依赖稳定 numeric code 和结构化 data，不匹配英文 message。调用方必须区分的领域错误没有结构化 data 时执行冲突门禁。JSON-RPC envelope、relay 诊断和 Rust 内部错误不能进入前端领域 contract。

输入队列饱和可按协议标为可重试，但只有只读 request 能由调用层使用指数退避和抖动重试。已写入 transport 的修改在断线后属于未知结果，除非协议提供幂等 ID 与查询确认，否则不自动重试。

## 初始化与关闭

每条 renderer connection 独立执行一次：

1. acquisition 得到 transport；
2. 发送 typed `initialize` request；
3. 校验 response、capability 和协议兼容性；
4. 发送 `initialized` notification；
5. 进入 `Ready` 并开放领域 request。

初始化期间到达的已知 notification/server request 继续读取并按协议暂存；未知 server request 立即拒绝，不能阻塞 reader。本地 frontend、生成物和打包 backend 使用同一固定 binary 版本，并校验 initialize response 与所需 capabilities；若允许远程或用户自备 backend 独立升级，先按 [前置能力补全](prerequisite-completion.md) 取得版本固定或兼容协商决定，不能从 user agent 或字段存在性猜测。

renderer connection 关闭时停止接受新 request、关闭 transport、拒绝该 client pending、结束其 server request、资源和 listener。process 退出对所有 protocol client 产生同一 host failure，但每个 client 独立完成本地 close。新 connection 使用新代次，旧 ID 和消息不进入新 connection。

## 背压与输出纪律

renderer transport、Main relay 和 backend transport 队列都必须有界。大 payload 使用协议定义的分块或资源 notification。relay 不缓存无限 frame，不阻塞其他 renderer connection，也不把 stderr 或诊断混入线上 frame。
