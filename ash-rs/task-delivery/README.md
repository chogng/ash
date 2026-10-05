# 跨机器任务投递

在 Windows 上可以直接让 agent “把当前版本交给 mac 做 macOS 验收，并附上 Windows 的验收结果”。
目标机器创建独立的 Session，发送机器保留原来的任务和历史。接收成功后，关闭发送窗口或断开 SSH
不会删除目标机器的队列任务。

先在产品的 SSH 连接管理中保存目标名称，并完成该目标的运行时连接。投递只使用已有的命名目标
和已验证的 runtime，不安装额外服务。SSH 沿用现有凭据；投递包包含项目快照、要求和显式上下文，
不复制 profile 中的登录信息、模型凭据或原会话的隐藏推理。两端执行目录
必须是已有提交的 Git 仓库根目录；子目录不会被悄悄扩大为整个仓库。接收端须开启 Queue，并
提供 `taskDelivery` version 1 contract。
已经移交历史、只提供执行服务的远端 profile 不接受 Agent 任务。

| Agent 工具 | 用途 |
| --- | --- |
| `remote_task_targets` | 列出保存的机器、项目目录及 runtime 配置状态 |
| `remote_task_send` | 指定目标、标题、验收要求和上下文，返回关联的目标 Session 回执 |
| `remote_task_list` | 找回当前来源 Thread 最近 50 次投递的编号，包括回执丢失的投递 |
| `remote_task_read` | 按编号读取目标的 Queue、当前 Turn、错误和最新报告 |

发送与远端查询分别声明外部写入、外部读取权限，沿用现有操作审批。发送必须有用户的跨机器
委托指令。目标任务使用接收机器的模型、凭据和自动审批规则；审批或界面能力不足时，通过普通
Session/Turn 状态等待用户，发送端可以查询。需要手动审批或继续对话时，在目标机器打开回执中的
Session。界面验收还需要目标机器上已连接、具备相关能力的 Ash 客户端，SSH 本身只负责连接。

## 代码和重试

快照取自调用 Thread 已绑定的工作目录，包含准确的 Git HEAD 和 Git 磁盘树，包括已暂存、未暂存
修改，以及未被忽略的新文件和二进制文件。真实 index 不变。未保存的编辑器缓冲区、忽略的产物和
子模块内容不会被搬运；含 Git 子模块或嵌入仓库的快照直接拒绝。Git 对象包最多 64 MiB；两端已有
共同提交时，以接收端的 HEAD 为明确前置对象，只发送缺少的对象。没有共同对象时发送完整闭包，
同样受大小和进程期限限制。

接收端验证对象包摘要、Git 对象完整性和前置提交，再通过现有 WorktreeManager 创建隔离目录，
保留目标原目录及其未提交修改。工作目录的 HEAD 和基线树写入回执，验收任务使用该隔离目录。

第一次发送先把目标和完整包存到来源 profile 的 `state.sqlite3`。发送过程中结果不确定时，错误
包含 `delivery_id`；也可通过 `remote_task_list` 找回编号。重试 `remote_task_send` 时提供该编号及
原参数，复用原包。来源代码继续变化、目标改名、窗口关闭或进程重启都不会替换已经保存的包。
同一编号配另一份任务会被拒绝。

接收端在文件和历史变更前保存包，使用固定的 Thread、Session 和 Queue command identity。只有
Queue 已持久接受任务才返回成功回执。丢失回执后重复投递不会创建第二个 Session 或 Turn；接收
在创建目录、创建 Thread 或入队之间中断，也能重放相同包完成。原 Session 不被复制或转移。

`task/snapshotInfo`、`task/receive`、`task/read` 的参数、回执和报告从 Rust 定义生成。报告中的
`turnId`、状态、错误和消息属于同一个当前 Turn；长消息明确标记 `messageTruncated`。完整历史
继续由目标 Session 提供，执行状态由 Core 和 Queue 提供，投递库只保存包和关联回执。

## 实现归属

本 crate 拥有包、重试约束和持久关联，`runtime` feature 提供领域流程；协议生成只消费数据类型，
无需编译执行引擎。App Server 组合目录授权、现有 SSH route 和工具注册。命名目标与运行时代际
都由 `remote-profile-store` 持有；Git 对象传输由 `ash-git` 持有。没有额外的消息板服务或监听进程。

验证入口：`just test ash-task-delivery --features runtime`、`just test ash-git transfer`、
`just test ash-app-server --lib task_delivery`。
