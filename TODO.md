# Verification follow-up

Remaining changes were committed locally on `main` on 2026-10-17. Renderer typechecking, the 15 selected unit-test files (543 tests across the initial run and the corrected TaskService rerun), `just verify ash-core`, `just verify ash-external-ext`, and 17 targeted Chromium integration tests passed. Every commit passed `just commit-check origin/main`. Electron smoke scenarios were not run.

- Investigate the activity badge geometry failure in `test/integration/browser/composite.integration.spec.ts`: the compact item measures 16px high with badge top 3px; the assertion expects 24px and 11px. Determine whether the fixture, layout, or expectation owns the mismatch before changing it.
- Reproduce with `pnpm test:browser:integration composite.integration.spec.ts --project=chromium --grep 'activity badges keep compact icons readable'`, then rerun the remaining browser cases stopped by the failure.
- Initial failure log: `/tmp/ash-remaining-browser-tests.log`; passing targeted run: `/tmp/ash-targeted-browser-tests.log`. No publication was requested or performed.

## 全量 Rust 校验后续

多根工作区的定向前端测试 31 项、App Server 的 `env_dirs_set` 6 项、TerminalService 27 项及 macOS arm64 Desktop E2E 2 项均通过，两个 Rust 包的 check 与 rust-warnings 通过。文件和职责对照见 `docs/ash-desktop-architecture.md` 第 4.2 节。

- [ ] 调查 `just verify ash-app-server --lib` 中的密钥存储断言失败：`encrypted_storage_rpc_reports_each_state_and_sanitized_operation_error` 期望空 providers，实际包含 `ollama`。单独运行同样失败。全量结果为 915 通过、1 失败、7 忽略。日志：`.build/multi-root-runtime-verify.log`、`.build/multi-root-unrelated-secret-test.log`。
- [ ] 调查 `just verify ash-exec-server --lib` 的进程测试等待：`process_completion_waits_for_both_delayed_output_streams` 与 `stdout_read_failure_fails_the_process_and_closes_all_streams` 卡在 `Processes` 析构中的线程 join。已对本次测试进程发送 SIGINT 并确认退出。线程采样：`.build/multi-root-exec-sample.txt`；日志：`.build/multi-root-exec-verify.log`。定向 `terminal::tests::` 校验已完整通过。

这两项分别位于密钥配置与普通命令进程退出路径；多根修复的定向验证结果不能代替这两项全量校验。

## 执行层全量校验后续

Codex 执行层对照与修复已完成，见 `docs/environment-access.md` 第 9 节。相关验证为 `local_tools` 33 项、`environment_runtime` 49 项、`dir_contributions` 20 项、`agent_runtime` 11 项与 `ash-agent-environment` 8 项，共 121 项通过，包含普通沙箱授权及动作批准下的真实 macOS 进程验证。两个包的 check 与 rust-warnings 通过。

- [ ] 调查 App Server 全量测试的 `tests::git_conflict_rpc_reads_stages_and_completes_only_the_selected_state` 偶发退出等待：线程采样定位到 `GitWatcher` 析构中的线程 join。已对本次测试 PID 19214 发送 SIGINT，并确认测试进程及外层命令退出；日志 `.build/execution-app-server-final.log`、采样 `.build/execution-final-app-server-sample.txt`。此前一次全量运行仍复现上面的密钥测试断言；新测试中的 macOS 路径别名断言已修正，并通过目录上下文的 20 项定向测试。
