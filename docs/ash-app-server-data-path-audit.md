# Ash app-server 到 Renderer 的大响应链路审计

2026-10-17 对照 [Owl 运行时调查](codex-owl-runtime-investigation.md)，检查 Ash 工作区的真实数据路径，重点是解析、复制、同步派发和背压。先完成源码审计与隔离算法实验，再实施第 7 节的第一批 P1；尚未运行真实 Desktop 场景 profile。

审计基线的结论：Ash Main 已经透明转发字节，避免了 Owl 在 Browser UI 线程完整解析 JSON 的问题。但 Renderer 的 framing 存在可复现的复制放大，完整帧还会重新 UTF-8 编码、同步解析和递归 schema 校验。聊天消费者没有使用后端已有的有界历史能力，进一步放大输入。背压能够限制传输中的字节块，不能等同于限制完整响应处理成本、总内存或控制消息延迟。

**实施状态：第一批 P1 已完成。** 第 1～4 节保留 manifest 对应的优化前审计快照；固定页 framing、接收端副本与重复编码已在现有 owner 中修复，当前实现、测试与前后对比见第 7 节。历史窗口、Worker、JSON.parse／schema 调度和后端输出调整仍是后续候选。

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
