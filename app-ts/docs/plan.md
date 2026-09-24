请为一个 TypeScript 前端应用设计并实现一套面向 Rust 后端的双向 JSON-RPC 2.0 通信基础设施。

项目架构：

* 前端语言：TypeScript
* 后端语言：Rust
* 前端运行于浏览器或 WebView
* 前端不运行 Node.js
* 模块系统使用 ESM
* TypeScript 开启严格模式
* 前后端通过双向 JSON-RPC 2.0 通信
* 底层传输可能是 WebSocket、WebView IPC、MessagePort 或自定义二进制通道
* TypeScript 和 Rust 两端都可以主动发起 request
* TypeScript 和 Rust 两端都可以发送 notification
* 不使用 Node.js `EventEmitter`
* 不使用 RxJS
* 不使用全局事件总线
* 不把具体传输实现耦合到 JSON-RPC 核心
* 所有来自 Rust 的数据在运行时都必须视为 `unknown`

目标是实现一个可靠、强类型、可取消、支持运行时校验的 `JsonRpcPeer`。

建议目录结构：

```text
src/
├─ base/
│  └─ common/
│     ├─ lifecycle.ts
│     └─ cancellation.ts
│
├─ rpc/
│  ├─ transport.ts
│  ├─ jsonRpcTypes.ts
│  ├─ jsonRpcPeer.ts
│  ├─ protocol.ts
│  ├─ definitions.ts
│  ├─ codecs.ts
│  ├─ errors.ts
│  └─ testing/
│     └─ fakeTransport.ts
│
├─ services/
│  ├─ downloadService.ts
│  └─ workspaceService.ts
│
└─ stores/
   ├─ downloadStore.ts
   └─ workspaceStore.ts
```

## 一、架构原则

整体分为四层：

```text
Transport
    ↓
JsonRpcPeer
    ↓
Domain Service / Controller
    ↓
Store / UI
```

职责如下。

### Transport

只负责发送和接收原始 JSON-RPC 消息。

不负责：

* 请求 ID 管理
* 响应匹配
* 方法路由
* 参数校验
* 超时
* 取消
* 业务逻辑

### JsonRpcPeer

负责：

* request / response
* notification
* 双向 request handler
* 请求 ID
* pending request 管理
* 超时
* `AbortSignal` 协作式取消
* 连接关闭清理
* JSON-RPC 错误映射
* 参数和结果运行时校验
* 协议错误处理

### Domain Service

负责：

* 暴露有业务语义的 API
* 隐藏 RPC 方法名
* 把 notification 转换为前端状态
* 把 RPC 错误转换为领域错误
* 不让 UI 直接调用字符串 RPC 方法名

### Store

负责：

* 保存当前状态
* 向 UI 提供可读取和可订阅状态
* 避免把所有后端 notification 继续传播为事件流

### 生命周期与取消

统一使用以下两个正交抽象：

* ECMAScript `Disposable` / `AsyncDisposable` 表达对象、监听、注册关系和子资源的所有权与生命周期；项目创建的资源通过 `IDisposable` / `IAsyncDisposable` 同时提供便捷的显式调用入口
* 标准 `AbortSignal` 表达某一次异步操作的协作式取消

`Disposable` 统一长期对象的组合式生命周期入口，通过受保护的 `_store` 和 `_register()` 持有子资源；`DisposableStore` 和 `AsyncDisposableStore` 基于标准 `DisposableStack` / `AsyncDisposableStack`，负责组合具有相同所有者的资源并按 LIFO 顺序释放。短作用域直接使用 `using` / `await using`，可替换单槽使用 `MutableDisposable<T>`，需要 clear-and-rebuild 时直接复用 `DisposableStore.clear()`。

`AbortController` 由发起操作的一方持有，取消一次 request 不得隐式销毁整个
peer。生命周期协议和操作取消保持正交，不再维护自定义取消协议或通用转换器。

基础模块在文件层面同样分离：`errors.ts` 统一 `CancellationError` 和错误判断；`cancellation.ts` 以标准 `AbortSignal` 为公共协议，负责取消令牌、等待竞争以及未来确有调用方需要的信号组合与超时策略；`lifecycle.ts` 不依赖取消机制。
RPC 等上层模块可以依赖两者，但不得把取消能力加入 `IDisposable`。

