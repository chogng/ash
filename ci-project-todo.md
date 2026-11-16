# CI 后续工作

本文件随 2026-10-08 工作树清理进入 main。旧 CI 工作树的完整交接与证据已保存在 `/Volumes/1t/ash/.git/worktree-cleanup/20261008/`；后续从 main 开始。

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

同一 SHA 的 [CI 记录](https://github.com/chogng/ash/actions/runs/40915659255) 中，依赖安全、Python lint、Rust 格式和拼写失败，frontend、Bazel、Rust 与 tooling 等下游作业被跳过。

[PR #57](https://github.com/chogng/ash/pull/57) 于 2026-10-20 squash 合并（`ee3dea640`）。[当时的 CI](https://github.com/chogng/ash/actions/runs/39490567225) 在安全门禁失败后跳过了前端、Bazel 和 Rust 作业。本地证书修复后，`just dependency-security` 的 advisories、licenses 和 sources 检查通过。Linux x64 已有 47 项通过记录，旧 hosted 启动失败的根因仍待确认。证书复验日志为 `/tmp/ash-pr57-certificate-{security,dependencies-final,http-final,bazel-final,app-server-build}.log`，基线 `0d95ccc29` 的 macOS 定向复核记录位于 `.build/pr57-rebased/validation.json`。

2026-11-05 复核时，`6188dbb239` 的 [main CI #972](https://github.com/chogng/ash/actions/runs/41954524140) 因 `codespell` 失败。`c31875f2fe` 的 [Windows 沙箱专项](https://github.com/chogng/ash/actions/runs/41942142909) 已通过。

2026-11-05 在 Windows x64 用 Bazel 9.0.0 和仓库外的输出目录重建 `MODULE.bazel.lock`，随后用 `bazel mod deps --lockfile_mode=error` 验证通过。日志位于 `.build/todo-local-acceptance-20261105/bazel-lockfile-final.log`。Linux TUI 真实场景仍单独验收。

## 2026-11-16 门禁修复与复验

当前基线 `5e05db0379` 的 [main CI #1347](https://github.com/chogng/ash/actions/runs/43845062198) 在依赖安全和前端格式检查失败，Bazel、Rust、tooling 等下游被跳过。安全日志为 `yrs 0.26.0 → smallstr 0.3.1` 的 `RUSTSEC-2026-0215`；格式日志仅列出 `artifactToolbar.css`。

本轮按现有依赖策略为该维护通知添加逐项审查例外。它不是已知漏洞；最新 Yrs 0.28.1 仍依赖 smallstr，上游 [#755](https://github.com/y-crdt/y-crdt/issues/755) 尚未解决。例外仅覆盖该 ID，上游替换后移除；不关闭其他告警、来源或许可证检查。CSS 经仓库 formatter 修正换行，没有样式行为变更。

Windows x64 本地 `just dependency-security` 退出 0，输出 `advisories ok, licenses ok, sources ok`；与 CI 相同入口的全量 TypeScript 和 config 格式检查均退出 0。日志位于 `.build/ci-acceptance-20261116/{dependency-security,format-typescript,format-config}.log`。本轮未改依赖图、Cargo lockfile、测试或产品断言。

以上仅证明本地门禁已解除，不能作为远端矩阵、macOS hosted MCP 或 Linux TUI 通过证据。下列四项继续待验收。

本轮已获准提交、推送并触发远端验收；发布后按新 SHA 核对矩阵。原 `pr-57-ci` heartbeat 不在本轮恢复范围。

## 接手顺序

2026-11-16 CI 分层与依赖迁移：V8 源码验证／发布移至 [ash-rusty-v8](https://github.com/chogng/ash-rusty-v8)，原八组配对按原发布提交的完整 provenance 重新校验后迁入 `rusty-v8-v152.2.0`，archive／binding 摘要不变。LiveKit 的 [独立发布](https://github.com/chogng/ash-livekit-server/actions/runs/43859873497) 六个平台原生版本检查、汇总和发布全部通过，产物为 `livekit-v1.13.7-ash.1`。主仓库锁定上述产物；macOS 默认不再编译 Go Server。旧 release 保留供旧 checkout 使用。

App Server 领域／host 库测试和真实进程测试有独立必需入口，原 stdio／SSH 用例完整迁入。日常媒体集成保留，六平台分发检查独立运行。main 按最近完成的运行累计改动并重试失败领域；证据缺失、过期或不匹配时全量回退，选中的失败／跳过仍阻止通过。实际规则见 [CI 职责](.github/workflows/README.md)。

Windows 本地 build 322 项／6 跳过、scripts 239 项／7 跳过通过；CI 选择器专项 34 项通过。V8 runtime 和 sandbox probe 的 `just verify` 均通过，LiveKit 新产物实际执行输出 `livekit-server version 1.13.7`；`just dependencies`、Bazel lockfile 严格检查和全工作流 actionlint 通过。日志位于 `.build/ci-followup-20261116/`。App Server 新矩阵及整窗场景仍须按新提交的远端结果验收。

2026-11-16 后续复核 [修复发布后的 CI](https://github.com/chogng/ash/actions/runs/43847772443)：门禁已通过，Rust／TUI 的跨平台失败来自 PDFium 冷缓存未建目录便打开 `prepare.lock`；tooling 来自 PDFium 打包 fixture 缺失、已删除 snapshot 扩展的旧预期，以及 Windows Python 3.11 平台识别被 subprocess mock 干扰。Bazel 缺 artifact-catalog／documents 的 BUILD 声明；frontend 类型检查前未生成 Desktop host 绑定。

本轮修正准备入口、fixture、目标平台隔离、Bazel 声明及 frontend 的 host 绑定准备步骤。新增冷缓存与复用回归，打包测试走真实 PDFium 复制和校验并断言库及许可证内容。Windows `just test-python build scripts code` 通过：321／231／28 项，分别跳过 6／7／1 项；原生 host helper 构建和 frontend 工作流契约测试通过。证据位于 `.build/ci-followup-20261116/`。两个新增 Bazel package query 通过；完整依赖 query 被 Windows 解包 macOS SDK 失败阻塞，不代表 Linux TUI 已运行。远端实际场景仍按下列项目验收。

补齐协议产物后，七个环境的分层类型检查及 `just check ash-pdf --locked` 通过。Windows setup 诊断产物还显示 SCM fixture 漏传新增的 editor service；修正后真实 Chromium 的英文／中文 SCM commit message 场景 2 项通过。组件诊断显示 SelectBox 与 List 的行内边距、圆角存在 CSS 顺序冲突，现通过 List 既有变量声明 SelectBox 几何；截图稳定性测试分别检查全部 fixture 的渲染成功、`blocks-ci` 子集数量及两次完整 manifest 一致性。未降低截图错误或稳定性断言。全量 stylelint 检查 439 个 CSS 文件，零错误。

组件测试首跑 8 项通过、1 项截图稳定性失败：多选菜单入场动画保留的 transform 层使圆角 16 个像素出现 1/255 差异。fixture 现等待动画完成并释放动画对象，保留严格 PNG 和完整 manifest 一致性检查。相关 CSS 二分及全新浏览器截图 2 项复验通过，日志为 `fixture-retest.log`；首跑记录保留在 `fixture-tests.log`。

- [ ] 按本轮发布后的新 main SHA 核对完整 CI 矩阵。
- [ ] 补 Desktop runtime acceptance 的 macOS hosted MCP 进程回归通过证据。已有 [macOS 本机补验](agenthost-todo.md#2026-10-29-macos-进程补验)。
- [ ] 在 Linux CI 真正执行 `//cli:tui-real-scenarios`，不能以本机 query 代替。
- [ ] 根据最新 protocol 和 TUI 日志检查依赖准备与 V8 构建产物；保留依赖边界和产品断言。

旧 57 文件格式批次因材料下载 HTTP 403 未取得字节，未重建或应用。上述未完成事项不影响已经保存的工作树恢复资料。
