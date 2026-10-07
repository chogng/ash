# ash-exec-server-protocol

执行环境的类型契约，与 App Server 的任务协议分开。

- `Message` 包含版本、鉴权 token、服务实例 ID 和请求；当前版本为 3，版本必须严格匹配。
- `environmentInfo` 返回环境身份、目录和权限上限。
- `processStart` 使用客户端生成的操作 ID，指定程序、参数、相对目录、超时和 `closed`/`open`/`terminal` 输入模式；`terminal` 附带 `rows`、`cols`。
- `processRead` 按 stdout/stderr 字节游标读取；必填 `waitMillis` 范围为 0–1000，0 立即返回，其他值等待新输出或终态；`gap` 表示输出已被淘汰。
- `processWrite`、`processCloseInput`、`processCancel` 控制已启动进程；启动尚未完成或进程已结束时，输入控制返回冲突。
- `processResize` 调整 PTY 尺寸；`processInterrupt` 发送进程中断，`processCancel` 终止整个执行。PTY 的 stderr 合并到 stdout，不接受 `processCloseInput`。
- `processInterrupt` 当前支持 Unix 进程组；Windows 终端使用 `processWrite` 发送 Ctrl-C 字节，独立信号请求返回冲突。
- `fileRead` 按字节 offset 返回一个范围、完整文件长度和版本。后续范围必须提交首个范围的版本；文件变化返回冲突，客户端丢弃整个未完成的读取。
- 文件写入使用 `fileWriteBegin` → `fileWriteChunk` → `fileWriteCommit`；Begin 固定操作 ID、路径、完整长度、内容摘要和覆盖条件。Chunk 只接受严格连续的 offset，上传不修改工作区文件。
- Commit 校验完整长度和内容摘要，再按原版本匹配或不存在/为空的条件一次发布。成功、拒绝、取消和结果未知均保留终态；`fileWriteStatus` 只观察，`fileWriteAbort` 取消尚未提交的上传。
- 文件系统发布过程中返回 IO 错误时，结果标记为 `outcomeUnknown`，不能声称文件未改动。
- 丢失 Commit 响应后只能查询结果，不能重发写入。重复 Commit 返回原终态，不再次发布，也不覆盖后来的修改。
- `terminal` 包含桌面 PTY 的领域数据，不属于 TCP 方法集合。
- 不接收客户端授权对象、Thread 命令或模型请求。

## 传输与限制

- 每条 TCP 连接顺序处理多个 UTF-8 JSON 请求及响应，以换行结束；每个请求独立校验身份和版本，调用方按请求顺序配对响应。
- 除身份查询外，请求必须带当前实例 ID；服务重启后返回 `staleEnvironment`。
- 帧上限 2 MiB，单文件 10 MiB，单次文件范围或上传块 256 KiB，每条输出尾部与单次输入 64 KiB。
- 输入字节为 JSON 数组；进程输出是 UTF-8 文本，桌面 PTY 输出保留原始字节。
- 进程终态区分退出、取消、超时、失败；退出码为非零表示命令失败。
- 错误区分鉴权、版本、实例变化、参数、权限、不存在、冲突、容量与 IO。
- 传输失败不能证明操作未执行；调用方不得据此重发有副作用的请求。
- 每个环境最多保留 1024 条上传/结果记录；上传在 Begin 时预留完整长度，总容量最多 64 MiB。60 秒没有收到上传块时转为取消并释放内容；终态保留一小时。清理在上传或结果请求进入时执行，环境退出同时释放所有记录。
- 连接关闭不取消上传，也不删除提交结果。实例重启后旧客户端仍被拒绝；结果记录不跨实例恢复。客户端取消在提交前发送 Abort；提交发出后的完成与取消竞争以宿主终态为准。

服务启动、保留时间及宿主配置见 [exec-server](../exec-server/README.md)。
