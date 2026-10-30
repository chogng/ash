# CI 后续工作

更新：2026-10-30。本文件随 2026-10-08 工作树清理进入 main。旧 CI 工作树的完整交接与证据已保存在 `/Volumes/1t/ash/.git/worktree-cleanup/20261008/`；后续从 main 开始。

## 已进入 main

- `74004ce68`：Python/source layout 与 protocol preparation 修复。
- `c46f5b567`：Academy CI 使用真实 `electron-ui` project，并保留 connected editor 覆盖。
- `e08faa321`：只排除三个生成 JSON 的格式检查，保留手写 JSON 覆盖。
- `1a49304ba`：assets Bazel label 与结构验证。
- `9c44c645e`：issue template 末尾空行修正。

上述原任务的 contract 红绿、109 项 scripts Python 测试、格式检查与 Bazel query 证据已保留。`--list` 和 query 结果不代表真实 UI 或 TUI 运行通过。

## 2026-10-08 历史失败记录

以下来自 `2ea5892bc08b899615d84a99d1aa7947f4d15943` 的实际 CI 日志，不代表当前 main 的失败位置：

| 检查                | 失败位置                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------- |
| protocol            | `service_features_do_not_make_protocol_depend_on_queue_execution` 的子 Cargo 命令无法离线取得 `adler2 v2.0.1` |
| TUI tests           | `v8-150.4.0` 缺少 `gen/src_binding_ptrcomp_sandbox_release_x86_64-unknown-linux-gnu.rs`                       |
| Bazel TUI scenarios | rules_rs 下载 Ubuntu zlib 原包 URL 返回 404，分析阶段停止                                                     |

对应 job 为 `113429759754`、`113429874338`、`113429760157`。原始日志归档在 `validation-evidence/ash-cleanup-ci-*.log`。frontend、Rust、codespell 与 dependencies 在该提交通过，不能据此宣称所有 CI 通过。

## 已保存的历史草案

`validation-evidence/ci-drafts/` 保存原 CI diagnosis、源码草案及 `proposed.patch`。补丁 SHA256：`543c6cbfa351c0bc18671ae2bce3169e111cd07251e830e2bcd2a58caa734288`。

草案涉及 8 个文件；Bazel 更新另需生成 `MODULE.bazel.lock`：

- Python：`build/lib/package_test_support.py`、`test_package.py`、`cargo_cache.py`、`test_cargo_cache.py`。
- Bazel：`MODULE.bazel`、`third_party/rules_rs/BUILD.bazel`、`linux_zlib_snapshot.patch`、`README.md`。

原报告的 36 项临时加载草案测试通过，不等于完整仓库入口、真实 Windows 或 Linux toolchain 验收。原草案未直接应用；Python metadata 和 Windows cache 已由后续实现接替，Bazel 也已升级 pin，不应重复应用旧补丁。

## 当前验证与剩余范围

2026-10-30 在 Windows x64、main `53706802f` 加本轮测试修正上复核：打包 fixture 使用真实 protocol source/artifact fingerprint，保留无效 metadata、过期源码与篡改产物的拒绝测试；Windows cache 已使用 `os.stat` 取得文件身份，并以整秒 fixture 保留时间顺序。补齐打包测试遗漏的四个内置包预期，并将 manifest 读取固定为 UTF-8 后，cache、package、protocol 的 60 项定向测试无失败、3 项原有平台跳过，包含硬链接去重和活动租约保护。日志见 `.build/todo-acceptance-20261030/python-targeted-final.log`。

完整入口首跑还发现 LiveKit 测试在 Windows 断言 POSIX 权限位；现按实际宿主断言 Windows 可写位，保留 POSIX 的 `0755` 检查及原有内容、摘要、时间和发布断言。使用仓库虚拟环境的 Python 3.14.7／Ruff 0.15.13，`just test-python build scripts code` 最终退出 0：build 275 项／6 跳过、scripts 218 项／7 跳过、code 28 项／1 跳过，均无失败。5 个相关 Python 文件的 Ruff lint／format、6 个改动文件的 `just fmt-check` 和 `git diff --check` 通过。首败及最终日志分别保留在 `.build/todo-acceptance-20261030/python-suites.log` 与 `python-suites-final.log`。

只读核对同一 SHA 的[最新 CI](https://github.com/chogng/ash/actions/runs/40915659255)：依赖安全、Python lint、Rust 格式和拼写失败，frontend、Bazel、Rust 与 tooling 等下游作业被跳过。因此继续保留完整矩阵验收；本轮没有发布或触发远端 CI。

## 接手顺序

- [ ] Bazel：按当前 `rules_rs 0.0.96`、现有兼容补丁和 `MODULE.bazel.lock` 复核 `--lockfile_mode=error`，不再应用旧 zlib snapshot 草案。
- [ ] 在 Linux CI 真正执行 `//cli:tui-real-scenarios`，不能以本机 query 代替。
- [ ] 根据最新 protocol 和 TUI 日志检查依赖准备与 V8 构建产物；保留依赖边界和产品断言。

旧 57 文件格式批次因材料下载 HTTP 403 未取得字节，未重建或应用。上述未完成事项不影响已经保存的工作树恢复资料。
