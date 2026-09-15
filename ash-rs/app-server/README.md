# `ash-app-server`

`ash-app-server` 组合一个环境中的服务并实现 App Server 协议，具体职责如下：

1. 分发类型化协议，管理请求取消、产品会话组织和通知订阅。
2. 通过 `core-api::AgentRuntime` 调用 Agent 操作；Core 负责执行、重试、取消和恢复。
3. 在文件、搜索、Git、Terminal、语言服务和目录贡献入口校验 Permission，传递有效授权。
4. 组合 profile 配置、环境服务与 Core 实现；目录贡献只在获得对应授权后生效。
5. 在 Agent、Shell 和上下文压缩执行期间持有空闲防休眠租约，同一进程内的目录服务共享系统资源。

连接建立、鉴权和消息队列由 `ash-app-server-transport` 负责。Core 契约和装配边界见
[`Core 架构`](../../docs/core.md#7-依赖边界)。

交互式 PTY、输出缓存和重连租约由 [`ash-exec-server`](../exec-server/README.md) 管理；
`src/server/terminal_operations.rs` 负责协议转换和调用，环境装配负责传入有效授权。

环境和目录授权语义见 [`docs/environment-access.md`](../../docs/environment-access.md)，wire contract 见
[`docs/ash-app-server-api.md`](../../docs/ash-app-server-api.md)。

```text
just test ash-app-server
```

## 执行环境

- Core 执行作用域结束时释放防休眠租约，包括完成、失败、中断及让出执行的审批或能力等待；恢复执行时重新获取。
- 工具内部的同步交互等待仍保留执行作用域，期间可能还有正在运行的命令；空闲连接和持久化的未完成任务不持有租约。
- 防休眠能力由 [sleep-inhibitor](../utils/sleep-inhibitor/README.md) 提供；系统拒绝获取时记录警告，任务按正常执行规则继续。

- `ASH_EXEC_ENVIRONMENTS` 指定宿主配置的执行环境列表，格式见 [exec-server](../exec-server/README.md)。
- Core 审批后调用显式选定的环境，执行结果仍写回当前 Thread。
- 执行目标在装配时固定身份、实例、根目录和权限上限；审批摘要包含这份绑定，切换当前工作区不会改写目标。
- `environment_runtime` 保留授权、配置激活与 Agent 工具装配；`WorkspaceRuntime` 组合就近索引、搜索、Git 与监听，`ExecutionRuntime` 组合目录绑定的终端与调试资源。
- 额外执行目标独立于当前工作区；容器副本同步与回写尚未接入，不将该目标自动当作当前索引对应的源码。
- 命令观察使用有上限的等待，短暂断线只恢复原进程的读取；取消以实际终态为准。完整语义见 [exec-server](../exec-server/README.md)。

## 进程入口

- `ash-app-server --listen stdio://` 提供直接连接；未设置 `ASH_WORKSPACE_ROOT` 时不继承当前目录授权。
- WebSocket 使用 `--listen ws://127.0.0.1:0 --ws-auth capability-token --ws-token-sha256 HEX --emit-listen-info stdout-json`，监听成功后输出一条启动记录。
- `src/startup.rs` 负责参数、环境绑定和服务启动；CLI 调用同一 `run`。
- profile 路径和随包产品服务发现由 `install-context` 提供，客户端消费相同契约。
- `arg0` 在普通参数解析前分发内部 worker；启动命令绑定实际宿主可执行路径。
- daemon 的连接和生命周期命令由 [`app-server-daemon`](../app-server-daemon/README.md) 提供。

验证：`just test ash-app-server --test stdio --test websocket --test worker`。

## 受管后台进程

- `ash-app-server --managed` 运行 profile 级共享服务；PID 记录直接指向此进程。
- `src/managed.rs` 拥有服务循环、连接线程、停止期限和空闲退出。
- `src/managed/registry.rs` 拥有目录服务组合，以及共享队列与自动化运行。
- 先取得 profile 端点，再启动后台工作，避免并发启动重复运行任务。
- daemon crate 提供进程管理和控制端点机制，App Server 依赖它；依赖方向保持单向。

## Agent grep

- `AgentGrepBackend::FastRegex` 使用 [`fast-regex-search`](../fast-regex-search/README.md) 的目录索引与私有 worker，最多返回 100 个匹配行；编辑器搜索独立使用 Content Search。
- 目录 watcher 的路径事件发布增量，重扫事件核对文件集合；查询只覆盖已处理更新的索引版本。空结果标明异步更新边界，不能当作最新磁盘内容不存在的证明。
- 索引容量不足或遍历失败返回工具失败；不会把未覆盖的文件默认为无匹配。候选内容变更触发一次更新重试。
- 验证命令：`just test ash-app-server --lib agent_grep`。
