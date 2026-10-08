# CI 后续工作

更新：2026-10-08。本文件随工作树清理更新到 main。旧 CI 工作树的完整交接与证据已保存在 `/Volumes/1t/ash/.git/worktree-cleanup/20261008/`；后续从 main 开始。

## 已进入 main

- `74004ce68`：Python/source layout 与 protocol preparation 修复。
- `c46f5b567`：Academic CI 使用真实 `electron-ui` project，并保留 connected editor 覆盖。
- `e08faa321`：只排除三个生成 JSON 的格式检查，保留手写 JSON 覆盖。
- `1a49304ba`：assets Bazel label 与结构验证。
- `9c44c645e`：issue template 末尾空行修正。

上述原任务的 contract 红绿、109 项 scripts Python 测试、格式检查与 Bazel query 证据已保留。`--list` 和 query 结果不代表真实 UI 或 TUI 运行通过。

## 最新失败记录

以下来自 `2ea5892bc08b899615d84a99d1aa7947f4d15943` 的实际 CI 日志，本次没有修改这些实现：

| 检查                | 失败位置                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| protocol            | `service_features_do_not_make_protocol_depend_on_queue_execution` 的子 Cargo 命令无法离线取得 `adler2 v2.0.1` |
| TUI tests           | `v8-150.4.0` 缺少 `gen/src_binding_ptrcomp_sandbox_release_x86_64-unknown-linux-gnu.rs`                       |
| Bazel TUI scenarios | rules_rs 下载 Ubuntu zlib 原包 URL 返回 404，分析阶段停止                                                     |

对应 job 为 `113429759754`、`113429874338`、`113429760157`。原始日志归档在 `validation-evidence/ash-cleanup-ci-*.log`。frontend、Rust、codespell 与 dependencies 在该提交通过，不能据此宣称所有 CI 通过。

## 已保存但未应用的草案

`validation-evidence/ci-drafts/` 保存原 CI diagnosis、源码草案及 `proposed.patch`。补丁 SHA256：`543c6cbfa351c0bc18671ae2bce3169e111cd07251e830e2bcd2a58caa734288`。

草案涉及 8 个文件；Bazel 更新另需生成 `MODULE.bazel.lock`：

- Python：`build/lib/package_test_support.py`、`test_package.py`、`cargo_cache.py`、`test_cargo_cache.py`。
- Bazel：`MODULE.bazel`、`third_party/rules_rs/BUILD.bazel`、`linux_zlib_snapshot.patch`、`README.md`。

原报告的 36 项临时加载草案测试通过，不等于完整仓库入口、真实 Windows 或 Linux toolchain 验收。该草案未在 main 应用；先对比当前源码与原 patch，再决定实际修复。

## 接手顺序

- [ ] Python metadata：测试 fixture 提供完整 protocol contract，保留生产 loader 与无效 metadata 覆盖。
- [ ] Windows cache：DirEntry 没有身份时读取 `os.stat`；时间 fixture 使用能跨平台保存的精度，保留锁、inode、硬链接断言。
- [ ] 使用锁定 Python/Ruff，运行真实入口 `just python=scripts/.venv/bin/python test-python build scripts code`，检查改动文件格式。
- [ ] Bazel：使用现有 patch 机制和官方固定 snapshot，保留原 SHA256 与 TLS 校验；由 Bazel 生成 lock，再以 `--lockfile_mode=error` 复核。
- [ ] 在 Linux CI 真正执行 `//cli:tui-real-scenarios`，不能以本机 query 代替。
- [ ] 根据最新 protocol 和 TUI 日志检查依赖准备与 V8 构建产物；保留依赖边界和产品断言。
- [ ] 跨平台 smoke 另行接手，核对原补丁哈希后再应用与验收，见 [smoke 交接](smoke-platform-handoff-todo.md)。本地尚无已核验的原补丁字节。

旧 57 文件格式批次因材料下载 HTTP 403 未取得字节，未重建或应用。上述未完成事项不影响已经保存的工作树恢复资料。
