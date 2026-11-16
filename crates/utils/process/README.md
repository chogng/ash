# ash-utils-process

`background_command` 构造不会弹出 Windows 控制台的普通命令；环境、stdio 和生命周期归调用方。

`process-tree` feature 提供管道进程树的共享机制，不引入 PTY 或沙箱授权依赖：

- `OwnedChild` 配置独立 Unix session 或 Windows Job，保留进程身份直到后代清理和主进程回收完成。
- 调用方先执行协议关闭、读取输出或处理超时，再调用 `close`；Drop 覆盖取消和启动后失败。
- Unix 先观察退出、清理 session，再回收 leader，避免 PID 复用。可选 guard 在宿主意外退出后继续清理。
- Windows 在恢复主线程前加入 Job；Job 接入失败时不执行用户代码。

`windows-security` feature 提供共享 SID、LocalFree 内存和私有桌面句柄。账户后端与 JS 锁定启动共用这些机制，
各自保留策略。JS 的启动令牌、AppContainer、降权与执行句柄由 `sandboxing` 拥有。

## 验证

```sh
just verify ash-utils-process
just verify ash-utils-process --features process-tree,windows-security
```

来源与许可证见 [NOTICE](NOTICE)。
