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

## Remote / Browser 多根工作区后续

已实际实现 SSH Remote 与独立 Browser 目录句柄模式的多根工作区文件编辑，沿 VS Code 对应文件职责接通命令、File 菜单与 Explorer 右键；没有另建工作区状态 owner。Browser 包含临时配置、JSONC 保存、revision 回滚、外部修改重载、URL 刷新恢复与 IndexedDB 草稿事务迁移。Remote 配置保存在 Desktop 本地，使用同一 SSH authority 的 URI 根；已修复远端根选择器的本地路径访问错误，以及 macOS 菜单失败只写控制台的问题。

验证：124 项定向单元／架构测试、22 项 Chromium 集成测试、5 项 Desktop smoke、2 项 Browser smoke 通过；新增脏文件保护断言后 SSH 多根再次通过。日志、截图及 SSH trace：`.build/remote-browser-evidence/README.md`。Renderer、Main、自动化类型检查与 Desktop/Web 构建通过。保留原有修改，未提交／发布。

- [ ] 连接 App Server 的 Web 模式仍是服务端单根会话，不属于本轮已验证的目录句柄实现；此前已询问 Browser 是否要求两种模式，尚未收到范围答复。若覆盖此模式，需先在 `crates/app-server-protocol/src/web.rs`、`crates/app-server/src/managed/web.rs` 和相应 transport owner 补正式的多目录授权／会话契约，再由已保留的 `appServerWebWorkspaceClient.ts` 机械适配。不能把 Browser 提升为 `directoryGrantsHost`。
- [ ] 为上述 Web 服务端模式确定并实现配置文件的独立访问生命周期：移除配置所在根之后，仍可访问已授权的准确工作区配置文件；不能把其父目录偷偷加入执行根。再接 Browser Host／编辑器链，补权限拒绝、脏文件、连接关闭和真实 Web App Server 验证。
- [ ] 直接保存工作区配置到远端机器尚未实现；当前 SSH 只验证本地配置文件保存远端 URI 根。Windows／Linux 远端及真实系统选择器尚未验证；现有 OpenSSH fixture 为 macOS 同机隔离服务，文件选择器使用受控返回值。
