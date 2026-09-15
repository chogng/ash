# ash-exec-server-protocol

执行环境的类型契约，与 App Server 的任务协议分开。

- `Message` 包含版本、鉴权 token、服务实例 ID 和请求；版本必须严格匹配。
- `environmentInfo` 返回环境身份、目录和权限上限。
- `processStart` 使用客户端生成的操作 ID，指定程序、参数、相对目录、超时和 `closed`/`open`/`terminal` 输入模式；`terminal` 附带 `rows`、`cols`。
- `processRead` 按 stdout/stderr 字节游标读取；`gap` 表示输出已被淘汰。
- `processWrite`、`processCloseInput`、`processCancel` 控制已启动进程；启动尚未完成或进程已结束时，输入控制返回冲突。
- `processResize` 调整 PTY 尺寸；`processInterrupt` 发送进程中断，`processCancel` 终止整个执行。PTY 的 stderr 合并到 stdout，不接受 `processCloseInput`。
- `processInterrupt` 当前支持 Unix 进程组；Windows 终端使用 `processWrite` 发送 Ctrl-C 字节，独立信号请求返回冲突。
- `fileRead` 返回原始字节和版本；`fileWrite` 要求原版本匹配，或目标不存在/为空。
- `terminal` 包含桌面 PTY 的领域数据，不属于 TCP 方法集合。
- 不接收客户端授权对象、Thread 命令或模型请求。

## 传输与限制

- 每条 TCP 连接处理一个 UTF-8 JSON 请求及响应，以换行结束。
- 除身份查询外，请求必须带当前实例 ID；服务重启后返回 `staleEnvironment`。
- 帧上限 2 MiB，单文件 256 KiB，每条输出尾部与单次输入 64 KiB。
- 输入字节为 JSON 数组；进程输出是 UTF-8 文本，桌面 PTY 输出保留原始字节。
- 进程终态区分退出、取消、超时、失败；退出码为非零表示命令失败。
- 错误区分鉴权、版本、实例变化、参数、权限、不存在、冲突、容量与 IO。
- 传输失败不能证明操作未执行；调用方不得据此重发有副作用的请求。

服务启动、保留时间及宿主配置见 [exec-server](../exec-server/README.md)。
