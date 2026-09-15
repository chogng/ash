# `ash-terminal-service`

- 管理已授权目录中的交互式 PTY 会话、输入和尺寸。
- 保存有界原始输出与命令状态，报告读取游标和数据缺口。
- 管理连接归属、重连租约、令牌轮换和进程终止。
- 发现可信 Shell 配置，过滤继承的环境变量。
- 使用普通 Rust 类型提供接口；App Server 负责 RPC 转换和 Base64 编码。

验证：`just check ash-terminal-service`、`just test ash-terminal-service`。
