# `ash-package-store`

> 状态：Current。本文拥有本 crate 的发布、选择、租约与清理契约；完整包的组装内容由 [`build/package`](../../build/package/README.md) 拥有，开发产物位置见 [`docs/build.md`](../../docs/build.md)。

1. `PackageStore::publish` 校验 `ash-package.json` 的完整文件摘要，并按版本、目标、JavaScript 运行时、构建配置和 `buildId` 发布 `packages/<version>/<build-id>`；编号清单是唯一选择记录，重复内容复用已有包。
2. `PackageLease` 和 `acquire_package_lease_for_executable` 让 `ash-app-server`、`ash-app-server-daemon` 与 `ash-code-mode-host` 在存活期间持有共享 `.lease`；启动 daemon 的父进程持有租约直到子进程完成接管。清理固定保留当前包和一个回滚包，只删除可取得独占租约的旧包、孤立包与未提交清单。
3. 本 crate 不组装包、不决定产品版本，也不读取可变指针；Node/Python 组装器只负责 staging，产品端只读取最新有效编号清单。修改清单格式、摘要算法或目录结构时必须同步更新构建端和 TypeScript/Python 读取端，并运行 `just test ash-package-store`、`pnpm --dir build test` 与 `python -B scripts/test-python.py`。
