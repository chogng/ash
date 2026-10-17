# `ash-package-store`

> 状态：Current。本文拥有本 crate 的发布、选择、租约与清理契约；完整包的组装内容由 [`build`](../../build/README.md) 拥有，开发产物位置见 [`docs/build.md`](../../docs/build.md)。

`validate_package_identity` validates a complete immutable package and recomputes its `buildId` without publishing or changing selection. Installation hosts retain their own launcher layout.

1. `PackageStore::publish` 校验 `ash-package.json` 的完整文件摘要，并按版本、目标、JavaScript 运行时、构建配置和 `buildId` 发布 `packages/<version>/<build-id>`；编号清单是唯一选择记录，重复内容复用已有包。
2. `PackageLease` 和 `acquire_package_lease_for_executable` 让 `ash`、`ash-app-server`、`ash-app-server-daemon`、`ash-code-mode-host` 与 `ash-voice-host` 在存活期间持有共享 `.lease`；启动 daemon 的父进程持有租约直到子进程完成接管。清理固定保留当前包和一个回滚包，只删除可取得独占租约的旧包、孤立包与未提交清单。
3. 产品包由 Node/Python 组装器负责 staging；本 crate 不决定产品版本，也不读取可变指针。产品端只读取最新有效编号清单。修改清单格式、摘要算法或目录结构时必须同步更新构建端和 TypeScript/Python 读取端，并运行 `just test ash-package-store`、`pnpm --dir build test` 与 `python -B scripts/test-python.py`。

`installation` feature 复用同一存储安装 capability。`install_executable` 接收产品固定的上游单文件发布信息，验证 HTTPS、压缩大小和 SHA-256，限量解压 gzip 或只含目标可执行文件的 ZIP，然后为已验证字节生成同格式的不可变包。安装锁覆盖下载与发布；失败保留原选择，命中同一发布时离线复用。返回的 `InstalledExecutable` 带共享 lease，调用方必须持有到子进程退出。上游版本与来源选择属于能力提供者，不在存储中查询最新版。
