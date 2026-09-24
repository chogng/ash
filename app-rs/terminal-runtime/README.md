# `ash-terminal-runtime`

1. 管终端 runtime 的预留、异步就绪、Session/Pane key 绑定、激活、后台保留和释放。
2. 管终端视图状态，包括滚动、滚动条、指针、选择及其基础绘制，但不知道 Workbench 的 Tab、Pane 和产品 binding。
3. 接收本地或 SSH 运行目标并向调用方发送生命周期事件；Workbench 只负责桌面事件桥接和 Pane 映射。

验证：`cargo test -p ash-terminal-runtime --lib`。
