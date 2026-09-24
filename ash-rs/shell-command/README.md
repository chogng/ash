# `ash-shell-command`

> 本 README 是显式本地进程 Tool 与只读 ripgrep profile 的实现契约。跨 crate Tool ownership
> 见 [`docs/tools.md`](../../docs/tools.md)，sandbox policy 见
> [`docs/sandboxing.md`](../../docs/sandboxing.md)。

本 crate 拥有 `shell-command` host definition、结构化请求解析和冻结的 `rg` executable
materialization。安装布局与候选位置由 [`ash-install-context`](../install-context/README.md)
提供；本 crate 不读取安装方式，不隐式启动 shell，不决定 Core approval，也不持有 Thread/Turn
状态。

## 文件与职责

| 文件 | 职责 |
| --- | --- |
| `src/lib.rs` | `ShellCommandTool`、`ShellCommandRequest`、definition 与 executor bridge |
| `src/ripgrep.rs` | `RipgrepExecutable` candidate validation/identity freeze 与 `BuiltInRipgrepPolicy` 参数约束 |
| `src/shell_command_tests.rs` | binding、authority、sandbox denial 与 validation |
| `src/ripgrep_tests.rs` | executable discovery 和 unsafe flag rejection |

## 公共契约与调用路径

```text
ShellCommandTool::new
└─ shell_command_definition + ash_tool_executor::CommandExecutor

ToolExecutor::execute
├─ validate binding / environment / cancellation
├─ ShellCommandRequest::from_arguments
└─ ShellCommandTool::execute_authorized
   └─ CommandExecutor::execute

App Server local adapter
├─ InstallContext::executable_candidates(Ripgrep)
├─ RipgrepExecutable::from_override / discover_candidates
├─ ShellCommandRequest::from_arguments
├─ directory argument validation
├─ RipgrepExecutable::materialize
└─ ShellCommandTool::execute_authorized
```

`ShellCommandRequest` 始终是显式 `program + arguments + relative working_directory`；没有 quoting、
globbing、environment expansion 或 shell parsing。`ShellCommandTool::execute_authorized` 只供已经
完成 host materialization 和 Core policy decision 的 adapter 使用。

## 只读 `rg` 配置档案

App Server 先从 `InstallContext` 获取以下候选：

1. `ASH_RG_PATH`；
2. package layout 的 `ash-path/rg[.exe]`；
3. 当前 Ash executable 同目录的 legacy `rg`/`rg.exe`；
4. 启动时 `PATH`。

显式 override 通过 `from_override` 单独验证，无效时直接失败；普通候选由
`discover_candidates` 逐个验证。选中的 executable canonicalize 并冻结后，`materialize` 只接受
模型别名 `rg`，替换成冻结的绝对 executable，并在 argv 前加入 `--no-config`。
`BuiltInRipgrepPolicy` 拒绝
preprocessor、hostname command、archive search、symlink follow、pattern file 与 ignore file
参数，包括 `-f/path`、`-LH` 等紧凑短参数形式，因为它们会扩大进程或文件读取边界。该 policy
只负责 built-in 参数安全，不替代下层 OS sandbox。
App Server adapter 还拒绝绝对路径和含 `..` component 的参数。
已存在的相对 path argument 会在 review 前 canonicalize；通过目录内 symlink 指向外部的
路径同样被拒绝。

canonical package builder 当前按 checksum-locked manifest 把 ripgrep 放到
`ash-path/rg[.exe]`，并在 `ash-package.json` 记录版本和 digest；具体 staging contract 见
[`build/ash_rs/README.md`](../../build/ash_rs/README.md)。本 crate 仍不信任
metadata，也尚未执行版本/capability probe。Packaging 不能改变上述 executable validation、
identity freeze 和 fail-closed 语义。Linux package 同时携带经过 source lock 构建的
`ash-resources/bwrap`；它的 discovery/probe contract 由
[`mxc-sandbox`](../mxc-sandbox/README.md) 拥有。

## 失败、取消与输出

- JSON shape、空 program、binding 或 environment 不匹配：子进程启动前失败；
- Core 选择的 sandbox backend 无法建立边界：返回 structured `SandboxDenied`；
- cancellation 在 spawn 前返回 not-started；spawn 后终止 child 并返回 uncertain outcome；
- timeout 同样终止 child，并按 started/uncertain 处理；
- stdout/stderr 共用一个 byte budget，结果保留 bounded prefix，并分别标记是否截断。

底层 checkpoint、kill 和 capture 语义由
[`ash-tool-executor`](../tool-executor/README.md) canonical 定义。

## 修改与验证

修改 model schema、危险 `rg` flags、discovery 顺序或 outcome mapping 时，必须同步检查 App Server
`local_tools.rs`、本 README 和 `docs/tools.md`。

```bash
cargo test -p ash-shell-command
cargo clippy -p ash-shell-command --all-targets --no-deps -- -D warnings
bazel test //ash-rs/shell-command:shell-command-unit-tests
```
