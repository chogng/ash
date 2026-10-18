# Ash app-server 到 Renderer 的大响应链路审计

2026-10-17 对照 [Owl 运行时调查](codex-owl-runtime-investigation.md)，检查 Ash 工作区的真实数据路径，重点是解析、复制、同步派发和背压。先完成源码审计与隔离算法实验，再实施第 7 节的第一批 P1；尚未运行真实 Desktop 场景 profile。

审计基线的结论：Ash Main 已经透明转发字节，避免了 Owl 在 Browser UI 线程完整解析 JSON 的问题。但 Renderer 的 framing 存在可复现的复制放大，完整帧还会重新 UTF-8 编码、同步解析和递归 schema 校验。聊天消费者没有使用后端已有的有界历史能力，进一步放大输入。背压能够限制传输中的字节块，不能等同于限制完整响应处理成本、总内存或控制消息延迟。

**实施状态：三批链路 P1 与流式 Markdown 优化已实现。** 第 1～4 节保留 manifest 对应的优化前审计快照；固定页 framing、接收端副本与重复编码见第 7 节；Code Chat 的有界历史、翻页、回放与审批保护见第 8 节；大帧解析与 schema 校验的 Worker、顺序队列及异步 ACK 见第 9 节。第 15 节记录流式 Markdown 尾部更新，第 16～17 节记录 Worker 回传、领域堆与正文复用，第 18～19 节记录围栏增量更新和取消载荷退休。其余链路测量见[数据链路性能 TODO](../TODO.md#数据链路性能--todo)。

证据快照与文件 hash 见 [manifest.json](research/ash-app-server-data-path-2026-10-17/manifest.json)，实验脚本见 [probe.cjs](research/ash-app-server-data-path-2026-10-17/probe.cjs)。这是调查时的实现，不替代 [前端与 App Server 连接边界](frontend-app-server-boundary.md)或产品契约。工作区有并发开发活动；后续修改前应重新核对文件 hash。

## 1. 完整数据路径

```text
Rust 领域结果
  → result<T>：serde_json::to_value
  → serialize_response：完整 JSON String
  → gateway：部分 resource 响应解析／改写 ID／重新序列化
  → OutboundSender：按已序列化字节申请输出额度
  → 单 writer：写完整 JSON 行、LF、flush
  → 本地连接 socket
  → daemon connect 连接程序：8KiB buffer 读写并 flush
  → stdout pipe
  → Electron Main ChildProcessJsonlTransport(stdoutMode: 'bytes')
  → Main relay：复制为 Uint8Array、MessagePort 发送
  → Renderer MessagePortSocket：再次复制、同步 fire(onData)
  → AppServerSocketTransport：扫描 LF、拥有片段、反复合并
  → 收齐一行：完整 concat、UTF-8 decode
  → AppServerProtocolClient：重新 UTF-8 encode 计长度
  → JSON.parse、envelope 检查、对应方法的 schema 校验
  → response resolve / notification 同步分发
  → 领域 adapter、Chat Service、Widget model
  → UI 更新和绘制
```

前端真实装配入口是 [LocalAgentHostServiceClient](../src/ash/platform/agentHost/electron-browser/localAgentHostService.ts)：它将 MessagePort socket 注册为 Managed 连接，再让通用 SocketTransport 和 ProtocolClient 使用该连接。不要因为 SocketTransport 同时支持远端 WebSocket，就把 Desktop 本地路径当作 WebSocket。

### 1.1 Rust 与连接程序

- [server.rs](../crates/app-server/src/server.rs) 的 `result<T>` 将 typed 结果转为 `serde_json::Value`，`serialize_response` 再生成完整字符串。这些分配发生在后端，不直接占用 Renderer，但会增加后端 CPU、内存和首字节等待。
- [gateway/local.rs](../crates/app-server/src/managed/gateway/local.rs) 把本地目录请求的响应送入 gateway 输出。`tag_resource_response` 只有在文本包含 `"resourceId"` 时才解析，并只对特定资源契约改写后重新序列化，不能写成所有响应都被 gateway 再解析一遍。
- [输出队列](../crates/app-server/src/server/message_queue.rs) 有每连接 320MiB 的 wire-byte 额度，覆盖队列和正在写出的 frame；gateway 输出 channel 容量为 256。额度会阻塞生产者，并非无界输出队列。
- [JsonlWriter](../crates/app-server-transport/src/lib.rs) 单次写完整消息、LF 并 flush。同连接的消息不能在一条 JSON 行内部交错。
- [daemon client](../crates/app-server-daemon/src/client.rs) 的 `relay_stdio` 使用共享 transport 的 `relay_output`；后者以 8192 字节 buffer 读 socket，写 stdout 并 flush。它不等待完整行，也不解析业务 JSON。8KiB 读写不代表 Node 每次必定收到 8KiB，OS pipe 和 stream 可以合并或拆分。

320MiB 阈值有兼容性理由：transport 注释说明编辑器原始文件上限为 50MiB，JSON 转义最坏可能扩张六倍。不能把该阈值直接降到几 MiB 来替代性能优化。

### 1.2 Main 转发与 Renderer 消费

[Main relay](../src/ash/platform/agentHost/electron-main/appServerConnectionRelay.ts) 选择 bytes 模式，因此 [ChildProcessJsonlTransport](../src/ash/platform/agentHost/node/childProcessJsonlTransport.ts) 不在 Main 做行拼装、解码或 JSON.parse。Main 的主要数据成本是 `new Uint8Array(chunk)` 和 MessagePort 序列化／发送。

[Renderer MessagePortSocket](../src/ash/platform/agentHost/electron-browser/appServerMessagePortTransport.ts) 又执行 `new Uint8Array(value.data)`，然后通过同步 Emitter 进入 [SocketTransport](../src/ash/platform/agentHost/browser/appServerSocketTransport.ts)。后者在 Renderer 进行 framing 和 UTF-8 解码；[ProtocolClient](../src/ash/platform/agentHost/browser/appServerProtocolClient.ts) 执行 JSON.parse、协议检查和方法结果解码。

普通响应的 Promise resolve 不会等待消费者的 `await` 后续代码。通知 listener 则在当前处理路径同步调用。两者都可能在下一次绘制前继续产生大量工作，但对应的 ACK 时点不同，见第 4 节。

## 2. 已确认的解析与复制问题

### 2.1 Framing 反复复制同一批字节

`AppServerSocketTransport.append` 的当前逻辑：

```ts
let owned = VSBuffer.wrap(data.buffer.slice());
while (this.parts.length && this.parts[this.parts.length - 1].byteLength < owned.byteLength * 2) {
    owned = VSBuffer.concat([this.parts.pop()!, owned]);
}
this.parts.push(owned);
```

每片先复制一次以取得所有权；合并又分配并复制已有片段。该做法避免无限增长的片段数组及每次复制整个前缀的简单平方级实现，但累计复制量依然随片段层级增长。换成小输入块并没有让这项成本变成固定的一次复制。

收到 LF 后还无条件执行 `VSBuffer.concat(this.parts, this.bufferedBytes)`。`VSBuffer.concat` 即使只收到一个 part，也会分配并复制；随后才解码完整帧。

按源码提取的实际 `acceptData`／`append` 方法进行实验，64MiB 合成行按 64KiB 块输入，framing 累计复制约 **12 倍 payload，即 768MiB**；按 8KiB 输入时约 **15 倍，即 960MiB**。这些数包含 append 的拥有副本、合并和最后 flatten，不包含 Main、IPC、Renderer 最初拥有副本、UTF-8 编码和对象解析。

这是累计内存写入量，不是同时保留 960MiB，也不是 RSS 测量。它仍会消耗内存带宽、分配和 GC，且某些合并步骤在单次 onData 中同步执行。

### 2.2 两处显式拥有副本，加上 IPC clone

可以从源码直接数出的副本有：

| 位置             | 工作                         | 判断                                                                    |
| ---------------- | ---------------------------- | ----------------------------------------------------------------------- |
| Main             | `new Uint8Array(chunk)`      | 显式复制；保证精确范围、独立 ownership，不能不核对就删除                |
| MessagePort      | `postMessage({ data })`      | 未使用 ArrayBuffer transfer；有跨进程序列化／复制成本，具体内部次数未测 |
| Renderer 入口    | `new Uint8Array(value.data)` | 显式复制收到的 typed array；优先核对能否直接 wrap                       |
| Renderer framing | slice、合并、flatten         | 第 2.1 节的累计放大                                                     |
| 帧校验           | `VSBuffer.fromString(frame)` | 第 2.3 节的完整重新编码副本                                             |

普通浏览器 MessagePort 的 ArrayBuffer transfer 用法不能直接套到 Electron Main：当前 Electron `MessagePortMain.postMessage` 类型的 transfer 参数接受 `MessagePortMain[]`。因此不能把 `postMessage(data, [data.buffer])` 当作已经验证可用的 Main 优化方案。

直接发送 Node Buffer 或更改 view 的 owner 还要考虑 pooled backing buffer、byteOffset、后续复用以及其他 socket 实现。先消除已确认多余的 Renderer 副本和 framing 复制，比未经验证地宣称全链路零复制更可控。

### 2.3 解码后重新编码，仅为计算长度

SocketTransport 已经以 `bufferedBytes` 校验完整帧字节数，并解码成 string；ProtocolClient 的 `validateFramePayload` 又执行：

```ts
const byteLength = VSBuffer.fromString(payload.frame).byteLength;
```

`VSBuffer.fromString` 使用 `TextEncoder.encode`，会再次分配完整 UTF-8 数组。该数组仅用于长度，没有传给 parser。大输入需要多付一次 O(N) 编码和 N 字节级分配。

优化应调整同进程 transport contract：由拥有 framing 的边界传递已经验证过的 byteLength，并统一其他 transport 的归一化。不能只删除限制，也不能信任任意未验证 peer 提供的长度。

### 2.4 一条响应的解码、解析和 schema 校验没有让出点

LF 所在的 onData 回调会连续执行完整 concat、UTF-8 decode、重新编码计长、JSON.parse、envelope 检查和递归结果校验。没有队列时间预算，也没有 Worker。

生成的 decoder 已经按 method 查对应结果 schema，并缓存 ref、属性列表、tagged union 和数字数组校验计划。这些优化确实存在；不能误报成每条响应遍历所有方法。它仍对当前结果递归验证，普通对象、数组和 union 的成本随实际内容增长。再次 decode envelope 只重复浅层协议检查，不是又一次完整 JSON.parse。

50,000 条 `toolOutput` entry、约 51.2MiB、能通过当前 decoder 的合成响应，在本次独立 Node 实验中，重新编码、JSON.parse、schema 校验各自 5 次中位数约 **17.52ms、60.97ms、75.10ms**。它们分别测量，不能把中位数直接相加说成某次已测 UI 停顿；但已经复现多个不可抢占阶段可能明显超过一帧。

同一个输入块包含多条小消息时，`acceptData` 也会连续派发到末尾，没有每轮耗时／条数限制。只在消息间增加 scheduler 有助于突发小消息，不能打断一次大 JSON.parse 或一次深校验。`await Promise.resolve()` 只让出到 microtask，不能保证让浏览器绘制。

生成器源是 [typescript_decoder.template.ts](../crates/app-server-protocol/src/typescript_decoder.template.ts)。任何 decoder 优化都应改生成源并保持协议拒绝语义，而不是手改 `.build` 或用类型断言跳过校验。

### 2.5 WebSocket 分支还人为复制一次完整消息

同一 SocketTransport 对 WebSocket 输入先执行 `VSBuffer.concat([data, LF])`，再交给 JSONL 扫描器。WebSocket 已有消息边界，这会额外分配并复制整条消息，又经历 append 和最后 concat。可以让经过大小检查的 WebSocket message 直接进入完整帧解码，保留严格 UTF-8 与协议校验，不必先补 LF 再寻找 LF。

本地 MessagePort 的四块 ACK 窗口不适用于浏览器 WebSocket；后端 WebSocket writer 有自己的队列，但本次没有测浏览器网络层到 JS 的积压或该分支的端到端背压。上述 framing 实验只模拟字节输入，不包含这次人为补 LF 的额外复制。

## 3. 上游输入量与业务派发问题

### 3.1 已有有界历史，聊天调用没有使用

后端 `session/thread/read` 和 `session/thread/subscribe` 支持 `history: latest / before + turnLimit`。`read_session_thread_history` 在 history 缺省时调用完整 snapshot；有值时走有界 history window。

但当前 [ChatService](../src/ash/workbench/services/chat/browser/chatService.ts) 的 `readThread` 只传 sessionId／threadId，`subscribeThread` 只增加 afterSequence；[前端线程领域接口](../src/ash/platform/agentHost/common/agentService.ts)也没有把 history 接入这两个方法。于是后端能力存在，主要聊天路径仍取得完整历史。不能把“协议支持分页”写成“聊天已分页”。

这会放大后端序列化、socket 传输、framing、解析、校验、adapter 和模型更新的全部成本。按 turnLimit 限制仍不等于按字节限制：一个 turn 本身也可能包含非常大的 tool result。

### 3.2 同一响应携带 thread 和 transcript 的内容

[后端读取处理器](../crates/app-server/src/server/request_processors/agent.rs)同时返回 thread 与 transcript。[ThreadTranscriptSnapshot::from_thread](../crates/thread-transcript/src/model.rs) 遍历 turn.items，并 clone 成 transcript item entries；运行中的 accumulator snapshot 也保留相应 item 内容。

因此普通 item 文本和结构可同时出现在 `thread.turns[].items` 与 `transcript.entries[].item` 中，JSON 序列化不会保留这两处的对象引用关系。不能笼统宣称每个 payload 都恰好翻倍：过滤、额外 transcript 数据和元数据会改变比例。

Renderer 的 adapter 随后分别转换 thread 和 transcript，ChatWidgetModel 接收 snapshot 时又复制 transcript entry 容器。这些不是 Main 的工作。字符串赋值一般是引用复用，也不能把所有 JS 对象展开都描述为复制了一遍字符串字节。

应先测量实际重复的 wire 字节和 retained heap，再设计 thread 摘要与 transcript 内容之间的引用／版本契约。不要让客户端自行建立另一套权威历史。

### 3.3 过期请求仍先支付解析与转换成本

ChatWidgetModel 的 refresh 在 await 后使用 generation、request 和 revision 判断是否接收结果；但响应在返回到这里之前，已经完成 JSON.parse、decoder 校验及领域转换。ProtocolClient 的普通 request 接口没有逐请求 AbortSignal；请求超时还会 fail 整条连接。

快速切换、重连或重复 refresh 下，丢弃显示结果不等于停止传输和 CPU。优化需要请求生命周期、取消语义和合法晚到响应的处理一起设计；不能简单删除 pending entry，否则当前未知响应 ID 会触发协议失败。

## 4. 背压已经有效，但保护范围有限

### 已接入的消费者刷新约束

文件模型的焦点刷新共享同一在途读取；文件事件使旧读取失效，并在事件突发后串行补读当前内容。编辑或关闭最后一个视图会取消相应信号，晚到内容在创建文本缓冲前丢弃。保存队列继续拥有写入及已确认修订；只读刷新不会重放写入，也不会因旧刷新等待而跨过新排队的保存。`browserTextModelService.test.ts` 48 项通过，其中回归直接断言读取次数、旧信号退休、最新修订及写入恰好一次，日志 `.build/todo-refresh/unit.log`。

Chat 的 Changes 摘要按当前模型代次共享在途读取。durable sequence 推进时串行补读最新摘要，迟到的旧代次或已关闭模型不能发布结果；提交和执行接口不参与合并。`chatViewPane.test.ts` 158 项通过，其中新增两个场景覆盖三次并发调用合并、读取期间历史推进与关闭后的迟到结果，日志 `.build/todo-chat-refresh/` 和 `.build/todo-general-document/all-unit-final.log`。

Code／Cowork 的 Thread／transcript 刷新也按模型 generation 共享在途读取。跨多个调度轮次到达的 committed 通知和 transcript revision 缺口只标记一次补读；当前 RPC 成功或失败退休后，再串行取得最新快照。写入后的刷新加入同一补读并等待结束，写请求及其结果不合并或重放。旧刷新失败不覆盖后续刷新，最后一次失败仍显示现有重试入口。A-B-A 切换、重新订阅和 dispose 阻止旧代次继续补读，旧代次清理不能清掉当前读取。

已知落后于 durable sequence 的 bounded 快照保留现有尾部和 transcript；刷新响应本身不再无限触发下一轮读取。没有新的通知或写入时，仍落后的快照进入可显式重试的错误状态。订阅发现落后仍会发起首次恢复，正常通知继续驱动补读。

本轮 `ChatWidgetModel` 的 81 项与 `ChatViewPane` 的 158 项单测通过，覆盖跨调度轮次的 150 次 Thread／transcript 通知、写入恰好一次、最终错误与显式重试、旧代次成功／失败、排队微任务跨选择和关闭后的迟到结果。日志 `.build/todo-selected-unit.log` 与补齐微任务代次回归后的 `.build/todo-refresh-final-unit.log`；Renderer 类型检查和 prepared Desktop Host／Renderer 构建通过。

这些结果证明消费者请求数量及生命周期约束，不是整条 Desktop 的性能测量，也没有给未支持取消的文件 provider 或 RPC 增加物理中止保证。通用传输取消和大内容按需读取仍待推进；已有帧的解析成本不能据此宣称消失。

### 4.1 当前链路怎样反压上游

```text
Main 最多维持少量未 ACK 的块
  → sent.length >= 4 时 pause stdout
  → pipe 逐渐写满，连接程序写 stdout 等待
  → 连接程序减少读取 socket
  → server socket writer 等待
  → 输出队列 byte budget 用尽后生产者等待
```

OS 与 stream 中已有缓存会延迟这个传播，因此不能说暂停时所有上游立即停止。Main 还设有 128 条／320MiB 的安全容量；平时在 4 条处 pause，不意味着常态会排满 128 条。

Renderer 在 `dataEmitter.fire` 返回后才发送 ACK。当前 Emitter 和 SocketTransport listener 同步调用，所以对于包含 LF 的块，ACK 通常要等 UTF-8 decode、JSON.parse、schema 校验以及同步通知 listener 完成。说“ACK 在解析之前发送”不符合这条路径。

普通 response 的领域 adapter 和调用方 Promise continuation 会在当前 stack 之后执行，ACK 不等待这些异步后续步骤，也不等待绘制。后续改为异步消费时，如果仍在入队后立即 ACK，就会削弱现有背压；必须把消费额度和所有权放到真正保留数据的 owner。

### 4.2 ACK 不限制半条大响应和总内存

没有 LF 的块只被收集、ACK，Main 的 in-flight 额度随之释放，而 Renderer 仍累积这一行。partial frame 可增长到 320MiB。达到 LF 后还会叠加合并 buffer、解码字符串、重新编码数组、JSON 对象，以及模型副本。

这是“有单帧上限，但 wire bytes 不是 RSS 上限”，并非无限缓存。Worker、另一窗口、另一连接或后台输出队列还有各自保留对象，不能把其中任一处的 320MiB 当成全进程／整个应用的总限制。

### 4.3 大 JSON 行导致同连接输出队头阻塞

Rust writer 单次写完整 frame；字节流、framing 与后端输出队列都不能在大行中途交错另一条消息。控制请求的独立执行容量有助于接纳和执行，但其返回／通知如果走同一输出连接，仍可能排在大响应后。

缩小 MessagePort 数据块只能让传输调度更细，无法让控制消息穿过已经开始输出的大 JSON 行。应优先减小业务 frame；确需进一步隔离时，再设计有界资源读取或明确的控制通道，并保持顺序、取消、重连和资源授权契约。

### 4.4 后端输出预算不涵盖构造前后的全部对象

`OutboundSender.send` 在收到已构造的 `OutgoingMessage.raw: String` 后才申请 wire-byte budget。等待 budget 的生产者已经持有其响应字符串；构造过程中的 typed 结果与 Value 也不在该计数里。请求执行容量限制同时工作的数量，不能因此把它称为无界并发；但输出队列的额度仍不证明整体内存受相同限制。

通知队列也已有长度／字节保护和 transient pruning，不应误报成完全无界。可以进一步检查大结果构造的准入、响应存活时间与各 owner 的额度，避免背压把积压从 writer 移到生产者堆上。

## 5. 初始优化排序（历史快照）

这里的 P1／P2 表示本次性能工作的先后，不代表已测得生产事故严重度。首批建议做确定性收益且不改变业务语义的优化，并同步补阶段测量。

本表是最初审计时的排序，不能当作当前待办：步骤 1、2 后由第 7 节完成，步骤 3 由第 8 节完成，大帧 Worker／顺序队列及 ACK 由第 9 节完成。阶段测量与后续候选按各节实际覆盖范围判断，剩余动作统一在根 TODO。

| 顺序 | 优先级 | 方案与 owner                                                                                                              | 主要收益                                        | 验证与边界                                                                                                   |
| ---- | ------ | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1    | P1     | Renderer framing 改为固定大小页／slab 收集，最后只合并一次；单 part 使用可证明安全的 fast path；LF 扫描评估 indexOf       | 消除 12～15 倍复制放大，保留有界 ownership      | tiny packet、跨 UTF-8、跨 LF、多行、CRLF 拒绝、超限、断连；同时限制页数量／字节                              |
| 2    | P1     | 去掉不必要的 Renderer 入口副本；由 framing owner 提供已验证 byteLength，移除完整重新编码                                  | 少两次 payload 级分配／遍历，降低峰值与 GC 压力 | 明确 socket buffer 是否可被复用；其他 transport 仍有边界检查；Main ownership 副本单独审查                    |
| 3    | P1     | Chat 领域契约接入已有 bounded history，首屏 latest、向前加载 before，refresh／subscribe 保留 sequence 和 history boundary | 从源头减少所有阶段工作                          | 单 turn 大结果另作 byte budget；审批／pending interaction、回放、瞬态 transcript、窗口恢复不可丢失           |
| 4    | P1     | 记录 receive／assemble／decode／length-check／parse／schema／adapter／apply／paint 阶段，队列加入 bytes 与 elapsed time   | 解释长任务，限制多小帧连续处理                  | 真实 task yield；ACK 跟随已消费额度；一次 JSON.parse 仍不可抢占；时钟跨进程需明确对应                        |
| 5    | P2     | 在输入减量后评估 Worker 承担 framing／parse／schema；同时优化 decoder 生成计划                                            | 隔离剩余的 Renderer CPU 重活                    | Worker 回传完整对象也会 clone；优先返回有界的已验证领域结果；保留 unknown-field／union／取消语义；修改生成源 |
| 6    | P2     | 去除 wire 中重复 item 内容，thread 提供状态摘要，transcript 通过稳定 ID／revision 关联；模型保留可安全复用的不可变值      | 降低后端及前端结构、序列化和 retained heap      | 先测重复比例；保持领域 owner，不能直接把 transport DTO 长期当业务模型或复制权威状态                          |
| 7    | P2     | 端到端请求取消、合并过期只读 refresh，处理晚到响应；大内容使用既有资源能力或按需读取                                      | 避免已无消费者的数据继续消耗链路                | 修改请求与 pending 生命周期；已发 JSON 帧不可凭空跳过；状态变更请求不能自动重放／合并                        |
| 8    | P2     | 后端结果构造纳入资源准入，测 writer／生产者等待；必要时调整有界数据与控制输出契约                                         | 降低背压时的堆积及同连接队头阻塞                | 控制执行额度不是输出抢占；不能降低文件兼容上限替代正确设计；多连接共享资源须核对                             |

步骤 1 的隔离候选采用固定 64KiB 页，仍使用原 acceptData；对相同 64MiB 输入，framing 累计复制下降到 **2 倍 payload（约 128MiB）**，最后 concat 一次。实验验证了该合成输入的输出文本完全相同。它没有替换产品代码，也未覆盖所有边界，因此是方案证据，不是可直接提交的实现。

Worker 不宜作为第一步自动选择：仅把完整解析对象从 Worker clone 回 Renderer，仍可能留下大量复制及业务归一化长任务。反之，只消除复制也无法让完整 JSON.parse 可抢占；两类问题需要分别解决。

后续用户将 parse／schema Worker 明确提前为第三批 P1，实施与实测见第 9 节；本表保留审计时的原始排序。

## 6. 测量、验证与限制

### 6.1 本次实际执行

- 静态核对 Rust 结果构造、gateway、输出队列、writer、daemon relay、Main bytes 转发、Renderer framing／protocol／Chat 消费者。
- 从当前 TS AST 提取 `acceptData` 与 `append` 的方法正文，以等价 Uint8Array VSBuffer adapter 统计 concat 复制量，并补计 append 的 slice 副本。不是另写一个猜测的 framing 算法。
- 对 4／16／64MiB 合成 JSON 行，分别以 8KiB／64KiB packet、各 5 次运行；统计总 CPU 工作的墙钟、单个 acceptData 最大耗时与累计复制量。
- 直接加载当前生成的 decoder 与 schema，对 1,000／10,000／50,000 条 toolOutput entry 的 schema 合法合成消息，分开测重新编码、JSON.parse 和结果校验，各取 5 次中位数。
- 用固定页候选对 64MiB 输入作 5 次对照，并检查完整输出字符串一致。

这不是实际 Thread 数据或 Electron IPC 测量，也没有测 Renderer FPS、真实输入延迟、峰值 RSS、Rust 序列化时间或控制消息等待。合成消息能通过 decoder，不代表它来自真实会话。原始数据见 [probe-results.json](research/ash-app-server-data-path-2026-10-17/probe-results.json)。

实验使用 Node `v24.21.0`／V8 `13.6.233.17-node.53`，与仓库 `.nvmrc` 一致。当前环境有并发开发工作，墙钟时间波动明显；优先级主要依据可确定的复制量、完整同步调用和未使用的有界历史路径。不能把隔离候选的墙钟差值当作已证明的 Ash 端到端加速比例。

### 6.2 原始审计实验与当前复跑入口

本节原始 `probe.cjs` 依赖 manifest 记录的优化前方法和生成协议，保留用于复核历史实验。当前代码的前后对比使用第 7 节的冻结基线与新探针，在仓库根目录运行：

```sh
node --expose-gc docs/research/ash-app-server-data-path-2026-10-17/p1/compare.cjs
```

新探针直接提取当前 transport、VSBuffer 和长度检查方法，不需要启动后端或读取生成 schema。复跑结果写入 ignored `.build/investigations/app-server-p1-2026-10-17/`，不会覆盖文档目录中的证据快照。后续方法或依赖变化时，应先核对提取范围和结果完整性，再解释性能数据。

### 6.3 产品改动的验收方向

1. 先用真实 Desktop 场景量出 Browser 与 Renderer 的事件循环延迟、首屏可见和完整应用时间，记录相同硬件、构建、后端与缓存条件。
2. 传输改变验证分片 UTF-8、tiny packets、多行、超限、异常关闭、ACK 延迟和取消；协议改变检查 schema 与晚到响应；历史窗口改变检查当前交互、replay、翻页和 revision 一致性。
3. 同时记录复制量、队列字节、heap／RSS 与 GC；避免以降低吞吐换取看似更少的长任务，或只把内存转移到 Worker／生产者。
4. 对控制消息单独测大响应传输期间的可发送、后端执行与返回可见时间，区分执行隔离和输出队头阻塞。

原始审计之后已实施步骤 1、2，详见下一节；建议后续接入 bounded history，并依据剩余长任务决定 Worker 或传输协议调整范围。

## 7. 第一批 P1：实现、回归测试与前后对比

### 7.1 当前实现

- [SocketTransport](../src/ash/platform/agentHost/browser/appServerSocketTransport.ts) 用 64KiB 固定页拥有跨回调保留的半帧。每个输入字节只复制进页一次，收齐后最多合并一次；单页直接解码 view。页数继续受原有 320MiB 单帧限制约束。
- LF 扫描使用 Uint8Array 的 `indexOf`。完整帧若已位于当前输入块内，直接同步解码，不先保存或复制。WebSocket 使用既有消息边界，不再补 LF 后重新扫描／收集。
- [MessagePortSocket](../src/ash/platform/agentHost/electron-browser/appServerMessagePortTransport.ts) 对普通 ArrayBuffer 建立保留准确 offset／length 的 view，复用本次接收的底层存储；SharedArrayBuffer 继续复制后交给消费者，防止 peer 同时修改解码输入。ACK 仍在同步 onData 消费结束后发送。
- [AppServerFrame](../src/ash/platform/agentHost/common/appServerTransport.ts) 是同进程的已校验帧：只有传输边界确认内容及 wire 字节数后才构造。SocketTransport 使用收集到的真实字节数；浏览器 WebSocket transport 复用其已有接收长度检查结果。
- [ProtocolClient](../src/ash/platform/agentHost/browser/appServerProtocolClient.ts) 对该帧直接复用 byteLength，不再 UTF-8 重编码。普通未归一化对象仍在原入口校验并计算长度，任意对象附加同名 byteLength 字段不会得到信任。JSON 语法、envelope 和结果 schema 检查继续执行。

UTF-8 本身继续由运行时提供的 TextEncoder／TextDecoder 执行，VSBuffer 是现有薄封装。这属于传输层基础工具；没有新增 Rust 服务或进程，也没有将编解码变成业务 API。本次消除的是不必要的再次编码。

### 7.2 同一基准的优化前后对比

在同一 Node 进程中运行冻结的旧方法与当前方法，使用实际 VSBuffer 类和相同输入；先各 warmup，一共 5 轮，每轮交替运行顺序，GC 位于计时区间之外。复制计数单独运行，不把计数 hook 混入性能样本。每次核对完整输出文本和剩余缓存。

环境为 Apple M5、macOS ARM64、Node v24.21.0、V8 13.6.233.17-node.53。下表为累计接收回调墙钟的 5 次中位数，包含 framing 与 UTF-8 decode；不包含 IPC、JSON.parse、schema 或 UI 绘制。

| 约 64MiB 响应输入块 | 优化前    | 优化后   | 累计复制量前 → 后                |
| ------------------- | --------- | -------- | -------------------------------- |
| 8KiB                | 122.156ms | 23.856ms | 15 倍 → 2 倍，约 960MiB → 128MiB |
| 64KiB               | 95.551ms  | 22.659ms | 12 倍 → 2 倍，约 768MiB → 128MiB |

4MiB 完整帧在单次输入时，累计复制从 2 倍降为 0；同样大小的分片多语言帧从 11 倍降到 2 倍。64MiB 已校验帧的独立长度检查从约 9.675ms 编码降为元数据读取，避免一个约 64MiB 的临时 UTF-8 数组。

这些是核心方法的隔离收益，不是端到端 UI 加速倍数。64MiB 样本的最大单次接收回调中位数仍约 5.3ms，未因总工作减少而同步下降；最终合并与解码仍需连续执行，JSON.parse 和 schema 的同步成本也未在本批解决。并发开发活动和 GC 会影响墙钟，原始样本与 CPU 时间全部保留。

证据：[比较脚本](research/ash-app-server-data-path-2026-10-17/p1/compare.cjs)、[冻结的旧方法](research/ash-app-server-data-path-2026-10-17/p1/baseline-source.json)、[原始结果](research/ash-app-server-data-path-2026-10-17/p1/comparison-results.json)、[来源与验证记录](research/ash-app-server-data-path-2026-10-17/p1/manifest.json)。

### 7.3 验证

53 个定向单测通过，覆盖 socket framing、协议客户端和 MessagePort 的真实入口。新增回归覆盖：

- 1／7／8192／65536 字节输入块、跨页的中文和 emoji、上游输入数组复用。
- 固定页分配上界、一次最终合并、完整帧与 WebSocket 的无片段复制路径。
- 超限、空帧、无效 UTF-8、CRLF、未结束帧及 listener 中断连时停止批内派发。
- 已校验帧不再编码、普通对象不能伪造受信长度、结果 schema 校验仍生效。
- 普通／共享 backing storage、非零 byteOffset、接收消费后 ACK、关闭与写入背压。

执行命令：

```sh
pnpm test:unit:prepared --run src/ash/platform/agentHost/test/browser/appServerSocketTransport.test.ts --run src/ash/platform/agentHost/test/browser/appServerProtocolClient.test.ts --run src/ash/platform/agentHost/test/electron-browser/appServerMessagePortTransport.test.ts
./node_modules/bun/bin/bun.exe check -p tsconfig.renderer.json --all
```

单测的正式准备步骤已运行；最终 prepared 运行编译当前源码并执行上述 53 个测试。Renderer 类型检查覆盖 4,163 个文件通过，修改文件的 TypeScript formatter 和文档检查也通过。本批没有改变后端线上协议或生成 DTO，未进行真实 Desktop 交互延迟／RSS 对比。

## 8. 第二批 P1：Code Chat 使用有界历史

### 8.1 调用链与职责

`ChatWidgetModel → IChatService → IAgentThreadService → App Server adapter → Renderer protocol client`
继续沿既有单一链路调用 `session/thread/read`／`subscribe`。领域接口增加前端拥有的
`ThreadSnapshotHistory` 和 `ThreadHistoryBoundary`；adapter 机械映射已经生成的正式协议字段，
并保留响应的游标元数据。Rust 协议、Core、Main relay、进程与 connection 拓扑均无修改。

Code Chat 首次订阅和普通刷新都请求 `{type: "latest", turnLimit: 20}`。
“加载更早的消息”使用 `{type: "before", turnId: oldestTurnId, turnLimit: 20}`，
取回完整 Turn 和条目，保留用户显式加载过的前缀；刷新只替换窗口覆盖的尾部。
同一翻页请求合并重复点击，失败保留游标与内容，允许重试，发送不因旧页失败而被阻断。
翻页只复制新接收的条目，不重复复制已经拥有的所有旧页。继续使用现有 ChatListWidget 的
稳定行身份与阅读锚点；无需增加第二个历史 service、缓存或滚动 owner。

未指定 history 的其他消费者保持完整历史行为，包括 Cowork 与现有完整读取操作。
这批范围是常规 Code Chat，不代表所有 App Server 消费者已经使用窗口。

### 8.2 翻页、回放与审批不丢失的边界

- **旧页与实时状态分离。** `before` 页不覆盖 Thread 的实时执行状态、durable sequence 或 transcript revision。
  旧页通常 revision 为 0；条目按稳定 ID 合并，重复语音只保留一份，语音锚点随其旧消息保留。
- **刷新保留已加载前缀。** 新窗口与已加载 Turn 的重叠点决定替换范围。终态与瞬态仍以最新尾部快照和
  transcript notifications 为准，不能把“窗口外”解释成“已删除”。
- **重连补齐中间窗口。** 重连传入已知 durable sequence；后端有界订阅以快照 sequence 接续回放，
  跳过已经由快照表示的历史事件。若新尾部与现有页面之间没有重叠，客户端按 `before` 连续取有界页，
  找到重叠点后一次组装，避免静默漏掉中间 Turn。每次跨 await 都检查当前代次；A-B-A 导航和释放会使旧结果失效。
- **旧快照不能抹掉新尾部。** durable sequence 已落后的有界快照即使带来更高流式 revision，也不能
  替换当前 transcript；客户端继续读取最新窗口。流式 revision 与历史页游标不是同一个时钟。
- **审批以 offer 为准。** Chat Service 不因有界快照缺少旧 Turn 就撤销现有 offer。
  Widget 从当前 connection 的 offer 显示交互，提交 offer 中的 Turn ID／request ID 和当前 Thread sequence。
  解决、取消、Turn 终态、期限与 connection 生命周期继续按既有 owner 规则回收权限。
  历史分页本身不授予审批权限，也不能由页面内容恢复完整交互请求。
- **键盘与无障碍。** 英文和中文的加载、失败重试、忙碌状态与帮助文字已补齐。
  最后一页加载完成后焦点回到 transcript，保留阅读位置与草稿；翻页不发送任何消息。

### 8.3 同一受控 Chromium 场景的前后对比

使用现有 `chatTranscript.integration` 入口，生成 1,000 Turn、每 Turn 一个约 1KiB ASCII 文本回复。
两种请求消费同一历史：旧方式省略 history，接入后请求最近 20 Turn。预先生成对应响应字符串，
计时包含实际 `JSON.parse`、生成 decoder 的 envelope／schema 校验、生产 App Server domain adapter、
`chatTranscriptListItems` 与 `ChatListWidget`；分别 warmup，再进行 5 轮交替顺序采样。
每轮断言完整／有界条目数为 1,000／20，且最后一条回复完全一致。GC 在计时区间外。

环境：本机 macOS ARM64、Apple M5，Playwright Chromium **149.0.7827.55**。下表为 5 次中位数：

| 阶段／指标                       | read 优化前 → 后   | subscribe 优化前 → 后 |
| -------------------------------- | ------------------ | --------------------- |
| 响应字节                         | 2,773,757 → 56,276 | 2,773,770 → 56,289    |
| JSON.parse                       | 1.7ms → 0.1ms      | 1.8ms → 低于计时精度  |
| 生成 schema 校验                 | 36.1ms → 1.2ms     | 31.8ms → 0.8ms        |
| 解析、校验与 domain 映射合计     | 38.0ms → 1.2ms     | 33.7ms → 0.9ms        |
| 列表组装与 render 调用           | 436.6ms → 9.1ms    | 420.7ms → 8.8ms       |
| 请求处理起点至 render 后两次 rAF | 485.5ms → 14.5ms   | 466.9ms → 15.2ms      |

该输入的响应大小约减少 **98%**。这是减少传入数据量的组件收益，**不是真实 Desktop 的端到端
加速比、内存占用或后台存储查询时间**。响应由受控 fixture 提供，两种订阅的 durable replay 都为空；
没有把省去的全历史重复 replay 算入收益。模型合并、后端 IO、IPC 与真实 provider 延迟未纳入本表。
两次 rAF 表示浏览器绘制机会，不是逐像素的屏幕呈现时间。CDP TaskDuration 样本也保留，但它包含
计时区间外的列表清理与浏览器活动，不与表内阶段时长直接等同。

原始样本保留在本机 `.build/investigations/chat-history-p1-2026-10-17/comparison-results.json`，
首次性能 fixture 失败及重跑日志、成功 HTML report、类型检查配置、旧源码和单测日志保存在同目录及
`.build/desktop/playwright/`。性能 fixture 初次遗漏 decoder 所需的 `jsonrpc` 字段，已修正；失败未计入样本。
重现入口：

```sh
pnpm test:browser:integration chatTranscript.integration.spec.ts --project=chromium --grep 'Chat bounded history'
```

### 8.4 验证与剩余成本

定向单测覆盖 adapter 参数与元数据映射、逐页完整遍历、旧页与流式更新并发、回放、重连跨多页缺口、
失败重试、A-B-A／释放、语音去重和旧消息锚点，以及窗口外的审批显示、提交与撤销。
真实 Chromium 覆盖英文／中文、深色／浅色／高对比度下的键盘翻页、帮助、失败重试、草稿和阅读锚点。
后端复用已有定向测试验证窗口内瞬态输出与 durable replay，不增加第二套后端历史实现。

实际结果：171 项前端定向单测通过；最后一次模型复制调整后，相关 13 项复测通过。
Chromium 6 个交互场景及 1 个性能比较场景通过。后端定向测试共 11 项通过（App Server 8 项、Core 3 项）。
Renderer 类型检查 4,166 文件、Chat integration 定向类型检查 2,727 文件通过；本批 17 个文件格式与
whitespace 检查通过。中文资源准备检查为 0 缺失条目。Rust 重编译产生既有 ts-rs
`deny_unknown_fields` 属性解析警告，本批未修改 Rust 代码或依赖。

验证入口：

```sh
pnpm test:unit:prepared --run src/ash/sessions/test/browser/chatViewPane.test.ts --run src/ash/platform/agentHost/test/browser/appServerAgentService.test.ts
./node_modules/bun/bin/bun.exe check -p tsconfig.renderer.json --all
just test ash-app-server --lib thread_read_and_subscribe_keep_transients_within_the_visible_running_history
just test ash-app-server --lib thread_subscription
just test ash-core --lib thread_history_
```

完整 Browser integration 类型检查仍被并发开发的 `terminal.integration.ts:385` 构造参数错误阻断；
采用相同编译选项、ambient typings 与 Chat 入口完成定向检查后，直接运行原有 `run.ts` runner。
这不代表当时整套 integration 类型检查通过。

第一批已本地提交为 `656ba0fed`，没有推送。提交门禁因 10 个不在提交范围内的文件格式问题失败，
本批文件的独立格式和 whitespace 检查通过后，按仓库规定完成本地提交；没有宣称全局门禁通过。
第二批已独立本地提交为 `c77786dee29e563dccff6bbcd138eb72db6fef01`，没有推送。
提交前的 `just commit-check origin/main` 因提交外 10 个 TS 文件和 `docs/desktop-architecture.md`
的格式问题失败；本批 17 文件的独立格式检查及 working-tree／staged whitespace 检查通过，
按提交工作流的范围外失败例外完成本地提交。

**仍存在的成本：** 20 Turn 是条数边界，单个巨大 Turn 仍可能产生大 JSON；本批没有 Worker 或时间片调度，
JSON.parse／schema／DOM 仍同步运行。用户主动加载的旧页继续保留，多年断线后的补齐也可能需要很多有界请求；
窗口不会把全部历史渲染内存限制为 20 Turn。已加载内容较大时，列表派生、数组／Map 合并与旧页保留成本
仍需进一步实测与治理，不能用本次初始加载收益替代背压和响应大小设计。

后端 `read_voice_transcripts` 仍按整个 Thread 的 sequence 读取语音，再按当前页可见 Item 锚点组装。
没有 Item 锚点的语音会进入多个页面，由前端按稳定 ID 去重；这类语音历史与 Thread 级元数据
也不受 20 Turn 条数限制。本次性能 fixture 没有语音，不能据此推断长语音会话的收益。

## 9. 第三批 P1：大帧解析与 schema 校验移入 Worker

### 9.1 职责与执行路径

`AppServerProtocolClient` 仍是每个 Renderer connection 的唯一协议 owner，持有 pending method、
初始化与兼容检查、请求 timeout、审批与取消、generation。Main 与 Rust 协议均未改动。

- 小于 **256 KiB wire bytes** 的帧同步解析；达到阈值时懒创建一个专属 Web Worker，后续复用。
  Desktop Renderer 与 Web 使用相同实现；没有全局 Worker 的 Node 测试／工具环境复用同步 decoder。
  浏览器 Worker 的创建、通信或解析失败会关闭连接，不静默回退为 UI 大帧解析。
- `appServerProtocolDecoding.ts` 在两条路径使用同一生成 decoder：JSON.parse、envelope、对应 method
  的 result schema，或 notification／server-request schema。没有调整生成 schema 或放宽非法输入检查。
- job 只携带接收时的 `firstRequestId` 与最多 128 个 pending `(id, method)` 路由快照。
  Worker 不持有业务请求表，也不执行 handler。快照防止提前到达、延后解码的响应冒充未来请求。
- 私有 Worker 通道复用 `WebWorkerClient/Server`，校验 channel、version、job ID、错误及取消消息。
  Worker 入口检查 job 字段、frame 字符长度与路由条数。返回侧检查 envelope 与当前 job 的路由配对；
  完整 payload 已由同应用 bundle 中、没有插件入口的固定 Worker 校验，不在 UI 再递归走一遍。
  这不是接受后端提供的“已验证”标记，不能把该结果入口接给不可信插件 Worker。
- 初始化的生成 schema 也只检查一次；Renderer 再检查 server identity、protocol major、schema hash、
  capabilities 和绝对 userHome。保留接收 unknown 的 `validateAppServerInitializeResult` 给独立 RPC 边界；
  已解码的同进程调用使用 `checkAppServerInitializeCompatibility`，避免第二次 schema 遍历。

源码入口：`src/ash/platform/agentHost/browser/appServerFrameDecoder.ts`、
`appServerProtocolDecoding.ts`、`appServerProtocolWorkerMain.ts`、`appServerProtocolClient.ts`，
以及 `src/ash/platform/agentHost/common/appServerProtocolCompatibility.ts`。
Worker 是 Renderer 协议客户端的实现细节，不是新的 app-server 或业务状态 owner。

### 9.2 顺序、容量、关闭与背压

大帧解码期间，同连接后到的小帧进入串行队列，response、notification、host request、取消不会越过前帧。
队列的活动帧与等待帧合计最多 **4096 帧／320 MiB wire bytes**；超限关闭连接并拒绝 pending，
不静默丢帧。连续消费等待帧达到约 4 ms 时使用 `setTimeout(0)` 让出一个真实任务，
而非只在 microtask 中循环。单个小帧的 schema、listener 或领域回调依然不可抢占。

每个异步 job 使用 request timeout 作为解码期限；没有 pending 请求的大 notification 也受保护。
显式 disconnect／dispose、解码错误和超时立即终止 Worker、清空队列并兑现全部 consumption Promise。
旧 drain 通过队列对象身份与 generation 检查，不能清理或派发新连接的工作。
收到 peer EOF／close 时先完成已收到的帧，再发布关闭；等待期间拒绝新请求。这样响应后紧跟 EOF
不会因为异步解析而丢掉最后一条响应。已知 EOF 时不再启动 host effects 或向失效 carrier 回复，
此前接收的响应与通知仍继续排空。初始化 host effects 仍在兼容检查通过之后才执行。

异步解析不能直接沿用“onData 返回就 ACK”：否则消息交给 Worker 后，Main 会立即恢复 stdout。
本批给 `AppServerFrame` 添加只在同进程使用的 consumption Promise，并以弱引用表把它关联到 socket
收到的 VSBuffer；`MessagePortSocket` 等消费完成才 ACK。后续没有 LF 的部分帧也继承当前未完成
consumption，Main 原有 **4 个未 ACK chunk 后暂停 stdout** 的规则因此继续有效。
第一条未完成大帧的前置分片仍立即 ACK，否则可能在收到完整 JSON 前耗尽 credit，形成死锁。
较早帧完成不会清除较新帧的消费标记；端口退休后不发送迟到 ACK。

该 ACK 只覆盖协议解码与分发完成，不代表所有 Promise 链中的领域转换、Chat 模型应用或 DOM 绘制完成。
浏览器 WebSocket 没有接收 pause API；接收队列提供硬上限和超限关闭，不能声称该路径已有网络反压。
wire bytes 上限不是 RSS／JS heap 上限，UTF-16 字符串、Worker 输入与输出、UI 对象图、部分帧 pages
及领域模型可能同时存在；没有把内存成本从统计中隐藏到 Worker。

### 9.3 真实 Chromium 前后对比

新增 `appServerDecode.integration.spec.ts` 与专用构建页面。两种方案经过相同生产
`AppServerProtocolClient`、真实生成 schema 与 response 分发；优化前方案注入同步 decoder，
等价复现 `c77786dee` 的 JSON.parse＋对应 schema 操作，优化后使用真正的 Web Worker。
旧协议／transport 源码备份保留在本机 investigation 的 `baseline/`。

每个场景先测两种方案首次使用，然后交替顺序测 **5 对 warm 样本**，每次通过 Renderer CDP 在相同点 GC。
read 结果的 thread 与 transcript 均包含相同内容，验证 Turn 数、最后文本与 ready 状态，
两次 rAF 后再停止心跳；断言仅大帧创建 Worker，小帧不创建。基础响应 JSON 预先生成，
逐帧字符串组装和 UTF-8 编码计长在阶段计时与心跳区间外，仍计入外层 CDP TaskDuration。
场景不经过真实后端、Main IPC、framing／UTF-8 decode、领域 adapter、Chat render 或完整 Desktop。

本机 macOS ARM64／Apple M5，Playwright Chromium **149.0.7827.55**。下表为 5 次中位数，时间均为 ms：

| 相同响应          | wire bytes | 同步派发耗时：前 → 后 | 最长计时器间隔：前 → 后 | 到已验证响应：前 → 后 | Renderer CDP TaskDuration：前 → 后 |
| ----------------- | ---------: | --------------------: | ----------------------: | --------------------: | ---------------------------------: |
| 1 Turn，小帧对照  |      9,492 |             0.2 → 0.3 |               4.6 → 4.5 |             0.2 → 0.3 |                          1.4 → 1.5 |
| 128 Turn，多对象  |  1,131,168 |             5.6 → 0.3 |               5.8 → 4.5 |             5.6 → 6.1 |                          7.4 → 2.9 |
| 2048 Turn，多对象 | 18,107,467 |            88.6 → 2.4 |              88.9 → 9.9 |          88.6 → 136.5 |                       103.9 → 27.8 |
| 1 Turn，巨大文本  | 16,778,516 |             3.1 → 2.3 |               4.2 → 4.6 |             3.1 → 9.5 |                        18.4 → 18.9 |

18.1 MB 多对象场景中，原来的约 **88 ms long task** 在 warm Worker 样本中未出现；解码等待期间
有约 15 次 rAF 回调机会。最长计时器间隔约降低 **89%**，主线程 TaskDuration 约降低 **73%**，
但响应总耗时增加约 **54%**。这是 UI 响应性与通信成本的取舍，不是总吞吐提升。
巨大文本场景主要是少量长字符串，JSON.parse 和 schema 原本仅约 3 ms，Worker 往返反而增加延迟，
没有证明所有超过阈值的帧都会加速。未来阈值或传输策略应结合实际 payload 形状继续测量。

计时器有约 4 ms 的浏览器调度底噪；rAF 是绘制机会，不是输入延迟或逐像素呈现。
PerformanceObserver long task 按与解码区间重叠的任务统计，可能包含该任务中的结果断言；
TaskDuration 也包含准备与验证的主线程工作，不等于表内派发耗时，更不包含 Worker CPU。
首次 Worker 使用包含 bundle 加载、初始化与 schema 缓存，原始样本单独保留；不能用 warm 数据代表冷启动。
没有采集 heap／RSS，不能据此宣称内存下降或完整 Desktop 加速。

样本与日志：`.build/investigations/app-server-decode-p1-2026-10-17/`，包括
`comparison-results.json`、`comparison-summary.json`、`verification.json`、源码备份、检查及失败修复日志。
重现入口：

```sh
pnpm test:browser:integration appServerDecode.integration.spec.ts --project=chromium
```

### 9.4 回归验证与剩余工作

定向单测覆盖 lazy threshold、Worker 复用／失败／reset、非法 JSON／schema／routing、结构化错误、
未知 host method、旧 response、异步审批取消与迟到结果、接收时路由快照、连接更换、bytes／count 溢出、
大初始化兼容检查、解码与请求超时、EOF 顺序、部分帧 ACK 及端口退休；复跑原有生成 decoder 边界测试。
真实 Chromium 构建并运行生产 Worker，同时验证响应内容和小帧不创建 Worker；额外将 2000 条小通知
排在大响应后，再发送 EOF，验证顺序、通知完整交付和队列中间有真实浏览器 timer 执行。

首轮边界单测的错误 fixture 使用了无效的 error.data，初始化 fixture 修改了受 identity 检查的 name，
已分别改为生成契约中的 InternalError 和较长 version；失败日志保留，没有放宽产品校验。
首轮 long task 统计遗漏了开始时间早于计时起点的重叠任务，已修正并重新采样。
异步取消测试改为等待取消帧自己的 consumption；首帧完成与取消帧之间允许真实任务让出，
不能用首帧完成代替取消已经处理的断言。

仍需处理的成本是 Renderer 的最终 framing 合并与 UTF-8 decode、完整字符串发送／对象图回传的
structured clone、领域 adapter、列表派生与 DOM，以及后端超大单 Turn 的输出。当前完整对象回传还不是
有界的领域增量；输入减量与字节预算仍有必要。相同连接的大帧会延迟后续审批／取消，这是保序的代价，
Worker 不消除 wire 队头阻塞。后端输出队列与跨窗口总内存预算不在本批改动范围。

实际验证：先完成 **97 项定向单测／5 文件**，EOF 补充及等待语义修正后，相关 **41 项复测通过**，
去重共 98 项；**2 项 Chromium 场景通过**（含 48 个性能样本），EOF 修改后相关浏览器场景复测通过。
Renderer 类型检查 4,169 文件、完整 browser integration 类型检查 4,115 文件通过。
本批 18 文件格式及 whitespace 检查通过。未运行真实 Electron Desktop／后端端到端场景。

正常 `pnpm test:browser:integration` 的准备阶段被范围外的中文条目
`zh-CN/ash/languageServer.installingRust` 的 Unknown translation 错误阻断。
复用已有生成协议／资源、完成完整 browser integration 类型检查后，运行仓库原有
`node test/integration/browser/run.ts appServerDecode.integration.spec.ts --project=chromium`，
该 runner 的真实构建与两项测试成功。Vite 输出现有 tree-sitter direct eval 警告、Node 输出现有
NO_COLOR／FORCE_COLOR 提示。本批没有改动这些依赖或翻译文件，没有宣称完整准备命令成功。

第三批使用独立本地提交；后续 Worker 通信优化另行记录，不混入本批。

## 10. Worker 往返成本与更高收益方案

### 10.1 先拆开解析、校验与复制

沿用第 9 节的生产协议客户端与真实 Chromium fixture，另开诊断测试，在测试拥有的 Worker 中
记录 JSON.parse 起止、解析结束到返回结果前、原始 postMessage 调用起止。预热一次后采集 5 次，
退出测试时销毁该 Worker。诊断样本与未插桩的性能对照分别记录，不能混用。

18,107,467 bytes／2048 Turn 场景的本轮基线中位数：JSON.parse **6.7 ms**，后续校验与路由
**128.8 ms**，发送侧 postMessage **9.1 ms**。最后一项只覆盖 Worker 同步序列化调用，
不含消息调度、Renderer 接收反序列化及后续领域处理，不能当作完整复制成本。
当前主要开销在解释式 schema 校验；把优化目标只放在 JSON.parse 或发送侧复制会错过大头。

### 10.2 Protobuf 的适用范围

Protobuf 使用字段编号、varint 与 packed repeated 编码，数值数组及大量短记录有减少 wire bytes
的机会；string 仍是 UTF-8。换编码本身不压缩或去重消息正文，也不提供普通 JS 对象跨 Worker
转移所有权的能力。[编码规范](https://protobuf.dev/programming-guides/encoding/)、
[Transferable objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)。
另一个潜在收益是由生成的二进制 decoder 替代 JSON.parse 与通用 schema 的结构遍历；这需要在保留
应用约束的前提下实测，不能从 wire bytes 的变化推导 CPU 收益，也不能预先保证比 V8 JSON.parse 快。

当前 18.1 MB fixture 的两处正文合计 `2 × 2048 × 4096 = 16,777,216` bytes，占 **92.65%**。
假设内容与重复次数不变，即便其余所有开销都消失，体积也最多减少约 **7.35%**；这是针对该 ASCII
fixture 的上界推算，不是 Protobuf 实测结果。超大单文本场景的正文占比更高。
去掉重复历史、分页与字节预算可以直接减少需要传输、解码、校验及复制的数据，收益与编码选择相互独立。

Protobuf 迁移也不能把“能解码”当作领域输入已经合法：应用仍需执行必填、范围、长度、枚举、
身份与关联关系等约束。尤其要明确缺失与 `0`／`false`／空字符串的区别；proto3 基础字段默认的
implicit presence 会合并这些状态，官方建议使用 `optional` 或相应 explicit presence。
[字段 presence 说明](https://protobuf.dev/programming-guides/field_presence/)。
还需保持 64 位值的精确表示、未知字段兼容策略、取消／审批语义及现有连接背压。

推荐原型保持现有请求／响应所有权与 transport，选择有界 Thread 页、数值数组和大文本三种相同
数据，对比 wire bytes、Rust 编码、Worker 解码与约束校验、UI 对象交付、总耗时及峰值内存。
若采用二进制，使用 ArrayBuffer 转移输入所有权；Worker 解码为完整 JS 对象后回传仍会 structured
clone。若要继续减少这部分开销，需要有界输出或改变消费者读取方式，不能只替换 wire codec。
本轮没有引入 Protobuf、gRPC 或第二套线上协议，没有声称迁移后的速度倍数。

### 10.3 已排除的复制优化

在 ignored investigation 中验证了字符串表／重复文本引用的原型，没有把它接入产品。
Node structuredClone 的独立诊断中，2048 个 4 KiB 重复文本的原始 clone 中位数约 **7.7 ms**；
指纹与完整相等检查、打包、clone、恢复合计约 **22.7 ms**。每 Turn 不同、但在两处重复的文本
也从约 **12.2 ms** 增至 **28.5 ms**。单个巨大重复文本能获益，但不能据此推广到所有响应。
这不是浏览器链路测量；结论仅用于否决当前通用扫描算法，不能作为产品加速数据。

另一个缓存对象校验 closure 的原型在真实 Chromium 中也回退：18.1 MB 的 Worker 校验中位数
**128.8 → 138.4 ms**，未插桩的已验证响应 **155.0 → 177.5 ms**。已移除该候选实现，
源码与原始样本保留在 investigation 中，没有保留更复杂但更慢的路径。

### 10.4 已实施：排除常规 union 分支失败的异常成本

生成 decoder 的 `matches` 会把不匹配的 union 分支转成 false，但原先只提前排除 type 不匹配。
Turn.kind 是六个 string const 的 oneOf；一个合法 coding 值仍会为另外五个分支创建并捕获异常。
仅 2048 个 Turn 的这一字段就产生 10,240 次常规分支失败。改动在 const／enum 明确不匹配时
直接返回 false；真正命中的分支仍走原有完整 validate，oneOf 的唯一匹配与错误路径保持原契约。
改动位于协议 owner 的 `typescript_decoder.template.ts`，通过正常生成器更新产物。

相同 Chromium **149.0.7827.55**、同一 fixture、本轮修改前后各 48 个样本，warm 结果仍取 5 次中位数。
表中“修改前”是已包含第三批 Worker 的版本，不能与第 9 节同步版本的“前”混淆。

| 相同响应                        | Worker 到已验证响应：修改前 → 后 | Worker 最长计时器间隔：修改前 → 后 | Worker Renderer CDP TaskDuration：修改前 → 后 | 同步解码到已验证响应：修改前 → 后 |
| ------------------------------- | -------------------------------: | ---------------------------------: | --------------------------------------------: | --------------------------------: |
| 9,492 bytes，小帧对照           |                        0.2 → 0.1 |                          4.0 → 4.6 |                                     1.5 → 1.7 |                         0.2 → 0.1 |
| 1,131,168 bytes，128 Turn       |                       10.8 → 3.2 |                          4.5 → 4.6 |                                     3.4 → 3.5 |                         6.1 → 1.9 |
| 18,107,467 bytes，2048 Turn     |                     155.0 → 50.6 |                         12.0 → 9.0 |                                   37.6 → 38.2 |                       95.9 → 17.6 |
| 16,778,516 bytes，1 Turn 大文本 |                      14.3 → 12.2 |                          6.2 → 4.6 |                                   26.9 → 23.5 |                         3.2 → 2.9 |

单位均为 ms；小帧的 Worker 列实际走生产阈值下的同步路径。18.1 MB 诊断样本中，JSON.parse
**6.7 → 7.0 ms**，后续校验与路由 **128.8 → 15.6 ms**，Worker 发送侧 postMessage
**9.1 → 9.5 ms**。校验阶段降低约 **88%**，未插桩的 Worker 响应耗时降低约 **67%**。
这项收益来自减少校验开销，不能声称已经减少对象复制、wire bytes 或 Renderer 总 CPU。
Worker 主线程 TaskDuration 没有下降；巨大单文本也没有足够的常规 union 失败支撑同等收益。
最终 Worker 仍比同数据同步解码慢，但把可阻塞主线程的那段工作隔离出去；两者目标需分别衡量。

本机同时有其他编译任务，计时器约 4 ms 的底噪、调度与 CPU 频率会影响绝对数字；没有将巨大文本的
小幅变化全部归因于本改动。沿用第 9 节的组件测量范围，不包含真实后端、Main IPC、Chat render、
完整 Desktop 或峰值内存。首次使用样本单独保留，没有用 warm 中位数代表启动体验。

通过 **75 项定向单测／3 文件**，覆盖全部六个 Turn kind、错误 kind／字段／计数、允许的额外字段、
own-property 与 closed record 契约，并复测生产 Worker 及协议客户端的顺序、审批、超时与关闭行为。
**3 项 Chromium 测试通过**，包括 48 个未插桩样本、5 个 Worker 阶段样本及 2000 通知后 EOF 的保序让出。
正常生成协议成功；protocol、Renderer、browser integration 完整类型检查分别覆盖 **1,591／4,169／4,115**
文件。继续复用第 9 节说明的准备产物，经仓库 raw browser runner 重新构建与运行；没有声称完整准备
命令或真实 Electron 端到端场景通过。

原始证据位于 `.build/investigations/app-server-worker-transfer-p1-2026-10-17/`：
`before-app-server-*.json`、`literal-guard-app-server-*.json`、`literal-guard-comparison-summary.json`、
`rejected-object-checks-summary.json`、字符串表原型、生成与测试日志。后续 Protobuf／生成校验函数原型
必须以修正后的 JSON decoder 为基线，避免把本可单独消除的异常成本全部算成换编码的收益。

第三批已本地提交为 `14f1d8a6a6e4697f2a3626d44cb2c80414bca2ee`，未推送。
该提交执行了 `just commit-check origin/main`；门禁被范围外 11 个未暂存 TypeScript 文件的格式问题
阻断，18 个提交文件的定向格式与 whitespace 检查通过，按仓库提交流程完成独立本地提交。
本节优化使用下一次独立本地提交，未混入第三批提交。

研究参考：[Off-main-thread](https://web.dev/articles/off-main-thread) 说明 Worker 与通信开销的取舍；
[Ajv standalone](https://ajv.js.org/standalone.html) 提供构建时生成校验函数的后续候选。
这些资料支撑方案选择，未把外部 benchmark 的倍数套用到 Ash。

## 11. Protobuf 原型与优化后 JSON 的同数据对比

### 11.1 原型范围与不变的协议 owner

第 10 节校验优化已独立本地提交为 `e50d1e0c2fa5b10372327d200a356a619cb955ba`，未推送。
提交门禁执行后被范围外 13 个未暂存 TypeScript 文件的格式问题阻断；4 个提交文件的定向格式、
working-tree／staged whitespace 检查和第 10 节测试通过，按仓库本地提交流程完成。

本原型只进入 `test/integration/browser/protobufPrototype/` 与专用浏览器 fixture，未切换产品 wire
协议，未增加实验 method、版本协商或 gRPC。Main relay、JSON 行 framing、Electron IPC、后端及
生产 Worker 默认实现保持原路径。唯一生产代码整理是把 `decodeAppServerFrame` 的 JSON.parse
之后部分提取为 `decodeAppServerMessage`，由原函数及原型复用。请求路由、pending 生命周期、
审批、取消、timeout、connection generation、EOF 和 schema 仍归现有协议客户端所有。

原型注入 `AppServerFrameDecoder`：test carrier 用 token 将已收到的 string／buffer 交给 decoder，
`AppServerFrame.byteLength` 使用本地实际编码长度，接收队列按相同的 4096 帧／320 MiB 限额计费。
token 不做 base64、不 stringify 已解码的 Protobuf 结果，也不向生产 transport 暴露新入口。
消费或连接退休时释放输入记录，没有创建第二份业务 pending map。

使用 **protobufjs 8.8.1／protobufjs-cli 2.7.1**，均为 devDependencies。`model.ts` 是测试 wire
模型的唯一输入，由现有 browser Vite buildStart 生成 `.build/protobuf-prototype/wire.proto` 和 fixture
目录下 ignored 的 `codec.js`；`codec.d.ts` 声明实际生成 runtime 的接口。静态代码生成在构建阶段执行，
Worker 不解析 `.proto` 或运行动态代码生成。两种 codec 使用同一个 Worker bundle；冷启动数字
不能当作分别打包后的产品加载成本。

Thread read 与 syntax/query 的测量字段使用类型化 Protobuf：安全计数采用 uint64，坐标数组采用
packed uint32；其他字段／控制消息使用 lossless JSON value 表示，未把整个 JSON 文本塞进 bytes。
它覆盖两种被测 payload 的机械映射，不是完整产品协议的 `.proto` 迁移方案。

### 11.2 保留值、校验与背压

- proto2 optional 标量与外层 array message 保留缺失字段与 `0`／`false`／空数组的区别，
  不用自动默认值补齐原协议的必填字段。
- 允许的额外字段通过显式名称和值传递；恢复 own keys 时使用 defineProperty，保留 `__proto__`，
  不触发原型 setter。未知的原型 wire 字段号被拒绝，不静默丢弃后接受消息。
- 64 位领域字符串保持字符串；uint64 转 JS 后仍受相同 safe integer／范围校验。
  无法由某个 typed field 精确表示的值走显式 value 表示，再由原 schema 决定是否拒绝，
  不截断负数、小数、超界数或把 `-0` 改成 `0`。
- string 使用严格 UTF-8 Reader 并保留 BOM。JSON 能表示的孤立 UTF-16 surrogate 值／字段名
  使用显式 UTF-16 bytes 扩展恢复，不能被编码器替换字符。该扩展是保留现有 JSON 值域的原型设计，
  不代表标准 Protobuf string 本身支持这些值。
- 解码后的新对象树原地去掉生成类的 prototype、展开数组 wrapper、合并额外字段，得到原有 plain
  own-field 形状；避免在 Worker 中再复制一整棵规范化结果。之后仍执行同一套完整生成 schema，
  不把 Protobuf 的结构解码当作取值／必填／枚举／tuple 长度等约束已经验证。
- protobuf.js 的小输出可能只是池化 backing buffer 的一段 view。只有独占完整 buffer 才直接 transfer；
  否则复制准确范围，该复制计入编码时间并记录 `inputBackingCopyBytes`，避免发送范围外字节或 detach
  编码器的共享池。进入 Worker 的两个二进制方案均断言 buffer 确实 detached。

实际浏览器测试暂停首个大响应的 Worker，模拟 carrier 在 4 个未消费**完整帧**后停止交付，释放后
验证 20 条 notification 全部保序到达，再排空 EOF。这个测试证明消费 Promise 没有在 postMessage
后提前释放；它不是 Electron 的 chunk carrier，也没有验证新二进制 framing。原有真实 transport
单测继续覆盖 Main 的 4 个未 ACK **chunk**、部分帧 ACK、端口退休和容量失败；未改变这些实现。

另测 host request 取消只回复一次、迟到 handler 不再回复、disconnect 兑现消费并拒绝 pending、
重连忽略 retired response、坏 JSON／Protobuf 关闭连接并释放消费，以及 Unicode、未知字段、
缺失数组、非法 kind、负计数、unsafe integer、截断数据和非法 UTF-8。修复的是原型适配器及 fixture，
没有放宽原生成 schema。早期错误／超时日志保留在 investigation 中。

### 11.3 采样与计时定义

三种方案是 JSON string、JSON UTF-8 ArrayBuffer transfer 对照、Protobuf ArrayBuffer transfer。
第二种用于分离“换格式”与“只转移输入 buffer”的收益。都沿用生产 **256 KiB wire bytes** 阈值；
有界 20 Turn 场景在 UI 同步解析，其余大场景使用真实 Worker。threadWorkload 与第 9 节 fixture
共用同一 builder，完整结果比较包含 thread 与 transcript 的两份正文，而非只检查条目数量。

每场景每 codec 记录 first-use 一次，再轮转 codec 顺序采集 **7 组 warm**，6 场景合计 **144 样本**。
每个 warm 样本前通过 Renderer CDP GC；Worker 继续正常 GC。计时包含实际解析、恢复对象形状、
完整 schema／路由校验、输入发送、结果 structured clone 及 UI 接收；心跳在响应完成时停止，
完整内容断言不计入响应耗时。first-use 与 warm 分开保存，不跨第 9／10 节不同运行直接比较绝对值。

`parseMs` 对 JSON bytes 包含 UTF-8 decode；`normalizeMs` 单列 Protobuf 形状恢复；`validateMs`
是相同生成 schema 与路由。`serializeMs` 是 Worker 同步 postMessage 时间；`returnDeliveryMs` 从
Worker 发送前到 UI 接收，包含该序列化、调度和接收反序列化，二者重叠，不能相加当作复制总成本。
各列独立取中位数，也不能要求列中位数之和等于总耗时中位数。

编码／必要的 UTF-8 计长与池化 buffer 复制另记 `encodeMs`，在响应和心跳计时外；
`encodeAndResponseMs` 是每个样本的 JS 编码加响应成本，不是 Rust 后端的端到端延迟。
没有测 Rust 编码、网络、framing、Main IPC、Chat adapter／DOM 或峰值内存；不能由组件数据宣称
完整 Desktop 加速或 RSS 下降。完整结果回传仍是 structured clone，Protobuf 并不让普通 JS 对象零复制。

### 11.4 结果：缩小部分载荷，没有获得总耗时优势

Apple M5／macOS ARM64，Node **24.21.0**、Chromium **149.0.7827.55**。下表取最终原地转换版本的
7 次 warm 中位数；时间为 ms，体积为 bytes。只在本表内比较，不把前轮不同负载下的绝对时间
当作这次原型的加速收益。

| 相同数据                          |   JSON → Protobuf bytes | Worker | JSON 响应 | JSON bytes 响应 | Protobuf 响应 | JS 编码：JSON → Protobuf |
| --------------------------------- | ----------------------: | :----: | --------: | --------------: | ------------: | -----------------------: |
| 有界 20 Turn                      |       177,221 → 168,135 |   否   |       0.2 |             0.2 |           0.6 |                0.1 → 0.5 |
| 2048 Turn 长历史                  | 18,107,467 → 17,222,287 |   是   |      23.8 |            24.1 |          31.3 |              23.2 → 45.7 |
| 1 Turn，巨大文本                  | 16,778,516 → 16,777,660 |   是   |       6.9 |             6.5 |           6.1 |              13.5 → 25.4 |
| 65,536 个六元数值 tuple           |     1,670,907 → 999,298 |   是   |      14.0 |            14.6 |          14.9 |               2.9 → 10.3 |
| BOM／中文／emoji／组合字符／NUL   |       791,621 → 577,735 |   是   |       0.9 |             1.4 |           1.1 |                1.3 → 2.0 |
| safe integer／额外字段／surrogate |       358,412 → 302,433 |   是   |       1.3 |             1.3 |           2.2 |                0.6 → 2.4 |

长历史只减少约 **4.9%** wire bytes，响应从 **23.8 → 31.3 ms**。数值 tuple 减少约 **40.2%**
wire bytes，但响应 **14.0 → 14.9 ms**，没有体现出总耗时优势；小幅差值不作统计显著性结论。
大文本的响应约少 0.8 ms，而 JS 编码约多 11.9 ms。对应的 JS 编码加响应中位数是
**20.3 → 30.9 ms**；长历史为 **46.3 → 77.0 ms**，数值 tuple 为 **16.9 → 25.3 ms**。
这些相加指标仍不代表未测的 Rust 编码或实际网络延迟。

关键阶段拆分如下，发送侧与返回交付重叠，不能相加：

| 数据／codec            | 解析 | 形状恢复 | 同一 schema／路由校验 | Worker 发送侧序列化 | 返回交付（含序列化） |
| ---------------------- | ---: | -------: | --------------------: | ------------------: | -------------------: |
| 长历史／JSON           |  3.0 |      0.0 |                   6.9 |                 5.0 |                 11.1 |
| 长历史／JSON bytes     |  5.9 |      0.0 |                   7.1 |                 4.9 |                 11.2 |
| 长历史／Protobuf       |  6.7 |      6.3 |                   7.1 |                 4.7 |                 10.2 |
| 大文本／JSON           |  1.8 |      0.0 |                   0.1 |                 1.6 |                  2.9 |
| 大文本／JSON bytes     |  3.3 |      0.0 |                   0.1 |                 1.6 |                  2.9 |
| 大文本／Protobuf       |  2.7 |      0.1 |                   0.1 |                 1.6 |                  2.7 |
| 数值 tuple／JSON       |  2.2 |      0.0 |                   3.6 |                 4.2 |                  8.1 |
| 数值 tuple／JSON bytes |  2.5 |      0.0 |                   3.6 |                 4.2 |                  8.5 |
| 数值 tuple／Protobuf   |  2.6 |      1.0 |                   3.7 |                 4.2 |                  7.2 |

单纯把 JSON string 换成可 transfer 的 UTF-8 buffer，长历史的 UI 发送从约 0.9 ms 降到计时精度内
的 0.0 ms，但 Worker 的 decode／parse 从 3.0 增至 5.9 ms，总响应 23.8 → 24.1 ms。
结果对象回传在三种格式下都仍有成本，数值 tuple 的发送侧同为 4.2 ms；不能把输入零复制当作
整条链路已经零复制。0.0 是浏览器计时精度与中位数结果，不是数学意义上的零耗时。

最初的 Protobuf 版本重新创建规范化对象树；其长历史恢复阶段约 11.9 ms，数值 tuple 约 7.7 ms。
最终版本原地转换，并给安全计数采用 varint，避免把这部分可消除的复制留在比较对象里。
两轮 JSON 基线也发生变化，不能把两轮 Protobuf 总耗时差全部归因于该修改。

### 11.5 判断、验证与复现

这版**保留现有对象形状与完整生成 schema**的原型不支持全量迁移 Protobuf：常见的有界 20 Turn
JSON 路径已经很短；长正文不因字段编号编码而消失；数值数组虽能缩小 wire bytes，恢复 JS tuple
和完整对象回传仍有成本。只有实际网络／带宽场景证明体积占主导时，才值得进一步评估该收益。

优先继续减少重复正文、有界分页加字节预算；数值结果可单独研究 typed array／更有界的消费契约，
同时衡量领域适配与回传成本。若研究生成式校验，JSON 也应使用同一生成校验器作为对照，
不能把减少校验工作全算成二进制编码收益。本次未替换 schema，因而也不证明生成式／融合校验
没有潜力。未建模领域的 generic fallback、UTF-16 扩展、原型 wire 深度限制和真实二进制 framing
仍需完整迁移设计；这里没有声称所有产品消息已经具备可发布的二进制协议。

生产客户端／decoder／socket／MessagePort 的 **102 项单测、5 文件通过**。完整 browser integration
类型检查通过，production Renderer 与 protocol 类型检查通过。最终完整构建的 **7 项 Chromium
测试通过**，包括原生产 Worker 的 3 项场景和原型的 4 项场景，采集 **144 个 codec 样本**及原有
48 个 Worker 对照样本。旧让出测试在空 listener 的 2000 条通知不足 4 ms 时会偶发失败，现仅在
该功能 fixture 中每 100 条加入 1 ms 的受控 listener 工作，确保确实跨越让出预算；性能采样不调用它。

早期测试发现池化 view 不能直接把整个 backing buffer 交付，以及 `--force-number` 的静态 reader
仍可返回 Long，已分别加入准确范围复制与显式安全转换，未放宽校验。一次完整测试的 7 项断言
虽通过，但 runner 清理阶段的系统 ps 查询超时，按失败保留日志；随后使用仓库 Node runner
重新完成构建、7 项测试及正常退出。没有修改系统安全设置或用户应用进程。

复现入口：

```sh
pnpm test:browser:integration appServerCodec.integration.spec.ts appServerDecode.integration.spec.ts --project=chromium
# 复用已生成的协议／资源时，仍执行完整 integration typecheck：
pnpm test:browser:integration:prepared appServerCodec.integration.spec.ts appServerDecode.integration.spec.ts --project=chromium
```

原始样本、首次使用数据、各次失败和最终报告保存在
`.build/investigations/app-server-protobuf-p1-2026-10-17/`：`final-app-server-codec-comparison.json`、
`final-comparison-summary.json`、`browser-protobuf-final.log`、`browser-contracts-final.log`、`unit.log`
及类型检查日志；成功报告为 `.build/desktop/playwright/editor-browser-o59Eea/report/index.html`。

## 12. 是否必须复制：Zed、VS Code 与 Ash 的可选路径

2026-10-17 继续对照本地 Zed `56934ec056`、VS Code `a2acc8c864a` 的源码。
这里比较具体边界，不把某个应用整体称为“零复制”，也不把结构化克隆的语义等同于可数出的物理内存复制次数。

### 12.1 必须重建普通 JS 对象，不代表必须传整棵对象

当前 Ash 的 `AppServerFrameDecoder.decode` 将大帧交给 Worker，完整校验后回传普通 JS 对象。
独立 JS 堆之间不能直接移动或共享这棵普通对象图；当前消息机制会在接收端重建它。
同一 JS 上下文的服务调用则可以直接传引用，不需要因“使用 Electron”而复制所有值。
字符串等底层存储是否被引擎共享属于实现细节，不能从 API 调用次数推断每个字节必然被复制几次。

| 路径                            | 可以省掉的成本                       | 仍然存在的工作                                          |
| ------------------------------- | ------------------------------------ | ------------------------------------------------------- |
| 同进程 Rust `move` / `Arc<T>`   | 可以避免重新序列化及深复制数据内容   | 所有权、线程安全、引用计数；外层集合可能仍要复制        |
| Worker 转移 `ArrayBuffer`       | 转移底层内存所有权，避免克隆该块字节 | 消息元数据、调度、接收端视图；发送方原 buffer 被 detach |
| Worker 共享 `SharedArrayBuffer` | 两侧读取同一数据块                   | 同步、生命周期、边界校验；不共享任意 JS 对象            |
| 二进制视图按需读取              | 避免预先展开完整对象图               | 格式验证、访问器、需要时的字符串解码与 UI 数据构造      |
| 源头限制输出、按需取正文        | 少传、少解析、少校验、少复制、少应用 | 翻页、版本、取消、审批和消费背压的完整语义              |

浏览器 Worker 的 buffer 转移与共享内存行为分别见
[Transferable objects](https://developer.mozilla.org/en-US/docs/Web/API/Web_Workers_API/Transferable_objects)
和 [SharedArrayBuffer](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer)。

### 12.2 Zed 的优势来自可共享的进程内数据结构

本地 `../zed/crates/gpui/src/app/context.rs:872` 的 `background_spawn` 接收 `Send` future，
返回 `Task<R>`，结果同样要求 `Send`；这条同进程任务路径没有要求先转成 JSON 再重建结果。
`../zed/crates/agent/src/thread.rs:1298` 的历史使用 `Vec<Arc<Message>>`，
`to_db` 在第 1950 行克隆这个集合，再于第 1973 行把结果移进后台任务。
这里会分配／复制外层 Vec、增加每个 Arc 的引用计数，但不会因此深复制每条 Message 的正文。
不能将它写成整个快照创建是 O(1) 或没有任何复制。

跨进程／网络另有成本：`../zed/crates/rpc/src/message_stream.rs:48` 将 Envelope 编码、zstd 压缩并发送，
第 87 行开始解压并解码接收的消息。Zed 的这条 RPC 同样没有消除编码与结果构造；
其进程内 `Arc` 不能直接跨到 Ash 的独立 Rust app-server 和 Chromium JS 堆。

### 12.3 VS Code 同样区分对象消息与可转移字节

本地 `../vscode/src/vs/base/common/worker/webWorker.ts:264` 的 `_send` 收集请求的顶层
`ArrayBuffer` 参数或直接为 `ArrayBuffer` 的返回值，加入 transfer list。
普通对象及其任意嵌套字段不会因此自动变成可转移结果。
`../vscode/src/vs/workbench/services/extensions/common/rpcProtocol.ts:42` 的扩展 RPC 路径
仍使用 `JSON.stringify` / `JSON.parse`，并把 `VSBuffer` 引用从 JSON 中单独提取、恢复。
`../vscode/src/vs/base/parts/ipc/common/ipc.mp.ts:59` 的 MessagePort 协议发送字节，
也不能据此声称整个扩展调用没有复制。

与减少载荷有关的例子是 `../vscode/src/vs/workbench/api/common/extHostChatAgents2.ts:92`：
Chat progress 先入队，再在 microtask 中批量调用 `$handleProgressChunk`，发送本次进度块。
它能减少调用次数；这段代码本身不能证明存在与 Ash 相同的字节额度或消费 ACK。

### 12.4 Ash 后续优先级与可验证假设

1. **先继续限制完整结果规模。** 第 8 节已接入有界历史，但 Turn 数上界不等于字节上界。
   单个超大 Turn、重复正文、工具输出仍值得检查。正文按需获取、合适的摘要与字节预算可同时减少
   编码、传输、解码、校验、克隆和领域应用；翻页、回放、审批与取消必须保持原有语义。
2. **对大数值结果试验紧凑 buffer 回传，并让消费者持续使用视图。** 如 syntax 的定宽 tuple，
   可考虑连续 `Uint32Array`，Worker 校验后转移底层 buffer，客户端以领域访问器读取。
   当前 `src/ash/platform/syntax/browser/syntaxApi.ts:59` 等处会将 tuple 映射成领域对象；
   若立即 `Array.from` 并展开全部对象，只会把分配和阻塞移回 UI，不能算解决了结果构造。
   适配层应继续隐藏 wire DTO，并保证 buffer 所有权、有效期、版本与取消语义。
3. **需要大规模随机访问时，再比较二进制视图。** FlatBuffers 可以直接访问已编码数据，
   不要求先展开成另一棵完整对象图，见[官方说明](https://flatbuffers.dev/)。
   可将已校验 buffer 转移给 UI，通过领域访问器按需读取；边界验证、JS 字符串创建和最终 UI 构造仍需付费。
   这比仅换 Protobuf codec 改动更大，必须保留字段存在性、整数精度、非法输入和协议演进语义。
4. **共享内存保留为特定场景候选。** `SharedArrayBuffer` 适合双方反复读取／写入的固定布局数据，
   不是共享普通 JS 对象的开关；并发写入需要适当同步，浏览器产品还需核对安全上下文和跨源隔离要求。
   字节池若在 UI 仍持有视图时被复用会产生错误，ACK／归还时机必须覆盖实际读取生命周期。
   它本身也不打通独立 Rust 进程到 Renderer 的共享内存通道。

另有一个局部副本：`appServerConnectionRelay.ts:247` 的 `new Uint8Array(chunk)` 会复制现有 Buffer 内容；
这与仅创建同一 buffer 的 view 不同。是否可安全删除需检查池化 backing store、准确范围、序列化和 chunk 生命周期，
并单独实测收益。Electron 当前公开的
[`MessagePortMain.postMessage`](https://www.electronjs.org/docs/latest/api/message-port-main#portpostmessagemessage-transfer)
的 transfer 参数是 `MessagePortMain[]`，不能直接套用浏览器 Worker 的 ArrayBuffer transfer 写法。

第 11 节同一次测量中，长历史总响应中位数为 23.8 ms，Worker 返回交付约 11.1 ms（其中发送侧约 5.0 ms）；
数值 tuple 返回交付约 8.1 ms（发送侧约 4.2 ms）。这些说明结果通路值得优化，
但返回交付还包含调度与接收，不能当成可完全消除的纯 memcpy 时间，也不能承诺等量加速。
上述紧凑结果、二进制视图及共享内存方案尚未实施或基准验证；本节只补充源码证据与下一步实验优先级。

## 13. 外部项目与 crates.io 复核：更高收益的候选

2026-10-17 查阅 DuckDB-Wasm、Tauri、VS Code、Ajv 与相关 Rust crate 的官方文档和源码，
并增加两个隔离实验。结论是继续减少结果的重复内容、通用对象构造和跨线程对象交付；
没有证据支持仅替换一种 codec 就能显著加速全部链路。本节不修改线上协议、依赖或产品实现。

### 13.1 首选结构性改动：同一个 Item 正文只传一次

当前 `SessionThreadReadResult` / `SessionThreadSubscribeResult` 同时携带 Thread 与 transcript；
`ThreadTranscriptSnapshot::from_thread` 还会 clone 原 Item。语义上已知的条目身份，可以用于组织
一个权威内容集合与有版本的引用，不必对所有字符串做通用指纹去重。
后者是第 10.3 节已经验证过会退化的不同算法。

用第 11 节同一份 `threadWorkload`，仅在一个字节数模型中把 transcript 的重复 Item 换成 `itemRef`，
保留 entry、turn、transient 等元数据，再完整恢复并 `deepStrictEqual` 原响应：

| 夹具                       | 当前 JSON 字节 | 引用表示字节 |   减少 |
| -------------------------- | -------------: | -----------: | -----: |
| 20 Turn，每条 4 KiB 正文   |        177,221 |       94,131 | 46.88% |
| 2048 Turn，每条 4 KiB 正文 |     18,107,467 |    9,595,041 | 47.01% |

这是**表示方式的体积实验**，不是已实现的新 DTO 或性能结果。生产版本还必须核对条目 scope、revision、
更新／删除、暂态 transcript Item、回放和审批；不能把不在 canonical Thread 中的暂态条目错误地改为悬空引用。
协议变更仍由共享协议 crate 拥有，App、Browser、TUI 消费者一起适配。
引用关系应保持到 Worker 交付与领域适配，避免回传前又展开成两份完整对象。
客户端也不能据此建立第二份权威历史。

该夹具减少约 47% 字节，显著高于第 11 节 Protobuf 的约 4.9%；这不表示真实耗时会等比例下降。
正常有界 20 Turn 在第 11 节已经只有约 0.2 ms 的解码响应，优化价值主要在较大的正文、峰值内存与高频更新。

### 13.2 新实测候选：Worker 校验后只回确认，UI 解析原字符串

当前 UI 已拥有不可变的原始 frame 字符串。另一种私有 Worker 交付方式是：

```text
UI 保留该 job 的原始 JSON
  → Worker JSON.parse + 完整生成 schema 校验
  → 仅返回 job / method / id 等确认元数据
  → UI 解析同一个原始 JSON，交给领域消费者
```

它多做一次 `JSON.parse`，但省掉完整对象图的 Worker 发送序列化与 UI 接收重建。
这不是字节零复制，也不说明重复解析通常更快；它依赖具体数据形状和 V8 的实际成本。

隔离实验使用真实 Chromium 149.0.7827.55 Worker 与当次生成的生产 decoder，
两种方式都完整校验同一响应。每个场景先运行一次，再交错运行 9 个 warm 样本／方式，
每次 warm 前通过 CDP 回收 UI 垃圾，Worker 保留正常 GC；总计 120 个样本。
同一个页面中的两种 Worker 均已 ready，不包含冷启动。
每个结果在响应与心跳计时停止后完整比较序列化结果，另确认两种方式都拒绝非法 Turn.kind。

下表为同次隔离实验各列独立 warm 中位数，单位 ms：

| 场景                                  | 完整对象回传响应 | 仅确认后再解析响应 | 确认方式 UI 再解析 | UI 心跳最大间隔：对象 → 确认 |
| ------------------------------------- | ---------------: | -----------------: | -----------------: | ---------------------------: |
| 20 Turn，177,221 bytes                |              0.4 |                0.3 |                0.0 |                    0.3 → 0.3 |
| 2048 Turn，18,107,467 bytes           |             25.6 |               18.5 |                5.7 |                    8.1 → 8.4 |
| 单大文本，16,778,516 bytes            |              7.9 |                5.9 |                1.8 |                    4.5 → 4.8 |
| 65,536 个数值 tuple，1,670,907 bytes  |             14.6 |                9.9 |                4.2 |                    5.4 → 5.2 |
| Unicode，5,063,328 bytes              |              5.8 |                7.1 |                3.2 |                    5.4 → 6.7 |
| 262,144 个数值 tuple，7,269,147 bytes |             63.3 |               36.7 |               13.6 |                  22.0 → 15.1 |

长历史响应约少 27.7%，普通数值 tuple 约少 32.2%，大数值 tuple 约少 42.0%；
Unicode 响应约增加 22.4%。长历史和大文本心跳中位数略升，不能称为全面减少 UI 卡顿。
0.0 表示计时精度下的中位数；各列中位数也不能简单相加。

该探针没有接入完整 ProtocolClient、Electron relay、真实 app-server、领域 adapter 和 DOM，
也未测峰值内存；不能把这些数字当成 Desktop 的端到端加速。
比第 11 节更简单的 harness 只允许比较本表两列，不能将跨次绝对值之差计为新收益。
20 Turn 强制走 Worker 只是实验对照，线上仍应保留当前小帧同步路径。

若继续产品化，确认必须绑定原 job、不可变 frame、method、connection generation 和生成 schema 版本；
恢复后的 envelope 要保持当前 decoder 的规范化语义。错误、断开、取消、晚到响应、server request、
顺序派发和消费 ACK 必须跑现有契约测试；ACK 不能在 UI 再解析／必要交付完成前提前释放。
尤其不能让超大／对象密集数据无条件回到 UI 的不可抢占 `JSON.parse`。
这支持一个**有条件选择的候选路径**，不支持全量替换当前 Worker 输出。

### 13.3 外部实现可以借鉴的具体机制

- **DuckDB-Wasm：数据批次与可转移结果。** 官方的 `query()` 取得完整结果，`send()` 按需取得 Arrow record batch，
  见[查询文档](https://duckdb.org/docs/preview/clients/wasm/query)。
  [Worker dispatcher](https://github.com/duckdb/duckdb-wasm/blob/main/packages/duckdb-wasm/src/parallel/worker_dispatcher.ts)
  对完整查询及结果块均把 `result.buffer` 放进 transfer list。这证明可将大结果设计成二进制视图和有界批次，
  而非先展开为整棵 JS 对象；不证明其 Wasm 内部或整条链路没有任何复制。
- **VS Code：数值结果持续保留紧凑表示。** 本地
  `../vscode/src/vs/editor/common/services/semanticTokensDto.ts:67` 将 full／delta token 编成连续 Uint32Array，
  解码在对齐且字节序合适时使用同一 buffer 的视图，非对齐路径会复制。
  [公开 API](https://code.visualstudio.com/api/references/vscode-api#SemanticTokens)也直接接收 Uint32Array。
  Ash syntax 可以借鉴这种领域契约，而非先转 binary 后立刻还原所有嵌套数组。
  本次 65,536 × 6 个 Uint32 的裸数据为 1,572,864 bytes，接近当前 1,670,907-byte JSON，
  且尚不含 header／元数据；它的主要目标是减少对象分配和交付，不应先承诺 wire bytes 大幅缩小。
- **Tauri：区分小控制消息与大数据交付。** [Channel 源码](https://github.com/tauri-apps/tauri/blob/dev/crates/tauri/src/ipc/channel.rs)
  区分 JSON 与 Raw body，小数据直接通知，大数据排队后由前端 fetch；Raw 对前端表现为 ArrayBuffer。
  普通 `Vec<u8>` 作为 Serialize 值仍会成为 JSON 数字数组，小 Raw 也有转换路径，不能称为普遍零复制。
  [官方 channel 文档](https://tauri.app/develop/calling-frontend/#channels)强调有序交付；
  这本身不等于 Ash 的消费 ACK 或字节额度。可借鉴大正文／资源按需取、控制响应保持小帧，不能照搬 API 替换 Electron。
- **Ajv：把 schema 工作放进构建阶段。** [Standalone validator](https://ajv.js.org/standalone.html)
  在构建期生成直接校验函数，避免每次运行时解释 schema，也避免浏览器运行时 Function 编译。
  当前 Ash 仍使用通用解释器，值得与专用生成函数做完整拒绝语义的差分对比。
  第 10.3 节失败的是闭包缓存候选，不代表构建期代码生成已失败。
  JTD 编译 parser 可融合解析与校验，但[其 union 能力](https://ajv.js.org/guide/typescript.html#type-safe-unions)
  不等同于现有完整 JSON Schema，不能静默丢掉范围、oneOf 唯一性或额外字段约束。

### 13.4 crate 选择：先消除中间表示，再比较解析器

crates.io API 当次观测到 `serde_json 1.0.154`、`sonic-rs 0.5.10`、`rkyv 0.8.18`、
`flatbuffers 25.12.19`、`arrow 60.0.0`。这里只记录研究对象，未修改 lockfile 或安装这些版本。

| 工具                                 | 值得研究的位置                                            | 对当前瓶颈的限制                                             |
| ------------------------------------ | --------------------------------------------------------- | ------------------------------------------------------------ |
| `serde_json::to_writer` / `RawValue` | typed response 直接编码；已校验原始 JSON 的透明嵌入／转发 | 不消除 Renderer 的对象构造或 Worker 克隆                     |
| `sonic-rs`                           | Rust 的长字符串编码、只读取少数字段的 gateway 等热点      | 不替换 Chromium 内置 JSON.parse；需要兼容性与目标 CPU 实测   |
| `flatbuffers`                        | Rust／TS 都通过访问器读取的大结构                         | 消费端必须保留视图；验证、字符串与协议演进仍有工作           |
| `arrow`                              | 大型表状／数值批次                                        | 对通用 Chat 对象过重，定宽 tuple 可以先用更小的专用表示      |
| `rkyv`                               | Rust 间共享或持久化的 archived 数据                       | 不会自动让现有 TS 消费者读取 Rust 内存，需要额外布局／访问层 |

当前 `server.rs:4579` 的 `result<T>` 先 `serde_json::to_value`，再由第 4597 行序列化为 String。
比“换更快 Value 实现”更值得先试的是直接序列化 typed envelope，避免为输出再造一棵完整 Value。
[`to_writer`](https://docs.rs/serde_json/latest/serde_json/fn.to_writer.html)可以对 Serialize 值直接编码，
[`RawValue`](https://docs.rs/serde_json/latest/serde_json/value/struct.RawValue.html)可以保留合法 JSON 片段而不展开它。
要保留当前原子 frame、序列化失败处理、队列字节预算和 gateway resource 路由；
不能未经预算就把可失败的半条响应直接写入 socket。

[`sonic-rs`](https://docs.rs/sonic-rs/latest/sonic_rs/)提供 aarch64 SIMD 与 LazyValue，但官方另有兼容性说明。
simdjson 的 [On-Demand](https://github.com/simdjson/simdjson/blob/master/doc/ondemand_design.md)
支持跳过未消费值的转换；按需访问不保证未经访问的数据已经完成所有应用约束验证。
不能借惰性解析跳过 Ash 所需的边界校验，也不能把作者的 Rust／C++ benchmark 移植成 Electron 的预期倍数。
[`rkyv`](https://docs.rs/rkyv/latest/rkyv/)的 archived 访问与验证、
[`FlatBuffers`](https://flatbuffers.dev/)的二进制访问、
[`Arrow JS`](https://arrow.apache.org/js/current/)的 typed-array vector，针对的是不同消费模型。

### 13.5 建议实施顺序与证据位置

按收益范围优先做：有版本的 Item 去重、单页字节预算与大正文按需取；
随后比较 Worker 小确认路径、构建期专用 validator、Rust typed response 直接编码。
数值密集路径再做可转移的领域视图原型，通用协议的二进制替换与跨进程共享内存继续后置。
它们可以分别实验，不应一次混入一个无法归因的性能提交。

性能验证应补上当前微基准没有覆盖的 Rust 结果构造、编码、gateway、连接程序、Main relay、领域应用和绘制，
至少记录首个可用页面、总耗时、UI 停顿分位数、审批／取消延迟和各进程内存。
还要在合理低配 CPU 上设 UI 同步解析预算，避免 M5 的中位数掩盖长尾。

所有原始证据在 `.build/investigations/app-server-next-options-2026-10-17/`：
`sources.json` 记录外部原始源码／crate API 的 URL 与 SHA256，`probe-inputs.json` 记录夹具与 decoder，
`representation-byte-probe.json` 记录表示方式体积，`receipt-results.json` 保留 120 个原始样本和摘要。
本轮探针所有 fixture 的结果对比与非法 kind 拒绝检查通过；未运行产品全链路或新的回归测试套件。

```sh
node .build/investigations/app-server-next-options-2026-10-17/representation-byte-probe.mjs
node .build/investigations/app-server-next-options-2026-10-17/receipt-probe.mjs
```

## 14. Codex／Claude 团队公开方案与 X 原帖

2026-10-17 继续检索公开资料，并用浏览器直接读取下列 X 原帖和讨论串，展开了 Codex 性能帖的完整内容。
搜索引擎和新闻聚合页只用于发现线索；以下判断以原帖、官方文档或官方仓库为依据。
X 搜索页要求登录，本轮没有登录；可公开访问的具体原帖可读，不能据此声称覆盖了 X 的全部讨论。

### 14.1 X 上可以确认的团队说明

| 日期与出处                                                                                                                                               | 团队公开说法                                                                                | 对 Ash 的启发与证据边界                                                     |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 2026-05-16，[OpenAIDevs 性能帖](https://x.com/OpenAIDevs/status/2055718005309575431)                                                                     | 切换线程的重渲染约少 75%；部分流式路径消除了无效重渲染；部分大型仓库 Git 操作约快 10～50 倍 | 指向无效派生、渲染和后台工作；不是 JSON 或 IPC 的速度倍数，也未公开具体实现 |
| 2026-08-24，[ClaudeDevs 流式渲染帖](https://x.com/ClaudeDevs/status/2092006814804214163)                                                                 | 只更新还在变化的内容；团队报告慢笔记本卡顿减少，以及 120Hz 设备上的流畅度改善               | 把每次增量的消费成本与传输成本一起测；这些数字属于团队测试条件              |
| 2026-04-01，[Boris 的新 renderer 讨论串](https://x.com/bcherny/status/2039421575422980329)及[视口说明](https://x.com/bcherny/status/2039421581907374320) | 将整个终端视口的渲染控制移到应用层，并报告长对话下稳定的相关 CPU／内存开销                  | 是 CLI 终端 renderer 方案；不能外推整个应用 RSS 恒定或 Electron IPC 零复制  |

[Boris 在 2026-09-23 的原帖](https://x.com/bcherny/status/2102854267782705648)
直接引用 ClaudeDevs 的[复盘发布帖](https://x.com/ClaudeDevs/status/2102839691154427983)，
链接到 [How we made claude.ai 3x faster in two weeks](https://claude.dev/blog/how-we-made-claude-ai-faster/)。
文章作者为 Raymond Wang、Sam Attard 和 Issac G.；这是网页／Desktop 团队的性能复盘，不是某一 codec 的 benchmark。

复盘中与本次问题最相关的机制是：缓存已完成的 Markdown 块、把增长中的代码围栏分词放进 Worker、
减少主线程重复克隆 IndexedDB 缓存快照，以及以 8.33 ms 帧预算验证流式显示。
这些是团队公开描述，尚未在 Ash 上实测。Claude Code 的
[官方 fullscreen 文档](https://code.claude.com/docs/en/fullscreen)另明确说明只保留可见消息的渲染树，
并使用终端 alternate screen buffer；这是限制渲染工作量的具体实现。
复盘也有通过一次代码块字符串复制改善正则高亮的案例；减少复制应服务于总耗时和交互延迟，不能作为绝对目标。

### 14.2 Codex 的正式方向：历史按需加载，而非完整重建

- 2026-07-15 合并的 [PR #33364](https://github.com/openai/codex/pull/33364)
  引入 paginated history：resume 不携带完整 turns，历史通过 turn／item cursor 分页，最新记录通过 live notification 到达。
  当时显式选择 history mode 是实验能力。
- 2026-08-25 合并的 [PR #40676](https://github.com/openai/codex/pull/40676)
  弃用 paginated thread 的全历史 hydration，并引导客户端走分页接口。
- [当日官方 App Server 文档](https://developers.openai.com/codex/app-server/)
  说明新的持久化本地 thread 默认使用分页；显式指定 history mode 仍是单独的实验选项。
  读取历史与恢复执行具有不同语义，不能为了显示一个旧会话就无条件触发较重的 resume 流程。

一个重要反例是 legacy 分支：本地 `../codex/codex-rs/app-server/src/request_processors/thread_processor.rs:3123`
仍明确说明，此分支分页减少网络输出，但每次请求仍会完整重放 rollout，等待独立的 turn metadata 索引。
公开的[版本固定源码](https://github.com/openai/codex/blob/e3465b4/codex-rs/app-server/src/request_processors/thread_processor.rs)
及 [issue #33786](https://github.com/openai/codex/issues/33786)也提供了该历史问题的证据。
issue 中的机器、时延和内存数字是报告者的观测，不能代表所有 Codex 版本。
对 Ash 而言，必须分别检查“输出是有界页”和“后端取得该页的工作量是否有界”。

本次没有找到上述团队公开推荐通过 Protobuf、rkyv 或共享任意 JS 对象来消除 Desktop UI 复制的证据。
Codex 包内的 ACK／IPC 分片分析仍属于本仓库先前的安装包调查，不能改标为团队在 X 上公开说明。

### 14.3 对照 Ash 后，新增加的优先检查项

本轮源码核对发现：

1. `ChatMarkdownContentPart.tryIncrementalUpdate` 第 49 行仍进入完整的 `render`；第 71 行调用
   `markdownRenderer.render(markdown, ...)` 后，才计算新节点指纹并复用旧 DOM。
   因此节点复用不等于已避免全文解析、净化和新节点构造。
2. 第 89～108 行遍历新旧节点并计算内容指纹，第 110 行起逐个调用 code block 的 `render`。
   需要测量调用频率、处理文本量，以及 code block 内部是否真正重做分词／布局；不能只从入口调用推断重活次数。
3. 下游标准 renderer 的 `src/ash/base/browser/markdownRenderer.ts` 还具有完整输入的 lexer 路径。
   流式长回复应检查每次 delta 的累计处理量，尤其是已结束段落、增长中的代码围栏、表格和后续内容修正。
4. `read_session_thread_history` 的有界分支进入 `agent_runtime().read_thread_history`。
   下一轮继续追到实际存储／快照 owner，确认页成本不会随全部历史反复增长，并量化 read、subscribe 和后台刷新是否重复做同一工作。

上述是源码证据与待验证假设，没有运行新的 Chat 场景，不能报告 Ash 已存在可量化的 75% 或数倍回归。
建议在第 13 节的传输／校验候选之外，优先补一个代表性的“长文本＋代码块持续流式输出”场景，
将全文 lexer 调用数、累计输入字符数、code block 实际更新、布局和每帧耗时一起记录。
若证实每个 chunk 重做前缀，则冻结已完成块并只更新不稳定尾部；必须同时覆盖 provider 修正、未闭合围栏、
Markdown 净化、数学内容、选择、焦点和代码模型生命周期。

这条消费端路径可能比继续压缩几个毫秒的 codec 更影响日常流畅度，具体优先级由 Ash 的端到端 profile 决定。

## 15. P1：流式 Markdown 只处理变化尾部（2026-10-17）

本节实测并处理第 14.3 节的重复解析问题。该节行号对应优化前的 `dcf19711b`，
不能再作为当前实现的入口行号。本轮调研第 12～14 节已单独提交为 `dcf19711b`；
以下代码、测试和测量记录属于随后实施的增量 Markdown 优化。

### 15.1 实现与保留的行为

修改仍由 `chatContentParts/chatMarkdownContentPart.ts` 的 `ChatMarkdownContentPart` 拥有，
生产调用方仍为 `ChatListWidget.render → tryIncrementalUpdate`，没有新增协议、Worker 或公开入口。

- 使用现有 Marked tokenizer 确定顶层块边界，保留已完成块的 DOM、净化结果、链接装饰和异步资源生命周期。
  每次从最后一个可变块重新分词、渲染；末块即使带空行也继续可变，允许列表变松、缩进代码续接、
  Setext 标题、表格和不完整行内语法继续改变。只有当前末块使用 `fillInIncompleteTokens`。
- 普通、未缩进的顶层开放代码围栏直接更新已有 `CodeBlockPart`，不再为每段代码生成 HTML、净化并重建占位节点。
  检查从上一次未结束行开始的新输入，识别跨 chunk 的闭合符；遇到可能闭合的围栏，交回 tokenizer。
  四反引号、较长闭合围栏、错误闭合行以及随后更正均经过逐字符对照。
- 内容修正从第一个变化块及其前一个块失效，允许原有块与新的缩进续行合并；相同完整块可以跨位置复用，同文段落按出现次数消费。
  未改变的普通节点还可通过净化后的指纹保留。代码模型继续按原有代码块序号拥有，修正不会另建平行业务状态。
- 保留 DOM 正向／反向选择、代码模型选择、工具栏焦点和滚动位置。隐藏时仍释放代码模型，更新源文本，
  再次显示时恢复；移除回复时释放模型、图片对象 URL、公式请求和监听器。
- 片段保留标准 renderer 自己的链接与资源 owner；没有把异步节点搬到已释放的 render 里。
  片段容器使用 `display: contents`，由响应根保留 `.ash-markdown` 样式，首尾间距与完整渲染一致。
  四种主题的实际块位置和高度对照误差小于 1 px。
- 已完成代码块不再为每次后续文本更新而重新调用 `render`；代码操作通过同一响应上下文读取最新 Markdown，
  避免每个块各自保留旧的完整回复字符串。链接操作也取得当前响应上下文。
- `codeBlockPart.ts` 对围栏 info 先查已注册 ID，再按语言名称解析，最后回退纯文本。
  空 info 和流式输入中的反引号不会再误入要求合法语言 ID 的严格查询并抛错。

以下输入保留完整渲染：后置／嵌套链接引用定义、HTML 支持、自定义 Marked 扩展、CRLF 归一化、
显示公式的潜在跨段闭合，以及包含公式的消息。公式需要同一消息内有序批次和宏作用域，不能按段分别求值。
元数据中的 trust、HTML、图标、alert 或 base URI 变化会失效保留结果；超大输入继续经过标准 renderer 的大小限制。
完整回退仍复用可保留的普通节点和既有代码模型，但可能重新解析全文。

### 15.2 相同输入的前后对比

环境：Apple M5、24 GiB、macOS 27.0.1、Node 24.21.0、Chromium 149.0.7827.55。
使用既有 `chatTranscript.integration.ts` 页面和真实 `ChatListWidget`／代码编辑器，
前后使用相同 fixture、样式、分块、计时器和可见完成断言。基线生产代码取自 `dcf19711b`，
在本 checkout 临时替换本任务拥有的三个生产文件完成测量，随后逐字恢复优化文件并核对 SHA-256。
其他任务的改动没有进入本次提交或替换范围。

每组完整文本均分成 128 次累计值更新，每 8 次更新等待一帧；每组 1 次预热、7 次有效样本。
输入构造、清空旧回复和强制 GC 位于计时区间之外。测量从第一次更新到最后一次更新后两个 animation frame，
同时断言末段确实为 `Final visible marker.`，代码块数量分别为 0／12／1。
这属于浏览器组件证据，没有测量 App Server、IPC、完整 Chat model 或 Desktop 启动／RSS，也不是 GPU 完成呈现的时间戳。

| 场景                                    | UTF-8 字节数 | 累计同步更新 ms，前 → 后 |  减少 | 到末次更新后两帧 ms，前 → 后 |
| --------------------------------------- | -----------: | -----------------------: | ----: | ---------------------------: |
| 96 段文本，含链接、行内代码和中文       |       62,027 |          2,848.7 → 152.6 | 94.6% |              2,900.1 → 175.1 |
| 12 组文本及 TypeScript 围栏，每块 36 行 |       23,279 |            682.6 → 107.9 | 84.2% |                749.2 → 158.1 |
| 单个持续增长的 TypeScript 围栏，800 行  |       30,234 |             190.1 → 86.4 | 54.6% |                223.3 → 150.0 |

以上为 7 次样本的中位数。同步更新耗时范围分别为：文本 2,841.2～2,856.6 → 147.8～156.7 ms；
混合 672.7～697.3 → 103.1～108.6 ms；单围栏 188.2～200.6 → 84.4～90.1 ms。
同步耗时包括尾部分词、标准 Markdown 渲染、代码模型更新和列表同步布局，不等于单次 chunk 耗时。

| 场景   | 单次最大同步更新 ms，中位数，前 → 后 | 累计 lexer 输入字符数，前 → 后 | 标准 Markdown render 次数，前 → 后 | 7 次样本的 ≥50 ms 长任务总数，前 → 后 |
| ------ | -----------------------------------: | -----------------------------: | ---------------------------------: | ------------------------------------: |
| 文本   |                           49.5 → 3.1 |            7,411,280 → 193,775 |                          128 → 224 |                                98 → 0 |
| 混合   |                           11.3 → 4.7 |             2,951,585 → 84,008 |                           128 → 76 |                                50 → 0 |
| 单围栏 |                            3.6 → 3.1 |             3,870,078 → 61,137 |                            128 → 4 |                                 0 → 0 |

lexer 计数通过 `Lexer.lex` 覆盖边界分词、标准 parse 和不完整 token 补全的重复 pass；
字符数按 JS 字符串长度计，不能当作 UTF-8 字节数。文本的 render／lexer 调用次数反而增加，
因为分块首次完成时需要独立渲染，但每次输入变小，累计 lexer 字符数减少 97.4%。
混合和单围栏分别减少 97.2% 和 98.4%，所以不能用函数调用次数单独判断收益。

标准 `ChatContentMarkdownRenderer.render` 内累计耗时为文本 2,401.5 → 98.4 ms、
混合 358.6 → 37.6 ms、单围栏 63.1 → 2.0 ms。
CDP `TaskDuration` 增量为 2,902.2 → 175.4、755.0 → 153.8、216.0 → 113.4 ms。
`MutationObserver.childList.removedNodes` 条目数分别为 12,477 → 381、4,239 → 335、889 → 257；
这不是递归销毁的全部 DOM 节点数。

完整原始样本、日志、源文件摘要和汇总保存在忽略目录：
`.build/investigations/chat-incremental-markdown-p1-2026-10-17/{before,after,summary}.json`、
`production-sources.json`、`fixture-sources.json`、`unit.log`、`behavior.log`。
早期缺少基础样式的基线和围栏快速路径未启用的中间样本仅作排查记录，没有混入上述最终统计。

### 15.3 验证与复现

- 单元测试 55 项通过，包括新增的段落、标题、表格、列表、alert、后置／嵌套引用、跨段公式、Unicode、
  CRLF、插入／重写／清空、trust 变化、输入大小限制、链接当前上下文和消息内公式宏批次。
  原有异步公式取消、图片加载／释放、净化与 provider 生命周期测试继续通过。
- 浏览器行为测试 13 项通过：九组围栏／缩进代码／任务列表逐字符与完整渲染对照，代码复制／插入／撤销／新文件，
  选择和焦点，英语与简体中文，隐藏后更新／恢复／释放，图片授权读取和滚动位置，以及四种主题的几何一致性。
- 前后性能测试各通过 1 项，每项包含 3 组预热和 21 次有效样本。
  浏览器 integration TypeScript 检查通过；性能 test 的原型 instrumentation 在 `finally` 中恢复。

```sh
pnpm test:unit:prepared --run src/ash/workbench/contrib/chat/test/browser/widget/chatContentMarkdownRenderer.test.ts --workers 1
pnpm test:browser:integration:prepared chatTranscript.integration.spec.ts --project=chromium --grep 'streaming Markdown (retains|fences|corrections|block layout)|streamed workspace images|Response code blocks'
ASH_MARKDOWN_BENCHMARK_LABEL=after pnpm test:browser:integration:prepared chatTranscript.integration.spec.ts --project=chromium --grep 'streaming Markdown controlled rendering comparison'
```

调研阶段提交文档前执行 `just commit-check origin/main`，在其他任务的 10 个未暂存文件格式错误处提前退出。
当时的调研提交只包含文档；文档的定向格式检查以及工作区和暂存区 whitespace 检查通过，随后完成本地提交，未推送。

### 15.4 剩余成本与适用范围

此方案对由多个已完成块组成的增长回复收益最高。它没有使任意 Markdown 达到恒定成本：单个巨大段落、
不断增长的列表／表格、缩进或嵌套代码，以及上述全局语义回退仍可能反复处理较大的尾部。

单个大代码围栏已基本消除重复 Markdown 工作，但 `CodeBlockPart` 仍比较完整代码文本，
变化时调用现有 `TextModel.setValue`，随后更新编辑器配置和布局。这些同步成本没有被 Worker 隐藏，
也没有在本轮改为编辑器增量写入。单围栏同步工作下降 54.6%，显示完成时间只下降 32.8%，
还受固定的逐帧投递节奏限制；不能把 Markdown 子阶段下降 96.8% 宣称为整条响应同幅度加速。

每个保留片段增加一个无布局盒的容器及其 render 生命周期。本轮验证释放语义，没有测量整机内存收益。
后续若继续优化，应先量化代码模型替换和布局，再决定是否让代码模型接收真正的增量编辑、合并配置／布局更新，
或为巨大单块设置工作预算。传输编码、Protobuf 和共享内存不会自动消除这些消费端工作。

## 16. Worker 回传与领域保留堆实测（2026-10-18）

结果支持先减少重复正文，再考虑专用大对象表示。20 Turn 常规页的回传成本很小；已经加载的长历史中，
Thread 和 transcript 各持有一份正文才是显著的常驻成本。本轮只测量和评估，未修改产品实现。

### 16.1 场景、边界与采样

环境为 Apple M5／macOS arm64、Node 24.21.0、Playwright Chromium 149.0.7827.55，
使用当前工作树的非压缩 Vite 产物。基准 HEAD 为 `2217d590f08cd0b2507bddb505461a19b67e9f41`；
当时还有未提交的 Worker 服务与恢复改动，不能用该 commit 单独代表本次源码。原始记录保留工作树状态，
产物及 source map 的 hash 见本地证据 manifest。

分开测两种边界：

- **回传阶段**：Worker 先调用生产 `decodeAppServerFrame` 完成解析、校验和路由，再保留结果。
  计时只发一个小命令，让它回传已校验的对象；同一 Worker 交错发送空 ACK 作为调度对照。
  每种场景先预热两对，再测 21 对。检查每个返回的正文、Item ID 和数值元组，断言在计时端点之后执行。
  ACK 没有返回业务值，只用于解释调度成本，不能视为可用替代方案或端到端优化收益。
- **保留堆**：受控 transport 提供合成响应，经过生产 `AppServerProtocolClient`、
  `createAppServerFrameDecoder`／通用 `WebWorkerService`、`createAppServerAgentThreadService`、
  `ChatService` 和 `ChatWidgetModel`。实际按模型要求的 20 Turn 页读取，调用 `loadOlderHistory`
  到目标数量，再通过合法的 `turnCompleted` 通知触发 20 次只读刷新。会话、目录、模型目录、
  Changes 和队列等外围依赖由场景固定；不执行工具、不连接真实 provider。

堆场景使用每 Item 4096 个 ASCII 字符，带唯一前缀；Thread／transcript 的相同 Item 正文相等。
20、128、2048 Turn 各运行三轮加载／刷新／释放。另测完整 2048 Turn 返回值的 DTO 与领域适配结果，
以及三轮不经过实验性共享的长历史释放。断言完整数量、逐 Item 正文一致、列表投影数量、ready 状态、
无在途 transport 请求和订阅释放；WeakRef 探针不持有模型或首个 Item。

计时期间不强制 GC、不拍快照。堆检查点在异步工作结束后，通过 Renderer CDP 分两次 GC，
读取 `Runtime.getHeapUsage.usedSize`，并在代表性状态保存八份快照。没有保留用于生成响应的 Renderer
全量 wire 字符串或原始 DTO；响应源留在独立的测试服务器进程，排除在 Renderer 指标之外。

这是生产消费者的浏览器组件证据，尚未覆盖 Electron／Main／Rust、DOM／Markdown／编辑器模型、
Worker isolate 的保留堆、瞬时分配峰值或进程 RSS。以下 MiB 均为 1024² 字节，不能外推为整机内存收益。

### 16.2 回传成本：小页与大对象应分开

下表的往返从 Renderer 发出小命令开始，到其收到对象消息的回调入口结束；包括命令调度、Worker 发送、
接收端对象重建及回调调度。发送列是 Worker 同步 `postMessage` 调用耗时，包含在往返内，不能相加。
JSON 字节数用于标识同数据集，并不是结构化克隆的真实字节计数。

| 数据集                                  | JSON 字节数 | Worker 同步发送中位数 | 回传往返中位数 / p95 |
| --------------------------------------- | ----------: | --------------------: | -------------------: |
| 20 Turn × 4 KiB 正文                    |     177,221 |             约 0.1 ms |         0.1 / 0.2 ms |
| 20 Turn × 16 KiB 正文                   |     668,741 |                0.1 ms |         0.2 / 0.3 ms |
| 128 Turn × 4 KiB，一次回传压力场景      |   1,131,168 |                0.2 ms |         0.5 / 0.8 ms |
| 2048 Turn × 4 KiB，一次回传压力场景     |  18,107,467 |                5.2 ms |        9.5 / 14.4 ms |
| 单 Item 8 MiB 正文，两份正文合计 16 MiB |  16,778,516 |                1.8 ms |         3.6 / 5.5 ms |
| 65,536 个六数值元组                     |   1,670,907 |                4.1 ms |         7.0 / 7.3 ms |

ACK 对照的往返中位数低于或接近 0.1 ms 的计时分辨率；同序号配对差值中位数依次为
0.1、0.2、0.4、9.5、3.6、7.0 ms。跨 Worker 的 `timeOrigin + now()` 还受时钟量化影响，
原始 delivery 样本甚至有接近零的负值；小场景以上表同一 Renderer 时钟的往返为准，不用跨时钟差推导纯复制耗时。
大场景的往返也不等于 UI 连续阻塞时长，未从这些结果推算物理 memcpy 次数。

**当前 20 × 4 KiB 页本身小于 256 KiB，生产 decoder 走同步路径，不启动 Worker。**
表中人为让它走 Worker 是回传对照。20 × 16 KiB 页超过阈值，但回传仍约 0.2 ms。
当前 Chat 首次订阅和刷新都请求 20 Turn，2048 Turn 一次返回仅代表未指定历史窗口的契约及压力场景，
不能据此宣称常规打开 Chat 会付出 9.5 ms 回传成本。

数值元组只有约 1.6 MiB，成本却明显高于 16 MiB 的少数长字符串；对象数量和形状也决定成本。
这支持按专用数据类型评估 packed buffer，而不是给通用 Worker 消息统一换协议。

### 16.3 保留堆：重复正文比 Item 外壳更值得处理

相对每轮已释放的预热基线，加载后存活 Renderer JS 堆增量的三轮中位数如下。
“刷新增量”比较第 20 次刷新和刚加载完成，代表相同已加载历史规模。

| 已加载 Turn 数，每个正文 4 KiB | 加载后 JS 堆增量 | 20 次刷新后额外增量，中位数 |
| ------------------------------ | ---------------: | --------------------------: |
| 20                             |         0.19 MiB |                    约 0 KiB |
| 128                            |         1.06 MiB |                     0.6 KiB |
| 2048，分 103 页读取            |        16.85 MiB |                     7.6 KiB |

小场景第一轮刷新另有约 123 KiB 增量，释放后仍比基线多约 136 KiB；后两轮没有同幅增长。
它与一次性的运行时／代码预热相容，不能直接定为泄漏。长历史三轮刷新增量为约 3.4～10.9 KiB，
没有随 20 次刷新保留额外的完整历史副本。

在同一 Renderer isolate 的长历史快照中，模型的直接字段路径为：

```text
ChatWidgetModel → _thread → turns[] → items[] → text
ChatWidgetModel → transcriptEntries[] → item → text
```

两条路径各有 2048 个 Item，合计 4096 个独立 Item 对象和 **4096 个独立正文 string 节点**；
正文节点去重后的 self size 合计 16,826,368 B（16.05 MiB）。20 次刷新后仍是相同数量。
这里计算的是直接拥有的正文节点 self size，没有累加重叠可达子图或声称得到整个模型的 dominator retained size。

完整 2048 Turn DTO 单独持有时堆增量约 17.44 MiB，领域适配结果单独持有时约 17.31 MiB；
两份快照都只有 4096 个正文 string 节点。适配后并未再保留第三、第四份完整正文。
源码也表明 `toThreadItem` 的普通消息转换和 `cloneTranscriptEntry` 复制对象外壳，复用各自的 string 值；
两份正文来自 Thread／transcript 各自的 wire 字段，不能把所有成本归咎于领域 adapter 的 spread。
上述单独持有比较不测适配瞬间 DTO 与结果共存的分配峰值。

为估算减量上限，在完成上述断言后，仅对可丢弃的合成模型做两步内存实验：

| 实验步骤                                 | 三轮堆下降中位数 | 快照变化                                         |
| ---------------------------------------- | ---------------: | ------------------------------------------------ |
| 同一 Item 的相等正文指向同一个 string 值 |         8.02 MiB | 正文节点 4096 → 2048，self size 16.05 → 8.02 MiB |
| 在正文已经共享后，再共享 Item 对象       |         82.9 KiB | Item 节点 4096 → 2048，正文节点不再减少          |

正文共享约占当前合成长历史模型增量的 48%。这只是收益上限实验，直接修改私有模型字段，
没有实现可上线的更新、版本和生命周期契约，也没有测协议改变后的加载时间。

释放另有三轮**未经过上述共享修改**的验证：2048 Turn 模型完成 20 次刷新后 dispose 并移除场景引用，
订阅数和在途请求归零；模型和首个 Item 的 WeakRef 全部失效，释放后堆增量分别为 24、2664、3396 B。
代表性快照中 `ChatWidgetModel` 实例与测试正文节点都归零。这一场景没有发现历史载荷持续保留，
不代表已经验证真实 Desktop 隐藏页、控件池或所有后台任务的释放。

### 16.4 优化优先级与证据

1. **值得优先验证正文只保留／传输一次。** 当前已有限页读取，下一步应在同一 owner 内评估按完整
   session／thread／turn／item 身份、durable sequence／transcript revision 以及内容相等性复用不可变领域正文。
   候选范围应有界并随加载历史释放；不新增全局无界 intern 表，不把 transport DTO 变成权威状态。
   wire 中正文只传一次可同时减少解析和克隆输入，但需先定义引用解析、瞬态 Item、翻页、回放和审批契约。
2. **Item 外壳复用优先级低。** 该数据集在正文共享后只再省约 0.08 MiB；直接共享可变对象会增加
   更新隔离的推理成本，尚无理由为这点收益改变通用生命周期。
3. **保留通用 Worker 现有对象回传。** 常规小页不会进入 Worker，较长正文的 20 Turn 页回传仍在亚毫秒级。
   第 13.2 节 ACK 后 UI 重新解析的方案不因本次回传成本就自动成立，仍需一起测 UI 解析、长任务及峰值。
   大规模数值元组可单独评估 Transferable packed buffer；本轮尚未验证该替代格式的端到端收益。
4. **当前不做推测性的历史泄漏修复。** 刷新没有积累完整副本，未修改的合成长历史可释放。
   DOM、编辑器模型、隐藏会话及 Desktop 峰值继续由完整调用链测量负责。

本轮未改产品代码。最终运行零场景错误，完成六组各 21 对有效回传样本、三组各三轮领域负载、
三轮 DTO／领域持有比较、三轮独立长历史释放、75 个 GC 后检查点及八份快照。
本地原始证据目录为 `.build/investigations/worker-return-heap-2026-10-18/`：
`run.mjs`、`fixture.ts`、`worker.ts`、`results.json`、`summary.json`、`analyze.mjs`、`run.log`、
`evidence-manifest.json` 和 `*.heapsnapshot`。`partial-*.json` 保留早期场景构造错误，
`*-completed.json` 保留校准运行；它们不混入最终表格。脚本及大体积快照按调查约定保留在 ignored 目录。

```sh
node .build/investigations/worker-return-heap-2026-10-18/run.mjs
node .build/investigations/worker-return-heap-2026-10-18/analyze.mjs
```

## 17. 已实施：同快照的不可变领域正文复用（2026-10-18）

第 16 节的收益上限已经落实到现有领域适配边界。`createAppServerAgentThreadService` 的 read／subscribe，
以及 Session 初始订阅的每份 Thread projection，先转换 canonical Thread，再转换配套 transcript。
转换中的临时索引只包含这一份领域 Thread 的 Item，返回结果后即释放，没有跨请求、跨窗口或全局正文缓存。

复用条件同时满足：session ID、thread ID 和 durable sequence 相同，entry／Item 的 turn ID、Item ID、
Item 类型对应，entry 非 transient，而且两份 `text` 完全相等。只让 transcript 的不可变 string 值引用
canonical 领域正文；两侧 Item 对象及 phase、富内容等可变外壳仍分别转换。transcript revision 保留原值，
流式通知独立转换；不同持久版本或正文不相等时保留各自值，不从旧值推导新状态。

这把复用范围限制在一次已校验快照，空间为该快照中 Item 数量的临时索引；Code 的普通页仍为 20 Turn，
Cowork 保留既有完整历史契约。模型对分页、历史前缀和实时 revision 的接受顺序继续由原 owner 决定。
Code／Cowork dispose 同时清掉 canonical Thread 和 transcript，Code 也清掉分页边界；
既有 generation／disposed 守卫阻止迟到响应重新放回正文。没有改 wire schema、后台权威状态或 Worker 消息协议。

### 17.1 相同场景的前后验证

沿第 16 节原脚本、工作负载、三轮采样、75 个 GC 后检查点与八份快照，分别运行优化前后产物。
优化前构建通过只读 loader 使用保存的两个原始源文件，没有替换工作区文件；其余依赖使用同一当前工作树。
每 Item 仍是 4096 个 ASCII 字符，按实际 20 Turn 页加载到目标数量，20 次刷新后再验证释放。
计时期间不强制 GC，原始 DTO 不作为额外领域状态保留，最终两组均无场景错误。

| 场景，加载后的存活 Renderer JS 堆增量中位数 |     优化前 |    优化后 |
| ------------------------------------------- | ---------: | --------: |
| 20 Turn                                     |  0.185 MiB | 0.107 MiB |
| 128 Turn                                    |  1.060 MiB | 0.558 MiB |
| 2048 Turn，103 页                           | 16.853 MiB | 8.807 MiB |
| 单独持有完整 2048 Turn 领域适配结果         | 17.318 MiB | 9.342 MiB |

长历史模型减少约 **8.05 MiB／47.7%**。快照直接确认两条领域路径的 Item 外壳仍有 4096 个，
正文 string 节点从 4096 降到 2048，去重后的正文 self size 从 16,826,368 降到 8,413,184 B。
优化后再执行第 16 节实验性的正文共享不再减少这份正文，说明收益已经由生产调用链取得。
DTO 控制场景前后仍约 17.44 MiB，本次没有减少 wire／Worker 克隆的两份输入。

20 次刷新后，2048 Turn 的额外堆增量中位数为前 7.6 KiB、后 7.9 KiB，没有堆积完整副本。
独立、不做实验性字段修改的三轮加载／刷新／释放后，优化后的堆与基线差值分别为 1600、2664、1732 B；
模型和首个 Item 的 WeakRef 全部失效，代表性释放快照的模型实例和测试正文节点归零。
这是领域保留堆改善，不是 Worker isolate、瞬时峰值、DOM／Markdown／编辑器资源或进程 RSS 的测量。

新增的整场加载计时包含合成 HTTP、翻页和固定 30 ms settle，仅有三轮：20 Turn 中位数约 35.5 → 36.6 ms，
128 Turn 42.3 → 46.7 ms，2048 Turn 133.5 → 129.8 ms。它不足以证明加载提速或稳定回归；
本次收益结论以同状态堆和具体正文节点为依据，不把约 48% 的领域堆下降换算成响应时间收益。

### 17.2 更新、隔离与释放覆盖

新增边界／模型用例覆盖三种快照入口、对象壳与 transport 脱离、不同身份／持久版本／Item 类型／正文、
transient 条目、新版本与流式通知独立、较旧只读结果不能覆盖更高 transcript revision、同 ID 的 A-B-A 导航，
以及 Code／Cowork dispose 后迟到结果不得回灌。普通字符串的值相等断言不能证明物理共享，
这部分由上述快照中的独立节点数量验证。

六个相关单测文件同一次编译运行，共 191 项通过，其中正文适配与模型两个文件 98 项。
同组取消、解码和 GitHub 消费者测试为第 19 节提供覆盖。运行命令：

```sh
pnpm test:unit:prepared --run src/ash/platform/agentHost/test/browser/appServerAgentService.test.ts --run src/ash/sessions/test/browser/chatWidgetModel.test.ts --run src/ash/platform/agentHost/test/browser/appServerProtocolClient.test.ts --run src/ash/platform/agentHost/test/browser/appServerFrameDecoder.test.ts --run src/ash/sessions/contrib/github/test/browser/githubService.test.ts --run src/ash/workbench/contrib/github/test/browser/githubRepositoryActions.test.ts
node .build/investigations/worker-body-reuse-before-2026-10-18/run.mjs
node .build/investigations/worker-body-reuse-after-2026-10-18/run.mjs
```

本地证据为 `.build/investigations/worker-body-reuse-{before,after}-2026-10-18/` 中的脚本、
`results.json`、`summary.json`、产物 source map 与快照；原始源码、准入记录和前后对照 manifest 位于
`.build/investigations/worker-body-reuse-2026-10-18/`。

## 18. 已实施：代码围栏增量更新与巨大尾部成本（2026-10-18）

沿已有 `ChatListWidget → ChatMarkdownContentPart → CodeBlockPart → TextModel / CodeEditorWidget` 浏览器组件场景分解同步成本。三个场景分别是 800 行围栏（30,234 UTF-8 字节）、8,000 行围栏（317,834 字节）、含链接／粗体／行内代码的单个长段落（10,103 字节）。每组128次累计更新、每8次等待一帧，以完整正文、代码模型全文和末次更新后两帧断言完成；每组1次预热、7次有效样本。GC在计时之外；配置、模型、布局和 Markdown/lexer计时存在嵌套，不能相加为总时间。这没有测App Server、Main IPC、Desktop整机收益。

实现仅在已有只读代码模型收到**以当前模型全文为前缀**的新文本时追加增量，复用模型的现有PieceTree和内容变更链。只有当前模型为LF且新正文不含CR才追加；修改／缩短及CRLF／混合EOL继续reset，以保留原来的EOL探测和归一化。语言、选择、隐藏／重建、复制和释放由原owner负责。没有增加缓存、transport状态或新公共API。配置与布局是否优化按新测量数据决定；本批不因重复调用次数就增加配置缓存。

最终结果为7次有效样本的中位数，阶段计时在同一进程内计算：

| 场景         | 累计同步更新 ms，前 → 后 | 模型写入 ms，前 → 后 | 到末次更新后两帧 ms，前 → 后 | CDP TaskDuration ms，前 → 后 |
| ------------ | -----------------------: | -------------------: | ---------------------------: | ---------------------------: |
| 800 行围栏   |    87.3 → 54.8（−37.2%） |          71.3 → 39.3 |                150.0 → 150.1 |                 117.5 → 83.2 |
| 8,000 行围栏 |  399.5 → 104.7（−73.8%） |         371.6 → 69.2 |      444.8 → 158.7（−64.3%） |                449.8 → 153.0 |
| 单个长段落   |        2,776.5 → 2,765.1 |       不涉及代码模型 |            2,808.3 → 2,791.6 |            2,793.7 → 2,784.9 |

模型写入前为`setValue`、后为`applyEdits`，均含其同步内容通知；配置／布局的中位总计分别只有0.8～1.2ms／2.0～2.4ms，因此不增加另一份配置缓存或布局调度。本次不是纯字符串复制微基准：实际生产模型、编辑器和列表执行了完整更新。

围栏的127次全文替换变成127次末尾插入，800行累计模型输入字符1,946,334 → 29,970；8,000行20,494,289 → 315,323（−98.5%）。字符数按JS字符串长度（UTF-16 code units）计，只表示模型API实际输入，不代表底层物理复制字节。8,000行7样本中的≥50ms长任务合计3 → 0；800行前后均为0。小围栏可见完成时间受固定的逐帧投递节奏限制，不能把同步更新改善直接写成相同幅度的响应显示收益。

单段落的累计lexer时间仍约2.46～2.49s，前后两组的7次样本各合计84个长任务、最长460～467ms；围栏优化没有改善它。8次连续更新形成的task会累积多个单次同步尾部操作。其准确后续是对巨大可变段落／列表／表格的分词与投递预算单独设计；仅减少围栏输入、Worker编码或重复配置调用不能解决。由于仍需保持链接／行内语义，不能用任意切段或降低输入上限掩盖成本。

验证：原13项真实Chromium行为测试通过；补EOL门禁后两项追加／EOL回归通过（共14个不同用例），新EOL用例直接验证CodeBlockPart的空→CRLF、CRLF／混合EOL→LF、清空再填、归一化模型全文与原样复制，并断言模型真正dispose。其余测试覆盖追加变更范围、全文、修正／缩短、无undo历史、复制、隐藏更新／恢复及移除释放，也复跑逐字符Unicode／围栏／列表对照、选择和焦点、配置、英语／中文及四主题几何。baseline及最终after性能测试各通过1项（共42个有效计时样本）；EOL门禁前的中间after另留作开发记录，不混入最终统计；每次命令先通过浏览器integration TS检查。三文件格式与whitespace检查通过。浏览器worker及headless进程在末次完成后核查不存在。

复现命令：

```sh
ASH_MARKDOWN_BENCHMARK_LABEL=after pnpm test:browser:integration:prepared chatTranscript.integration.spec.ts --project=chromium --grep 'streaming Markdown remaining consumer costs'
pnpm test:browser:integration:prepared chatTranscript.integration.spec.ts --project=chromium --grep 'streaming code updates|streaming Markdown (retains|fences|corrections|block layout)|Response code blocks'
```

已完成原“大代码围栏setValue、配置／布局与巨大单块尾部预算”的测量，并实现有证据的围栏追加优化；巨大单块的后续治理仍应作为已量化的剩余项，不宣称整个数据链路完成。

原始证据：`.build/investigations/data-consumer-costs-2026-10-18/`。早期161,303字节单段落未完成暖机，已中断；其孤儿renderer被发现并按准确进程身份清理。与孤儿CPU重叠的后续成功功能样本标为`background-cpu-invalid.*`，不用于最终统计。未修改产品输入上限。

## 19. 已实施：取消后的只读结果退休（2026-10-18）

修复沿现有真实调用链落地：关闭或切换 GitHub 读取消费者 → CancellationToken → 既有 operationId / `github/cancel` → AppServerProtocolClient 的原 pending slot → 原 response / deadline 完成。取消只读读取后，收帧时已标记取消的响应仍按原顺序消费、验证 JSON-RPC envelope / 已发出 ID，但不递归校验已无消费者的 payload；Worker 只回传 `{ kind: 'retiredResponse', id }`。合法迟到响应回收原 pending slot，并按取消错误结算。

signal 的用途是退休结果 payload，Promise 仍跟随原响应或原 deadline；这保留了 Session GitHub consumer 在远端请求退休之前合并 refresh 的现有约束。没有新增 tombstone map、调度器、自动重放或写请求合并：取消 slot 继续占原 128 pending 上限，原 deadline / disconnect / reconnect 清理仍由协议客户端单一 owner 负责。GitHub 写入不传 signal，取消后仍以原响应判断已提交或不确定的结果。

收益范围是可确定的处理减量，不是本轮新延迟/堆测量：在取消发生早于帧进入 decoder 时，可跳过 schema 遍历及完整 Worker 对象回传；已送入 Worker 的响应不能撤回该次 schema / clone 成本，主线程仍拦截发布并回收 slot。JSON 解析、已有字节传输与同连接排队成本仍存在。协议本身未新增 client→server 通用 `$/cancelRequest`，物理中止继续使用 GitHub 已支持的 domain cancel。

验证：`pnpm test:unit:prepared` 同次编译运行 AppServerAgentService、ChatWidgetModel、AppServerProtocolClient、AppServerFrameDecoder、Session GitHubService、GitHubRepositoryActions 六文件，共 191 passing。取消链自身与现有消费者覆盖合计 93 passing：ProtocolClient 56、FrameDecoder 9、Session GitHubService 17、RepositoryActions 11；其中新增 7 场景覆盖取消帧与后续活跃帧的消费顺序、乱序响应、已进 Worker 后取消、128 slot 额度、deadline / reconnect、发送前已取消与完成后 signal listener 释放、GitHub 只读取消及写入恰好一次/原 outcome。原 150 个通知合并直到 remote 退休的测试继续通过。两解码路径均断言取消响应仅返回 ID，并拒绝未发出的取消 ID、重复响应及非法 envelope。两个解码/协议套件启用了 disposable tracker。

原始日志：`.build/investigations/data-flow-lifecycle-2026-10-18/unit-final.log`。5 个改动文件 formatter 和 `git diff --check` 通过。第一次全测试编译只因并行正文测试 fixture 缺 toolMode 失败，owner 补全后上述同一入口通过。

### 19.1 后端 producer / writer 测量边界

本轮只读确认已有 telemetry：`rpc.resource_wait_ms`、`rpc.execution_queue_wait_ms`、`rpc.execution_ms`、`rpc.outbound_queue_wait_ms`（request_processing.rs）及 `rpc.write_ms`（request_dispatch.rs）。execution 指标包含 dispatch / 结果构造 / JSON serialization，尚无这三段独立配对样本；outbound queue 指标覆盖已序列化响应等待输出准入与队列投递。

共享 request admission 在结果序列化后、deliver 前释放，避免慢连接占据跨连接执行额度；本连接输出 byte lease 从 `OutboundSender.send` 成功取得额度到 writer 完成保持，但 response.raw 在等待这份 lease 之前已经构造，因此不能把输出字节额度当作全部结果构造内存的上限。单 writer 仍按整行输出，control 执行额度独立不意味着输出能抢占已开始的大行。已有后端 lease 释放 / writer 关闭唤醒 producer 的行为测试不构成本次性能采样。

没有在本轮采集 Rust producer / writer 的运行数据，也没有跨进程单调时钟与 Renderer request identity 的配对实测；这些 TODO 保留。当前完成的取消切片也不覆盖所有 Thread/transcript refresh、通用 transport 中止或所有大内容按需资源读取。

正文的分页／重连补充回归另有 12 项通过，覆盖有界分页、重叠尾部、旧页退休、较新 streaming revision，以及两个窗口／连接 Worker 注册入口；Renderer 类型检查通过。启动的四组真实场景、nonce 阶段和 CPU 证据见[启动复测](desktop-startup.md#2026-10-18-入口与连接复测)。