开发和测试环境可以显式安装 `DisposableTracker`。追踪器记录资源创建栈、
owner-child 关系并拒绝重复所有权与所有权环；在一个明确的测试或应用作用域结束时
调用 `assertNoLeaks()`。未安装追踪器时所有钩子均为空操作，生产正确性不得依赖
追踪器。每个 JavaScript realm 同时只安装一个追踪器；Electron main 和 renderer
入口在开发环境自动安装，并在各自应用作用域关闭时执行断言。新增资源容器时必须
覆盖 LIFO、幂等、销毁后注册、释放异常、
`SuppressedError` 和所有权转移测试。

`lifecycle.ts` 统一承载 `IDisposableTracker` 契约、tracker 槽、通知钩子以及开发和测试追踪器的创建栈、所有权图与泄漏报告；生产生命周期正确性不依赖是否安装追踪器。

Electron `contextBridge` 是明确的序列化边界：Symbol 键不能跨越该边界，因此
preload 只暴露带字符串键 `dispose()` 的 `DisposableHandle`。renderer 在需要
转移本地所有权时使用 `toDisposable()` 包装；其他本地模块直接使用标准协议，
不做适配器转换。

## 二、传输层接口

定义：

```ts
export interface JsonRpcTransport {
	readonly onMessage: (
		listener: (message: unknown) => void
	) => IDisposable;

	readonly onClose: (
		listener: (reason?: unknown) => void
	) => IDisposable;

	send(message: JsonRpcOutgoingMessage): void | Promise<void>;

	close(): void | Promise<void>;

	dispose(): void;
}
```

要求：

* `onMessage` 接收的内容类型必须是 `unknown`
* 传输层不得假设消息一定合法
* `send()` 可以是同步或异步
* `close()` 必须支持幂等调用
* 所有监听注册必须返回 `IDisposable`
* `close()` 负责可等待的有序关闭，`dispose()` 负责同步、幂等的兜底清理
* 不依赖 Node.js API
* 不使用 `Buffer`
* 不使用 `process`
* 不使用 `NodeJS.Timeout`

可以额外提供以下适配器示例之一：

```text
WebSocketJsonRpcTransport
WebViewJsonRpcTransport
MessagePortJsonRpcTransport
```

但核心 `JsonRpcPeer` 不得直接依赖具体传输。

## 三、JSON-RPC 2.0 消息类型

定义严格类型：

```ts
export type JsonRpcId = string | number;

export interface JsonRpcRequest {
	readonly jsonrpc: '2.0';
	readonly id: JsonRpcId;
	readonly method: string;
	readonly params?: unknown;
}

export interface JsonRpcNotification {
	readonly jsonrpc: '2.0';
	readonly method: string;
	readonly params?: unknown;
}

export interface JsonRpcSuccessResponse {
	readonly jsonrpc: '2.0';
	readonly id: JsonRpcId;
	readonly result: unknown;
}

export interface JsonRpcErrorObject {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
}

export interface JsonRpcErrorResponse {
	readonly jsonrpc: '2.0';
	readonly id: JsonRpcId | null;
	readonly error: JsonRpcErrorObject;
}

export type JsonRpcIncomingMessage =
	| JsonRpcRequest
	| JsonRpcNotification
	| JsonRpcSuccessResponse
	| JsonRpcErrorResponse;

export type JsonRpcOutgoingMessage =
	JsonRpcIncomingMessage;
```

实现运行时解析函数：

```ts
export function parseJsonRpcMessage(
	value: unknown
): JsonRpcIncomingMessage;
```

要求：

* 校验 `jsonrpc === '2.0'`
* 区分 request、notification、success response 和 error response
* 校验 `id`
* 校验 `method`
* 校验 `error.code`
* 校验 `error.message`
* 拒绝同时包含 `result` 和 `error` 的响应
* 拒绝 request 缺少 `id`
* 允许 notification 不包含 `id`
* 对非法消息抛出明确的协议错误
* 不直接信任类型断言

## 四、协议映射

定义前端主动调用 Rust 的方法映射：

