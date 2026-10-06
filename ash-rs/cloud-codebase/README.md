# `ash-cloud-codebase`

> 产品边界、配置和文件位置见 [`docs/codebase.md`](../../docs/codebase.md)。

## 职责

- 持久化 root-bound grant、`CloudCodebaseId`、本地/远端 generation 和 `Granted/Syncing/Ready/Stale/Revoking/Failed` 状态。
- 只发布 `ash-codebase` 已切分并复核的代码片段，调用已注册 provider 完成云端语义索引与查询，并校验返回候选的授权范围和 generation。
- 在授权生效前要求 provider 支持按 grant 幂等删除；撤销失败或进程中断时保留待删除状态，直到删除完成。

## 依赖方向

`ash-cloud-codebase` 依赖 `ash-codebase`。App Server 注入 provider registry、profile state 路径和 Workspace 生命周期。具体 provider 负责凭据、HTTP、租户隔离、远端数据库与 retention；本 crate 不保存 secret 或源码正文。

## 持久化身份

| 字段                         | 用途                                       |
| ---------------------------- | ------------------------------------------ |
| `CloudCodebaseGrantId`       | 本机一次明确授权，也是远端批量删除边界     |
| `CloudCodebaseId`            | 服务端长期对象身份，不从本地路径推导       |
| `root_id`                    | 防止授权被另一个 Workspace 复用            |
| destination                  | 固定 provider、tenant 与 collection        |
| selection + max egress bytes | 固定允许发布的相对路径范围和源码 byte 上限 |
| remote generation            | 固定一次查询实际使用的云端版本             |

旧状态数据库会一次性迁移到当前 schema；迁移使用原 provider collection 作为此前已经存在的远端对象身份。迁移不会丢弃 `Revoking` 或失败删除任务。

## Provider 契约

`CloudCodebaseProvider` 必须对同一 grant 和 local generation 做幂等发布，只使用请求中的 `MaterializedChunk`，在云端完成语义召回、排序、过滤与截断，并返回同一 remote generation 下的 `ChunkReference`。重复删除同一 grant 必须成功。

Controller 在接收查询结果后再次校验 root、授权 path、remote generation、result limit 和 chunk identity。最终源码读取、融合与 byte budget 仍由 `ash-codebase` 完成。

## 状态恢复

`authorize` 只保存 `Granted`。`sync` 先保存 `Syncing`，发布成功后保存 `Ready` 与 generation；本地 generation 变化时状态为 `Stale`。`revoke` 先保存 `Revoking`，provider 删除成功后才清空 grant。打开数据库时发现中断的同步或删除，会保留可恢复状态，不会把云端数据当作已删除。

## 验证

```bash
just test ash-cloud-codebase
just check ash-cloud-codebase --all-targets
```

测试覆盖 path/byte 授权、仅发布已复核片段、generation 校验、非法候选拒绝、删除失败重开重试、旧 schema 迁移和不支持幂等删除的 provider 拒绝。
