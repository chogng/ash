# Windows sandbox

- 实现 Windows 专用账户、限制令牌、文件授权、WFP 网络限制与进程树回收。
- 隔离 Windows API 依赖，消费 `sandboxing` 的统一策略和 `install-context` 的安装身份。
- 安装、更新和删除通过独立 Windows 服务执行，必须提供当前变更清单的摘要；普通执行不自动安装或修复。
- 每次执行独占账户、随机文件 SID、Job、桌面、代理路由和 ACL 恢复记录。
- 产品包提供执行 helper 和管理服务；运行时校验 helper 路径与 SHA-256，不搜索 PATH。

2026-10-02 在 Windows 11 23H2 x64 完成了新版服务路径的管理员实机验收：34 项账户单测、9 项服务测试和 10 项完整执行用例全部通过，运行器更新后复测全部执行用例，服务程序更新后再验证实际执行。服务、账户和安装目录已清理，WFP 删除逐项查询确认；具体证据见 [本轮验收记录](../../docs/windows-sandbox-acceptance-runbook.md#2026-10-02-服务及账户管理员验收)。该结果不证明 PSEC、其他 Windows 系统或 WSL 通过。

| 归属 | 职责 |
| --- | --- |
| `windows-sandbox` | 账户、令牌、WFP、ACL、PTY、进程树及执行租约的 Windows 实现；helper 通过管理管道请求安装操作 |
| [`windows-sandbox-service`](../windows-sandbox-service/README.md) | SCM 注册与生命周期、管理员持有的服务程序、本地管道认证，以及管理请求的调用者权限 |
| `mxc-sandbox` | 独立 PSEC、Seatbelt、Bubblewrap 适配器；不承担旧版 Windows 的账户安装 |

服务运行器和账户状态位于系统 ProgramData 下的 `AshWindowsSandbox`。账户状态仍以调用者的 DPAPI 身份加密；服务在同一操作系统线程上模拟经过认证的管道调用者完成管理操作。管理员持有状态和运行器的所有权，调用者只读；执行租约、运行目录和 ACL 日志具有各自所需的写权限。

运行器更新先独占安装锁及全部账户租约，再记录新程序摘要并替换文件，保留账户和 WFP 对象。中断后执行保持拒绝；新的明确更新或删除请求处理记录中的程序。版本 3 的旧账户目录不被版本 4 服务接管，升级前须用原 helper 的明确删除命令移除旧安装。

`FileSystemIsolation::WindowsAccount` 使用 Codex 的兼容令牌和有预算限制的可写路径审计，不承诺整个宿主只读。要求 `Strict` 时在启动前拒绝；未获授权的宿主审计修正不会自动执行。

`HostAclChanges::ScopedWithTraversal` 允许范围内的 ACL 调整，以及必要祖先目录的非继承属性查询和遍历。它不授予祖先目录枚举或文件读取权限。设备与命名对象目录授权已退出实现，普通执行不触发安装或提升权限。

契约、审计限制与实机证据见 [沙箱架构](../../docs/sandboxing.md) 和 [Windows 验收手册](../../docs/windows-sandbox-acceptance-runbook.md)。

```powershell
just test ash-windows-sandbox --lib --locked
just check ash-windows-sandbox --tests --locked
just rust-warnings ash-windows-sandbox
just test ash-windows-sandbox-service
just rust-warnings ash-windows-sandbox-service
python -B scripts/cargo.py build -p ash-windows-sandbox --bin ash-windows-sandbox --locked
bazel build //ash-rs/windows-sandbox:ash-windows-sandbox
```

需要真实账户的测试显式标为忽略，须在获准配置的验收环境执行。`scripts/test-windows-sandbox.ps1` 提供服务与账户安装、全部用例、运行器及服务程序更新后执行，以及 finally 清理入口；调用方须已获得安装与验收授权。

网络连接进程归属实现参考 Codex `da20788df913189878ebca7f4963d8a363ee6bf2`；对应许可与归属保存在 `LICENSE-APACHE` 和 `NOTICE`。文件 ACL 日志复用固定版本的 `wxc_common`，不引入 Codex 的协议或产品配置。
