# `ash-utils-process`

`background_command(program)` 为普通后台进程构造 `std::process::Command`，在 Windows 设置
`CREATE_NO_WINDOW`，其他平台保持标准命令行为。生产库只依赖标准库；异步调用方使用
`tokio::process::Command::from(background_command(program))`。

调用方继续负责参数、环境、工作目录、标准输入输出、超时和进程回收。后续调用
`creation_flags` 会覆盖原有标志，需要保留 `CREATE_NO_WINDOW`。交互终端、PTY、sandbox
以及 daemon 的特殊脱离启动策略留在各自所属模块。

`just verify ash-utils-process` 验证 std/Tokio 子进程执行和输出捕获；Windows 还从脱离控制台的
父进程启动系统 PowerShell 探针，通过 `GetConsoleWindow` 检查后台子进程没有控制台窗口。
