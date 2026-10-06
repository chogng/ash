# Ash API 接口文档规范

> 本文规定 Desktop、CLI 或其他客户端提交 Ash App Server 产品 API 需求时必须包含的内容。  
> ash-rs 是已接受契约的 owner，并据此实现 Rust 协议、handler、typed client、生成类型和测试。

当前已经接受的产品契约见
[`ash-app-server-api.md`](ash-app-server-api.md)。

## 快速理解

这份规范帮助需求提出方把“希望增加一个接口”写成能够实现、测试和长期维护的产品契约。先说明
用户问题和权威状态，再定义方法、字段、错误、取消、幂等和恢复；不能只提交一组 DTO 或方法名。

| 你正在确认什么 | 文档必须给出的答案                                           |
| -------------- | ------------------------------------------------------------ |
| 为什么需要接口 | 用户或客户端要完成的真实任务，以及明确不做什么               |
| 谁拥有状态     | Server、连接、Session、Thread、Turn 或能力句柄中的唯一所有者 |
| 成功意味着什么 | 可观察结果、持久化边界和它不保证的内容                       |
| 失败后怎么办   | 稳定错误、能否重试、取消和迟到结果处理                       |
| 如何安全演进   | 能力协商、版本、生成物和所有调用方同步方式                   |

## 1. 文档头

每份 API 文档必须先写：

```yaml
title: Browser Capability API
status: draft | review | accepted | deprecated
capabilityVersion: 1
owner: ash-rs
rustOwner: ash-rs
requestedBy: desktop
consumers: [desktop, cli]
lastUpdated: YYYY-MM-DD
```

还需说明：

- 解决的问题；
- 不在范围内的能力；
- 权威状态由哪一端持有；
- 哪些客户端需要该能力；
- 当前开发期 breaking-change 与调用方同步更新策略。

## 2. 方法清单

先提供一张完整清单：

| Method                             | Direction       | Consumers    | Side effect | Idempotent | Capability | Summary     |
| ---------------------------------- | --------------- | ------------ | ----------: | ---------: | ---------- | ----------- |
| `session/request` (`createThread`) | Client → Server | Desktop, CLI |         yes |   required | sessions   | 创建 Thread |
| `browser/observe`                  | Server → Client | Desktop host |          no |        n/a | browser    | 观察目标    |

Direction 只能使用：

- Client → Server request；
- Server → Client request；
- Server → Client notification；
- 双向 Resource request。

同一 method 在 in-process、stdio、Unix socket 和 WebSocket 上必须保持相同语义。若某个
transport 不支持该能力，必须通过 initialize capability 明确声明，不能提供绕过 dispatcher
的隐藏 Rust 方法。

## 3. 每个请求必填内容

每个 request 单独一节，包含：

1. method 字符串；
2. direction；
3. 前置条件；
4. capability 与版本；
5. Params 的字段表；
6. Result 的字段表；
7. 所有错误码；
8. deadline 和 timeout；
9. cancellation 行为；
10. idempotency 规则；
11. owner/connection/thread/turn 路由；
12. 成功 JSON fixture；
13. 每类错误 JSON fixture。

字段表格式：

| Field      | Type       | Required | Nullable | Constraints | Meaning     |
| ---------- | ---------- | -------: | -------: | ----------- | ----------- |
| `threadId` | `ThreadId` |      yes |       no | existing    | 目标 Thread |
| `maxBytes` | integer    |      yes |       no | 1..262144   | 最大 chunk  |

`required` 和 `nullable` 必须分开说明。不能用“可选”同时表达字段缺失和 JSON `null`。

## 4. JSON 样例

请求：

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "method": "session/request",
  "params": {
    "commandId": "command_01...",
    "sessionId": "session_123",
    "expectedSequence": 17,
    "request": {
      "type": "startTurn",
      "threadId": "thread_123",
      "input": [
        { "type": "text", "text": "分析当前网页" }
      ]
    }
  }
}
```

成功响应：

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "result": {
    "turnId": "turn_456",
    "sequence": 18
  }
}
```

错误响应：

```json
{
  "jsonrpc": "2.0",
  "id": 42,
  "error": {
    "code": -32004,
    "message": "CommandConflict",
    "data": null
  }
}
```

Fixtures 是测试输入，必须是可解析的完整 JSON，不能只写 TypeScript 示例对象。

## 5. 生命周期和状态机

涉及状态的接口必须给出：

- 状态全集；
- 初始状态；
- 合法转换；
- 终态；
- 失败和取消的区别；
- connection 断开时的行为；
- process crash/restart 后的行为。

示例：

```text
Created → Running → Completed
                  → Failed
                  → Cancelling → Interrupted
```

