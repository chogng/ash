# Code Mode

- 通过独立 Host 进程执行 JavaScript，不链接 V8。
- 转发工具调用、通知、取消操作和共享值。
- 默认启动当前程序同目录的 `ash-code-mode-host`；`ASH_CODE_MODE_HOST_BIN` 可指定路径。
- Host 启动失败或退出时返回错误，不切换到进程内执行。
- `ash-code-mode-session` 提供共享状态与接口，`ash-code-mode-runtime` 仅供 V8 Host 和引擎测试使用。
