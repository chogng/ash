# `ash-shell-completion`

> 本 README 是 Shell parser、command signature、token evidence 与 completion candidate 的实现契约。
> Shell/Agent 路由顺序见 [`ash-input-classifier`](../input-classifier/README.md)；命令执行和授权见
> [`ash-shell-command`](../../ash-rs/shell-command/README.md)。

1. 位于 `app-rs/shell-completion`，拥有 App 进程内的 Shell 输入解析、命令规格与补全算法。
2. 结合 PATH、工作区、路径和 alias 快照，为 token 生成描述，并从同一状态生成补全项。
3. 向输入分类器和输入框提供结果；命令执行、Shell/Agent 路由与 UI 状态由各自能力负责。

本 crate 不读取交互 Shell 状态，不启动命令。

## 公共契约

| Symbol | 职责 | 调用约束 |
| --- | --- | --- |
| `ShellCompletionEngine` | 持有 registry、PATH、工作目录、工作区候选和 alias 快照 | 每个 Shell 环境持有一个实例；环境变化后显式更新 |
| `ShellCommandRegistry` | 注册递归 `ShellCommandSpec` | 调用者显式注册的顶层命令视为权威事实；注册过程不能启动 generator 或授权执行 |
| `ShellCommandSpec` | 描述一个 command/subcommand 的 option 和 argument grammar | 未知 option 和无法验证的 opaque value 不产生 token evidence |
| `ShellTokenSnapshot` | 返回输入中每个 token 的位置和可选结构描述 | classifier 只把 `description.is_some()` 当作确定性证据 |
| `ShellCompletion` | 返回 replacement、display、kind 和 byte replace range | 产品宿主负责展示和应用，不得越过 editor authority |
| `ShellCompletionSnapshot` | 返回有界候选和当前 token 是否已有精确匹配 | inline UI 必须用精确匹配标记避免把 `git` 错续写成 `git-*`；不应自己重建 command 语义 |
| `ShellAlias` | 表达宿主已解析的一个 alias | 本 crate 只做最多三层展开；不自行读取 dotfile 或 PTY |

`ShellValueHint::Opaque` 只声明 argument slot，不会把任意字符串当作已识别 token。只有静态 choice、
合法 integer、已注册 command、现有 path、精确 directory target 等可验证值才产生描述。这一约束防止
`git status 是做什么的` 中的自然语言因为“命令接受参数”而被错误计为 Shell evidence。

## 执行路径与内部 owner

```text
ShellCompletionEngine::analyze
  → parser::parse_shell_commands
  → engine::ShellCompletionEngine::describe_word
      environment assignment / alias / wrapper
      command registry / subcommand / exact option
      option value / directory candidate / existing path
  → types::ShellTokenSnapshot

ShellCompletionEngine::complete
  → 同一个 parser 和 CommandState
  → engine::completions
      command / alias / subcommand / option / value / path candidates
```

- `parser::ShellLexer` 拥有 quote、escape、comment、pipeline、command separator、redirection 和
  `--flag=value` 边界；classifier 不得再维护第二套 Shell parser。
- `engine::CommandState` 拥有递归 subcommand、pending option value、combined short option、wrapper
  command 与 alias expansion 的状态迁移。
- `catalog::default_registry` 是 Ash 自建的内置 command grammar；没有复制 Warp completer 或其
  AGPL command-signature 数据。Shell builtin 始终可用；Git、Cargo、kubectl 等外部默认规格只有对应
  executable 出现在 PATH 快照时才参与顶层证据和补全。
- `environment::ExecutableCatalog` 在明确的 PATH 快照中冻结 executable identity；PATH 更新必须通过
  `set_path_entries` 重新建立快照。
- `dir::DirCatalog` 只读 package scripts、Just recipes 和 Make targets；目录内容变化后调用 `refresh_dir_catalog`。
- `engine::completions` 只投影候选，不拥有 ghost text/popup、selection、Tab 行为或 editor mutation。

## 失败和安全边界

- 无法读取 PATH 目录、manifest 或普通目录时跳过该来源，不启动子进程；PATH 快照最多读取 256 个
  目录并保留 16,384 个 executable，单个 directory source 最多读取 1 MiB、保留 4,096 个候选；
- alias 名称非法或 replacement 为空时在进入 engine 前拒绝；循环或超过三层的 alias 不产生证据；
- command registry 中没有的 option、无法验证的 value 和不存在的严格 file/directory 不产生描述；
- parser 接受未完成输入并返回已有 token，不把解析失败升级为产品错误；
- completion 最多返回 100 项，replace range 始终是原始 UTF-8 输入的 byte range；路径 replacement
  会保留单/双引号上下文或对未引用的 Shell 特殊字符做转义。

本 crate 不实现动态 generator。需要 namespace、Git branch、container 等运行时候选时，长期扩展方向是
接收宿主已经授权并带 revision 的候选快照；不得为了补全在同步 parser 或 classifier 路径中执行任意命令。

## 当前覆盖与限制

当前内置 catalog 覆盖 Shell builtins、常见 POSIX 命令，以及 Git、Cargo、Docker Compose、kubectl、
npm/pnpm/yarn/bun、Python/pytest、ripgrep、find 和 curl 的常用结构。PATH 中未收录 signature 的 executable
仍会被识别为顶层命令，但其参数没有结构描述。alias 必须由产品宿主提供；App 当前尚未从交互 PTY
采集 alias 或动态 completion snapshot。

## 验证

```bash
just check ash-shell-completion --locked
just test ash-shell-completion --locked
just rust-warnings ash-shell-completion --locked
```

测试覆盖 parser byte span、pipeline、redirection、递归 grammar、严格未知值、组合短参数、command wrapper、
递归和循环 alias、PATH replacement、有界工作区 targets、光标中间/`--option=` replacement、Shell-aware
separator，以及 command/subcommand/option/value/quoted path completion。
