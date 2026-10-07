# `<Capability / Domain>` API

> 使用本模板前请先阅读
> [Ash API 接口文档规范](ash-api-interface-requirements.md)。
> 删除所有占位说明后再提交评审。

## 快速理解

`<用一段面向调用方的文字说明：这项能力解决什么问题，成功后用户能观察到什么，以及最重要的
限制是什么。不要从方法名或 DTO 开始。>`

| 常见场景                       | 系统行为               | 调用方需要做什么         |
| ------------------------------ | ---------------------- | ------------------------ |
| `<主要成功场景>`               | `<可观察结果>`         | `<下一步或无需操作>`     |
| `<需要等待、批准或恢复的场景>` | `<状态与失败语义>`     | `<重试、取消或重新读取>` |
| `<不支持的场景>`               | `<明确拒绝或降级方式>` | `<替代入口>`             |

## 元数据

```yaml
title: <Capability / Domain> API
status: draft
capabilityVersion: 1
owner: crates
rustOwner: crates
requestedBy: desktop
consumers:
  - desktop
  - cli
lastUpdated: YYYY-MM-DD
```

## 范围

### 范围内

- `<本接口解决的问题>`

### 范围外

- `<明确不处理的能力>`

### 状态所有者

`<说明权威状态属于 Desktop、crates、connection、thread、turn 或 capability handle。>`

### 兼容策略

`<开发期说明 breaking change 如何同步更新所有调用方；发布后再说明兼容范围和升级方式。>`

## 方法清单

| Method            | Direction                   | Consumers            | Side effect |       Idempotent | Capability    | Summary  |
| ----------------- | --------------------------- | -------------------- | ----------: | ---------------: | ------------- | -------- |
| `<domain/method>` | `<Client → Server request>` | `<Desktop/CLI/host>` |  `<yes/no>` | `<required/n/a>` | `<domain/v1>` | `<用途>` |

## `<domain/method>`

### 语义

`<准确描述成功语义，以及它不保证什么。>`

### 前置条件

- `<连接、资源、状态或权限前置条件>`

### 参数

| Field     | Type     |   Required |   Nullable | Constraints   | Meaning  |
| --------- | -------- | ---------: | ---------: | ------------- | -------- |
| `<field>` | `<type>` | `<yes/no>` | `<yes/no>` | `<范围/格式>` | `<含义>` |

### 结果

| Field     | Type     |   Required |   Nullable | Constraints   | Meaning  |
| --------- | -------- | ---------: | ---------: | ------------- | -------- |
| `<field>` | `<type>` | `<yes/no>` | `<yes/no>` | `<范围/格式>` | `<含义>` |

### 错误

| Error               |  Retryable | Client action | Data         |
| ------------------- | ---------: | ------------- | ------------ |
| `<StableErrorName>` | `<yes/no>` | `<处理方式>`  | `<稳定字段>` |

### 路由与所有权

`<说明 connection、thread、turn、capability、resource 或 browser target 的 owner 和路由。>`

### 幂等性

`<副作用请求必须定义 commandId、typed command receipt、expectedSequence、冲突和重启重放语义。>`

### 截止时间与取消

`<定义 deadline 单位、主动取消、断连、Turn 终止和迟到响应处理。>`

### 顺序

`<定义 durable sequence、stream sequence、response/notification 因果顺序和 resync。>`

### 安全性

`<定义验证、allowlist、审批、action digest、脱敏、host policy 和审计。>`

### 请求样例

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "<domain/method>",
  "params": {}
}
```

### 成功样例

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {}
}
```

### 错误样例

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": {
    "code": -32000,
    "message": "<StableErrorName>",
    "data": {}
  }
}
```

## 通知

`<逐项定义通知字段、顺序、丢弃/合并策略。没有通知时写 None。>`

## 生命周期与状态机

```text
<Initial> → <Running> → <Terminal>
```

`<说明失败、取消、断连和进程重启后的状态。>`

## 资源生命周期

`<如涉及大对象，定义 ResourceRef、digest、TTL、quota、chunk 和 release；否则写 None。>`

## 兼容性

- Synchronized callers: `<Rust/Desktop/CLI/TUI 需同一变更迁移的入口>`
- Existing development data: `<是否必须清空>`
- Unknown notifications: `<处理方式>`
- Unknown requests: `<稳定错误>`
- Schema regeneration: `<fixtures/hash/generated TypeScript>`
- Transport parity: `<in-process/stdio/socket/websocket 的一致性或 capability 限制>`

## 验收测试

- [ ] Success fixture parses and round-trips.
- [ ] Every stable error has a fixture.
- [ ] Lifecycle transitions are covered.
- [ ] Idempotency replay and conflict are covered.
- [ ] Deadline, cancellation, disconnect, and late response are covered.
- [ ] Ordering gap and resync are covered.
- [ ] Security rejection paths are covered.
- [ ] Rust DTO and mapper tests pass.
- [ ] In-process client and external transport use the same dispatcher behavior.
- [ ] TypeScript generation compiles.
- [ ] JSON Schema and schema hash are updated.
- [ ] Contract fixtures pass for every declared consumer.
