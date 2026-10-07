# `ash-uds`

- 提供跨平台同步 `UnixListener`、`UnixStream`；调用方拥有线程、截止时间和连接生命周期。
- `SocketDirectory::create` 只创建新目录；`prepare` 创建或检查目录，`open` 只检查。父目录必须已存在，已有不安全目录直接报错，不修改其权限。
- Unix 目录必须属于当前有效用户且权限为 `0700`。Windows 创建带受保护、仅当前用户可访问 DACL 的目录，并通过目录句柄校验所有者、ACL 和重解析点。
- `bind`、`connect`、`remove_socket` 只接受单个端点名称。Windows 通过 AF_UNIX 重解析标记区分 socket 与普通文件；调用方确认监听者已退出后才能删除残留端点。
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