## 6. 顺序与一致性

必须说明：

- 哪个字段提供 durable sequence；
- 哪个字段提供 stream sequence；
- response 与 notification 的因果顺序；
- snapshot 与实时订阅如何避免事件空洞；
- 客户端发现空洞后如何 resync；
- 哪些通知可以合并，哪些不能丢弃。

## 7. 类型化命令重放

所有持久化副作用请求必须说明：

- `commandId` 是否必填；
- 对应的 typed command payload；
- receipt 持久化在哪个 aggregate；
- `expectedSequence` 针对哪个 aggregate；
- 相同 ID + 相同 command 的稳定结果；
- 相同 ID + 不同 command 的 `CommandConflict`；
- 重启恢复后如何重放。

JSON-RPC `id` 只做当前连接的 response pairing，不能代替 `commandId`。

## 8. 超时、取消和迟到响应

Server → Client 请求必须定义：

- deadline 字段和单位；
- Turn 结束时如何取消；
- connection 断开时如何清理；
- `serverRequest/resolved` 通知；
- deadline 后的迟到 response 是否忽略；
- UI 如何关闭等待状态。

## 9. Connection 与所有者

必须分别说明：

- Thread subscription；
- Turn owner；
- CapabilityHandle owner；
- Resource owner；
- Browser Target owner。

不能用“当前活动客户端”或“当前活动 Tab”这种可变全局概念代替稳定 owner。

## 10. 资源

大对象不得在普通业务消息中使用 Base64 或暴露本地路径。接口文档需要定义：

- `resourceId`；
- MIME type；
- size；
- SHA-256；
- owner connection；
- TTL；
- 单资源与单连接 quota；
- chunk 最大值；
- offset 范围；
- release、过期和断连清理。

## 11. 安全

每个涉及 Browser、文件、命令、网络、下载或外部 URL 的接口必须说明：

- 信任边界；
- 输入验证；
- origin/路径/目标 allowlist；
- secret 和敏感字段脱敏；
- approval 是否需要；
- approval 与 action digest 如何绑定；
- host policy 的二次校验；
- 审计记录。

## 12. 错误码

每个错误码必须稳定，并包含：

| Error                      | Retryable | Client action  | Data           |
| -------------------------- | --------: | -------------- | -------------- |
| `ServerOverloaded`         |       yes | jitter backoff | `retryAfterMs` |
| `BrowserTargetUnavailable` |        no | 刷新目标列表   | `targetId`     |

不要只写“失败时返回 error”。

## 13. 开发期破坏性变更

文档必须标注：

- 哪些 Rust/TypeScript DTO、registry 和 schema 同步改变；
- Desktop、CLI 与 TUI 哪些调用方必须同一变更迁移；
- 旧开发数据是否需要清空；
- 未知 notification/request 的稳定错误行为；
- schema hash 和 fixtures 是否已重新生成。

当前开发阶段不保留旧 route、deprecated alias、DTO mapper 或 storage upcast。发布后的版本与
migration 政策必须另立 RFC，不能提前把兼容逻辑放进 Core。

## 14. Rust 实现验收

API 被视为完成，必须同时具备：

- Rust DTO；
- wire-specific DTO 与 canonical model 的必要机械映射；
- handler 与路由；
- capability/version 校验；
- error code；
- timeout/cancellation；
- idempotency；
- Rust tests；
- JSON fixtures；
- in-process App Server Client contract test；
- stdio transport contract test；
- TypeScript 生成；
- JSON Schema 生成；
- schema hash；
- Desktop 与 CLI contract fixtures。

缺少其中任何一项，接口状态仍是 `draft` 或 `review`，不能标记为 `accepted`。

## 15. 可复制模板

建议从独立文件
[`ash-api-interface-template.md`](ash-api-interface-template.md)
复制一份作为新接口文档。以下内容与该模板的要求一致：

````markdown
# <Capability / Domain> API

## Metadata

- Status:
- Capability version:
- Owner:
- Rust owner:
- Requested by:
- Consumers:
- Last updated:

## Scope

### In scope

### Out of scope

### State owner

## Method inventory

| Method | Direction | Consumers | Side effect | Idempotent | Capability | Summary |

## `<method/name>`

### Semantics

### Preconditions

### Params

| Field | Type | Required | Nullable | Constraints | Meaning |

### Result

| Field | Type | Required | Nullable | Constraints | Meaning |

### Errors

| Error | Retryable | Client action | Data |

### Routing and ownership

### Idempotency

### Deadline and cancellation

### Ordering

### Security

### Request fixture

```json
{}
```

### Success fixture

```json
{}
```

### Error fixtures

```json
{}
```

## State machine

## Compatibility

## Acceptance tests
````