```ts
export interface ServerMethods {
	'download/start': {
		params: StartDownloadParams;
		result: StartDownloadResult;
	};

	'download/cancel': {
		params: CancelDownloadParams;
		result: null;
	};

	'workspace/open': {
		params: OpenWorkspaceParams;
		result: OpenWorkspaceResult;
	};
}
```

定义 Rust 主动调用前端的方法映射：

```ts
export interface ClientMethods {
	'ui/confirm': {
		params: ConfirmParams;
		result: ConfirmResult;
	};

	'ui/showMessage': {
		params: ShowMessageParams;
		result: null;
	};
}
```

定义 Rust 发给前端的通知：

```ts
export interface ServerNotifications {
	'download/progress': DownloadProgress;
	'download/completed': DownloadCompleted;
	'download/failed': DownloadFailed;
	'workspace/changed': WorkspaceChanged;
}
```

定义前端发给 Rust 的通知：

```ts
export interface ClientNotifications {
	'ui/focused': UiFocused;
	'ui/blurred': UiBlurred;
}
```

所有方法名必须集中定义，不允许在业务组件中散落字符串。

## 五、运行时 Codec

定义：

```ts
export interface Codec<T> {
	parse(value: unknown): T;
}
```

定义请求方法：

```ts
export interface RpcMethodDefinition<P, R> {
	readonly method: string;
	readonly params: Codec<P>;
	readonly result: Codec<R>;
}
```

定义通知：

```ts
export interface RpcNotificationDefinition<P> {
	readonly method: string;
	readonly params: Codec<P>;
}
```

示例：

```ts
export const startDownloadMethod:
	RpcMethodDefinition<
		StartDownloadParams,
		StartDownloadResult
	>;

export const downloadProgressNotification:
	RpcNotificationDefinition<DownloadProgress>;
```

要求：

* 方法名和 codec 必须绑定在同一个定义对象中
* 不允许调用方单独传递字符串和泛型类型
* 禁止这种 API：

```ts
rpc.request<StartDownloadResult>(
	'workspace/open',
	params
);
```

推荐这种 API：

```ts
rpc.request(
	startDownloadMethod,
	params
);
```

这样方法名、参数类型、结果类型和运行时校验不会分离。

## 六、JsonRpcPeer 接口

定义：

```ts
export interface RpcRequestOptions {
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
}

export interface JsonRpcPeer {
	request<P, R>(
		definition: RpcMethodDefinition<P, R>,
		params: P,
		options?: RpcRequestOptions
	): Promise<R>;

	notify<P>(
		definition: RpcNotificationDefinition<P>,
		params: P
	): Promise<void>;

	onNotification<P>(
		definition: RpcNotificationDefinition<P>,
		listener: (params: P) => void
	): IDisposable;

	registerRequestHandler<P, R>(
		definition: RpcMethodDefinition<P, R>,
		handler: (
			params: P,
			context: RpcRequestContext
		) => R | Promise<R>
	): IDisposable;

	dispose(): void;
}
```

定义请求上下文：

```ts
export interface RpcRequestContext {
	readonly requestId: JsonRpcId;
	readonly signal: AbortSignal;
}
```

## 七、请求发送

实现 `request()`。

要求：

1. 自动生成唯一请求 ID
2. 将请求加入 pending map
3. 发送标准 JSON-RPC request
4. 收到匹配 response 后：

   * 解析消息
   * 校验 result
   * resolve Promise
   * 清理 timeout
   * 清理 cancellation listener
   * 从 pending map 删除
5. 收到 error response 后：

   * 转换成 `JsonRpcRemoteError`
   * reject Promise
   * 清理 pending 状态
6. `send()` 失败时：

   * reject Promise
   * 清理 pending 状态
7. 不允许 Promise 永久 pending

建议 pending 结构：

```ts
interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: unknown): void;
	resultCodec: Codec<unknown>;
	timeoutId?: ReturnType<typeof globalThis.setTimeout>;
	cancellationListener?: IDisposable;
}
```

避免实际实现中使用不安全的 `Codec<unknown>`，请设计合理的类型擦除边界。

## 八、请求超时

支持：

```ts
rpc.request(
	startDownloadMethod,
	params,
	{
		timeoutMs: 15_000
	}
);
```

要求：

