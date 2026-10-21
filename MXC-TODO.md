# MXC 剩余验收与退出兼容 fork

当前 SDK 为 `mxc-sdk = "=1.0.1"`，兼容 fork 固定为 `f1e8694b75dea05ebb3dc8050039d04fe304236f`。运行命令与验收方法见 [适配器验证](crates/mxc-sandbox/README.md#验证)，依赖差异见 [SDK 依赖说明](third_party/mxc/README.md)。

## Windows／WSL2

- [ ] 在支持 PSEC 的 Windows 宿主重跑当前固定 fork 的文件、网络、ConPTY、执行服务 RPC、后代回收和清理验收，记录系统版本、架构、SDK 提交及原始结果；入口见 [Windows 验收手册](docs/windows-sandbox-acceptance-runbook.md) 和 `scripts/test-psec.ps1`。
- [ ] 在该宿主的 WSL2 中重跑 Linux 适配器、PTY、执行服务及网络矩阵，补 Windows 挂载目录和互操作边界，记录发行版、内核和 Bubblewrap 版本；命令见 [WSL 验证入口](crates/mxc-sandbox/README.md#验证)。
- [ ] 完成管理员账户的安装、认证管道、真实文件权限、网络、PTY、后代回收、运行器更新、服务更新和清理验收；步骤见 [Windows 验收手册](docs/windows-sandbox-acceptance-runbook.md)。

## Linux

- [ ] 补独立 Linux 发行版和 x64 宿主运行范围；不能沿用旧版 WSL2 或交叉编译结果。

本机 Docker Linux arm64 的执行、网络与真实 socket，以及 Linux x64 的 MXC／执行服务全部测试目标编译检查已补齐；具体范围见 [Linux 验证记录](crates/mxc-sandbox/README.md#2026-10-18-linux-验证记录)。Docker Desktop LinuxKit 不作为独立发行版／物理 x64 宿主结果。

## 外部网络与 socket

- [ ] 补另一台局域网设备及公网 IPv6；每个外部端点先完成普通进程可达性对照。受本机代理影响的 DNS 对照不能替代独立公网出口。

## 退出兼容 fork 的条件

- [ ] 将仍需要的通用修正按上游贡献／安全流程独立提交或确认官方已有等价实现；Unix PTY 作业控制与 UTF-8 资源构建可单独提交。
- [ ] 确认官方代码完整实施 Ash 已批准的文件、网络、ACL 和进程生命周期要求。
- [ ] 固定新的官方 commit，用未经修改的 SDK 重新完成三个平台的受影响验收。
- [ ] 移除根清单的兼容 patch，保留官方 SDK 版本声明，更新 Cargo/Bazel lockfile、来源审查与链接；保留许可证归属。
