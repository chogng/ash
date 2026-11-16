# ash-utils-pty

`ash-utils-pty` 拥有交互式 PTY、Windows ConPTY、终端输入、合并输出、尺寸、前台中断和终端句柄生命周期。
底层终端实现来自随库维护的 `portable-pty`；来源与许可证见 [NOTICE](NOTICE)。

普通管道进程、进程组、Job 和 Unix 守护由 [utils/process](../process/README.md) 拥有。
本 crate 不提供外部 driver 接口，不持有工具授权、沙箱策略、超时或输出历史。

## 接口与生命周期

- `spawn_pty_process` 返回终端会话、输出通道与退出通知。stderr 已合并到 stdout。
- `ProcessHandle` 提供输入、resize、中断、退出状态和终止；释放会话会结束其进程树。
- Unix 中断查询终端当前前台进程组；关闭时清理整个受管 session，包括子进程创建的其他组。
- Windows 在执行用户代码前将进程加入 Job。正常退出保留已脱离的后代，显式终止清理整个 Job。
- 退出通知不代表输出已排空。调用方继续读取至通道关闭；后台阻塞 waiter 不能因会话释放而被取消。
- `release_pty_handles_after_exit` 兼容旧版 ConPTY 的 EOF 行为；支持 client lifetime 的系统等待最后一个控制台客户端退出。
- Unix 关闭输入发送换行和终端当前的 VEOF；raw mode 不提供管道式半关闭。

`process_id` 在交给回收任务前捕获 OS 身份。`has_child_processes` 在用户关闭终端时查询真实子进程；
`current_working_directory` 在支持的平台查询实际目录，退出或无法查询时返回 `None`。

`CancellablePipeReader` 仍供 Windows App Server Client 读取 stdio；连接关闭可中断读取，无需等待外部写端退出。

## 验证

```sh
just verify ash-utils-pty
```

Windows 测试覆盖控制台输入、中断、正常退出、后代存活、Job 接入失败与输出 EOF；Unix 场景覆盖终端尺寸、
前台组、后台后代与回收。测试依赖宿主 Python 和相应系统 shell。