* 超时后删除 pending request
* Promise reject 为 `RpcTimeoutError`
* 清理 cancellation listener
* 可选发送 `$/cancelRequest`
* 晚到的 response 不得重新 resolve
* 晚到 response 可以在开发环境记录 warning
* 定时器必须可清理
* 使用：

```ts
ReturnType<typeof globalThis.setTimeout>
```

## 九、请求取消

使用标准或兼容 LSP 风格的取消通知：

```json
{
	"jsonrpc": "2.0",
	"method": "$/cancelRequest",
	"params": {
		"id": 42
	}
}
```

要求：

* `AbortSignal` 触发后：

  * 从 pending map 移除请求
  * reject Promise 为 `RpcRequestCancelledError`
  * 发送取消通知
  * 忽略后续到达的 response
* 取消是协作式取消
* 不假设 Rust 任务已经立即停止
* 重复 cancel 不产生重复副作用
* 已完成请求不再发送取消通知

同时支持 Rust 取消其发给前端的 request。

前端收到：

```json
{
	"jsonrpc": "2.0",
	"method": "$/cancelRequest",
	"params": {
		"id": 83
	}
}
```

时，应触发对应 request handler 的 `AbortSignal`。

## 十、通知发送和接收

实现：

```ts
notify(definition, params)
```

要求：

* notification 不包含 `id`
* `params` 在发送前应通过 codec 或明确的序列化约束
* send 失败时返回 rejected Promise
* 不等待 response

实现：

```ts
onNotification(definition, listener)
```

要求：

* 支持多个监听器
* 返回 `IDisposable`，由监听者的所有者负责解除监听
* 非法 params 不调用 listener
* 校验失败交给统一错误处理器
* 单个 listener 抛出异常不影响其他 listener
* 未知 notification 默认不导致连接关闭
* 开发环境可以 warning
* 生产环境可以忽略或上报

不需要实现完整事件流操作符：

```text
map
filter
reduce
any
forward
debounce
throttle
```

如业务需要节流，应在 service 或 store 层处理。

## 十一、Rust 调用前端

实现：

```ts
registerRequestHandler(
	definition,
	handler
);
```

收到 Rust request 时：

1. 查找对应 handler
2. 校验 params
3. 创建独立 `AbortController`
4. 调用 handler
5. 校验 handler 返回结果
6. 返回 success response
7. handler 抛出异常时返回 error response
8. 请求结束后清理 handler execution 状态

没有 handler 时返回：

```json
{
	"jsonrpc": "2.0",
	"id": 83,
	"error": {
		"code": -32601,
		"message": "Method not found"
	}
}
```

params 校验失败时返回：

```json
{
	"jsonrpc": "2.0",
	"id": 83,
	"error": {
		"code": -32602,
		"message": "Invalid params"
	}
}
```

内部错误返回：

```json
{
	"jsonrpc": "2.0",
	"id": 83,
	"error": {
		"code": -32603,
		"message": "Internal error"
	}
}
```

要求：

* 不把 JavaScript stack trace 原样发送给 Rust
* 可以返回受控 `errorId`
* 可以定义业务错误码
* handler 的 error 映射必须集中处理

## 十二、标准错误

实现：

```ts
export class JsonRpcError extends Error {}

export class JsonRpcProtocolError
	extends JsonRpcError {}

export class JsonRpcRemoteError
	extends JsonRpcError {
	readonly code: number;
	readonly data?: unknown;
}

export class RpcTimeoutError
	extends JsonRpcError {}

export class RpcRequestCancelledError
	extends JsonRpcError {}

export class RpcConnectionClosedError
	extends JsonRpcError {}

export class RpcValidationError
	extends JsonRpcError {}

export class RpcDisposedError
	extends JsonRpcError {}
```

要求：

* 错误类型包含必要上下文
* 不默认记录完整 payload
* 不记录敏感参数
* remote error 保留 code 和受控 data
* 协议错误和业务错误明确区分

## 十三、连接关闭

传输关闭时：

* 将 peer 标记为 closed
* reject 所有 pending request
* 错误类型使用 `RpcConnectionClosedError`
* 清理全部 timeout
* 清理全部 cancellation listener
* 取消所有正在执行的入站 request handler token
* 后续 `request()` 立即失败
* 后续 `notify()` 立即失败
* 不允许 pending Promise 永久存在
* close 和 dispose 必须幂等

