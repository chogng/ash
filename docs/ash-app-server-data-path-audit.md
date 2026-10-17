# Ash app-server 到 Renderer 的大响应链路审计

2026-10-17 对照 [Owl 运行时调查](codex-owl-runtime-investigation.md)，检查 Ash 工作区的真实数据路径，重点是解析、复制、同步派发和背压。先完成源码审计与隔离算法实验，再实施第 7 节的第一批 P1；尚未运行真实 Desktop 场景 profile。

审计基线的结论：Ash Main 已经透明转发字节，避免了 Owl 在 Browser UI 线程完整解析 JSON 的问题。但 Renderer 的 framing 存在可复现的复制放大，完整帧还会重新 UTF-8 编码、同步解析和递归 schema 校验。聊天消费者没有使用后端已有的有界历史能力，进一步放大输入。背压能够限制传输中的字节块，不能等同于限制完整响应处理成本、总内存或控制消息延迟。

**实施状态：三批 P1 已实现。** 第 1～4 节保留 manifest 对应的优化前审计快照；固定页 framing、接收端副本与重复编码见第 7 节；Code Chat 的有界历史、翻页、回放与审批保护见第 8 节；大帧解析与 schema 校验的 Worker、顺序队列及异步 ACK 见第 9 节。后端输出预算、Worker 结果复制和领域应用仍有后续工作。

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

## 5. 优化顺序

这里的 P1／P2 表示本次性能工作的先后，不代表已测得生产事故严重度。首批建议做确定性收益且不改变业务语义的优化，并同步补阶段测量。

表中步骤 1、2 已按第 7 节完成；其余步骤仍未实施。

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
提交前的 `just commit-check origin/main` 因提交外 10 个 TS 文件和 `docs/ash-desktop-architecture.md`
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
