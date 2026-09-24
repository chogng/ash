# `ash-app-server-daemon`

- 管理独立的 `ash-app-server --managed` 进程，记录其 PID、启动身份和可执行文件摘要。
- 串行化 start、restart、stop、version 操作，初始化探测成功后才返回 ready。普通 start/connect 复用同一 profile 已运行且协议与必需能力兼容的进程；只有显式 restart 才更换运行代次。
- 提供同用户控制端点与 stdio 连接程序；`ManagedEndpoint` 由后台服务进程持有。
- 启动失败时终止并回收新子进程，仅清理该代记录；仍存活或已被后继进程替换的记录受到保护。
- Windows 通过同一进程句柄读取创建时间、验证身份、终止并等待退出；后台启动要求脱离控制程序的 Job。Unix 验证启动身份后终止。
- App Server 持有目录服务、队列和自动化运行；本 crate 的正常依赖不包含 App Server 实现。

## 命令与路径

- `ash-app-server-daemon connect` 取得共享 profile 服务连接并代理 stdio。
- `ash-app-server-daemon start|restart|stop|version` 输出单行 JSON；`pid` 是实际后台进程 PID。
- `ASH_APP_SERVER_PATH` 显式选择后台可执行文件，必须是绝对路径；默认使用控制程序同目录的 `ash-app-server[.exe]`。
- 发布产品通过 `ASH_APP_SERVER_SHA256` 传入后台程序的预期摘要，匹配后才启动；开发 generation 使用实际内容身份。
- `--product-services PATH` 显式指定产品服务配置；profile 路径和随包资源发现由 `install-context` 提供。
- 包租约覆盖启动交接，后台服务自己持有运行期间的租约。

本地端点按 profile 固定，不随产品包版本、schema hash 或后端文件摘要变化。它使用 [`ash-uds`](../uds/README.md) 的私有目录和同用户校验。不同版本安装通过 initialize 校验协议主版本和必需能力；schema hash 差异只作诊断。协议不兼容时连接失败，不会自动替换后台进程。控制程序不需要长期驻留；每个窗口保留自己的连接。

## 验证

```text
just test ash-app-server-daemon --lib
just test ash-app-server --test managed_initialize --test managed_lifecycle
```

Windows 身份与终止测试位于 `src/process/windows_tests.rs`，须在 Windows 执行实测。