如果支持重连，不要在核心 peer 中隐式自动重连。

重连应由更上层的 connection manager 负责。

## 十四、dispose

`dispose()` 时：

* 标记 peer 为 disposed
* 停止监听 transport
* reject 所有 pending request
* 取消所有入站 handler token
* 清理 notification listeners
* 清理 request handlers
* 清理 timeout
* 调用 transport.close()
* 捕获异步 close 错误
* 不产生未处理的 Promise rejection
* dispose 后不能继续使用

## 十五、消息顺序和并发

明确以下语义：

* 同一 transport 上按消息到达顺序处理
* 不阻塞后续独立消息
* 不要求 request 按发送顺序完成
* response 必须通过 ID 匹配
* notification listener 可以同步执行
* request handler 可以异步执行
* 多个 request handler 可以并发运行
* 同一个请求只能返回一次 response
* 重复 response 视为协议异常
* 未知 response ID 在开发环境 warning

请避免整个消息处理过程被一个慢 handler 阻塞。

## 十六、数字边界

Rust 数值类型和 JavaScript 数值语义不同。

必须说明：

* JavaScript `number` 不能安全表示全部 `u64`
* 超过 `Number.MAX_SAFE_INTEGER` 的值不能直接作为 JSON number 使用
* 文件大小、字节偏移、数据库 ID、时间戳等字段应评估是否可能超过安全范围

推荐 wire format：

```ts
export interface DownloadProgressWire {
	taskId: string;
	receivedBytes: string;
	totalBytes: string;
}
```

领域层：

```ts
export interface DownloadProgress {
	taskId: string;
	receivedBytes: bigint;
	totalBytes: bigint;
}
```

codec 负责：

```text
string
→ BigInt
→ 范围校验
```

禁止无条件把 Rust `u64` 映射为 TypeScript `number`。

## 十七、命名规范

RPC request 方法使用：

```text
download/start
download/cancel
workspace/open
workspace/readFile
ui/confirm
```

notification 使用：

```text
download/progress
download/completed
download/failed
workspace/changed
terminal/output
```

建议：

* 使用领域名作为前缀
* request 使用动作名称
* notification 使用已发生事实或状态变化
* 不使用模糊名称，例如 `update`、`event`、`message`
* 不让 UI 直接依赖方法字符串
* 方法字符串只存在于 protocol definition 中

## 十八、领域服务示例

实现：

```ts
export class DownloadService {
	constructor(
		private readonly rpc: JsonRpcPeer,
		private readonly store: DownloadStore
	) {}

	startDownload(
		params: StartDownloadParams,
		options?: RpcRequestOptions
	): Promise<StartDownloadResult>;

	cancelDownload(
		taskId: string,
		options?: RpcRequestOptions
	): Promise<void>;

	dispose(): void;
}
```

构造时监听：

```ts
downloadProgressNotification
downloadCompletedNotification
downloadFailedNotification
```

收到 notification 后更新 store。

UI 不应直接写：

```ts
rpc.onNotification(
	downloadProgressNotification,
	...
);
```

而应依赖：

```ts
downloadService
downloadStore
```

## 十九、Store 示例

实现一个轻量 store：

```ts
export interface ReadonlyStore<T> {
	getSnapshot(): T;

	subscribe(
		listener: (state: T) => void
	): IDisposable;
}
```

要求：

* store 保存当前状态
* 新 UI 挂载后可以立即读取当前值
* notification 进入前端后优先更新状态
* 只有真正瞬时的动作才直接处理
* 不把下载进度等持续信息只建模成事件

下载状态示例：

```ts
export interface DownloadTaskState {
	taskId: string;
	status:
		| 'running'
		| 'completed'
		| 'failed'
		| 'cancelled';
	receivedBytes: bigint;
	totalBytes: bigint | null;
	error?: string;
}
```

## 二十、Fake Transport

实现：

```ts
export class FakeJsonRpcTransport
	implements JsonRpcTransport {

	sentMessages: JsonRpcOutgoingMessage[];

	receive(message: unknown): void;

	disconnect(reason?: unknown): void;

	send(message: JsonRpcOutgoingMessage):
		Promise<void>;

	close(): Promise<void>;
}
```

