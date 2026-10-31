# `ash-uds`

- 提供跨平台同步 `IpcListener`、`IpcStream`；Unix 使用标准库 UDS，Windows 使用原生命名管道，由 Tokio 管理 IOCP、就绪通知和等待；调用方拥有截止时间和连接生命周期。
- `SocketDirectory::create` 只创建新目录；`prepare` 创建或检查目录，`open` 只检查。父目录必须已存在，已有不安全目录直接报错，不修改其权限。
- Unix 目录必须属于当前有效用户且权限为 `0700`。Windows 创建带受保护、仅当前用户可访问 DACL 的目录，并通过目录句柄校验所有者、ACL 和重解析点。
- `bind`、`connect` 只接受单个端点名称；Unix 专有的 `remove_socket` 在确认监听者已退出后删除残留 socket。Windows 将规范化目录和端点名哈希为固定长度的 `\\.\pipe\ash-ipc-<sha256>`，始终使用指定的私有 runtime 目录保存日志、锁和进程记录；管道由内核随句柄释放，同名文件不参与管道的绑定、连接和清理。
- Windows 管道创建时设置当前用户专属 DACL、拒绝远程客户端，并以 `FILE_FLAG_FIRST_PIPE_INSTANCE` 防止第二个监听者占用同一端点。客户端禁止服务端提权冒充；对端 PID 来自内核的 named-pipe API，继续校验用户和提权上下文。
- Windows 读写使用重叠 I/O，Tokio/Mio 持有缓冲区直到完成；`WouldBlock` 不接受新字节。适配层以 message-mode 管道传输连续字节，隐藏消息边界，并保留空消息表达 `shutdown(Write)`，使 stdin EOF 后仍能读取响应；普通空 `write` 不发送 EOF。普通释放保留已接收的写入，`shutdown(Both)` 取消所有克隆的未完成 I/O 并唤醒等待者；没有调用方的 `shutdown(Read)` 返回 `Unsupported`。
- 目录对象在 Windows 上阻止目录删除和替换，最后一个克隆释放时关闭句柄。监听者存活期间须保留对象，清理空目录前须释放所有克隆。Unix 依靠私有目录权限，父目录应由宿主信任；打开句柄不阻止同用户移动目录。
- `peer_identity` 从操作系统查询对端身份，返回是否同用户、是否同 Windows 提权上下文。Unix 不存在 UAC，`same_elevation` 为真。此函数不决定连接是否被允许。

App Server transport 要求同用户、同提权上下文，且在交换应用数据前检查。
daemon 保留目录对象管理端点。

已有 Windows runtime 目录若只有继承 ACL，启动会返回权限错误；该目录中可能已有外部打开的句柄，修改 ACL 不能撤销这些句柄。

Windows 安全辅助代码的来源和许可见 [NOTICE](NOTICE) 与 [LICENSE-APACHE](LICENSE-APACHE)。

验证：

```text
just check ash-uds
just test ash-uds
just test ash-app-server-transport --lib local_socket
just test ash-app-server-daemon --lib endpoint
```
