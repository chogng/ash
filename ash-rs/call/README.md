# ash-call

- 持久化通话、成员角色和媒体房间代次。
- 使用房间成员凭据授权；SQLite 只保存凭据哈希。
- 处理邀请、移除、角色变更、结束和幂等重试。
- 权限变更先记录待执行状态，再由宿主更换 LiveKit 房间。
- 不依赖 UI、LiveKit SDK、设备驱动或模型执行。
- 持久化成员的发言设备；其他设备只听，切换设备会更换房间。
- `runtime` feature 提供协作服务客户端、本地进程管理、通话控制与权限换代后重入。
- 成员变化按修订号等待；通话状态通过宿主通知界面。
- 文档房间关联和 AI 任务执行仍未接入。

设计与验收范围见[协作媒体方案](../docs/design/collaboration-media.md)。

```sh
just test ash-call --features runtime
```