要求：

* 可手动注入消息
* 可检查发送消息
* 可模拟 send rejection
* 可模拟连接关闭
* 可精确控制消息顺序
* 不使用真实时间或真实网络

## 二十一、测试要求

使用 Vitest。

### 消息解析

覆盖：

* 合法 request
* 合法 notification
* 合法 success response
* 合法 error response
* 非法 jsonrpc 字段
* 非法 method
* 非法 id
* 同时存在 result 和 error
* error 缺少 code
* error 缺少 message

### request

覆盖：

* 正常发送和响应
* 多个并发请求
* response 乱序到达
* response ID 匹配
* result codec 校验
* remote error
* send 失败
* timeout
* cancel
* cancel 后晚到 response
* 重复 response
* 未知 response ID
* transport close 时 reject pending
* dispose 时 reject pending

### notification

覆盖：

* 正常接收
* params codec 校验
* 多个 listener
* `IDisposable` 解除监听
* listener 异常不影响其他 listener
* 未知 notification
* notify 发送
* notify send 失败

### 入站 request

覆盖：

* 正常 handler
* 异步 handler
* 无 handler
* params 非法
* handler 抛出异常
* handler 返回非法结果
* Rust 发送取消通知
* handler context token 被取消
* 同一个 request 只响应一次
* 多个 handler 并发执行

### 生命周期

覆盖：

* dispose 幂等
* close 幂等
* dispose 后 request
* dispose 后 notify
* dispose 后注册 handler
* 所有 timeout 被清理
* 所有 listener 被清理
* 所有入站 handler token 被取消

### 数值 codec

覆盖：

* 合法 bigint 字符串
* 非法数字字符串
* 负数
* 超范围
* `Number.MAX_SAFE_INTEGER` 边界
* Rust `u64` 最大值

## 二十二、禁止事项

不得：

* 使用 Node.js `EventEmitter`
* 使用 `node:events`
* 使用 `Buffer`
* 使用 `process`
* 使用 `NodeJS.Timeout`
* 使用 CommonJS
* 使用 `require`
* 使用 RxJS
* 使用全局事件总线
* 在 UI 中直接写 RPC 方法字符串
* 只依赖 TypeScript 泛型而不做运行时校验
* 对入站消息直接使用 `as`
* 让 pending Promise 永久存在
* 忽略 transport close
* 忽略 send rejection
* 忽略 timeout 清理
* 忽略 cancellation listener 清理
* 把完整内部异常 stack 返回给 Rust
* 将全部 Rust `u64` 直接映射为 JavaScript number
* 在 JsonRpcPeer 中直接实现业务 store
* 在 Transport 层实现协议路由
* 在核心 peer 中隐式自动重连

## 二十三、输出内容

请按以下顺序输出：

1. 架构设计说明
2. JSON-RPC 消息模型
3. 请求和通知语义
4. 双向 request 处理流程
5. 取消和超时设计
6. 目录结构
7. `errors.ts`
8. `jsonRpcTypes.ts`
9. `codecs.ts`
10. `definitions.ts`
11. `transport.ts`
12. `jsonRpcPeer.ts`
13. fake transport
14. protocol 定义示例
15. download service
16. download store
17. UI 使用示例
18. Vitest 测试
19. 并发和竞态分析
20. 数值边界分析
21. 错误处理策略
22. 与普通事件总线和单向 RPC client 的区别

代码要求：

* 所有代码必须完整可运行
* 不要使用省略号
* 不要只给伪代码
* TypeScript 开启 strict
* 公共 API 添加简洁 TSDoc
* 外部输入统一使用 `unknown`
* 尽量避免 `any`
* 所有异步操作必须捕获错误
* 所有 timeout 必须可清理
* 所有 cancellation listener 必须通过 `IDisposable` 清理
* 所有 pending request 必须有明确终止路径
* 说明如何避免重复 response
* 说明如何处理未知 response ID
* 说明如何处理晚到 response
* 说明如何处理连接关闭
* 说明如何处理双向取消
* 优先保证协议正确性、运行时安全、资源释放和可维护性
