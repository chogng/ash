# MXC 上游补丁审查与 PR 准备

2026-10-18 对照官方 1.0.1（`fda29ac6`）重新审查兼容差异并迁移到 `f1e8694b`，见 [当前依赖审查](README.md)。官方新增的 PTY 死锁、Seatbelt 启动、Bubblewrap DNS 和 PSEC 回环修正均保留；下文列出的严格准备、前台中断、ACL 及路径边界差异仍需保留。此轮没有创建官方 issue／PR 或发送安全报告。以下是 2026-10-11 的历史贡献准备记录；其中 `.build/mxc-upstream-*` 材料不在当前检出，分支／提交和远程链接不能视为材料仍在本机的证明。

2026-10-11 已准备两个互不依赖的候选 PR：Windows 资源 UTF-8 编码，以及 Windows 直接启动时的可执行路径分隔符。代码、英文 issue／PR 草稿、复现材料和测试输出均已保存，资源编码已向官方提出 [issue #1466](https://github.com/microsoft/mxc/issues/1466)，等待维护者确认方案，尚未创建 PR 或推送准备分支。第二项仍需 Windows 实际复现及维护者确认修正范围；不能把 portable renderer 测试当作 Windows 运行证据。

审查基线是本轮 fetch 后的官方 `main`：`c6f301d53a1430c4c921a05c57af838f7392348f`。待拆补丁来自当前兼容 fork `d4bc220668130f941d117aab4326edb4c1812e78`。两个准备分支都直接从官方基线建立；没有相互依赖，没有引入 Ash 名称、请求类型、严格启动 facade、依赖或 lockfile 改动，也没有修改 `/Volumes/1t/mxc` 的 checkout。完整差异仍见 [依赖审查](README.md)。

## 官方贡献要求

- [CONTRIBUTING.md](https://github.com/microsoft/mxc/blob/main/CONTRIBUTING.md) 要求先搜索或提出 issue，再与维护者确认方案；简单修复可直接进入实现，复杂的 runner、配置或 SDK API 改动需要先写设计。当前草稿是供仓库所有者审阅的本地准备，不代表完成该流程。
- [SECURITY.md](https://github.com/microsoft/mxc/blob/main/SECURITY.md) 明确要求安全漏洞走 Microsoft 私密报告渠道。隔离绕过、越权或 ACL 恢复问题需先核实并按该流程报告，不能直接把完整复现粘贴进公开 issue／PR。当前仅做本地拆分，没有发送报告。
- [PR 模板](https://github.com/microsoft/mxc/blob/main/.github/PULL_REQUEST_TEMPLATE.md) 要求说明变化、关联问题、实际验证、适用的文档与 Copilot instructions 更新。CLA 状态未经确认，草稿中保持未勾选；不能代用户签署。
- 初始 PR 使用 Draft，补充复现、行为测试和平台证据后才标为 ready。Rust 要遵循其现有格式与 Clippy；政策、schema 或 SDK API 修改须同步对应文档、版本契约、生成链和跨 SDK 语义。
- 当前 [PR 构建说明](https://github.com/microsoft/mxc/blob/main/docs/development/build-and-test/pull-requests.md) 与模板说明 GitHub Actions 自动验证；ADO PR 构建需 Microsoft 有写权限的维护者触发 `/azp run`。CONTRIBUTING 中的“不自动运行”描述针对 ADO，不能据此说所有 PR CI 都需手动触发。
- 两个候选不改 lockfile；以后若新增依赖，必须通过其 `dependency-feed-check`，新增包可能需要 Microsoft 维护者填充依赖 feed。

## 第一批候选

| 候选 | 独立变化与价值 | 已有证据 | 发布前条件 |
| --- | --- | --- | --- |
| 01 资源 UTF-8 | 仅在手动 Windows 资源编译处加 `/c 65001`，4 行；保持版权字符和跨编译器行为 | macOS ARM64 上 LLVM 22.1.8：原命令返回 1，修正命令返回 0，`.res` 中版权 UTF-16 字节正确；改动文件格式与 whitespace 通过 | issue #1466 已提出，等待方案确认及 CLA 确认；发布为 Draft，Windows rc.exe 实际构建和官方矩阵通过后再 ready |
| 02 可执行路径分隔符 | 仅在 WindowsCreateProcess 的 argv[0] 把 `/` 转为 `\`，其余参数、URL、路径参数及 shell contexts 不变；含两个新测试 | 原实现的新断言失败；候选的 20 项 cmdline 测试、check、warning gate、Clippy 通过，使用上游 Rust 1.93 | Windows 运行 `reproduce.ps1`；若原版同样成功，重新评估而不是提交未经证实的 runtime bug。维护者需确认通用 argv[0] 规则还是仅 cmd.exe 规则；再关联 issue、确认 CLA、提交 Draft |

资源编码候选：本地分支 `user/chogng/windows-resource-utf8`，提交 `4fc1743d`。
命令行候选：本地分支 `codex/upstream-windows-executable-separators`，提交 `a524e68e`。
本地准备仓库在 `.build/mxc-upstream-pr`，归档在 `.build/mxc-upstream-review/candidates.bundle`；两个 patch 均已对官方基线独立执行 apply-check。它们未写入当前 Ash 依赖，Ash 固定 SDK 提交不变。

审阅入口：

- [资源编码 issue](../../.build/mxc-upstream-review/01-resource-utf8/issue.md)、[PR 正文](../../.build/mxc-upstream-review/01-resource-utf8/pr.md)、[补丁](../../.build/mxc-upstream-review/01-resource-utf8/diff.patch)、[实测结果](../../.build/mxc-upstream-review/01-resource-utf8/validation.json)。
- [命令行 issue](../../.build/mxc-upstream-review/02-windows-executable/issue.md)、[PR 正文](../../.build/mxc-upstream-review/02-windows-executable/pr.md)、[补丁](../../.build/mxc-upstream-review/02-windows-executable/diff.patch)、[验证说明](../../.build/mxc-upstream-review/02-windows-executable/validation.md)、[Windows 复现脚本](../../.build/mxc-upstream-review/02-windows-executable/reproduce.ps1)。
- [PTY 前台中断提案](../../.build/mxc-upstream-review/proposals/pty-interrupt.md)、[严格启动控制拆分提案](../../.build/mxc-upstream-review/proposals/strict-launch.md)。

`.build` 材料用于本地审阅，不会随普通源码提交保存；需要迁移准备工作时保留 bundle 和该目录。报告中的验证状态是准备阶段证据，不是官方 CI 结果。

## 其余补丁按独立问题拆分

| 问题 | 对应实现 | 合适的上游路径与当前缺口 |
| --- | --- | --- |
| Unix PTY 前台作业中断 | `mxc_pty`、SandboxProcess trait、两个 Unix runner、MxcPtyProcess | 已准备 feature issue／设计草稿。明确 foreground SIGINT 与 kill 的区别，讨论失效句柄、竞态和 unsupported 行为；先对照 Rust／Node／.NET API。需要独立 SDK 测试和 Linux 运行结果，不把整个严格启动 facade 带入 |
| Unix 非回收式退出观察与清理顺序 | `poll_child_exit`、两个 runner、ProviderMonitor、`rustix` process feature | 独立 lifecycle 修复：保留 leader PID，先停止监控和清理，再最终 wait。先用旧实现复现后代漏清理／PID 生命周期问题；若涉及错误 PID 被信号或隔离保证，按私密安全流程。`rustix` 新增直接依赖涉及 feed gate。不能只新增 helper 而不修改调用链，也不能声称解决另起 session 的全部后代 |
| Seatbelt 目录移动下的路径限制 | profile builder 的 ancestor anchors | 与 fcntl 拆开；先准备合成目录复现、允许访问正向对照与 rename 后越权检查。属于可能的隔离缺陷，优先私密报告；宏观“硬化”不能替代具体 bug 与兼容性证明 |
| Seatbelt 只读描述符的 fcntl 修改 | profile builder 的 system-fcntl deny | 与 rename 拆开；保留 80／110 的实际 macOS 复现和允许写控制，说明不受限全盘写的兼容行为，按安全报告流程确认披露 |
| 隐藏父目录内的显式授权例外 | Seatbelt deny exceptions、Bubblewrap mount ordering | 属于路径优先级语义；先确认官方 intended contract，不能把 Ash 的“深层授权可覆盖隐藏祖先”默认变成官方语义。需多平台允许／拒绝对照，再决定 feature 或 bug；两个 backend 可拆开实现 |
| Unix socket 限制 | SeatbeltConfig、profile builder、strict launch options | 先比较现有 [PR #1278](https://github.com/microsoft/mxc/pull/1278) 的 deniedUnixSocketPaths／持续名字规则。它不自动等价于“默认禁止，只准指定 IPC 目录”，需列出余下场景；不重复提出同一字段，也不直接推广内部 serde-skip 字段 |
| dirhelper 查询与系统工具兼容 | Seatbelt baseline mach lookup | 独立 macOS 兼容提案：以 getconf／xcrun 可复现问题说明为什么需要该 lookup；限制在 dirhelper，不附带共享缓存写权限或全面 mach-lookup。新增 baseline allowance 需维护者政策审查及正向、拒绝对照 |
| Seatbelt 完整环境和共享代理环境处理 | Seatbelt runner、proxy_env | 与代理协议扩展拆开。先确认 env presence/default 语义，覆盖环境继承及空值，证明共享 helper 迁移保持各 backend 行为，不能仅凭减少重复代码提交 |
| SOCKS ALL_PROXY、WS／WSS 环境变量 | proxy_env、两个 Unix runner | 需先确认配置代理的协议能力。不能只从 caller 的 ALL_PROXY 推断 HTTP endpoint 同时支持 SOCKS；当前 fork 的推断不宜原样作为通用默认。准备显式协议设计和真实 curl／SOCKS／DNS 测试后再提 |
| Bubblewrap 非 PTY 会话隔离 | command args 的 stdio-mode 分支 | 已有 [issue #1444](https://github.com/microsoft/mxc/issues/1444)，先确认维护者方向；只拆 `--new-session` 的非 PTY 条件与 controlling-terminal 测试。Linux 实机证明 pipes/inherit 隔离、PTY job control 保持正常后才准备代码 PR |
| Bubblewrap 根挂载、readonly-try 与 denied remount | bwrap command mount plan | 三个可独立变化，不附带代理或 session 改动。分别确认 `/proc`／`/dev`、缺失 readonlyPaths 的错误语义、隐藏目录授权例外的写边界。需 Linux 挂载／访问实测；[issue #1445](https://github.com/microsoft/mxc/issues/1445) 是授权目录内保护后续执行配置的相关议题，并不覆盖这些补丁 |
| WSL AF_VSOCK 绕过限制 | seccomp、bwrap launch | 与其他 socket family 拆开，使用 WSL2 真实跨系统启动对照并按安全流程报告。[PR #1457](https://github.com/microsoft/mxc/pull/1457) 针对 AF_PACKET，不能作为 AF_VSOCK 已解决的证据 |
| 受信 Bubblewrap 执行路径 | ExecutionRequest 字段、version probe、runner | 是宿主控制 API 设计，需同一个路径用于 probe／spawn，讨论身份与 TOCTOU、policy identity。与 seccomp、网络 monitor 分开，优先版本化 launch options，而不是裸内部字段 |
| PSEC exact-request 准备与错误分类 | BaseContainerRunner、psec_tests | 拆出“准备本次策略且关闭临时资源”的 API 议题；需 Windows PSEC 成功、缺能力、故障和 cleanup 的新证据。不可把所有未知错误归为 unsupported，不能仅有 compile 就提完整成功路径 |
| Windows ACL 独立日志及严格恢复 | DaclManager constructors／restore/recover | 拆成恢复目录归属、失败保留日志／execution lease 两个接口议题；确认已有恢复契约。以 Windows 实际失败恢复和并发消费者测试为门槛；涉及越权／残留权限时走私密报告 |
| Windows ACL 继承恢复和对象级修改 | filesystem_dacl propagation、legacy inheritance、object-only writes | 与 API 扩展分开，按 inherited/protected root、非继承 ancestor 修改等独立失败场景拆修复。补现场 SDDL 前后对照、混合 inheritance tree、并发 SID 和恢复测试；缺 Windows 实机时保留待办，不一次提交 427 行综合变更 |
| 账户后端写拒绝、遍历和隐藏目录 helper | DaclManager 的新增授权方法 | 先讨论 MXC 是否接受这类 embedding helper；不要求他们接纳 Ash 的账户运行器或自身策略模型。若接受，只提供受支持的版本化契约与独立 ACL 行为测试 |
| 严格启动 facade、继承控制台与兼容 reexport | restricted.rs、engine visibility、v1 exports、models/parser/policy identity | 已准备拆分设计草稿。按 backend/fallback 控制、禁止 host ACL 修改、预检、执行路径、追加限制及 helper export 分开讨论；保留单一执行引擎。`prepare_restricted` 不原样上提，内部标记和 public reexport 必须有通用 caller 与版本化 API 依据 |

Windows 命令行候选仅处理现有 fork 中实际存在的 argv[0] 分隔符补丁，不声称修复 `/C` 后任意命令的全部 quoting／解析问题。任何进一步修正都需要独立复现。

[issue #1459](https://github.com/microsoft/mxc/issues/1459) 讨论 Seatbelt 另起 session 的后代存活；本轮退出观察修正并不等价于跨 session 的全树回收。这一契约问题需持续跟踪，但不要以该 issue 替代本轮具体补丁的复现与验证。

模块改名、清单展开、复制 fixture、格式重排和 Ash 适配代码已经去掉，不构成上游 PR。官方采用其他实现时，以隔离及清理保证等价且回归通过为退出 fork 的依据，不以实现形式一致为要求。

## 验证与下一步

准备阶段使用上游 Rust 1.93；命令行候选的普通 check、warning-denying check、20 项测试和 Clippy 已通过。资源编码做了真实 LLVM Windows-resource 编译前后对照。修改文件的格式、whitespace、独立 apply-check 和 bundle 校验通过。

完整 workspace 的 `cargo fmt --all -- --check` 在官方基线和候选都失败，输出完全一致，来源为无关上游文件；保留两份输出，没有把格式化整个上游混进候选。第一批均未新增依赖／lockfile，未运行完整 workspace 测试或远端 CI；Windows 实际运行和 rc.exe 构建仍未执行。

01 已提交官方 issue #1466，明确请求维护者确认 `/c 65001` 的方案；维护者确认后再发布 Draft。创建请求包含 Bug 类型及 Issue-Bug／Needs-Triage 标签，但 GitHub 未应用，当前账号没有该仓库 triage 权限，等待维护者分类。用户已将后续跟进交给 Dot；本聊天每 6 小时的自动跟进已暂停，避免重复处理。02 先补 Windows 复现，成功后再讨论范围。PTY 与严格启动控制先提设计 issue。安全相关部分先完成私密报告材料及适用的实机证据，再与维护者协调公开修复。这些独立准备分支无需合并进兼容 fork；当前 Ash pin 已按上文升级为官方 1.0.1 加必要兼容修正。
